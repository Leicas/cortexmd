import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { glob } from 'glob';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getCodeDb, computeGitOriginId } from '../lib/code-nav/db.js';
import {
  walkRepo,
  languageForPath,
  resolveRepoFull,
  resolveRepoBySlug,
  resolveRepoById,
  getMachineId,
  firstCommitSha,
  gitOrigin,
  getRepoPathOnMachine,
} from '../lib/code-nav/repos.js';
import type BetterSqlite3 from 'better-sqlite3';
import { parseFile, normalizeNewlines, sha1Hex } from '../lib/code-nav/parser.js';
import type { ParseResult } from '../lib/code-nav/parser.js';
import { writeVaultRegistry } from '../lib/code-nav/registry.js';
import { projectSymbolById } from '../lib/code-nav/projection.js';
import { getCodeNavStats } from '../lib/code-nav/stats.js';
import { config } from '../config.js';
import { getCodeNavSavings, recordExternalCodeNavSavings } from '../lib/code-nav/savings.js';
import { listFiles, readNote, deleteNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { logger } from '../lib/logger.js';

const SYMBOL_ID_RE = /^[0-9a-f]{16}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// In-process per-repo lock to prevent concurrent re-index of the same repo.
const indexLocks = new Set<string>();

const MAX_BODY_LINES = 200;

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

/**
 * Apply a single file's parse result to the code DB inside the caller's transaction.
 * Shared by `code_index_repo` (server-side fs walk) and `code_ingest_repo`
 * (client-supplied payload) to avoid drift in the per-file SQL.
 *
 * Caller is responsible for opening the transaction and prepping any context-
 * specific work (hashing, language detection). This function expects the parse
 * result to already be normalized (ids, hashes computed against `repoId`).
 */
function applyParseResultToRepo(
  db: BetterSqlite3.Database,
  repoId: string,
  file: {
    relativePath: string;
    language: string;
    contentHash: string;
    sizeBytes: number;
  },
  parseResult: ParseResult,
): void {
  const deleteSymbolsForFile = db.prepare(
    `DELETE FROM symbols WHERE repo_id=? AND relative_path=?`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (id, repo_id, relative_path, name, kind, qualified_name, signature, docstring, start_line, end_line, parent_id, content_hash, body_simhash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_id=excluded.repo_id,
       relative_path=excluded.relative_path,
       name=excluded.name,
       kind=excluded.kind,
       qualified_name=excluded.qualified_name,
       signature=excluded.signature,
       docstring=excluded.docstring,
       start_line=excluded.start_line,
       end_line=excluded.end_line,
       parent_id=excluded.parent_id,
       content_hash=excluded.content_hash,
       body_simhash=excluded.body_simhash`,
  );
  const insertCall = db.prepare(
    `INSERT OR IGNORE INTO calls (caller_id, callee_name, callee_id, call_line)
     VALUES (?, ?, NULL, ?)`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO files (repo_id, relative_path, content_hash, language, size_bytes, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, relative_path) DO UPDATE SET
       content_hash=excluded.content_hash,
       language=excluded.language,
       size_bytes=excluded.size_bytes,
       indexed_at=excluded.indexed_at`,
  );
  const deleteImportsForFile = db.prepare(
    `DELETE FROM file_imports WHERE repo_id=? AND relative_path=?`,
  );
  const insertImport = db.prepare(
    `INSERT OR REPLACE INTO file_imports (repo_id, relative_path, imported_name, source_module, resolved_repo)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  const selectExistingForFile = db.prepare(
    `SELECT id, name, kind, signature
       FROM symbols
      WHERE repo_id = ? AND relative_path = ?`,
  );
  const insertSymbolChange = db.prepare(
    `INSERT INTO symbol_changes
       (repo_id, relative_path, name, kind, change_kind,
        before_symbol_id, after_symbol_id, before_signature, after_signature, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Capture pre-state for breaking-change detection BEFORE we wipe the
  // file's symbols. We diff against parseResult.symbols by (name, kind):
  // since a symbol's id hashes the signature, "same id" implies "same
  // signature" — divergence means either the signature changed (id changed
  // for the same logical symbol) or the symbol disappeared.
  const existing = selectExistingForFile.all(repoId, file.relativePath) as Array<{
    id: string;
    name: string;
    kind: string;
    signature: string | null;
  }>;
  const existingByKey = new Map<string, { id: string; signature: string | null }>();
  for (const old of existing) {
    existingByKey.set(
      `${old.name}\x00${old.kind}`,
      { id: old.id, signature: old.signature },
    );
  }

  deleteSymbolsForFile.run(repoId, file.relativePath);
  const newKeys = new Set<string>();
  for (const sym of parseResult.symbols) {
    insertSymbol.run(
      sym.id,
      repoId,
      file.relativePath,
      sym.name,
      sym.kind,
      sym.qualifiedName,
      sym.signature,
      sym.docstring,
      sym.startLine,
      sym.endLine,
      sym.parentId,
      sym.contentHash,
      // body_simhash flows from the wire payload (Rust client). Server-side
      // parseFile (used by code_index_repo when fs walking) doesn't compute
      // it yet — those rows get NULL and are filtered out by mode=body.
      sym.bodySimhash ?? null,
    );
    const key = `${sym.name}\x00${sym.kind}`;
    newKeys.add(key);
    const old = existingByKey.get(key);
    if (old && old.id !== sym.id) {
      insertSymbolChange.run(
        repoId,
        file.relativePath,
        sym.name,
        sym.kind,
        'sig_changed',
        old.id,
        sym.id,
        old.signature,
        sym.signature ?? null,
        Date.now(),
      );
    }
  }
  // Anything in `existing` not present in `newKeys` is gone.
  for (const old of existing) {
    const key = `${old.name}\x00${old.kind}`;
    if (!newKeys.has(key)) {
      insertSymbolChange.run(
        repoId,
        file.relativePath,
        old.name,
        old.kind,
        'removed',
        old.id,
        null,
        old.signature,
        null,
        Date.now(),
      );
    }
  }

  for (const call of parseResult.calls) {
    insertCall.run(call.callerId, call.calleeName, call.callLine);
  }
  upsertFile.run(repoId, file.relativePath, file.contentHash, file.language, file.sizeBytes, Date.now());
  deleteImportsForFile.run(repoId, file.relativePath);
  for (const imp of parseResult.imports) {
    insertImport.run(repoId, file.relativePath, imp.importedName, imp.sourceModule);
  }
}

// ────────────────────────────── code_repo_register ──────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out',
  '.obsidian', '.sync', '.trash',
  'target', '__pycache__', 'venv', '.venv', 'vendor',
]);

async function registerRepoCore(
  rawPath: string,
  inputSlug: string | undefined,
): Promise<{ id: string; slug: string; abs_path: string; machine_id: string; git_origin: string | null; conflict?: string }> {
  const absPath = path.resolve(rawPath);
  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }
  const gitDir = path.join(absPath, '.git');
  if (!existsSync(gitDir)) {
    throw new Error(`Not a git repo (no .git/): ${absPath}`);
  }

  const sha = await firstCommitSha(absPath);
  const id = sha.slice(0, 16);
  const origin = await gitOrigin(absPath);

  let slug = (inputSlug ?? path.basename(absPath)).trim();
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug "${slug}". Allowed: ^[a-z0-9][a-z0-9_-]*$`);
  }

  const db = getCodeDb();
  const machineId = getMachineId();

  // Check for slug collision with a DIFFERENT id → auto-suffix.
  const existingBySlug = db.prepare(`SELECT id FROM repos WHERE slug=?`).get(slug) as { id: string } | undefined;
  if (existingBySlug && existingBySlug.id !== id) {
    slug = `${slug}-${id.slice(0, 4)}`;
  }

  // Path conflict check: same (machineId, abs) mapped to a DIFFERENT repo_id.
  const existingPath = db
    .prepare(`SELECT repo_id FROM repo_paths WHERE machine_id=? AND abs_path=?`)
    .get(machineId, absPath) as { repo_id: string } | undefined;
  if (existingPath && existingPath.repo_id !== id) {
    throw new Error(
      `Path ${absPath} on machine ${machineId} is already registered to repo ${existingPath.repo_id} (incoming id: ${id})`,
    );
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO repos (id, slug, git_origin, first_commit_sha, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, slug, origin, sha, now);

    if (origin) {
      db.prepare(
        `UPDATE repos SET git_origin = COALESCE(?, git_origin) WHERE id = ?`,
      ).run(origin, id);
    }
    // If a slug update is needed (collision auto-suffix), make sure the local row matches.
    db.prepare(`UPDATE repos SET slug = ? WHERE id = ?`).run(slug, id);

    db.prepare(
      `INSERT INTO repo_paths (repo_id, machine_id, abs_path, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, machine_id) DO UPDATE SET
         abs_path = excluded.abs_path,
         last_seen_at = excluded.last_seen_at`,
    ).run(id, machineId, absPath, now, now);
  });
  tx();

  // Mirror to vault registry.
  await writeVaultRegistry();

  return { id, slug, abs_path: absPath, machine_id: machineId, git_origin: origin };
}

export function registerCodeRepoRegister(server: McpServer): void {
  server.tool(
    'code_repo_register',
    'Register a local git checkout under a stable repo identity (first-commit SHA[0:16]). Mirrors the registry to ${BRAIN_VAULT}/Ops/code-repos.json so other machines can pick up the slug ↔ id mapping.',
    {
      path: z.string().describe('Absolute path to the local checkout'),
      slug: z.string().optional().describe('Slug to register under; defaults to basename of path'),
    },
    wrapToolHandler('code_repo_register', async (params) => {
      const inPath = params.path as string;
      const inSlug = params.slug as string | undefined;
      const result = await registerRepoCore(inPath, inSlug);
      return {
        _detail: `${result.slug} → ${result.id} on ${result.machine_id}`,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }),
  );
}

// ────────────────────────────── code_repo_list ──────────────────────────────

export function registerCodeRepoList(server: McpServer): void {
  server.tool(
    'code_repo_list',
    'List all known repos. Returns `{machineId, repos[]}` where each repo includes `paths: [{machine_id, abs_path, registered_at, last_seen_at}]` covering every machine that registered a checkout (so non-server clients can find their own path). Legacy flat fields `abs_path` / `last_seen_at` are preserved for back-compat; they prefer the server\'s machine, falling back to the first known path. When `repos[]` is empty, a top-level `hint` string points at cortexmd.',
    {},
    wrapToolHandler('code_repo_list', async () => {
      const db = getCodeDb();
      const machineId = getMachineId();
      const repoRows = db
        .prepare(
          `SELECT r.id, r.slug, r.git_origin, r.git_origin_id, r.first_commit_sha, r.created_at,
                  (SELECT COUNT(*) FROM symbols s WHERE s.repo_id = r.id) AS symbol_count,
                  (SELECT COUNT(*) FROM files f   WHERE f.repo_id = r.id) AS file_count,
                  (SELECT MAX(indexed_at) FROM files f WHERE f.repo_id = r.id) AS last_indexed_at
           FROM repos r
           ORDER BY r.slug`,
        )
        .all() as Array<{
        id: string;
        slug: string;
        git_origin: string | null;
        git_origin_id: string | null;
        first_commit_sha: string;
        created_at: number;
        symbol_count: number;
        file_count: number;
        last_indexed_at: number | null;
      }>;

      const pathRows = db
        .prepare(
          `SELECT repo_id, machine_id, abs_path, registered_at, last_seen_at
             FROM repo_paths
            ORDER BY repo_id, last_seen_at DESC`,
        )
        .all() as Array<{
        repo_id: string;
        machine_id: string;
        abs_path: string;
        registered_at: number;
        last_seen_at: number;
      }>;

      const pathsByRepo = new Map<string, Array<{
        machine_id: string;
        abs_path: string;
        registered_at: number;
        last_seen_at: number;
      }>>();
      for (const p of pathRows) {
        const arr = pathsByRepo.get(p.repo_id) ?? [];
        arr.push({
          machine_id: p.machine_id,
          abs_path: p.abs_path,
          registered_at: p.registered_at,
          last_seen_at: p.last_seen_at,
        });
        pathsByRepo.set(p.repo_id, arr);
      }

      const repos = repoRows.map((r) => {
        const paths = pathsByRepo.get(r.id) ?? [];
        // Legacy flat fields: prefer the server's machine, else fall back to
        // the first known path so older clients keep working.
        const local = paths.find((p) => p.machine_id === machineId);
        const fallback = paths[0];
        const flatPath = local ?? fallback ?? null;
        return {
          id: r.id,
          slug: r.slug,
          git_origin: r.git_origin,
          git_origin_id: r.git_origin_id,
          first_commit_sha: r.first_commit_sha,
          created_at: r.created_at,
          paths,
          // Back-compat flat fields:
          abs_path: flatPath ? flatPath.abs_path : null,
          last_seen_at: flatPath ? flatPath.last_seen_at : null,
          status: paths.length > 0 ? 'registered' : 'unknown_path',
          symbolCount: r.symbol_count,
          fileCount: r.file_count,
          lastIndexedAt: r.last_indexed_at,
        };
      });

      const payload: { machineId: string; repos: typeof repos; hint?: string } = {
        machineId,
        repos,
      };
      if (repos.length === 0 && !config.noHints) {
        payload.hint =
          'No repos registered yet. Use `cortexmd index <repo-path>` to index a repo (https://github.com/Leicas/cortexmd).';
      }

      return {
        _detail: `${repos.length} repos`,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }),
  );
}

// ────────────────────────────── code_repo_scan ──────────────────────────────

async function scanForGitRepos(rootDir: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ p: string; d: number }> = [{ p: rootDir, d: 0 }];
  while (queue.length > 0) {
    const { p, d } = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      continue;
    }
    // If `.git` is here, this is a repo — record and stop descending.
    const hasGit = entries.some((e) => e.name === '.git');
    if (hasGit) {
      found.push(p);
      continue;
    }
    if (d >= depth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      queue.push({ p: path.join(p, e.name), d: d + 1 });
    }
  }
  return found;
}

export function registerCodeRepoScan(server: McpServer): void {
  server.tool(
    'code_repo_scan',
    'Scan a directory for git repos (BFS, depth-limited). Auto-registers each one; logs and continues on individual failures.',
    {
      rootDir: z.string().describe('Absolute root directory to scan'),
      depth: z.number().int().min(1).max(6).optional().default(2),
    },
    wrapToolHandler('code_repo_scan', async (params) => {
      const rootDir = path.resolve(params.rootDir as string);
      const depth = (params.depth as number | undefined) ?? 2;
      const discovered = await scanForGitRepos(rootDir, depth);
      const registered: any[] = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      for (const p of discovered) {
        try {
          const r = await registerRepoCore(p, undefined);
          registered.push(r);
        } catch (err) {
          skipped.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        _detail: `scan ${rootDir} → ${registered.length}/${discovered.length} registered`,
        content: [{ type: 'text', text: JSON.stringify({ discovered: discovered.length, registered, skipped }) }],
      };
    }),
  );
}

// ────────────────────────────── code_repo_rename ────────────────────────────

export function registerCodeRepoRename(server: McpServer): void {
  server.tool(
    'code_repo_rename',
    'Rename a repo slug. qualified_name (Class.method) does not embed the slug, so no symbol rewrites are needed.',
    {
      slug: z.string().describe('Current slug'),
      new_slug: z.string().describe('Target slug'),
    },
    wrapToolHandler('code_repo_rename', async (params) => {
      const slug = params.slug as string;
      const newSlug = params.new_slug as string;
      if (!SLUG_RE.test(newSlug)) {
        throw new Error(`Invalid slug "${newSlug}". Allowed: ^[a-z0-9][a-z0-9_-]*$`);
      }
      const db = getCodeDb();
      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown slug: ${slug}`);
      const conflict = db.prepare(`SELECT id FROM repos WHERE slug=?`).get(newSlug) as { id: string } | undefined;
      if (conflict && conflict.id !== repo.id) {
        throw new Error(`Slug already taken: ${newSlug}`);
      }
      db.prepare(`UPDATE repos SET slug=? WHERE id=?`).run(newSlug, repo.id);
      await writeVaultRegistry();
      return {
        _detail: `${slug} → ${newSlug}`,
        content: [{ type: 'text', text: JSON.stringify({ id: repo.id, slug: newSlug }) }],
      };
    }),
  );
}

