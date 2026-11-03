import path from 'node:path';
import { realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getCodeDb } from './code-nav/db.js';
import { config } from '../config.js';
import { resolveSafePathForRead } from './vault.js';
import { searchNotes } from './search.js';
import { listSourceVaultPaths } from './source-vaults.js';
import type { WorkerTool, WorkerToolResult, WorkerSource } from './worker/types.js';

async function boundedRead(file: string, ceiling: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Worker source is not a regular file');
    const buffer = Buffer.alloc(ceiling + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > ceiling) throw new Error('Worker source exceeds read ceiling');
    return buffer.subarray(0, used).toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface WorkerScope {
  mode: 'code-investigator' | 'knowledge-investigator';
  repo?: string;
  paths?: string[];
  note_paths?: string[];
}

/** Strict lexical scope: never normalize traversal, absolute paths or aliases into permission. */
export function workerPath(value: string): string {
  const p = value.replace(/\\/g, '/').replace(/\/$/, '');
  if (
    !p ||
    p.length > 1024 ||
    /[\x00-\x1f:]/.test(p) ||
    p.startsWith('/') ||
    p.split('/').some((s) => s === '..' || s === '' || (s === '.' && p !== '.'))
  )
    throw new Error('Invalid worker-relative path');
  return p;
}
export function withinWorkerScope(p: string, roots: string[]): boolean {
  return roots.some((root) => root === '.' || p === root || p.startsWith(root + '/'));
}

interface SymbolRow {
  id: string;
  repo_id: string;
  relative_path: string;
  name: string;
  kind: string;
  signature: string | null;
  docstring: string | null;
  start_line: number;
  end_line: number;
  content_hash: string;
}
const fields =
  's.id,s.repo_id,s.relative_path,s.name,s.kind,s.signature,s.docstring,s.start_line,s.end_line,s.content_hash';
const querySchema = z.object({ query: z.string().min(1).max(500) }).strict();
const idSchema = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).strict();
const pathSchema = z.object({ path: z.string().min(1).max(1024) }).strict();
const symbolReadSchema = idSchema
  .extend({ offset_lines: z.number().int().min(0).max(100000).optional() })
  .strict();
const noteReadSchema = pathSchema
  .extend({ offset_chars: z.number().int().min(0).max(64000).optional() })
  .strict();
