#!/usr/bin/env node
/**
 * ============================================================================
 * snapshot-vault.mjs — build a LOCAL, gitignored subset of a vault for the
 *                       real-vault benchmark (eval/real-vault.ts)
 * ============================================================================
 *
 * The real-vault benchmark needs a directory of `.md` notes. Real vaults
 * contain private material (client emails, PII), so this script pulls a
 * PARAMETERIZED SUBSET into a gitignored dir (`.realvault-snapshot/` by
 * default) and NEVER transmits anything — it only reads a source and writes
 * locally.
 *
 * TWO SOURCES
 *   --source local   Copy `.md` files from a local vault dir (`--from`).
 *                    Bytes are copied verbatim so frontmatter + `[[wikilinks]]`
 *                    survive (both gold sets depend on them). This is the
 *                    recommended, zero-dependency path.
 *
 *   --source mcp     Pull via the obsidian-brain MCP server over HTTP
 *                    (JSON-RPC: notes_list to page, notes_get per note). NO
 *                    upload — list + get + local-write only. Requires --server
 *                    and --token (or BRAIN_SERVER / BRAIN_TOKEN env). Use this
 *                    when the notes live only on the server, not on disk.
 *
 * FILTERING (applied to each note's vault-relative path)
 *   --include A,B    Folder allowlist (prefix match). Omit = include everything.
 *   --exclude X,Y    Folder denylist (prefix match). ALWAYS WINS over include.
 *                    Defaults to `EmailLog` so PII never lands in a snapshot
 *                    even if you forget — pass --exclude '' to opt out.
 *   --max-notes N    Cap the number of notes written (deterministic: notes are
 *                    sorted by path, first N kept).
 *
 * USAGE
 *   node scripts/snapshot-vault.mjs --source local --from /path/to/vault \
 *     --out .realvault-snapshot --include Projects,CRM --exclude EmailLog --max-notes 500
 *
 *   node scripts/snapshot-vault.mjs --source mcp \
 *     --server https://brain.example.com --token "$BRAIN_TOKEN" \
 *     --out .realvault-snapshot --exclude EmailLog --max-notes 300
 *
 * SAFETY
 *   - Writes only under --out. Refuses an --out outside the repo unless it is
 *     absolute AND --force is given.
 *   - Prints a summary: kept N, excluded M by folder, capped at max.
 * ============================================================================
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_OUT = '.realvault-snapshot';
const DEFAULT_EXCLUDE = ['EmailLog']; // PII default-deny

// ---------------------------------------------------------------------------
// Pure path-filter helper (exported for unit tests in eval/__tests__).
// ---------------------------------------------------------------------------

/**
 * Decide whether a vault-relative note path passes the include/exclude folder
 * filters. Prefix match on path segments; EXCLUDE always wins over INCLUDE.
 *
 * A prefix like `EmailLog` matches `EmailLog/x.md` and `EmailLog` itself but
 * NOT `EmailLogArchive/x.md` (segment-boundary aware) so filters are precise.
 *
 * @param {string} relPath  vault-relative path, forward-slashed
 * @param {{ include?: string[], exclude?: string[] }} filters
 * @returns {boolean} true if the note should be kept
 */
export function shouldInclude(relPath, filters = {}) {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const include = (filters.include ?? []).filter(Boolean);
  const exclude = (filters.exclude ?? []).filter(Boolean);

  const matchesPrefix = (prefix) => {
    const p = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p) return false;
    return norm === p || norm.startsWith(p + '/');
  };

  // exclude wins, even when inside an included parent
  if (exclude.some(matchesPrefix)) return false;
  // no include list => include everything not excluded
  if (include.length === 0) return true;
  return include.some(matchesPrefix);
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    source: 'local',
    from: undefined,
    server: process.env.BRAIN_SERVER || undefined,
    token: process.env.BRAIN_TOKEN || undefined,
    out: DEFAULT_OUT,
    include: [],
    exclude: DEFAULT_EXCLUDE.slice(),
    maxNotes: undefined,
    force: false,
  };
  const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--server') args.server = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--include') args.include = list(argv[++i]);
    else if (a === '--exclude') args.exclude = list(argv[++i]); // explicit '' clears default
    else if (a === '--max-notes') args.maxNotes = parseInt(argv[++i], 10) || undefined;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--include=')) args.include = list(a.slice('--include='.length));
    else if (a.startsWith('--exclude=')) args.exclude = list(a.slice('--exclude='.length));
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a.startsWith('--max-notes=')) args.maxNotes = parseInt(a.slice('--max-notes='.length), 10) || undefined;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Source: local vault dir
// ---------------------------------------------------------------------------

