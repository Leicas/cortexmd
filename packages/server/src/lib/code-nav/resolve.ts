import { getCodeDb } from './db.js';
import { resolveRepoBySlug } from './repos.js';

const SYMBOL_ID_RE = /^[0-9a-f]{16}$/;

/**
 * A candidate symbol surfaced when a name is ambiguous (or for building the
 * "no match" diagnostic). Mirrors the fields agents need to pick the right id.
 */
export interface SymbolCandidate {
  id: string;
  name: string;
  path: string;
  kind: string;
  repo: string;
}

/**
 * Shared name→id resolver for the id-taking code-nav tools (code_symbol_get,
 * code_symbol_callers, code_symbol_callees, code_change_impact). Lets an agent
 * pass a symbol `name` (+ optional `repo` slug) instead of a 16-hex `id` it
 * cannot know without first calling code_symbol_search.
 *
 * Behavior:
 *  - If `id` is supplied, it is returned verbatim (id-based path is unchanged).
 *  - Otherwise `name` is required and resolved by EXACT name match:
 *      • scoped to `repo` when given; if `repo` is omitted and exactly one repo
 *        is registered, that repo is used as the default; otherwise an error
 *        asks the caller to pass `repo`.
 *      • exactly one match  → its id.
 *      • multiple matches   → throws, listing up to 5 candidates (id/name/path/
 *        kind) so the caller can disambiguate — never guesses.
 *      • zero matches       → throws "no symbol named X in repo Y".
 *
 * Throws on any unresolvable input so callers can surface the message directly.
 */
export function resolveSymbolId(input: {
  id?: string;
  name?: string;
  repo?: string;
}): string {
  const { id, name, repo } = input;

  // 1. id wins — behavior identical to the pre-existing id-only path.
  if (id) {
    if (!SYMBOL_ID_RE.test(id)) {
      throw new Error(`Invalid symbol id "${id}" (expected 16-char hex).`);
    }
    return id;
  }

  // 2. Fall back to name resolution.
  if (!name) {
    throw new Error('Provide either `id` (16-char hex) or `name` (+ optional `repo`).');
  }

  const db = getCodeDb();

  // Resolve the repo scope: explicit slug, or an unambiguous single default.
  let repoId: string | null = null;
  let repoSlug: string | null = null;
  if (repo) {
    const repoRow = resolveRepoBySlug(repo);
    if (!repoRow) throw new Error(`Unknown repo slug: ${repo}`);
    repoId = repoRow.id;
    repoSlug = repoRow.slug;
  } else {
    const repoRows = db.prepare(`SELECT id, slug FROM repos`).all() as Array<{
      id: string;
      slug: string;
    }>;
    if (repoRows.length === 1) {
      repoId = repoRows[0].id;
      repoSlug = repoRows[0].slug;
    } else if (repoRows.length === 0) {
      throw new Error(
        `Cannot resolve name "${name}": no repos are registered. Index one with ` +
          '`cortexmd index <repo-path>`.',
      );
    } else {
      throw new Error(
        `Cannot resolve name "${name}": ${repoRows.length} repos are registered — ` +
          'pass `repo: <slug>` to disambiguate.',
      );
    }
  }

  // Exact name match within the resolved repo.
  const matches = db
    .prepare(
      `SELECT id, name, relative_path AS path, kind
         FROM symbols
        WHERE repo_id = ? AND name = ?
        ORDER BY relative_path, start_line`,
    )
    .all(repoId, name) as Array<{ id: string; name: string; path: string; kind: string }>;

  if (matches.length === 1) {
    return matches[0].id;
  }

  if (matches.length === 0) {
    throw new Error(
      `No symbol named "${name}" in repo "${repoSlug}". ` +
        'Use code_symbol_search to find the right name/id.',
    );
  }

  // Multiple matches — never guess. List the top ~5 so the caller can pick.
  const candidates: SymbolCandidate[] = matches.slice(0, 5).map((m) => ({
    id: m.id,
    name: m.name,
    path: m.path,
    kind: m.kind,
    repo: repoSlug!,
  }));
  const listed = candidates
    .map((c) => `  ${c.id}  ${c.kind} ${c.name}  (${c.path})`)
    .join('\n');
  const more = matches.length > candidates.length ? ` (+${matches.length - candidates.length} more)` : '';
  throw new Error(
    `Ambiguous name "${name}" in repo "${repoSlug}": ${matches.length} matches${more}. ` +
      `Pass one of these ids as \`id\`:\n${listed}`,
  );
}
