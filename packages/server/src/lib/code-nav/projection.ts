import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveSafePath } from '../vault.js';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { getCodeDb } from './db.js';
import { resolveRepoById, getRepoPathOnMachine } from './repos.js';
import { parseFrontmatter, stringifyFrontmatter } from '../frontmatter.js';

const MAX_BODY_LINES = 1000;

interface SymbolRow {
  id: string;
  repo_id: string;
  relative_path: string;
  name: string;
  kind: string;
  qualified_name: string;
  signature: string | null;
  docstring: string | null;
  start_line: number;
  end_line: number;
  parent_id: string | null;
  content_hash: string;
}

export interface ProjectionResult {
  projected: boolean;
  vaultPath: string;
  reason?: string;
}

/** Slugify text for path use: lower, non-alnum→`-`, collapse, trim. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Slugify a path (preserve `/` separators between segments). */
function slugifyPath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((seg) => slugify(seg.replace(/\.[^.]+$/, '')))
    .filter((s) => s.length > 0)
    .join('/');
}

function slugifyName(name: string): string {
  return slugify(name) || 'symbol';
}

function vaultPathFor(slug: string, relativePath: string, name: string, kind: string): string {
  const parts = ['Code', slug, slugifyPath(relativePath), `${slugifyName(name)}-${kind}.md`];
  return parts.join('/');
}

function findCalleeRows(db: ReturnType<typeof getCodeDb>, callerId: string): Array<{ id: string; name: string; relative_path: string; slug: string }> {
  return db
    .prepare(
      `SELECT s.id, s.name, s.relative_path, r.slug
       FROM calls c
       JOIN symbols s ON s.id = c.callee_id
       JOIN repos r ON r.id = s.repo_id
       WHERE c.caller_id = ? AND c.callee_id IS NOT NULL`,
    )
    .all(callerId) as Array<{ id: string; name: string; relative_path: string; slug: string }>;
}

function findCallerRows(db: ReturnType<typeof getCodeDb>, calleeId: string): Array<{ id: string; name: string; relative_path: string; slug: string }> {
  return db
    .prepare(
      `SELECT s.id, s.name, s.relative_path, r.slug
       FROM calls c
       JOIN symbols s ON s.id = c.caller_id
       JOIN repos r ON r.id = s.repo_id
       WHERE c.callee_id = ?`,
    )
    .all(calleeId) as Array<{ id: string; name: string; relative_path: string; slug: string }>;
}

/**
 * Project a symbol into the RW vault. Idempotent: if a fresh projection
 * already exists, returns without rewriting.
 */