// ────────────────────────────── code_repo_drop ──────────────────────────────

export function registerCodeRepoDrop(server: McpServer): void {
  server.tool(
    'code_repo_drop',
    'Delete a repo from the DB (cascades). With purge_projections:true, also removes Code/{slug}/** notes that haven\'t been manually edited.',
    {
      slug: z.string(),
      purge_projections: z.boolean().optional().default(false),
    },
    wrapToolHandler('code_repo_drop', async (params) => {
      const slug = params.slug as string;
      const purge = (params.purge_projections as boolean | undefined) ?? false;

      const db = getCodeDb();
      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown slug: ${slug}`);

      let purged = 0;
      let kept = 0;
      if (purge) {
        const baseRel = `Code/${slug}`;
        try {
          const files = await listFiles(baseRel, '**/*.md');
          for (const rel of files) {
            try {
              const { content } = await readNote(rel);
              const { data } = parseFrontmatter(content);
              const projectedAt = typeof data.projected_at === 'string'
                ? Date.parse(data.projected_at)
                : NaN;
              const stat = await fs.stat(rel).catch(() => null);
              const mtimeMs = stat ? stat.mtimeMs : 0;
              if (!isNaN(projectedAt) && mtimeMs > projectedAt + 60_000) {
                kept++;
                logger.warn('code_repo_drop: keeping manually-edited projection', { path: rel });
                continue;
              }
              await deleteNote(rel);
              purged++;
            } catch (err) {
              logger.warn('code_repo_drop: failed to purge file', {
                path: rel,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch {
          // listFiles may fail if the directory does not exist — ignore.
        }
      }

      db.prepare(`DELETE FROM repos WHERE id=?`).run(repo.id);
      await writeVaultRegistry();

      return {
        _detail: `dropped ${slug}${purge ? ` (purged ${purged}, kept ${kept})` : ''}`,
        content: [{ type: 'text', text: JSON.stringify({ slug, purged, kept }) }],
      };
    }),
  );
}

// ────────────────────────────── code_index_repo ─────────────────────────────

export function registerCodeIndexRepo(server: McpServer): void {
  server.tool(
    'code_index_repo',
    'Refresh the code index for a registered repo (live re-index). Cheap and content-hash incremental — re-parses only files whose contents changed (pass force=true to re-parse all). Call this to bring the index up to date when results look stale instead of reading source files by hand.',
    {
      repo: z.string().describe('Repo slug (must be registered via code_repo_register)'),
      force: z.boolean().optional().default(false).describe('Re-parse all files even if unchanged'),
    },
    wrapToolHandler('code_index_repo', async (params) => {
      const slug = params.repo as string;
      const force = (params.force as boolean | undefined) ?? false;
      const repo = resolveRepoFull(slug);

      if (indexLocks.has(repo.id)) {
        throw new Error(`Index already running for repo "${slug}"`);
      }
      indexLocks.add(repo.id);
      try {
        const db = getCodeDb();
        const relPaths = await walkRepo(repo);

        const seen = new Set<string>();
        let added = 0;
        let updated = 0;

        const getFile = db.prepare(
          `SELECT content_hash FROM files WHERE repo_id=? AND relative_path=?`,
        );

        for (const relPath of relPaths) {
          seen.add(relPath);
          const lang = languageForPath(relPath);
          if (!lang) continue;

          const abs = path.join(repo.absolutePath, relPath);
          let raw: string;
          let sizeBytes: number;
          try {
            const buf = await fs.readFile(abs);
            sizeBytes = buf.byteLength;
            raw = buf.toString('utf-8');
          } catch {
            continue;
          }

          const normalized = normalizeNewlines(raw);
          const hash = sha1Hex(normalized);

          const existing = getFile.get(repo.id, relPath) as { content_hash: string } | undefined;
          const hadFile = !!existing;
          const unchanged = existing && existing.content_hash === hash && !force;

          if (unchanged) continue;

          let result: ParseResult;
          try {
            result = await parseFile(repo.id, relPath, lang, normalized);
          } catch (err) {
            continue; // unparseable — skip
          }

          const tx = db.transaction(() => {
            applyParseResultToRepo(
              db,
              repo.id,
              {
                relativePath: relPath,
                language: lang,
                contentHash: hash,
                sizeBytes,
              },
              result,
            );
          });
          tx();

          if (hadFile) updated++;
          else added++;
        }

        // Prune files that disappeared
        const pathsRow = db
          .prepare(`SELECT relative_path FROM files WHERE repo_id=?`)
          .all(repo.id) as { relative_path: string }[];
        const stale = pathsRow.filter((r) => !seen.has(r.relative_path));
        const removed = stale.length;
        const deleteFile = db.prepare(`DELETE FROM files WHERE repo_id=? AND relative_path=?`);
        const deleteSymbolsForFileStmt = db.prepare(
          `DELETE FROM symbols WHERE repo_id=? AND relative_path=?`,
        );
        const pruneTx = db.transaction(() => {
          for (const r of stale) {
            deleteSymbolsForFileStmt.run(repo.id, r.relative_path);
            deleteFile.run(repo.id, r.relative_path);
          }
        });
        pruneTx();

        // ── Workspace resolution: build pkgName → repo_id map for this repo ──
        await updateImportResolution(repo.id, repo.absolutePath);

        // ── Resolve call edges using cross-repo SQL ──
        resolveCallEdges();

        const total =
          (db.prepare(`SELECT COUNT(*) as c FROM files WHERE repo_id=?`).get(repo.id) as {
            c: number;
          }).c;

        return {
          _detail: `repo=${slug} +${added} ~${updated} -${removed} (total ${total})`,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ repo: slug, added, updated, removed, total }),
            },
          ],
        };
      } finally {
        indexLocks.delete(repo.id);
      }
    }),
  );
}

// ────────────────────────────── code_ingest_repo ────────────────────────────

const SymbolKind = z.enum([
  'function', 'class', 'method', 'interface', 'type',
  'const-export', 'struct', 'enum', 'trait', 'impl', 'union',
]);
const Language = z.enum(['typescript', 'tsx', 'javascript', 'python', 'rust', 'go', 'cpp']);

const SymbolPayloadSchema = z.object({
  id: z.string().regex(SYMBOL_ID_RE),
  name: z.string().min(1),
  kind: SymbolKind,
  qualified_name: z.string(),
  signature: z.string().nullable(),
  docstring: z.string().nullable(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  parent_id: z.string().regex(SYMBOL_ID_RE).nullable(),
  content_hash: z.string().min(1),
  // 64-bit body SimHash, lowercase 16-char hex. Optional for back-compat
  // with older clients that don't compute it.
  body_simhash: z.string().regex(/^[0-9a-f]{16}$/).nullable().optional(),
});
const CallPayloadSchema = z.object({
  caller_id: z.string().regex(SYMBOL_ID_RE),
  callee_name: z.string().min(1),
  call_line: z.number().int().positive(),
});
const ImportPayloadSchema = z.object({
  imported_name: z.string().min(1),
  source_module: z.string().min(1),
});
const FilePayloadSchema = z.object({
  relative_path: z.string().min(1),
  language: Language,
  content_hash: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  symbols: z.array(SymbolPayloadSchema).max(5000),
  calls: z.array(CallPayloadSchema).max(20000),
  imports: z.array(ImportPayloadSchema).max(2000),
});

const REPO_ID_RE = /^[0-9a-f]{16}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const ABS_PATH_MAX = 1024;

export function registerCodeIngestRepo(server: McpServer): void {
  server.tool(
    'code_ingest_repo',
    'Accept a pre-parsed symbol/call/import payload from a client-side indexer and store it in the server\'s per-machine code DB. Use this when the server cannot reach the source tree (e.g. Docker MCP without the dev tree mounted). The local fs alternative is `code_index_repo`.',
    {
      repo_id: z.string().regex(REPO_ID_RE),
      slug: z.string().regex(SLUG_RE),
      git_origin: z.string().nullable(),
      first_commit_sha: z.string().regex(SHA40_RE),
      machine_id: z.string().min(1),
      abs_path: z.string().min(1).max(ABS_PATH_MAX).refine((s) => !s.includes('\x00'), {
        message: 'abs_path must not contain NUL bytes',
      }),
      package_workspaces: z.object({
        name: z.string().optional(),
        workspaces: z.array(z.string()).optional(),
        workspace_packages: z.array(z.object({
          name: z.string(),
          relative_path: z.string(),
        })).optional(),
      }).optional(),
      files: z.array(FilePayloadSchema).max(10000),
      full_replace: z.boolean().optional().default(true),
    },
    wrapToolHandler('code_ingest_repo', async (params) => {
      const repoId = params.repo_id as string;
      const slug = params.slug as string;
      const gitOriginVal = params.git_origin as string | null;
      const firstCommit = params.first_commit_sha as string;
      const machineId = params.machine_id as string;
      const absPath = params.abs_path as string;
      const pkgWs = params.package_workspaces as
        | {
            name?: string;
            workspaces?: string[];
            workspace_packages?: Array<{ name: string; relative_path: string }>;
          }
        | undefined;
      const files = params.files as Array<z.infer<typeof FilePayloadSchema>>;
      const fullReplace = (params.full_replace as boolean | undefined) ?? true;

      if (fullReplace && files.length === 0) {
        throw new Error('Refusing to apply full_replace=true with files.length===0 (would delete every file).');
      }

      // The Rust client now derives repo_id from sha1(git_origin)[:16] when an
      // origin exists, falling back to first_commit_sha[:16] when there is no
      // remote. Both forms are accepted: server treats the supplied repo_id as
      // authoritative and only sanity-checks that it matches one of the two.
      const firstSha16 = firstCommit.slice(0, 16);
      const originId = computeGitOriginId(gitOriginVal);
      if (repoId !== firstSha16 && repoId !== originId) {
        throw new Error(
          `repo_id "${repoId}" does not match first_commit_sha[0:16] "${firstSha16}"` +
            (originId ? ` or sha1(git_origin)[0:16] "${originId}"` : ' (and no git_origin was supplied)'),
        );
      }

      if (indexLocks.has(repoId)) {
        throw new Error(`Index already running for repo_id "${repoId}"`);
      }
      indexLocks.add(repoId);
      try {
        const db = getCodeDb();
        const now = Date.now();
        const pkgName = pkgWs?.name ?? null;

        // Pre-flight: path conflict on (machineId, absPath) belonging to a different repo_id.
        // Reconciliation: if the same checkout reappears under a different repo_id (typical
        // when the identity scheme upgrades from first_commit_sha[:16] to sha1(git_origin)[:16]
        // for fork-awareness), rebind the path to the incoming id rather than rejecting the
        // ingest. The old repo row is left in place — orphaned repo rows with no paths are
        // harmless and easy to drop later via `code_repo_drop`. We only rebind the (machine,
        // abs_path) tuple; other machines' checkouts of the old repo_id are untouched.
        const existingPath = db
          .prepare(`SELECT repo_id FROM repo_paths WHERE machine_id=? AND abs_path=?`)
          .get(machineId, absPath) as { repo_id: string } | undefined;
        if (existingPath && existingPath.repo_id !== repoId) {
          logger.warn('code_ingest_repo: rebinding path under new repo_id', {
            absPath,
            machineId,
            previousRepoId: existingPath.repo_id,
            incomingRepoId: repoId,
          });
          db.prepare(
            `DELETE FROM repo_paths WHERE machine_id=? AND abs_path=? AND repo_id=?`,
          ).run(machineId, absPath, existingPath.repo_id);
        }

        // 1. Upsert repo. The client now controls `repo_id` (typically derived
        //    from sha1(git_origin) for fork-aware identity). Treat the payload
        //    as authoritative: keyed on `id`, insert if missing, otherwise
        //    update the mutable fields. Also compute & store git_origin_id so
        //    forks with the same first_commit_sha but different origins remain
        //    distinct rows.
        const gitOriginId = computeGitOriginId(gitOriginVal);
        const repoTx = db.transaction(() => {
          db.prepare(
            `INSERT INTO repos (id, slug, git_origin, first_commit_sha, created_at, package_name, git_origin_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               slug = excluded.slug,
               git_origin = COALESCE(excluded.git_origin, repos.git_origin),
               first_commit_sha = excluded.first_commit_sha,
               package_name = excluded.package_name,
               git_origin_id = COALESCE(excluded.git_origin_id, repos.git_origin_id)`,
          ).run(repoId, slug, gitOriginVal, firstCommit, now, pkgName, gitOriginId);
          db.prepare(
            `INSERT INTO repo_paths (repo_id, machine_id, abs_path, registered_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, machine_id) DO UPDATE SET
               abs_path = excluded.abs_path,
               last_seen_at = excluded.last_seen_at`,
          ).run(repoId, machineId, absPath, now, now);
        });
        repoTx();

        // 2. Apply each file via the shared helper, in a single transaction.
        const getFile = db.prepare(
          `SELECT content_hash FROM files WHERE repo_id=? AND relative_path=?`,
        );
        let added = 0;
        let updated = 0;
        let unchanged = 0;

        const seen = new Set<string>();

        // Per-file content-hash skip: when the incoming file's content_hash matches
        // what's already in `files`, the symbol/call/import rows are guaranteed to be
        // current (the hash is computed over normalized source). Skipping the
        // delete-and-reinsert keeps warm runs near-zero on repos that haven't changed.
        const touchFileSeenAt = db.prepare(
          `UPDATE files SET indexed_at=? WHERE repo_id=? AND relative_path=?`,
        );

        const filesTx = db.transaction(() => {
          for (const f of files) {
            seen.add(f.relative_path);
            const existing = getFile.get(repoId, f.relative_path) as
              | { content_hash: string }
              | undefined;
            const hadFile = !!existing;

            if (existing && existing.content_hash === f.content_hash) {
              touchFileSeenAt.run(now, repoId, f.relative_path);
              unchanged++;
              continue;
            }

            applyParseResultToRepo(
              db,
              repoId,
              {
                relativePath: f.relative_path,
                language: f.language,
                contentHash: f.content_hash,
                sizeBytes: f.size_bytes,
              },
              {
                symbols: f.symbols.map((s) => ({
                  id: s.id,
                  name: s.name,
                  kind: s.kind,
                  qualifiedName: s.qualified_name,
                  signature: s.signature,
                  docstring: s.docstring,
                  startLine: s.start_line,
                  endLine: s.end_line,
                  parentId: s.parent_id,
                  contentHash: s.content_hash,
                  bodySimhash: s.body_simhash ?? null,
                })),
                calls: f.calls.map((c) => ({
                  callerId: c.caller_id,
                  calleeName: c.callee_name,
                  callLine: c.call_line,
                })),
                imports: f.imports.map((i) => ({
                  importedName: i.imported_name,
                  sourceModule: i.source_module,
                })),
              },
            );

            if (hadFile) updated++;
            else added++;
          }
        });
        filesTx();

        // 3. Optional full-replace prune.
        let removed = 0;
        if (fullReplace) {
          const pathsRow = db
            .prepare(`SELECT relative_path FROM files WHERE repo_id=?`)
            .all(repoId) as { relative_path: string }[];
          const stale = pathsRow.filter((r) => !seen.has(r.relative_path));
          removed = stale.length;
          const deleteFile = db.prepare(`DELETE FROM files WHERE repo_id=? AND relative_path=?`);
          const deleteSymbolsForFileStmt = db.prepare(
            `DELETE FROM symbols WHERE repo_id=? AND relative_path=?`,
          );
          const pruneTx = db.transaction(() => {
            for (const r of stale) {
              deleteSymbolsForFileStmt.run(repoId, r.relative_path);
              deleteFile.run(repoId, r.relative_path);
            }
          });
          pruneTx();
        }

        // 4. Cross-repo workspace resolution from payload (no fs).
        const workspacePackages = pkgWs?.workspace_packages ?? [];
        updateImportResolutionFromPayload(repoId, workspacePackages);

        // 5. Resolve call edges. Skip when no per-file delta touched the calls
        //    table — calls.callee_id values are stable as long as no symbols
        //    were added, updated, or removed.
        const filesChanged = added + updated + removed;
        if (filesChanged > 0) {
          resolveCallEdges();
        }

        // 6. Mirror to vault registry.
        await writeVaultRegistry();

        const total = (db
          .prepare(`SELECT COUNT(*) as c FROM files WHERE repo_id=?`)
          .get(repoId) as { c: number }).c;

        const callsResolvedAfter = (db
          .prepare(`SELECT COUNT(*) as c FROM calls WHERE callee_id IS NOT NULL`)
          .get() as { c: number }).c;

        return {
          _detail: `ingest repo=${slug} +${added} ~${updated} =${unchanged} -${removed} (total ${total})`,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                repo: slug,
                repo_id: repoId,
                added,
                updated,
                unchanged,
                removed,
                total,
                callsResolvedAfter,
              }),
            },
          ],
        };
      } finally {
        indexLocks.delete(repoId);
      }
    }),
  );
}

// ────────────────────────────── code_sync_pull ──────────────────────────────

export function registerCodeSyncPull(server: McpServer): void {
  server.tool(
    'code_sync_pull',
    'Return a snapshot of a registered repo (files + symbols + calls + imports) in the same shape `code_ingest_repo` accepts, so a client can round-trip the data into its own local code DB. Optional `since_indexed_at` filter returns only files re-indexed at or after the given epoch-ms; when omitted, returns the whole repo. Used by client-side indexers to mirror what the server has so other clients\' work is reflected locally.',
    {
      slug: z.string().regex(SLUG_RE).optional(),
      repo_id: z.string().regex(REPO_ID_RE).optional(),
      since_indexed_at: z.number().int().nonnegative().optional(),
    },
    wrapToolHandler('code_sync_pull', async (params) => {
      const slug = params.slug as string | undefined;
      const repoId = params.repo_id as string | undefined;
      const sinceMs = params.since_indexed_at as number | undefined;
      if (!slug && !repoId) {
        throw new Error('code_sync_pull: provide `slug` or `repo_id`');
      }

      const db = getCodeDb();
      const repoRow = (slug ? resolveRepoBySlug(slug) : resolveRepoById(repoId!)) as
        | (RepoRowFull)
        | null;
      if (!repoRow) {
        throw new Error(`Unknown code repo "${slug ?? repoId}"`);
      }

      const since = sinceMs ?? 0;
      const fileRows = db
        .prepare(
          `SELECT relative_path, content_hash, language, size_bytes, indexed_at
           FROM files
           WHERE repo_id = ? AND indexed_at >= ?
           ORDER BY relative_path`,
        )
        .all(repoRow.id, since) as Array<{
        relative_path: string;
        content_hash: string;
        language: string;
        size_bytes: number;
        indexed_at: number;
      }>;

      const symStmt = db.prepare(
        `SELECT id, name, kind, qualified_name, signature, docstring,
                start_line, end_line, parent_id, content_hash
         FROM symbols
         WHERE repo_id = ? AND relative_path = ?
         ORDER BY start_line`,
      );
      const callStmt = db.prepare(
        `SELECT c.caller_id, c.callee_name, c.call_line
         FROM calls c
         JOIN symbols s ON s.id = c.caller_id
         WHERE s.repo_id = ? AND s.relative_path = ?
         ORDER BY c.call_line`,
      );
      const importStmt = db.prepare(
        `SELECT imported_name, source_module
         FROM file_imports
         WHERE repo_id = ? AND relative_path = ?
         ORDER BY imported_name`,
      );

      const files = fileRows.map((f) => ({
        relative_path: f.relative_path,
        language: f.language,
        content_hash: f.content_hash,
        size_bytes: f.size_bytes,
        indexed_at: f.indexed_at,
        symbols: symStmt.all(repoRow.id, f.relative_path),
        calls: callStmt.all(repoRow.id, f.relative_path),
        imports: importStmt.all(repoRow.id, f.relative_path),
      }));

      const totalRow = db
        .prepare(`SELECT COUNT(*) AS c, MAX(indexed_at) AS m FROM files WHERE repo_id = ?`)
        .get(repoRow.id) as { c: number; m: number | null };

      const payload = {
        repo_id: repoRow.id,
        slug: repoRow.slug,
        git_origin: repoRow.git_origin,
        first_commit_sha: repoRow.first_commit_sha,
        package_name: repoRow.package_name ?? null,
        files,
        meta: {
          server_machine_id: getMachineId(),
          since_indexed_at: since,
          files_total: totalRow.c,
          files_returned: files.length,
          repo_last_indexed_at: totalRow.m,
        },
      };

      return {
        _detail: `pull repo=${repoRow.slug} files=${files.length}/${totalRow.c} since=${since}`,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }),
  );
}

interface RepoRowFull {
  id: string;
  slug: string;
  git_origin: string | null;
  first_commit_sha: string;
  created_at: number;
  package_name?: string | null;
  git_origin_id?: string | null;
}

// ────────────────────────────── code_savings_push ────────────────────────────

export function registerCodeSavingsPush(server: McpServer): void {
  server.tool(
    'code_savings_push',
    'Accept token-savings deltas from a client-side indexer that served code-nav lookups against its local DB. Each entry merges into the server\'s aggregate counters (per-tool + per-repo) so the dashboard and `code_nav_stats` reflect the full multi-machine picture, not just server-served calls. Sent periodically by `cortexmd` (slice-4 sync).',
    {
      entries: z
        .array(
          z.object({
            tool_name: z.string().min(1).max(64),
            calls: z.number().int().nonnegative(),
            tokens_saved: z.number().int().nonnegative(),
            repo_slug: z.string().regex(SLUG_RE).optional(),
          }),
        )
        .max(64),
      machine_id: z.string().min(1).optional(),
    },
    wrapToolHandler('code_savings_push', async (params) => {
      const entries = params.entries as Array<{
        tool_name: string;
        calls: number;
        tokens_saved: number;
        repo_slug?: string;
      }>;
      const machineId = (params.machine_id as string | undefined) ?? null;

      let merged = 0;
      let totalCalls = 0;
      let totalTokensSaved = 0;
      for (const e of entries) {
        recordExternalCodeNavSavings(
          e.tool_name,
          e.calls,
          e.tokens_saved,
          e.repo_slug ?? null,
        );
        merged++;
        totalCalls += e.calls;
        totalTokensSaved += e.tokens_saved;
      }

      return {
        _detail: `savings push: ${merged} entries, +${totalCalls} calls, +${totalTokensSaved} tokens (machine=${machineId ?? 'unknown'})`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              merged_entries: merged,
              calls_added: totalCalls,
              tokens_saved_added: totalTokensSaved,
              machine_id: machineId,
            }),
          },
        ],
      };
    }),
  );
}

// ────────────────────────────── code_repos_sync ──────────────────────────────

export function registerCodeReposSync(server: McpServer): void {
  server.tool(
    'code_repos_sync',
    'Return the full repo registry from the server\'s code DB so a client can mirror it locally before doing a per-repo `code_sync_pull`. Mirrors what `code_repo_list` exposes for human use, but in the exact upsert shape the indexer\'s `repos` table needs: `{id, slug, git_origin, first_commit_sha, package_name, git_origin_id, created_at}`. No path or stats — keep separate from the per-repo snapshot endpoint.',
    {},
    wrapToolHandler('code_repos_sync', async () => {
      const db = getCodeDb();
      const rows = db
        .prepare(
          `SELECT id, slug, git_origin, first_commit_sha, package_name, git_origin_id, created_at
           FROM repos ORDER BY slug`,
        )
        .all() as Array<{
        id: string;
        slug: string;
        git_origin: string | null;
        first_commit_sha: string;
        package_name: string | null;
        git_origin_id: string | null;
        created_at: number;
      }>;

      return {
        _detail: `repos_sync: ${rows.length}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              repos: rows,
              server_machine_id: getMachineId(),
              total: rows.length,
            }),
          },
        ],
      };
    }),
  );
}