async function walkMarkdown(root) {
  /** @type {string[]} */
  const out = [];
  async function recurse(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git, .obsidian, etc.
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await recurse(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  }
  await recurse(root);
  return out;
}

async function collectLocal(fromDir) {
  const root = path.resolve(fromDir);
  const files = await walkMarkdown(root);
  const notes = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    notes.push({ relPath: rel, read: () => readFile(abs, 'utf-8') });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Source: obsidian-brain MCP over HTTP JSON-RPC (list + get only, no upload)
// ---------------------------------------------------------------------------

async function mcpCall(server, token, name, params) {
  const res = await fetch(server.replace(/\/$/, '') + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: params },
    }),
  });
  if (!res.ok) throw new Error(`MCP ${name} HTTP ${res.status}`);
  const text = await res.text();
  // Server may reply as JSON or as an SSE `data:` frame; handle both.
  const jsonLine = text.includes('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : text;
  const payload = JSON.parse(jsonLine);
  if (payload.error) throw new Error(`MCP ${name}: ${payload.error.message}`);
  // tools/call returns { content: [{ type:'text', text: '<json>' }] }.
  const content = payload.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : payload.result;
}

async function collectMcp(server, token) {
  if (!server) throw new Error('--source mcp requires --server (or BRAIN_SERVER)');
  const paths = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const page = await mcpCall(server, token, 'notes_list', {
      directory: '.',
      pattern: '**/*.md',
      limit: pageSize,
      offset,
    });
    const items = Array.isArray(page) ? page : page.notes ?? page.results ?? [];
    if (items.length === 0) break;
    for (const it of items) {
      const p = typeof it === 'string' ? it : it.path ?? it.relPath;
      if (p) paths.push(p);
    }
    if (items.length < pageSize) break;
  }
  return paths.map((relPath) => ({
    relPath: relPath.replace(/\\/g, '/'),
    read: async () => {
      const note = await mcpCall(server, token, 'notes_get', { path: relPath });
      return typeof note === 'string' ? note : note.content ?? '';
    },
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'snapshot-vault.mjs --source local|mcp [--from DIR] [--server URL --token T]\n' +
        '  --out .realvault-snapshot --include A,B --exclude EmailLog --max-notes N [--force]\n',
    );
    return;
  }

  // Guard the output path: writes stay inside the repo unless explicitly forced.
  const outAbs = path.resolve(args.out);
  const repoRoot = path.resolve(process.cwd());
  const insideRepo = outAbs === repoRoot || outAbs.startsWith(repoRoot + path.sep);
  if (!insideRepo && !(path.isAbsolute(args.out) && args.force)) {
    throw new Error(
      `Refusing to write outside the repo: ${outAbs}. Pass an absolute --out AND --force to override.`,
    );
  }

  // Gather the source note list.
  let notes;
  if (args.source === 'local') {
    if (!args.from) throw new Error('--source local requires --from <vault-dir>');
    const s = await stat(args.from).catch(() => null);
    if (!s || !s.isDirectory()) throw new Error(`--from is not a directory: ${args.from}`);
    notes = await collectLocal(args.from);
  } else if (args.source === 'mcp') {
    notes = await collectMcp(args.server, args.token);
  } else {
    throw new Error(`Unknown --source: ${args.source} (expected local|mcp)`);
  }

  // Filter by folder (exclude wins), then sort + cap deterministically.
  let excludedByFolder = 0;
  const kept = notes.filter((n) => {
    const ok = shouldInclude(n.relPath, { include: args.include, exclude: args.exclude });
    if (!ok) excludedByFolder++;
    return ok;
  });
  kept.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const cappedOut = args.maxNotes !== undefined ? kept.slice(0, args.maxNotes) : kept;
  const cappedCount = kept.length - cappedOut.length;

  // Write.
  let written = 0;
  for (const n of cappedOut) {
    const dest = path.join(outAbs, n.relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    const content = await n.read();
    await writeFile(dest, content, 'utf-8');
    written++;
  }

  process.stdout.write(
    `snapshot-vault: source=${args.source} → ${outAbs}\n` +
      `  found     ${notes.length}\n` +
      `  excluded  ${excludedByFolder}  (by --exclude ${JSON.stringify(args.exclude)}` +
      (args.include.length ? ` / --include ${JSON.stringify(args.include)}` : '') +
      `)\n` +
      `  capped    ${cappedCount}  (--max-notes ${args.maxNotes ?? '∞'})\n` +
      `  WRITTEN   ${written}\n`,
  );
}

// Run only when invoked directly (not when imported by the test for
// shouldInclude). import.meta.url === the invoked script's file URL.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
    process.exit(1);
  });
}