function tool(name: string, description: string, key: string): WorkerTool {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { [key]: { type: 'string' } },
      required: [key],
      additionalProperties: false,
    },
  };
}
export const CODE_WORKER_TOOLS = [
  tool(
    'code_symbol_search',
    'Search symbol names/signatures within the fixed repository and paths. Returns at most 20 indexed records, not verified source bodies.',
    'query',
  ),
  tool('code_file_outline', 'List up to 50 indexed symbols in one scoped file.', 'path'),
  tool(
    'code_symbol_get',
    'Read a scoped symbol with up to 200 source lines when the server has matching source. Missing or stale source is reported explicitly.',
    'id',
  ),
  tool(
    'code_symbol_callers',
    'List up to 20 scoped callers of a scoped symbol; cross-scope edges are omitted.',
    'id',
  ),
  tool(
    'code_symbol_callees',
    'List up to 20 scoped resolved callees of a scoped symbol; unresolved and cross-scope edges are omitted.',
    'id',
  ),
];
export const KNOWLEDGE_WORKER_TOOLS = [
  tool(
    'notes_search',
    'Lexically search within the fixed note paths. Returns at most 20 results; no memory heat updates or external reranking.',
    'query',
  ),
  tool(
    'notes_get',
    'Read one scoped note without modifying memory heat. Large notes are truncated.',
    'path',
  ),
];
CODE_WORKER_TOOLS.find((t) => t.name === 'code_symbol_get')!.parameters = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    offset_lines: {
      type: 'integer',
      minimum: 0,
      description: 'Line offset inside the symbol; use nextOffsetLines to read another chunk.',
    },
  },
  required: ['id'],
  additionalProperties: false,
};
KNOWLEDGE_WORKER_TOOLS.find((t) => t.name === 'notes_get')!.parameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset_chars: {
      type: 'integer',
      minimum: 0,
      description: 'Character offset; use nextOffsetChars to read another chunk.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

export interface WorkerToolDependencies {
  db?: Database.Database;
  search?: typeof searchNotes;
  read?: (path: string) => Promise<{ content: string; etag: string }>;
  resolveNote?: typeof resolveSafePathForRead;
  vaultRoots?: string[];
}

export function createWorkerTools(scope: WorkerScope, deps: WorkerToolDependencies = {}) {
  const roots = (
    scope.mode === 'code-investigator' ? (scope.paths ?? ['.']) : (scope.note_paths ?? [])
  ).map(workerPath);
  if (!roots.length || roots.length > 20)
    throw new Error(
      'Explicit note_paths are required for knowledge investigation; scope has at most 20 paths',
    );
  const tools = scope.mode === 'code-investigator' ? CODE_WORKER_TOOLS : KNOWLEDGE_WORKER_TOOLS;
  // Opening the normal index can initialize its schema; tools below perform SELECTs only.
  const db = scope.mode === 'code-investigator' ? (deps.db ?? getCodeDb()) : undefined;
  const repo = db?.prepare('SELECT id,slug FROM repos WHERE slug=?').get(scope.repo ?? '') as
    | { id: string; slug: string }
    | undefined;
  if (db && !repo) throw new Error('A registered repo slug is required for code investigation');
  const scopeSql =
    '(' +
    roots
      .map(() => "(s.relative_path=? OR substr(s.relative_path,1,length(?)+1)=? || '/' OR ?='.')")
      .join(' OR ') +
    ')';
  const scopeArgs = roots.flatMap((r) => [r, r, r, r]);
  const allowedSymbol = (id: string): SymbolRow => {
    const s = db!
      .prepare(`SELECT ${fields} FROM symbols s WHERE s.id=? AND s.repo_id=? AND ${scopeSql}`)
      .get(id, repo!.id, ...scopeArgs) as SymbolRow | undefined;
    if (!s) throw new Error('Symbol unavailable within worker scope');
    workerPath(s.relative_path);
    return s;
  };
  const source = (s: SymbolRow): WorkerSource => ({
    path: s.relative_path,
    repo: repo!.slug,
    hash: s.content_hash,
    startLine: s.start_line,
    endLine: s.end_line,
  });
  const rowsResult = (rows: SymbolRow[], cap: number): WorkerToolResult => {
    const safe = rows.filter((s) => {
      try {
        return withinWorkerScope(workerPath(s.relative_path), roots);
      } catch {
        return false;
      }
    });
    return {
      content: {
        symbols: safe
          .slice(0, cap)
          .map(({ repo_id, ...s }) => ({
            ...s,
            signature: s.signature?.slice(0, 150),
            docstring: s.docstring?.slice(0, 150),
          })),
        truncated: rows.length > cap,
        snapshot:
          'Indexed metadata only; source freshness is checked by code_symbol_get. Signatures/docstrings may be abbreviated. Relationships omit out-of-scope and unresolved edges.',
      },
      sources: safe.slice(0, cap).map(source),
      limitations:
        rows.length > cap ? ['Symbol results truncated; refine the query or scope.'] : [],
    };
  };
  async function safeNote(p: string): Promise<string> {
    if (!withinWorkerScope(p, roots)) throw new Error('Note unavailable within worker scope');
    const resolved = await (deps.resolveNote ?? resolveSafePathForRead)(p);
    // The general vault resolver accepts basename-prefixed aliases. Workers require
    // the literal scoped relative path, never that convenience fallback.
    const vaults = deps.vaultRoots ?? [config.brainVault, ...listSourceVaultPaths()];
    const selected = vaults
      .filter((v) => {
        const rel = path.relative(path.resolve(v), path.resolve(resolved));
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (
      !selected ||
      path.relative(path.resolve(selected), path.resolve(resolved)).replace(/\\/g, '/') !== p
    )
      throw new Error('Worker note aliases are not allowed');
    // Canonicalize the configured root as well: Windows temporary roots may use
    // 8.3 names (RUNNER~1) which realpath expands. Only aliases *inside* the
    // selected vault can cross this request's narrower relative-path scope.
    const canonicalRoot = await realpath(selected);
    const canonicalNote = await realpath(resolved);
    if (path.resolve(canonicalNote) !== path.resolve(canonicalRoot, p))
      throw new Error('Worker note symlink aliases are not allowed');
    return canonicalNote;
  }
  return {
    tools,
    async executeTool(
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<WorkerToolResult> {
      signal.throwIfAborted();
      if (!tools.some((t) => t.name === name))
        throw new Error('Tool is not permitted in this worker mode');
      if (name === 'notes_search') {
        const { query } = querySchema.parse(args);
        // Exact boundary filtering is required: ordinary search scope uses startsWith.
        const hits = (deps.search ?? searchNotes)(query, {
          scopePaths: roots.includes('.') ? undefined : roots,
          limit: 100,
          rerank: false,
          graph: false,
        });
        const results = [];
        for (const hit of hits) {
          signal.throwIfAborted();
          try {
            const p = workerPath(hit.path);
            await safeNote(p);
            results.push({
              path: p,
              title: hit.title.slice(0, 200),
              snippet: hit.snippet.slice(0, 300),
            });
          } catch {
            continue;
          }
          if (results.length === 21) break;
        }
        const truncated = results.length > 20 || hits.length >= 100;
        return {
          content: {
            results: results.slice(0, 20),
            snapshot: 'Lexical index only; read notes to verify current contents.',
          },
          sources: results.slice(0, 20).map((r) => ({ path: r.path })),
          limitations: truncated ? ['Search results truncated; refine scope or query.'] : [],
        };
      }
      if (name === 'notes_get') {
        const parsed = noteReadSchema.parse(args);
        const offset = parsed.offset_chars ?? 0;
        const p = workerPath(parsed.path);
        const resolved = await safeNote(p);
        const content = deps.read
          ? (await deps.read(p)).content
          : await boundedRead(resolved, 64_000);
        signal.throwIfAborted();
        const etag = createHash('sha256').update(content).digest('hex');
        if (offset > content.length) throw new Error('Note offset exceeds content');
        const end = Math.min(content.length, offset + 3000);
        return {
          content: {
            path: p,
            content: content.slice(offset, end),
            offsetChars: offset,
            nextOffsetChars: end < content.length ? end : null,
            truncated: offset > 0 || end < content.length,
          },
          sources: [
            {
              path: p,
              hash: etag,
              startLine: content.slice(0, offset).split('\n').length,
              endLine: content.slice(0, end).split('\n').length,
            },
          ],
          limitations:
            offset > 0 || end < content.length
              ? ['Only a note excerpt was inspected; remaining content may be relevant.']
              : [],
        };
      }
      if (name === 'code_symbol_search') {
        const { query } = querySchema.parse(args);
        // Escaped LIKE treats user punctuation literally and keeps work bounded by result count.
        const q = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
        return rowsResult(
          db!
            .prepare(
              `SELECT ${fields} FROM symbols s WHERE s.repo_id=? AND ${scopeSql} AND (s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\') ORDER BY s.relative_path,s.start_line LIMIT 21`,
            )
            .all(repo!.id, ...scopeArgs, q, q) as SymbolRow[],
          20,
        );
      }
      if (name === 'code_file_outline') {
        const p = workerPath(pathSchema.parse(args).path);
        if (!withinWorkerScope(p, roots)) throw new Error('File unavailable within worker scope');
        return rowsResult(
          db!
            .prepare(
              `SELECT ${fields} FROM symbols s WHERE s.repo_id=? AND s.relative_path=? ORDER BY s.start_line LIMIT 51`,
            )
            .all(repo!.id, p) as SymbolRow[],
          50,
        );
      }
      const parsed =
        name === 'code_symbol_get' ? symbolReadSchema.parse(args) : idSchema.parse(args);
      const s = allowedSymbol(parsed.id);
      if (name !== 'code_symbol_get') {
        const callers = name === 'code_symbol_callers';
        const rows = db!
          .prepare(
            `SELECT DISTINCT ${fields} FROM calls c JOIN symbols s ON s.id=c.${callers ? 'caller_id' : 'callee_id'} WHERE c.${callers ? 'callee_id' : 'caller_id'}=? AND s.repo_id=? AND ${scopeSql} LIMIT 21`,
          )
          .all(s.id, repo!.id, ...scopeArgs) as SymbolRow[];
        const result = rowsResult(rows, 20);
        if (
          !callers &&
          db!
            .prepare('SELECT 1 FROM calls WHERE caller_id=? AND callee_id IS NULL LIMIT 1')
            .get(s.id)
        )
          result.limitations!.push(
            'Unresolved outgoing calls are omitted; the callee graph is incomplete.',
          );
        return result;
      }
      const base = rowsResult([s], 1);
      const local = db!
        .prepare('SELECT abs_path FROM repo_paths WHERE repo_id=? AND machine_id=?')
        .get(repo!.id, config.machineId) as { abs_path: string } | undefined;
      if (!local)
        return {
          ...base,
          limitations: [
            'Source unavailable on this server; indexed metadata alone cannot establish implementation behavior.',
          ],
        };
      try {
        const root = await realpath(local.abs_path);
        const lexical = path.resolve(root, s.relative_path);
        const actual = await realpath(lexical);
        const rel = path.relative(root, actual);
        if (rel.startsWith('..') || path.isAbsolute(rel) || actual !== lexical)
          throw new Error('Source outside scope or symlink');
        const raw = (await boundedRead(actual, 2_000_000))
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        signal.throwIfAborted();
        const lines = raw.split('\n');
        const indexed = db!
          .prepare('SELECT content_hash,indexed_at FROM files WHERE repo_id=? AND relative_path=?')
          .get(repo!.id, s.relative_path) as
          | { content_hash: string; indexed_at: number }
          | undefined;
        const hash = createHash('sha1').update(raw).digest('hex');
        if (!indexed || hash !== indexed.content_hash)
          throw new Error('Indexed file hash does not match current source');
        const offset = symbolReadSchema.parse(args).offset_lines ?? 0;
        const start = s.start_line + offset;
        if (start > s.end_line) throw new Error('Symbol offset exceeds source range');
        const selected: string[] = [];
        let chars = 0;
        for (let line = start; line <= Math.min(s.end_line, start + 199); line++) {
          const text = lines[line - 1] ?? '';
          if (chars + text.length > 3000) break;
          selected.push(text);
          chars += text.length + 1;
        }
        const end = start + selected.length - 1;
        if (!selected.length)
          return {
            ...base,
            limitations: ['A source line exceeds the worker excerpt ceiling; inspect it directly.'],
          };
        const truncated = offset > 0 || end < s.end_line;
        return {
          content: {
            ...s,
            repo_id: undefined,
            signature: s.signature?.slice(0, 150),
            docstring: s.docstring?.slice(0, 150),
            body: selected.join('\n'),
            truncated,
            nextOffsetLines: end < s.end_line ? end - s.start_line + 1 : null,
            indexedAt: indexed.indexed_at,
            fileHash: hash,
          },
          sources: [{ ...source(s), hash, startLine: start, endLine: end }],
          limitations: truncated
            ? ['Only a source excerpt was inspected; remaining lines may be relevant.']
            : [],
        };
      } catch {
        signal.throwIfAborted();
        return {
          ...base,
          limitations: [
            'Source unavailable, outside scope, too large, or stale; no unverified source body was returned.',
          ],
        };
      }
    },
  };
}