/**
 * Build a pkgName → repo_id map by reading this repo's package.json workspaces
 * and matching workspace package.json `name` fields against registered repos
 * (via repo_paths on this machine). Update file_imports.resolved_repo for
 * each bare-name (non-relative) import in this repo.
 */
async function updateImportResolution(repoId: string, repoAbs: string): Promise<void> {
  const db = getCodeDb();
  const pkgPath = path.join(repoAbs, 'package.json');
  let pkg: any = null;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
  } catch {
    // No package.json — only this repo's own bare imports can resolve to itself; skip.
    return;
  }

  const workspaces: string[] = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];

  if (workspaces.length === 0) return;

  // Resolve workspace globs → workspace abs paths.
  const workspaceDirs: string[] = [];
  for (const w of workspaces) {
    try {
      const matches = await glob(w, { cwd: repoAbs, posix: true });
      for (const m of matches) {
        const abs = path.resolve(repoAbs, m);
        if (existsSync(path.join(abs, 'package.json'))) workspaceDirs.push(abs);
      }
    } catch {
      /* skip bad glob */
    }
  }

  // Build pkgName → repo_id map.
  const machineId = getMachineId();
  const pkgNameToRepoId = new Map<string, string>();
  for (const dir of workspaceDirs) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
      if (typeof p.name !== 'string') continue;
      const row = db
        .prepare(
          `SELECT rp.repo_id FROM repo_paths rp WHERE rp.machine_id=? AND rp.abs_path=?`,
        )
        .get(machineId, dir) as { repo_id: string } | undefined;
      if (row) {
        pkgNameToRepoId.set(p.name, row.repo_id);
      }
    } catch {
      /* skip */
    }
  }

  if (pkgNameToRepoId.size === 0) return;

  // Update file_imports.resolved_repo for non-relative imports whose
  // source_module starts with a known package name.
  const imports = db
    .prepare(
      `SELECT relative_path, imported_name, source_module
       FROM file_imports WHERE repo_id=?`,
    )
    .all(repoId) as Array<{ relative_path: string; imported_name: string; source_module: string }>;

  const updateStmt = db.prepare(
    `UPDATE file_imports SET resolved_repo=? WHERE repo_id=? AND relative_path=? AND imported_name=?`,
  );

  const tx = db.transaction(() => {
    for (const imp of imports) {
      if (imp.source_module.startsWith('.') || imp.source_module.startsWith('/')) continue;
      // Match against known package names (longest prefix wins).
      let bestMatch: { name: string; repoId: string } | null = null;
      for (const [name, rid] of pkgNameToRepoId) {
        if (imp.source_module === name || imp.source_module.startsWith(`${name}/`)) {
          if (!bestMatch || name.length > bestMatch.name.length) {
            bestMatch = { name, repoId: rid };
          }
        }
      }
      if (bestMatch) {
        updateStmt.run(bestMatch.repoId, repoId, imp.relative_path, imp.imported_name);
      }
    }
  });
  tx();
}