export async function projectSymbolById(
  id: string,
  opts: { force?: boolean } = {},
): Promise<ProjectionResult> {
  const force = opts.force ?? false;
  const db = getCodeDb();
  const sym = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as SymbolRow | undefined;
  if (!sym) {
    throw new Error(`Symbol not found: ${id}`);
  }

  const repoRow = resolveRepoById(sym.repo_id);
  if (!repoRow) {
    throw new Error(`Repo for symbol ${id} not found in registry`);
  }
  const slug = repoRow.slug;
  const vaultPath = vaultPathFor(slug, sym.relative_path, sym.name, sym.kind);

  // Resolve safe path (write into RW vault) — also enforces denied segments.
  const absVaultPath = resolveSafePath(vaultPath, true);

  // Check existing file freshness.
  if (!force) {
    try {
      const existing = await fs.readFile(absVaultPath, 'utf-8');
      const { data } = parseFrontmatter(existing);
      if (data.content_hash === sym.content_hash) {
        return { projected: false, vaultPath, reason: 'fresh' };
      }
    } catch {
      // missing — proceed to write
    }
  }

  // Read source body slice from the on-disk file.
  const repoAbs = getRepoPathOnMachine(sym.repo_id);
  let body = '';
  let truncated = false;
  if (repoAbs) {
    const srcAbs = path.join(repoAbs, sym.relative_path);
    try {
      const raw = await fs.readFile(srcAbs, 'utf-8');
      const lines = raw.replace(/\r\n?/g, '\n').split('\n');
      const start = Math.max(0, sym.start_line - 1);
      const end = Math.min(lines.length, sym.end_line);
      let slice = lines.slice(start, end);
      if (slice.length > MAX_BODY_LINES) {
        slice = slice.slice(0, MAX_BODY_LINES);
        truncated = true;
      }
      body = slice.join('\n');
    } catch (err) {
      body = `<unable to read file: ${err instanceof Error ? err.message : String(err)}>`;
    }
  } else {
    body = '<repo path not registered on this machine>';
  }

  // Build callee/caller wiki-link lists.
  const callees = findCalleeRows(db, id);
  const callers = findCallerRows(db, id);
  const calleeLinks = callees.map((c) => `- [[code:${c.slug}:${c.relative_path}:${c.name}]]`);
  const callerLinks = callers.map((c) => `- [[code:${c.slug}:${c.relative_path}:${c.name}]]`);

  const langForBlock = guessLangFromPath(sym.relative_path);

  const sections: string[] = [];
  sections.push(`# ${sym.qualified_name || sym.name}`);
  sections.push('');
  sections.push('## Signature');
  sections.push('```' + langForBlock);
  sections.push(sym.signature ?? `(${sym.kind} ${sym.name})`);
  sections.push('```');
  if (sym.docstring && sym.docstring.trim().length > 0) {
    sections.push('');
    sections.push('## Doc');
    sections.push(sym.docstring);
  }
  sections.push('');
  sections.push('## Body');
  sections.push('```' + langForBlock);
  sections.push(body);
  sections.push('```');
  sections.push('');
  sections.push('## Related');
  sections.push('### Callers');
  sections.push(callerLinks.length > 0 ? callerLinks.join('\n') : '_(none)_');
  sections.push('');
  sections.push('### Callees');
  sections.push(calleeLinks.length > 0 ? calleeLinks.join('\n') : '_(none)_');
  sections.push('');

  const frontmatter: Record<string, unknown> = {
    type: 'code-symbol',
    code_id: sym.id,
    repo_slug: slug,
    relative_path: sym.relative_path,
    kind: sym.kind,
    signature: sym.signature ?? '',
    content_hash: sym.content_hash,
    projected_at: new Date().toISOString(),
    start_line: sym.start_line,
    end_line: sym.end_line,
  };
  if (truncated) frontmatter.truncated = true;

  const final = stringifyFrontmatter(frontmatter, sections.join('\n'));

  // Atomic write via .tmp + rename
  const tmp = `${absVaultPath}.tmp`;
  await fs.mkdir(path.dirname(absVaultPath), { recursive: true });
  await fs.writeFile(tmp, final, 'utf-8');
  await fs.rename(tmp, absVaultPath);

  return { projected: true, vaultPath };
}

function guessLangFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.ts': return 'ts';
    case '.tsx': return 'tsx';
    case '.js': return 'js';
    case '.jsx': return 'jsx';
    case '.py': return 'python';
    case '.rs': return 'rust';
    case '.go': return 'go';
    default: return '';
  }
}

/**
 * Best-effort projection of any code wiki-links found in `body`. Caps at
 * `maxProjections` (default 3). Failures are logged, never thrown.
 */
export async function projectCodeRefsFromBody(body: string, maxProjections = 3): Promise<string[]> {
  if (!config.codeAutoProjectOnRecall) return [];
  const re = /\[\[code:([^:\]]+):([^:\]]+):([^\]]+)\]\]/g;
  const seen = new Set<string>();
  const tasks: Array<{ slug: string; relpath: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = `${m[1]}:${m[2]}:${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ slug: m[1], relpath: m[2], name: m[3] });
    if (tasks.length >= maxProjections) break;
  }

  const projected: string[] = [];
  const db = getCodeDb();
  const lookup = db.prepare(
    `SELECT s.id FROM symbols s
     JOIN repos r ON r.id = s.repo_id
     WHERE r.slug = ? AND s.relative_path = ? AND s.name = ?
     LIMIT 1`,
  );

  for (const t of tasks) {
    try {
      const row = lookup.get(t.slug, t.relpath, t.name) as { id: string } | undefined;
      if (!row) continue;
      const result = await projectSymbolById(row.id);
      if (result.projected) projected.push(result.vaultPath);
    } catch (err) {
      logger.warn('Auto-projection failed', {
        ref: `${t.slug}:${t.relpath}:${t.name}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return projected;
}