/**
 * Payload-driven workspace resolution for `code_ingest_repo`.
 *
 * Builds pkgName→repo_id map by joining the payload's workspace_packages
 * against `repos.package_name`. The calling repo is included if it has a
 * package_name. Updates `file_imports.resolved_repo` for non-relative
 * imports whose source_module matches a known package (longest prefix wins).
 *
 * No filesystem access — server never reads source.
 */
function updateImportResolutionFromPayload(
  repoId: string,
  workspacePackages: Array<{ name: string; relative_path: string }>,
): void {
  const db = getCodeDb();

  // Build pkgName → repo_id map by looking up each workspace package name in the
  // repos table by package_name. Always include the calling repo if it has one.
  const pkgNameToRepoId = new Map<string, string>();
  const lookupByPkgName = db.prepare(`SELECT id FROM repos WHERE package_name=?`);

  // Self-include: the calling repo's own package_name resolves to itself.
  const selfRow = db
    .prepare(`SELECT package_name FROM repos WHERE id=?`)
    .get(repoId) as { package_name: string | null } | undefined;
  if (selfRow?.package_name) {
    pkgNameToRepoId.set(selfRow.package_name, repoId);
  }

  for (const wp of workspacePackages) {
    if (!wp.name) continue;
    const row = lookupByPkgName.get(wp.name) as { id: string } | undefined;
    if (row) {
      pkgNameToRepoId.set(wp.name, row.id);
    }
  }

  if (pkgNameToRepoId.size === 0) return;

  const imports = db
    .prepare(
      `SELECT relative_path, imported_name, source_module
       FROM file_imports WHERE repo_id=?`,
    )
    .all(repoId) as Array<{ relative_path: string; imported_name: string; source_module: string }>;

  const updateStmt = db.prepare(
    `UPDATE file_imports SET resolved_repo=? WHERE repo_id=? AND relative_path=? AND imported_name=?`,
  );

  const tx = db.transaction(() => {
    for (const imp of imports) {
      if (imp.source_module.startsWith('.') || imp.source_module.startsWith('/')) continue;
      let bestMatch: { name: string; repoId: string } | null = null;
      for (const [name, rid] of pkgNameToRepoId) {
        if (imp.source_module === name || imp.source_module.startsWith(`${name}/`)) {
          if (!bestMatch || name.length > bestMatch.name.length) {
            bestMatch = { name, repoId: rid };
          }
        }
      }
      if (bestMatch) {
        updateStmt.run(bestMatch.repoId, repoId, imp.relative_path, imp.imported_name);
      }
    }
  });
  tx();
}

/**
 * Re-resolve unresolved call edges using cross-repo logic.
 * Allowed callee repos = caller's repo + any repo referenced via file_imports
 * that match the callee_name as imported_name.
 */
function resolveCallEdges(): void {
  const db = getCodeDb();
  const unresolvedRows = db
    .prepare(`SELECT rowid as rid, caller_id, callee_name FROM calls WHERE callee_id IS NULL`)
    .all() as { rid: number; caller_id: string; callee_name: string }[];

  const resolveStmt = db.prepare(`
    WITH caller_file AS (SELECT s.repo_id, s.relative_path FROM symbols s WHERE s.id=?),
    allowed_repos AS (
      SELECT cf.repo_id AS repo_id FROM caller_file cf
      UNION
      SELECT fi.resolved_repo AS repo_id
        FROM file_imports fi, caller_file cf
        WHERE fi.repo_id = cf.repo_id
          AND fi.relative_path = cf.relative_path
          AND fi.imported_name = ?
          AND fi.resolved_repo IS NOT NULL
    )
    SELECT s.id FROM symbols s
    WHERE s.name = ? AND s.repo_id IN (SELECT repo_id FROM allowed_repos)
    LIMIT 2
  `);
  const updateCalleeId = db.prepare(`UPDATE calls SET callee_id=? WHERE rowid=?`);

  const tx = db.transaction(() => {
    for (const row of unresolvedRows) {
      const matches = resolveStmt.all(row.caller_id, row.callee_name, row.callee_name) as {
        id: string;
      }[];
      if (matches.length === 1) {
        updateCalleeId.run(matches[0].id, row.rid);
      }
    }
  });
  tx();
}

// ──────────────────────────── code_symbol_search ────────────────────────────

export function registerCodeSymbolSearch(server: McpServer): void {
  server.tool(
    'code_symbol_search',
    'Search code symbols (functions, classes, methods, interfaces, types, exported consts) by name/signature/docstring. Optionally filter by kind and repo slug. Returns `{results[]}`; when `results[]` is empty, also includes a top-level `hint` string pointing at cortexmd for un-indexed repos.',
    {
      query: z.string().describe('FTS query (matched against name, signature, docstring)'),
      kind: z
        .enum(['function', 'class', 'method', 'interface', 'type', 'const-export', 'struct', 'enum', 'trait', 'impl'])
        .optional(),
      repo: z.string().optional().describe('Repo slug filter'),
      limit: z.number().int().positive().max(100).optional().default(20),
    },
    wrapToolHandler('code_symbol_search', async (params) => {
      const rawQuery = params.query as string;
      const kind = params.kind as string | undefined;
      const repoSlug = params.repo as string | undefined;
      const limit = (params.limit as number | undefined) ?? 20;

      const db = getCodeDb();
      const escaped = rawQuery.replace(/"/g, '""').trim();
      const ftsQuery = escaped.length > 0 ? `"${escaped}"*` : '""';

      const filters: string[] = [];
      const args: any[] = [ftsQuery];
      if (kind) {
        filters.push('s.kind = ?');
        args.push(kind);
      }
      if (repoSlug) {
        const repo = resolveRepoBySlug(repoSlug);
        if (!repo) throw new Error(`Unknown repo slug: ${repoSlug}`);
        filters.push('s.repo_id = ?');
        args.push(repo.id);
      }
      const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

      const sql = `
        SELECT s.id, s.repo_id, s.relative_path, s.name, s.kind, s.qualified_name,
               s.signature, s.start_line, s.end_line, bm25(symbols_fts) AS bm,
               r.slug AS repo_slug
        FROM symbols_fts
        JOIN symbols s ON s.rowid = symbols_fts.rowid
        JOIN repos r ON r.id = s.repo_id
        WHERE symbols_fts MATCH ? ${where}
        ORDER BY bm ASC
        LIMIT ?
      `;
      args.push(limit);

      let rows: any[];
      try {
        rows = db.prepare(sql).all(...args) as any[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`FTS query failed: ${msg}`);
      }

      const results = rows.map((r) => ({
        id: r.id,
        repo: r.repo_slug,
        path: r.relative_path,
        name: r.name,
        kind: r.kind,
        qualifiedName: r.qualified_name,
        signature: r.signature,
        startLine: r.start_line,
        endLine: r.end_line,
        score: -(r.bm as number),
      }));

      const payload: { results: typeof results; hint?: string } = { results };
      if (results.length === 0 && !config.noHints) {
        const repoLabel = repoSlug ? `repo ${repoSlug}` : 'any registered repo';
        payload.hint =
          `No results for query "${rawQuery}" in ${repoLabel}. ` +
          'If the repo lives on this machine but hasn\'t been indexed yet, ' +
          'run `cortexmd index <repo-path>` to populate the index. ' +
          'See https://github.com/Leicas/cortexmd for installation.';
      }

      return {
        _detail: `q="${rawQuery}" → ${results.length} symbols`,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }),
  );
}

// ───────────────────────────── code_symbol_get ──────────────────────────────

export function registerCodeSymbolGet(server: McpServer): void {
  server.tool(
    'code_symbol_get',
    'Fetch a single symbol by ID, including its source body (capped to 200 lines).',
    {
      id: z.string().regex(SYMBOL_ID_RE).describe('16-char hex symbol ID'),
    },
    wrapToolHandler('code_symbol_get', async (params) => {
      const id = params.id as string;
      const db = getCodeDb();
      const sym = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as SymbolRow | undefined;
      if (!sym) throw new Error(`Symbol not found: ${id}`);

      const repo = resolveRepoById(sym.repo_id);
      const repoSlug = repo?.slug ?? sym.repo_id;
      const repoAbs = getRepoPathOnMachine(sym.repo_id);

      let body = '';
      let truncated = false;
      if (repoAbs) {
        const abs = path.join(repoAbs, sym.relative_path);
        try {
          const raw = await fs.readFile(abs, 'utf-8');
          const lines = normalizeNewlines(raw).split('\n');
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

      return {
        _detail: `${sym.qualified_name} (${sym.kind})`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: sym.id,
              repo: repoSlug,
              path: sym.relative_path,
              name: sym.name,
              kind: sym.kind,
              qualifiedName: sym.qualified_name,
              signature: sym.signature,
              docstring: sym.docstring,
              startLine: sym.start_line,
              endLine: sym.end_line,
              parentId: sym.parent_id,
              body,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}

// ──────────────────────── code_symbol_callers / callees ────────────────────

interface EdgeNode {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  repo: string;
  path: string;
  startLine: number;
}

function rowToEdgeNode(r: SymbolRow, slugFor: (id: string) => string): EdgeNode {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    qualifiedName: r.qualified_name,
    repo: slugFor(r.repo_id),
    path: r.relative_path,
    startLine: r.start_line,
  };
}

function buildSlugMap(): (id: string) => string {
  const db = getCodeDb();
  const rows = db.prepare(`SELECT id, slug FROM repos`).all() as { id: string; slug: string }[];
  const map = new Map(rows.map((r) => [r.id, r.slug]));
  return (id: string) => map.get(id) ?? id;
}

export function registerCodeSymbolCallers(server: McpServer): void {
  server.tool(
    'code_symbol_callers',
    'Return symbols that call this symbol. BFS, depth-limited (default 1, max 3).',
    {
      id: z.string().regex(SYMBOL_ID_RE),
      depth: z.number().int().min(1).max(3).optional().default(1),
    },
    wrapToolHandler('code_symbol_callers', async (params) => {
      const id = params.id as string;
      const depth = (params.depth as number | undefined) ?? 1;
      const db = getCodeDb();

      const root = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as SymbolRow | undefined;
      if (!root) throw new Error(`Symbol not found: ${id}`);

      const callersStmt = db.prepare(
        `SELECT s.* FROM calls c JOIN symbols s ON s.id=c.caller_id WHERE c.callee_id=?`,
      );

      const slugFor = buildSlugMap();
      const visited = new Set<string>([id]);
      const edges: { from: string; to: string; kind: 'caller' }[] = [];
      const symbolsMap = new Map<string, EdgeNode>();
      symbolsMap.set(root.id, rowToEdgeNode(root, slugFor));

      let frontier: string[] = [id];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const rows = callersStmt.all(cur) as SymbolRow[];
          for (const row of rows) {
            edges.push({ from: row.id, to: cur, kind: 'caller' });
            if (!visited.has(row.id)) {
              visited.add(row.id);
              symbolsMap.set(row.id, rowToEdgeNode(row, slugFor));
              next.push(row.id);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }

      return {
        _detail: `${root.name} ← ${edges.length} caller edges`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              root: rowToEdgeNode(root, slugFor),
              edges,
              symbols: Array.from(symbolsMap.values()),
            }),
          },
        ],
      };
    }),
  );
}

export function registerCodeSymbolCallees(server: McpServer): void {
  server.tool(
    'code_symbol_callees',
    'Return symbols this symbol calls. BFS, depth-limited (default 1, max 3). Unresolved callee names are returned separately.',
    {
      id: z.string().regex(SYMBOL_ID_RE),
      depth: z.number().int().min(1).max(3).optional().default(1),
    },
    wrapToolHandler('code_symbol_callees', async (params) => {
      const id = params.id as string;
      const depth = (params.depth as number | undefined) ?? 1;
      const db = getCodeDb();

      const root = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as SymbolRow | undefined;
      if (!root) throw new Error(`Symbol not found: ${id}`);

      const calleesStmt = db.prepare(
        `SELECT s.* FROM calls c JOIN symbols s ON s.id=c.callee_id
         WHERE c.caller_id=? AND c.callee_id IS NOT NULL`,
      );
      const unresolvedStmt = db.prepare(
        `SELECT DISTINCT callee_name FROM calls WHERE caller_id=? AND callee_id IS NULL`,
      );

      const slugFor = buildSlugMap();
      const visited = new Set<string>([id]);
      const edges: { from: string; to: string; kind: 'callee' }[] = [];
      const symbolsMap = new Map<string, EdgeNode>();
      symbolsMap.set(root.id, rowToEdgeNode(root, slugFor));
      const unresolved = new Set<string>();

      let frontier: string[] = [id];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const rows = calleesStmt.all(cur) as SymbolRow[];
          for (const row of rows) {
            edges.push({ from: cur, to: row.id, kind: 'callee' });
            if (!visited.has(row.id)) {
              visited.add(row.id);
              symbolsMap.set(row.id, rowToEdgeNode(row, slugFor));
              next.push(row.id);
            }
          }
          if (d === 0) {
            const unrows = unresolvedStmt.all(cur) as { callee_name: string }[];
            for (const u of unrows) unresolved.add(u.callee_name);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }

      return {
        _detail: `${root.name} → ${edges.length} callee edges (${unresolved.size} unresolved)`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              root: rowToEdgeNode(root, slugFor),
              edges,
              symbols: Array.from(symbolsMap.values()),
              unresolved: Array.from(unresolved),
            }),
          },
        ],
      };
    }),
  );
}

// ─────────────────────────── code_file_outline ──────────────────────────────

export function registerCodeFileOutline(server: McpServer): void {
  server.tool(
    'code_file_outline',
    'Return all indexed symbols for a file in a registered repo, ordered by start line.',
    {
      repo: z.string(),
      path: z.string(),
    },
    wrapToolHandler('code_file_outline', async (params) => {
      const slug = params.repo as string;
      const filePath = params.path as string;
      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown repo slug: ${slug}`);

      const db = getCodeDb();
      const rows = db
        .prepare(
          `SELECT id, kind, name, qualified_name, signature, start_line, end_line, parent_id
           FROM symbols WHERE repo_id=? AND relative_path=? ORDER BY start_line`,
        )
        .all(repo.id, filePath) as Array<{
        id: string;
        kind: string;
        name: string;
        qualified_name: string;
        signature: string | null;
        start_line: number;
        end_line: number;
        parent_id: string | null;
      }>;

      const symbols = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        qualifiedName: r.qualified_name,
        signature: r.signature,
        startLine: r.start_line,
        endLine: r.end_line,
        parentId: r.parent_id,
      }));

      const payload: { repo: string; path: string; symbols: typeof symbols; hint?: string } = {
        repo: slug, path: filePath, symbols,
      };
      if (symbols.length === 0 && !config.noHints) {
        payload.hint =
          `No indexed symbols for "${filePath}" in ${slug}. The file may have changed ` +
          'since the last index or not be indexed yet — refresh with `cortexmd index ' +
          '<repo-path>` or code_index_repo(repo) (cheap, content-hash incremental) and ' +
          'retry, rather than reading the file by hand.';
      }

      return {
        _detail: `${slug}/${filePath} → ${symbols.length} symbols`,
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
      };
    }),
  );
}

// ───────────────────────────── code_project_symbol ──────────────────────────

export function registerCodeProjectSymbol(server: McpServer): void {
  server.tool(
    'code_project_symbol',
    'Project a symbol into the RW vault as a markdown note under Code/{slug}/. Idempotent on content_hash unless force=true.',
    {
      id: z.string().regex(SYMBOL_ID_RE),
      force: z.boolean().optional().default(false),
    },
    wrapToolHandler('code_project_symbol', async (params) => {
      const id = params.id as string;
      const force = (params.force as boolean | undefined) ?? false;
      const result = await projectSymbolById(id, { force });
      return {
        _detail: result.projected ? `projected ${result.vaultPath}` : `fresh ${result.vaultPath}`,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }),
  );
}

// ──────────────────────────── code_check_staleness ──────────────────────────

const MAX_STALENESS_SCAN = 10000;

export function registerCodeCheckStaleness(server: McpServer): void {
  server.tool(
    'code_check_staleness',
    'Walk notes whose code_refs frontmatter points at known symbols and report which refs have drifted (content_hash mismatch or symbol deleted).',
    {
      memory_path: z.string().optional().describe('Limit to a single note path'),
      since: z.number().optional().describe('Filter to notes modified after this epoch ms'),
    },
    wrapToolHandler('code_check_staleness', async (params) => {
      const memoryPath = params.memory_path as string | undefined;
      const since = params.since as number | undefined;

      const db = getCodeDb();
      const lookup = db.prepare(`SELECT content_hash FROM symbols WHERE id=?`);

      type DriftEntry = {
        path: string;
        ref: string;
        oldHash: string | null;
        newHash: string | null;
      };
      const drifted: DriftEntry[] = [];
      let scanned = 0;

      const candidates: string[] = [];
      if (memoryPath) {
        candidates.push(memoryPath);
      } else {
        try {
          const memList = await listFiles('Memories', '**/*.md');
          for (const c of memList) candidates.push(c);
        } catch { /* ignore */ }
        try {
          const noteList = await listFiles('Notes', '**/*.md');
          for (const c of noteList) candidates.push(c);
        } catch { /* ignore */ }
      }

      let truncated = false;
      for (const p of candidates) {
        if (scanned >= MAX_STALENESS_SCAN) {
          truncated = true;
          break;
        }
        scanned++;
        try {
          if (since) {
            // resolve via fs.stat — listFiles returns paths relative to vault root; readNote handles resolution.
          }
          const { content } = await readNote(p);
          const { data } = parseFrontmatter(content);
          const refs = Array.isArray(data.code_refs) ? data.code_refs : [];
          if (refs.length === 0) continue;
          for (const r of refs) {
            if (!r || typeof r !== 'object') continue;
            const refKey = typeof r.ref === 'string' ? r.ref : '';
            const refId = typeof r.id === 'string' ? r.id : null;
            const refHash = typeof r.hash === 'string' ? r.hash : null;
            if (!refId) {
              drifted.push({ path: p, ref: refKey, oldHash: refHash, newHash: null });
              continue;
            }
            const cur = lookup.get(refId) as { content_hash: string } | undefined;
            if (!cur) {
              drifted.push({ path: p, ref: refKey, oldHash: refHash, newHash: null });
              continue;
            }
            if (cur.content_hash !== refHash) {
              drifted.push({ path: p, ref: refKey, oldHash: refHash, newHash: cur.content_hash });
            }
          }
        } catch {
          continue;
        }
      }

      // Drift is self-healing: the index is content-hash incremental and the
      // CLI hook re-syncs on each tool call. Tell the agent to refresh and
      // re-query rather than fall back to reading whole files by hand.
      const remedy = drifted.length > 0
        ? 'Drift detected — the index is live and cheap to refresh. Re-index with '
          + '`cortexmd index <repo-path>` or code_index_repo(repo) (content-hash '
          + 'incremental, re-parses only changed files), then re-query. Do NOT fall '
          + 'back to reading the source files by hand.'
        : undefined;

      return {
        _detail: `staleness scanned=${scanned} drifted=${drifted.length}${truncated ? ' (truncated)' : ''}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ scanned, drifted, truncated, ...(remedy ? { remedy } : {}) }),
          },
        ],
      };
    }),
  );
}

// ────────────────────────── code_change_impact ─────────────────────────────
//
// Transitive caller graph: "if I change this symbol, who else needs to be
// re-reviewed?" Walks calls.callee_id → calls.caller_id with a SQL recursive
// CTE up to `depth`, capped at `limit` results.

interface ImpactRow {
  id: string;
  repo_id: string;
  relative_path: string;
  name: string;
  kind: string;
  distance: number;
}

export function registerCodeChangeImpact(server: McpServer): void {
  server.tool(
    'code_change_impact',
    'Transitive caller graph for a symbol — "who depends on this if I change it?". Walks calls.callee_id → calls.caller_id via recursive CTE up to `depth` levels, returning each caller with its BFS distance from the root. Use this before refactoring to scope the blast radius.',
    {
      id: z.string().regex(SYMBOL_ID_RE),
      depth: z.number().int().min(1).max(5).optional().default(3),
      limit: z.number().int().positive().max(500).optional().default(100),
    },
    wrapToolHandler('code_change_impact', async (params) => {
      const id = params.id as string;
      const depth = (params.depth as number | undefined) ?? 3;
      const limit = (params.limit as number | undefined) ?? 100;

      const db = getCodeDb();
      const root = db
        .prepare(`SELECT * FROM symbols WHERE id=?`)
        .get(id) as SymbolRow | undefined;
      if (!root) throw new Error(`Symbol not found: ${id}`);

      // Recursive CTE walks callers backward from root. Track minimum distance
      // (BFS depth) so the same caller reached via two paths reports the
      // shorter one. Filter to depth ≤ given input. Cap at limit + 1 so we
      // can detect truncation.
      const sql = `
        WITH RECURSIVE impact(id, distance) AS (
          SELECT c.caller_id AS id, 1 AS distance
            FROM calls c
           WHERE c.callee_id = ?
          UNION
          SELECT c.caller_id AS id, i.distance + 1 AS distance
            FROM calls c
            JOIN impact i ON c.callee_id = i.id
           WHERE i.distance < ?
             AND c.caller_id IS NOT NULL
        )
        SELECT s.id        AS id,
               s.repo_id   AS repo_id,
               s.relative_path AS relative_path,
               s.name      AS name,
               s.kind      AS kind,
               MIN(i.distance) AS distance
          FROM impact i
          JOIN symbols s ON s.id = i.id
         WHERE s.id <> ?
         GROUP BY s.id
         ORDER BY distance ASC, s.name ASC
         LIMIT ?
      `;

      const rows = db
        .prepare(sql)
        .all(id, depth, id, limit + 1) as ImpactRow[];

      const truncated = rows.length > limit;
      const trimmed = truncated ? rows.slice(0, limit) : rows;

      const slugFor = buildSlugMap();
      const transitiveCallers = trimmed.map((r) => ({
        id: r.id,
        repo: slugFor(r.repo_id),
        path: r.relative_path,
        name: r.name,
        kind: r.kind,
        distance: r.distance,
      }));

      return {
        _detail: `${root.name} ← ${transitiveCallers.length} transitive callers (depth≤${depth})${truncated ? ' (truncated)' : ''}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              root: {
                id: root.id,
                repo: slugFor(root.repo_id),
                path: root.relative_path,
                name: root.name,
                kind: root.kind,
              },
              transitiveCallers,
              totalCount: transitiveCallers.length,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}

// ──────────────────────────── code_call_chain ───────────────────────────────
//
// Find a call path from `source` to `target` — i.e. the ordered list of
// symbols where each calls the next, ending at the target. Source must call
// (transitively) target; if no path exists within `max_depth` we return
// `found=false`. Uses BFS so the returned chain is the shortest one. The
// roadmap (2026-05-02 tsbench Run C gap analysis, Gap 1.2) calls this out
// as parity with token-savior's `get_call_chain` after the bench agent
// returned CANNOT_ANSWER on TASK-029.

interface CallChainNode {
  id: string;
  repo: string;
  path: string;
  name: string;
  kind: string;
  line: number;
}

export function computeCallChain(params: {
  source: string;
  target: string;
  max_depth?: number;
}): { payload: Record<string, unknown>; detail: string } {
  const sourceId = params.source;
  const targetId = params.target;
  const maxDepth = params.max_depth ?? 8;

  if (!/^[0-9a-f]{16}$/.test(sourceId)) {
    throw new Error('source must be 16 lowercase hex chars');
  }
  if (!/^[0-9a-f]{16}$/.test(targetId)) {
    throw new Error('target must be 16 lowercase hex chars');
  }

  const db = getCodeDb();
  const sourceRow = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(sourceId) as
    | SymbolRow
    | undefined;
  if (!sourceRow) throw new Error(`Source symbol not found: ${sourceId}`);
  const targetRow = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(targetId) as
    | SymbolRow
    | undefined;
  if (!targetRow) throw new Error(`Target symbol not found: ${targetId}`);

  // BFS from source forward through `calls.caller_id → calls.callee_id`.
  // Track parent pointers so the path can be reconstructed when we hit target.
  const parent = new Map<string, string | null>();
  parent.set(sourceId, null);
  const queue: string[] = [sourceId];
  const distance = new Map<string, number>();
  distance.set(sourceId, 0);

  const stmt = db.prepare(
    `SELECT callee_id FROM calls WHERE caller_id = ? AND callee_id IS NOT NULL`,
  );
  let found = sourceId === targetId;
  while (queue.length > 0 && !found) {
    const current = queue.shift()!;
    const d = distance.get(current)!;
    if (d >= maxDepth) continue;
    const next = stmt.all(current) as Array<{ callee_id: string }>;
    for (const { callee_id } of next) {
      if (parent.has(callee_id)) continue;
      parent.set(callee_id, current);
      distance.set(callee_id, d + 1);
      if (callee_id === targetId) {
        found = true;
        break;
      }
      queue.push(callee_id);
    }
  }

  const slugFor = buildSlugMap();
  const renderRow = (r: SymbolRow): CallChainNode => ({
    id: r.id,
    repo: slugFor(r.repo_id),
    path: r.relative_path,
    name: r.name,
    kind: r.kind,
    line: r.start_line,
  });

  if (!found) {
    return {
      detail: `no call chain ${sourceRow.name} → ${targetRow.name} within depth ${maxDepth}`,
      payload: {
        found: false,
        source: renderRow(sourceRow),
        target: renderRow(targetRow),
        maxDepth,
      },
    };
  }

  // Walk parent pointers back to source.
  const idChain: string[] = [];
  let cur: string | null = targetId;
  while (cur !== null) {
    idChain.push(cur);
    cur = parent.get(cur) ?? null;
  }
  idChain.reverse();

  // Bulk-resolve each id to symbol metadata.
  const placeholders = idChain.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM symbols WHERE id IN (${placeholders})`)
    .all(...idChain) as SymbolRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: CallChainNode[] = idChain
    .map((id) => byId.get(id))
    .filter((r): r is SymbolRow => r !== undefined)
    .map(renderRow);

  return {
    detail: `${sourceRow.name} → ${targetRow.name} in ${chain.length - 1} hop(s)`,
    payload: {
      found: true,
      source: renderRow(sourceRow),
      target: renderRow(targetRow),
      maxDepth,
      hops: chain.length - 1,
      chain,
    },
  };
}

export function registerCodeCallChain(server: McpServer): void {
  server.tool(
    'code_call_chain',
    'Find a call path from `source` symbol to `target` symbol — the ordered list of intermediates where each calls the next. BFS over the calls graph in the forward direction; returns the shortest chain found within `max_depth` (default 8). When no path exists, returns `found:false`. Pair with `code_change_impact` (which is the reverse direction, "who calls me") to navigate large refactors.',
    {
      source: z.string().regex(SYMBOL_ID_RE),
      target: z.string().regex(SYMBOL_ID_RE),
      max_depth: z.number().int().min(1).max(20).optional().default(8),
    },
    wrapToolHandler('code_call_chain', async (params) => {
      const { detail, payload } = computeCallChain({
        source: params.source as string,
        target: params.target as string,
        max_depth: params.max_depth as number | undefined,
      });
      return {
        _detail: detail,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }),
  );
}

// ──────────────────────────── code_nav_stats ────────────────────────────────

export function registerCodeNavStats(server: McpServer): void {
  server.tool(
    'code_nav_stats',
    'Read-only snapshot of the code-nav DB and token-savings counters. Useful for clients (CLI, dashboards) wanting the same data the Code dashboard tab shows. Includes per-repo symbol/file counts and per-tool tokens-saved totals.',
    {},
    wrapToolHandler('code_nav_stats', async () => {
      const dbStats = getCodeNavStats();
      const savings = getCodeNavSavings();
      return {
        _detail: `repos=${dbStats.repoCount} syms=${dbStats.symbolCount} saved=${savings.totalSaved}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              db: dbStats,
              savings,
            }),
          },
        ],
      };
    }),
  );
}

// ──────────────────────────── code_full_context ─────────────────────────────
//
// One-shot symbol context: body + N callers + N callees + outgoing file imports.
// Replaces 4-call sequences (symbol_get + callers + callees + file_outline).
// Token-savior parity (`get_full_context`).

export function registerCodeFullContext(server: McpServer): void {
  server.tool(
    'code_full_context',
    'Symbol body + immediate callers/callees + the file\'s outgoing imports, in one call. Replaces a sequence of code_symbol_get + code_symbol_callers + code_symbol_callees + (file imports lookup). Cap callers/callees with `max_callers`/`max_callees`; cap body with `max_body_lines`.',
    {
      id: z.string().regex(SYMBOL_ID_RE).describe('16-char hex symbol ID'),
      max_callers: z.number().int().min(0).max(50).optional().default(5),
      max_callees: z.number().int().min(0).max(50).optional().default(5),
      max_body_lines: z.number().int().min(0).max(MAX_BODY_LINES).optional().default(80),
      include_imports: z.boolean().optional().default(true),
    },
    wrapToolHandler('code_full_context', async (params) => {
      const id = params.id as string;
      const maxCallers = (params.max_callers as number | undefined) ?? 5;
      const maxCallees = (params.max_callees as number | undefined) ?? 5;
      const maxBodyLines = (params.max_body_lines as number | undefined) ?? 80;
      const includeImports = (params.include_imports as boolean | undefined) ?? true;

      const db = getCodeDb();
      const sym = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as
        | SymbolRow
        | undefined;
      if (!sym) throw new Error(`Symbol not found: ${id}`);

      const slugFor = buildSlugMap();
      const repoSlug = slugFor(sym.repo_id);
      const repoAbs = getRepoPathOnMachine(sym.repo_id);

      // 1. Body (truncated to maxBodyLines).
      let body = '';
      let truncated = false;
      if (repoAbs) {
        const abs = path.join(repoAbs, sym.relative_path);
        try {
          const raw = await fs.readFile(abs, 'utf-8');
          const lines = normalizeNewlines(raw).split('\n');
          const start = Math.max(0, sym.start_line - 1);
          const end = Math.min(lines.length, sym.end_line);
          let slice = lines.slice(start, end);
          if (slice.length > maxBodyLines) {
            slice = slice.slice(0, maxBodyLines);
            truncated = true;
          }
          body = slice.join('\n');
        } catch (err) {
          body = `<unable to read file: ${err instanceof Error ? err.message : String(err)}>`;
        }
      } else {
        body = '<repo path not registered on this machine>';
      }

      // 2. Callers (depth=1, capped). Reuse the same shape as code_symbol_callers.
      const callersStmt = db.prepare(
        `SELECT s.* FROM calls c JOIN symbols s ON s.id=c.caller_id
         WHERE c.callee_id=? LIMIT ?`,
      );
      const callerRows = (maxCallers > 0
        ? (callersStmt.all(id, maxCallers) as SymbolRow[])
        : []) as SymbolRow[];
      const callers = callerRows.map((r) => rowToEdgeNode(r, slugFor));

      // 3. Callees (depth=1, capped). Resolved + unresolved names.
      const calleesResolvedStmt = db.prepare(
        `SELECT s.* FROM calls c JOIN symbols s ON s.id=c.callee_id
         WHERE c.caller_id=? AND c.callee_id IS NOT NULL LIMIT ?`,
      );
      const calleesUnresolvedStmt = db.prepare(
        `SELECT DISTINCT callee_name FROM calls
         WHERE caller_id=? AND callee_id IS NULL LIMIT ?`,
      );
      const calleeRows = (maxCallees > 0
        ? (calleesResolvedStmt.all(id, maxCallees) as SymbolRow[])
        : []) as SymbolRow[];
      const callees = calleeRows.map((r) => rowToEdgeNode(r, slugFor));
      const unresolvedRows =
        maxCallees > 0
          ? (calleesUnresolvedStmt.all(id, maxCallees) as { callee_name: string }[])
          : [];
      const unresolved = unresolvedRows.map((r) => r.callee_name);

      // 4. Outgoing imports for this symbol's file.
      let imports: { name: string; from: string }[] = [];
      if (includeImports) {
        const importRows = db
          .prepare(
            `SELECT imported_name AS name, source_module AS from_
             FROM file_imports WHERE repo_id=? AND relative_path=?`,
          )
          .all(sym.repo_id, sym.relative_path) as Array<{
          name: string;
          from_: string;
        }>;
        imports = importRows.map((r) => ({ name: r.name, from: r.from_ }));
      }

      return {
        _detail: `${sym.qualified_name} (${callers.length}c/${callees.length}cee/${imports.length}imp)`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              symbol: {
                id: sym.id,
                repo: repoSlug,
                path: sym.relative_path,
                name: sym.name,
                kind: sym.kind,
                qualifiedName: sym.qualified_name,
                signature: sym.signature,
                docstring: sym.docstring,
                startLine: sym.start_line,
                endLine: sym.end_line,
                parentId: sym.parent_id,
              },
              body,
              bodyTruncated: truncated,
              callers,
              callees,
              unresolvedCallees: unresolved,
              imports,
            }),
          },
        ],
      };
    }),
  );
}

// ───────────────────────────── code_audit_file ──────────────────────────────
//
// File-scoped multi-aspect summary: outline + caller/callee counts per symbol,
// entry points (called externally but call nothing internal in this file),
// "heaviest" symbols by line count, and the file's import surface.
// Token-savior parity (`audit_file`).

interface AuditSymbolRow {
  id: string;
  name: string;
  kind: string;
  qualified_name: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  parent_id: string | null;
  caller_count: number;
  callee_count: number;
  external_caller_count: number;
}

export function registerCodeAuditFile(server: McpServer): void {
  server.tool(
    'code_audit_file',
    'Multi-aspect summary of a single file: outline with caller/callee counts, entry points (symbols called from outside the file), heaviest symbols by LOC, and the file\'s outgoing imports. One call replaces code_file_outline + per-symbol caller/callee probes.',
    {
      repo: z.string(),
      path: z.string(),
      max_symbols: z.number().int().min(1).max(500).optional().default(100),
      heaviest_top: z.number().int().min(0).max(50).optional().default(5),
    },
    wrapToolHandler('code_audit_file', async (params) => {
      const slug = params.repo as string;
      const filePath = params.path as string;
      const maxSymbols = (params.max_symbols as number | undefined) ?? 100;
      const heaviestTop = (params.heaviest_top as number | undefined) ?? 5;

      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown repo slug: ${slug}`);

      const db = getCodeDb();

      // Fetch all symbols in the file with caller/callee counts.
      // - caller_count: total resolved call sites pointing at this symbol (file-agnostic).
      // - callee_count: total resolved call sites originating from this symbol.
      // - external_caller_count: callers whose `relative_path` differs from this file.
      const rows = db
        .prepare(
          `SELECT s.id,
                  s.name,
                  s.kind,
                  s.qualified_name,
                  s.signature,
                  s.start_line,
                  s.end_line,
                  s.parent_id,
                  (SELECT COUNT(*) FROM calls c WHERE c.callee_id = s.id) AS caller_count,
                  (SELECT COUNT(*) FROM calls c
                     WHERE c.caller_id = s.id AND c.callee_id IS NOT NULL) AS callee_count,
                  (SELECT COUNT(*) FROM calls c
                     JOIN symbols sc ON sc.id = c.caller_id
                     WHERE c.callee_id = s.id AND sc.relative_path != s.relative_path) AS external_caller_count
             FROM symbols s
            WHERE s.repo_id = ? AND s.relative_path = ?
            ORDER BY s.start_line ASC
            LIMIT ?`,
        )
        .all(repo.id, filePath, maxSymbols) as AuditSymbolRow[];

      const truncated = rows.length === maxSymbols;
      const symbols = rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        qualifiedName: r.qualified_name,
        signature: r.signature,
        startLine: r.start_line,
        endLine: r.end_line,
        parentId: r.parent_id,
        loc: r.end_line - r.start_line + 1,
        callerCount: r.caller_count,
        calleeCount: r.callee_count,
        externalCallerCount: r.external_caller_count,
      }));

      // Entry points: symbols called from outside this file.
      const entryPoints = symbols
        .filter((s) => s.externalCallerCount > 0)
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          qualifiedName: s.qualifiedName,
          startLine: s.startLine,
          externalCallerCount: s.externalCallerCount,
        }));

      // Heaviest symbols by LOC (top N, excluding container kinds since they
      // span their methods).
      const heaviest = symbols
        .filter(
          (s) =>
            s.kind !== 'class' &&
            s.kind !== 'interface' &&
            s.kind !== 'struct' &&
            s.kind !== 'enum' &&
            s.kind !== 'trait' &&
            s.kind !== 'impl' &&
            s.kind !== 'union',
        )
        .sort((a, b) => b.loc - a.loc)
        .slice(0, heaviestTop)
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          qualifiedName: s.qualifiedName,
          startLine: s.startLine,
          loc: s.loc,
        }));

      // File's outgoing imports.
      const importRows = db
        .prepare(
          `SELECT imported_name AS name, source_module AS from_
             FROM file_imports WHERE repo_id=? AND relative_path=?`,
        )
        .all(repo.id, filePath) as Array<{ name: string; from_: string }>;
      const imports = importRows.map((r) => ({ name: r.name, from: r.from_ }));

      // File metadata (language, size, indexed_at).
      const fileRow = db
        .prepare(
          `SELECT language, size_bytes, indexed_at
             FROM files WHERE repo_id=? AND relative_path=?`,
        )
        .get(repo.id, filePath) as
        | { language: string; size_bytes: number; indexed_at: number }
        | undefined;

      return {
        _detail: `${slug}/${filePath} → ${symbols.length} sym, ${entryPoints.length} entry, ${imports.length} imp${truncated ? ' (truncated)' : ''}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              repo: slug,
              path: filePath,
              file: fileRow
                ? {
                    language: fileRow.language,
                    sizeBytes: fileRow.size_bytes,
                    indexedAt: fileRow.indexed_at,
                  }
                : null,
              symbols,
              entryPoints,
              heaviest,
              imports,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}

// ─────────────────────── find_import_cycles ─────────────────────────────────
//
// Detect file-level import cycles by treating the symbol-call graph as a
// directed graph between files: every resolved call from a symbol in file A
// to a symbol in file B contributes an edge A → B. Then run Tarjan's SCC
// algorithm and report every strongly-connected component of size ≥ 2.
//
// We use the call graph (not `file_imports`) because:
//   1. `file_imports.source_module` is a textual import string ("./foo") that
//      we'd have to resolve to a file path with language-specific rules.
//   2. The call graph's `callee_id` is already resolved at ingest time, so
//      file→file edges fall out of a single SQL query.
//
// Trade-off: a file that imports another but never calls anything from it
// won't show up here. That's a deliberate false-negative — a cycle that
// nobody actually exercises is rarely a refactoring target.

interface FileEdgeRow {
  src: string;
  dst: string;
}

export function registerCodeFindImportCycles(server: McpServer): void {
  server.tool(
    'code_find_import_cycles',
    'Detect file-level cycles in a repo by treating resolved cross-file calls as directed edges. Reports all strongly-connected components of size ≥ 2 (each is a closed loop where every file transitively calls back into every other file in the cycle). Use to find tangled module boundaries before refactoring.',
    {
      repo: z.string(),
      min_cycle_size: z.number().int().min(2).max(50).optional().default(2),
      limit: z.number().int().positive().max(500).optional().default(50),
    },
    wrapToolHandler('code_find_import_cycles', async (params) => {
      const slug = params.repo as string;
      const minCycleSize = (params.min_cycle_size as number | undefined) ?? 2;
      const limit = (params.limit as number | undefined) ?? 50;

      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown repo slug: ${slug}`);

      const db = getCodeDb();

      // Pull every distinct file→file edge inside this repo.
      const edges = db
        .prepare(
          `SELECT DISTINCT s_caller.relative_path AS src,
                            s_callee.relative_path AS dst
             FROM calls c
             JOIN symbols s_caller ON s_caller.id = c.caller_id
             JOIN symbols s_callee ON s_callee.id = c.callee_id
            WHERE s_caller.repo_id = ?
              AND s_callee.repo_id = ?
              AND s_caller.relative_path != s_callee.relative_path`,
        )
        .all(repo.id, repo.id) as FileEdgeRow[];

      // Tarjan's SCC. Iterative variant — avoids recursion-depth issues on
      // big graphs and stays predictable under V8's stack limits.
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        if (!adj.has(e.src)) adj.set(e.src, []);
        adj.get(e.src)!.push(e.dst);
        if (!adj.has(e.dst)) adj.set(e.dst, []);
      }

      const indexMap = new Map<string, number>();
      const lowlink = new Map<string, number>();
      const onStack = new Set<string>();
      const stack: string[] = [];
      let counter = 0;
      const sccs: string[][] = [];

      // Iterative DFS — each frame is { node, neighborIdx } so we can resume
      // after a recursive call.
      for (const start of adj.keys()) {
        if (indexMap.has(start)) continue;
        type Frame = { node: string; iter: Iterator<string> };
        const callStack: Frame[] = [];
        const pushFrame = (n: string) => {
          indexMap.set(n, counter);
          lowlink.set(n, counter);
          counter += 1;
          stack.push(n);
          onStack.add(n);
          callStack.push({ node: n, iter: (adj.get(n) ?? [])[Symbol.iterator]() });
        };
        pushFrame(start);

        while (callStack.length > 0) {
          const frame = callStack[callStack.length - 1];
          const next = frame.iter.next();
          if (next.done) {
            // Post-order: pop frame, propagate lowlink to parent, finalize SCC if root.
            callStack.pop();
            if (lowlink.get(frame.node) === indexMap.get(frame.node)) {
              const comp: string[] = [];
              while (true) {
                const w = stack.pop()!;
                onStack.delete(w);
                comp.push(w);
                if (w === frame.node) break;
              }
              if (comp.length >= minCycleSize) {
                sccs.push(comp);
              }
            }
            if (callStack.length > 0) {
              const parent = callStack[callStack.length - 1];
              lowlink.set(
                parent.node,
                Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
              );
            }
            continue;
          }
          const w = next.value;
          if (!indexMap.has(w)) {
            pushFrame(w);
          } else if (onStack.has(w)) {
            lowlink.set(
              frame.node,
              Math.min(lowlink.get(frame.node)!, indexMap.get(w)!),
            );
          }
        }
      }

      // Sort by size desc — biggest cycles first; ties broken alphabetically.
      sccs.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
      const truncated = sccs.length > limit;
      const trimmed = truncated ? sccs.slice(0, limit) : sccs;

      const cycles = trimmed.map((files) => ({
        size: files.length,
        files: [...files].sort(),
      }));

      return {
        _detail: `${cycles.length} file-level cycle(s)${truncated ? ' (truncated)' : ''} in ${slug}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              repo: slug,
              cycles,
              totalCount: cycles.length,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}

// ─────────────────────── find_dead_code ─────────────────────────────────────
//
// Symbols that nothing else in the repo calls into. Useful as a refactoring
// sweep — lets the agent surface candidate removals without reading every
// file. We deliberately skip a few categories that look dead but aren't:
//
//   - Names matching common entry-point patterns (`main`, `init`, `setup`,
//     `default`, `_start`, test runners, …) — these get called by the
//     framework, not by application code.
//   - Symbols in test files (`*.test.*`, `*.spec.*`, `tests/**`) — they're
//     called by the test runner, which we don't index.
//   - Container kinds (`class`, `struct`, `enum`, `trait`, `interface`,
//     `impl`, `module`, `namespace`, `union`) — their methods/fields are the
//     real callees, and reporting an unused class on top of all its unused
//     methods would be noisy.
//
// The heuristic is intentionally conservative — false negatives (real dead
// code we miss) are better than false positives (a "dead" function the
// framework actually calls).

interface DeadSymbolRow {
  id: string;
  name: string;
  kind: string;
  qualified_name: string;
  signature: string | null;
  relative_path: string;
  start_line: number;
  end_line: number;
}

const ENTRY_POINT_NAMES = new Set([
  'main',
  'init',
  'setup',
  'teardown',
  'default',
  '_start',
  'run',
  'start',
  'stop',
  'execute',
  'handler',
  'handle',
  // Test-runner conventions
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'before',
  'after',
  // Common framework hooks
  'constructor',
  'componentDidMount',
  'componentWillUnmount',
  'render',
]);

const CONTAINER_KINDS = new Set([
  'class',
  'struct',
  'enum',
  'trait',
  'interface',
  'impl',
  'module',
  'namespace',
  'union',
]);

const TEST_PATH_RE = /(^|[\\/])(tests?|__tests__|spec|specs)[\\/]|\.(test|spec)\.[^./\\]+$/i;

export function registerCodeFindDeadCode(server: McpServer): void {
  server.tool(
    'code_find_dead_code',
    'Surface symbols in a repo that nothing else calls — refactoring candidates. Filters out conventional entry points (main/init/setup/handler/render/...), container kinds (class/struct/enum/...), and symbols in test files. Pass `kind` to narrow to a specific symbol kind (e.g. `function`).',
    {
      repo: z.string(),
      kind: z.string().optional(),
      include_underscore: z.boolean().optional().default(false),
      limit: z.number().int().positive().max(1000).optional().default(200),
    },
    wrapToolHandler('code_find_dead_code', async (params) => {
      const slug = params.repo as string;
      const kindFilter = params.kind as string | undefined;
      const includeUnderscore =
        (params.include_underscore as boolean | undefined) ?? false;
      const limit = (params.limit as number | undefined) ?? 200;

      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown repo slug: ${slug}`);

      const db = getCodeDb();

      // Symbols with zero RESOLVED callers. We deliberately ignore unresolved
      // calls (callee_id IS NULL) since they're calls to symbols outside the
      // index — counting them would understate the dead-code surface.
      const baseSql = `
        SELECT s.id,
               s.name,
               s.kind,
               s.qualified_name,
               s.signature,
               s.relative_path,
               s.start_line,
               s.end_line
          FROM symbols s
         WHERE s.repo_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM calls c
              WHERE c.callee_id = s.id
           )
      `;

      const sql = kindFilter ? `${baseSql} AND s.kind = ?` : baseSql;
      const args: unknown[] = kindFilter ? [repo.id, kindFilter] : [repo.id];
      const rows = db.prepare(sql).all(...args) as DeadSymbolRow[];

      const filtered = rows.filter((r) => {
        if (CONTAINER_KINDS.has(r.kind)) return false;
        if (ENTRY_POINT_NAMES.has(r.name)) return false;
        if (TEST_PATH_RE.test(r.relative_path)) return false;
        // Convention: leading-underscore names are usually intentionally
        // private and may be exposed via re-export. Skip unless the caller
        // explicitly opts in.
        if (!includeUnderscore && r.name.startsWith('_')) return false;
        return true;
      });

      filtered.sort(
        (a, b) =>
          a.relative_path.localeCompare(b.relative_path) ||
          a.start_line - b.start_line,
      );

      const truncated = filtered.length > limit;
      const trimmed = truncated ? filtered.slice(0, limit) : filtered;

      const symbols = trimmed.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        qualifiedName: r.qualified_name,
        signature: r.signature,
        path: r.relative_path,
        startLine: r.start_line,
        endLine: r.end_line,
        loc: r.end_line - r.start_line + 1,
      }));

      return {
        _detail: `${symbols.length} dead symbol(s)${truncated ? ' (truncated)' : ''} in ${slug}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              repo: slug,
              symbols,
              totalCount: symbols.length,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}

// ─────────────────────── find_semantic_duplicates ───────────────────────────
//
// Cluster symbols by similar structural fingerprint. Two modes:
//   - `mode: "exact"` (default): same canonical signature byte-for-byte after
//     whitespace normalization. Catches cut-and-paste declarations.
//   - `mode: "structural"`: replace identifier-shaped tokens with a `_`
//     placeholder, keep punctuation/keywords. Two functions with isomorphic
//     parameter shapes but different names land in the same bucket.
//
// We work off the `signature` column only — the server doesn't see symbol
// bodies (that's the whole reason cortexmd exists). A future
// upgrade would push body simhash into the ingest payload and bucket on
// near-equal hashes; for now, signature-shape buckets catch the
// highest-signal duplicates a refactor would target.

interface DupSymbolRow {
  id: string;
  name: string;
  kind: string;
  qualified_name: string;
  signature: string;
  relative_path: string;
  start_line: number;
  end_line: number;
}

function canonicalSignature(sig: string): string {
  return sig.replace(/\s+/g, ' ').trim().toLowerCase();
}

function structuralSignature(sig: string): string {
  // Drop runs of identifier-like tokens (letters, digits, underscores) so
  // only structural punctuation remains. Then collapse whitespace.
  return sig
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hamming-weight (popcount) of a 32-bit integer. Classic SWAR.
function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

interface DupBodyRow extends DupSymbolRow {
  body_simhash: string;
}

const BODY_MODE_MAX_SYMBOLS = 5000;

/**
 * Pure core for `code_find_semantic_duplicates`. Returns the JSON-ready
 * payload + a one-line detail string. Both the MCP tool registration and
 * the REST shim in `index.ts` go through this so logic stays in one place.
 *
 * Throws `Error` on bad slug or oversized body-mode comparison; callers
 * map to MCP error / HTTP 4xx accordingly.
 */
export function computeFindSemanticDuplicates(params: {
  repo: string;
  mode?: 'exact' | 'structural' | 'body';
  kind?: string;
  min_cluster_size?: number;
  min_signature_length?: number;
  max_hamming?: number;
  limit?: number;
}): { payload: Record<string, unknown>; detail: string } {
  const slug = params.repo;
  const mode = params.mode ?? 'exact';
  const kindFilter = params.kind;
  const minCluster = params.min_cluster_size ?? 2;
  const minSigLen = params.min_signature_length ?? 8;
  const maxHamming = params.max_hamming ?? 3;
  const limit = params.limit ?? 50;

  const repo = resolveRepoBySlug(slug);
  if (!repo) throw new Error(`Unknown repo slug: ${slug}`);
  const db = getCodeDb();

  if (mode === 'body') {
    const bodySql = kindFilter
      ? `SELECT s.id, s.name, s.kind, s.qualified_name, s.signature,
                s.relative_path, s.start_line, s.end_line, s.body_simhash
           FROM symbols s
          WHERE s.repo_id = ?
            AND s.body_simhash IS NOT NULL
            AND s.kind = ?
          LIMIT ?`
      : `SELECT s.id, s.name, s.kind, s.qualified_name, s.signature,
                s.relative_path, s.start_line, s.end_line, s.body_simhash
           FROM symbols s
          WHERE s.repo_id = ?
            AND s.body_simhash IS NOT NULL
          LIMIT ?`;
    const bodyArgs: unknown[] = kindFilter
      ? [repo.id, kindFilter, BODY_MODE_MAX_SYMBOLS + 1]
      : [repo.id, BODY_MODE_MAX_SYMBOLS + 1];
    const rows = db.prepare(bodySql).all(...bodyArgs) as DupBodyRow[];
    if (rows.length > BODY_MODE_MAX_SYMBOLS) {
      throw new Error(
        `Too many fingerprinted symbols for O(N²) body-mode comparison (>${BODY_MODE_MAX_SYMBOLS}). Filter by --kind or split the repo.`,
      );
    }

    const fps: Array<{ hi: number; lo: number }> = rows.map((r) => ({
      hi: parseInt(r.body_simhash.slice(0, 8), 16) | 0,
      lo: parseInt(r.body_simhash.slice(8, 16), 16) | 0,
    }));

    const parent = new Int32Array(rows.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const dist =
          popcount32(fps[i].hi ^ fps[j].hi) + popcount32(fps[i].lo ^ fps[j].lo);
        if (dist <= maxHamming) union(i, j);
      }
    }

    const components = new Map<number, number[]>();
    for (let i = 0; i < rows.length; i++) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(i);
    }

    const clusters = [...components.values()]
      .filter((idxs) => idxs.length >= minCluster)
      .map((idxs) => {
        const sorted = idxs
          .map((i) => rows[i])
          .sort(
            (a, b) =>
              a.relative_path.localeCompare(b.relative_path) ||
              a.start_line - b.start_line,
          );
        return {
          representative: sorted[0].body_simhash,
          size: sorted.length,
          symbols: sorted.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            qualifiedName: r.qualified_name,
            signature: r.signature,
            path: r.relative_path,
            startLine: r.start_line,
            endLine: r.end_line,
            bodySimhash: r.body_simhash,
          })),
        };
      })
      .sort(
        (a, b) =>
          b.size - a.size || a.representative.localeCompare(b.representative),
      );

    const truncated = clusters.length > limit;
    const trimmed = truncated ? clusters.slice(0, limit) : clusters;

    return {
      detail: `${trimmed.length} body-dup cluster(s)${truncated ? ' (truncated)' : ''} in ${slug} (max_hamming=${maxHamming}, n=${rows.length})`,
      payload: {
        repo: slug,
        mode: 'body',
        maxHamming,
        fingerprintedSymbolCount: rows.length,
        clusters: trimmed,
        totalCount: trimmed.length,
        truncated,
      },
    };
  }

  // exact / structural
  const baseSql = `
    SELECT s.id,
           s.name,
           s.kind,
           s.qualified_name,
           s.signature,
           s.relative_path,
           s.start_line,
           s.end_line
      FROM symbols s
     WHERE s.repo_id = ?
       AND s.signature IS NOT NULL
       AND length(s.signature) >= ?
  `;
  const sql = kindFilter ? `${baseSql} AND s.kind = ?` : baseSql;
  const args: unknown[] = kindFilter
    ? [repo.id, minSigLen, kindFilter]
    : [repo.id, minSigLen];
  const rows = db.prepare(sql).all(...args) as DupSymbolRow[];

  const fingerprint = mode === 'structural' ? structuralSignature : canonicalSignature;
  const buckets = new Map<string, DupSymbolRow[]>();
  for (const r of rows) {
    const fp = fingerprint(r.signature);
    if (fp.length < Math.max(4, minSigLen / 2)) continue;
    if (!buckets.has(fp)) buckets.set(fp, []);
    buckets.get(fp)!.push(r);
  }

  const clusters: Array<{
    fingerprint: string;
    size: number;
    symbols: Array<{
      id: string;
      name: string;
      kind: string;
      qualifiedName: string;
      signature: string;
      path: string;
      startLine: number;
      endLine: number;
    }>;
  }> = [];
  for (const [fp, members] of buckets) {
    if (members.length < minCluster) continue;
    clusters.push({
      fingerprint: fp,
      size: members.length,
      symbols: members
        .sort(
          (a, b) =>
            a.relative_path.localeCompare(b.relative_path) ||
            a.start_line - b.start_line,
        )
        .map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          qualifiedName: r.qualified_name,
          signature: r.signature,
          path: r.relative_path,
          startLine: r.start_line,
          endLine: r.end_line,
        })),
    });
  }
  clusters.sort((a, b) => b.size - a.size || a.fingerprint.localeCompare(b.fingerprint));
  const truncated = clusters.length > limit;
  const trimmed = truncated ? clusters.slice(0, limit) : clusters;

  return {
    detail: `${trimmed.length} duplicate cluster(s)${truncated ? ' (truncated)' : ''} in ${slug} (mode=${mode})`,
    payload: {
      repo: slug,
      mode,
      clusters: trimmed,
      totalCount: trimmed.length,
      truncated,
    },
  };
}

export function registerCodeFindSemanticDuplicates(server: McpServer): void {
  server.tool(
    'code_find_semantic_duplicates',
    'Cluster near-duplicate symbols across a repo. Three modes:\n' +
      ' - `exact` — whitespace-normalized signatures match byte-for-byte (cut-and-paste declarations).\n' +
      ' - `structural` — identifiers stripped from signature; same parameter shape, different names cluster.\n' +
      ' - `body` — 64-bit SimHash of normalized symbol body (computed by the Rust ingest client). Pairs within `max_hamming` bits cluster via union-find. Catches real copy-paste with renamed variables. Limited to repos with ≤ 5000 symbols carrying a body fingerprint (older clients don\'t send one).',
    {
      repo: z.string(),
      mode: z.enum(['exact', 'structural', 'body']).optional().default('exact'),
      kind: z.string().optional(),
      min_cluster_size: z.number().int().min(2).max(50).optional().default(2),
      min_signature_length: z.number().int().min(0).max(1000).optional().default(8),
      max_hamming: z.number().int().min(0).max(32).optional().default(3),
      limit: z.number().int().positive().max(500).optional().default(50),
    },
    wrapToolHandler('code_find_semantic_duplicates', async (params) => {
      const { detail, payload } = computeFindSemanticDuplicates({
        repo: params.repo as string,
        mode: params.mode as 'exact' | 'structural' | 'body' | undefined,
        kind: params.kind as string | undefined,
        min_cluster_size: params.min_cluster_size as number | undefined,
        min_signature_length: params.min_signature_length as number | undefined,
        max_hamming: params.max_hamming as number | undefined,
        limit: params.limit as number | undefined,
      });
      return {
        _detail: detail,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }),
  );
}

// ─────────────────────── detect_breaking_changes ────────────────────────────
//
// Surface symbols whose public shape changed in a way that could break a
// downstream caller. Powered by `symbol_changes`, a delta log populated
// during ingest (see `applyParseResultToRepo`). Two change kinds are tracked:
//
//   - `removed` — the symbol's (name, kind) tuple existed before this ingest
//     for the same file but is gone now.
//   - `sig_changed` — same (name, kind) is still there, but its symbol_id
//     changed — and since `id = sha1(repo|path|name|kind|signature)[:16]`,
//     a different id means the signature changed.
//
// Renames are NOT detected — a `foo` → `bar` rename surfaces as
// `removed(foo) + added(bar)`, and we don't log `added` (it's not breaking).
// A future iteration could heuristically pair `removed` and `added` events
// in the same ingest by signature similarity.

interface SymbolChangeRow {
  id: number;
  relative_path: string;
  name: string;
  kind: string;
  change_kind: string;
  before_symbol_id: string | null;
  after_symbol_id: string | null;
  before_signature: string | null;
  after_signature: string | null;
  captured_at: number;
}

export function registerCodeDetectBreakingChanges(server: McpServer): void {
  server.tool(
    'code_detect_breaking_changes',
    'List symbols whose public shape changed in a way that could break downstream callers, captured incrementally during ingest. Returns `removed` (symbol gone) and `sig_changed` (same name+kind but new signature) entries since `since_ts` (default: last 7 days). Does NOT track renames (those surface as removed+added pairs; we don\'t log adds).',
    {
      repo: z.string(),
      since_ts: z.number().int().min(0).optional(),
      change_kind: z.enum(['removed', 'sig_changed', 'all']).optional().default('all'),
      path_prefix: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional().default(200),
    },
    wrapToolHandler('code_detect_breaking_changes', async (params) => {
      const slug = params.repo as string;
      const sinceTs =
        (params.since_ts as number | undefined) ??
        Date.now() - 7 * 24 * 60 * 60 * 1000;
      const changeKind =
        (params.change_kind as 'removed' | 'sig_changed' | 'all' | undefined) ?? 'all';
      const pathPrefix = params.path_prefix as string | undefined;
      const limit = (params.limit as number | undefined) ?? 200;

      const repo = resolveRepoBySlug(slug);
      if (!repo) throw new Error(`Unknown repo slug: ${slug}`);

      const db = getCodeDb();

      const args: unknown[] = [repo.id, sinceTs];
      let sql = `
        SELECT id,
               relative_path,
               name,
               kind,
               change_kind,
               before_symbol_id,
               after_symbol_id,
               before_signature,
               after_signature,
               captured_at
          FROM symbol_changes
         WHERE repo_id = ?
           AND captured_at >= ?
      `;
      if (changeKind !== 'all') {
        sql += ` AND change_kind = ?`;
        args.push(changeKind);
      }
      if (pathPrefix) {
        sql += ` AND relative_path LIKE ?`;
        args.push(`${pathPrefix}%`);
      }
      sql += ` ORDER BY captured_at DESC, id DESC LIMIT ?`;
      args.push(limit + 1);

      const rows = db.prepare(sql).all(...args) as SymbolChangeRow[];
      const truncated = rows.length > limit;
      const trimmed = truncated ? rows.slice(0, limit) : rows;

      const changes = trimmed.map((r) => ({
        path: r.relative_path,
        name: r.name,
        kind: r.kind,
        changeKind: r.change_kind,
        beforeSymbolId: r.before_symbol_id,
        afterSymbolId: r.after_symbol_id,
        beforeSignature: r.before_signature,
        afterSignature: r.after_signature,
        capturedAt: r.captured_at,
      }));

      return {
        _detail: `${changes.length} breaking change(s)${truncated ? ' (truncated)' : ''} in ${slug} since ${new Date(sinceTs).toISOString()}`,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              repo: slug,
              sinceTs,
              changeKind,
              changes,
              totalCount: changes.length,
              truncated,
            }),
          },
        ],
      };
    }),
  );
}
