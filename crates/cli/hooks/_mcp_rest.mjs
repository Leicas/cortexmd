// Shared helpers for cortexmd Claude Code hooks.
//
// Hooks delegate ALL credential resolution + HTTP to the Rust client
// (`cortexmd`), via subcommands that mirror the server's `/api/recall`,
// `/api/store-memory`, and `/api/code-repo-list` endpoints. The hook scripts
// only glue Claude Code event JSON into CLI args and emit `additionalContext`.
//
//   cortexmd recall --query "..." --format block
//   cortexmd store-memory --content "..." --category observation --source "..."
//   cortexmd repo-list
//
// Why: the Rust client already does the right thing for credentials —
// it picks up env (MCP_URL/MCP_API_KEY), then OAuth token cache, then
// `~/.config/cortexmd/config.toml`, then Claude Code's MCP config.
// Replicating that in JS was duplicate work; spawning the binary gives us
// one source of truth and lets every future hook use the same resolution
// chain.
//
// Configuration:
//   CORTEXMD_BIN            override the binary path (default: `cortexmd`,
//                           resolved against $PATH).
//   CORTEXMD_HOOK_TIMEOUT_MS  per-call subprocess timeout (default 4000).
//   CORTEXMD_HOOKS_DISABLE    if "1"/"true", every hook silently passes through.
//   CORTEXMD_HOOK_MINIMAL     if "1"/"true", drop nice-to-have parts of hook output.
//   CORTEXMD_MEMORY_DISABLE   if "1"/"true", suppress memory injection blocks.
//
// Failures NEVER block the user — every entry-point swallows errors and
// emits a no-op `{}` so a broken hook never breaks the session.
//
// Node built-ins only.

import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, statSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';

const TIMEOUT_MS = Number.parseInt(process.env.CORTEXMD_HOOK_TIMEOUT_MS ?? '4000', 10) || 4000;
const CORTEXMD_BIN = process.env.CORTEXMD_BIN ?? 'cortexmd';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const HOOK_DISABLED = envFlag('CORTEXMD_HOOKS_DISABLE');
export const HOOK_MINIMAL = envFlag('CORTEXMD_HOOK_MINIMAL');
export const MEMORY_DISABLED = envFlag('CORTEXMD_MEMORY_DISABLE');

// Machine-scoped diary agent name: `Claude Code (<hostname>)`, so each machine
// gets its own directory under `Ops/Agent Diaries/`. The host segment is
// sanitized the same way the server sanitizes a diary agentName (strip path
// separators and `..`). Falls back to plain `Claude Code` if the hostname is
// empty or os.hostname() throws.
export function diaryAgentName() {
  try {
    const host = (hostname() ?? '')
      .replace(/[/\\]/g, '')
      .replace(/\.\./g, '')
      .trim();
    if (host) return `Claude Code (${host})`;
  } catch { /* fall through to default */ }
  return 'Claude Code';
}

const STATE_DIR = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
export const ERROR_LOG = join(STATE_DIR, 'cortexmd', 'hook-errors.log');
const ERROR_LOG_MAX = 2 * 1024 * 1024;

export function logError(stage, err) {
  try {
    mkdirSync(dirname(ERROR_LOG), { recursive: true });
    try {
      const st = statSync(ERROR_LOG);
      if (st.size > ERROR_LOG_MAX) {
        try { renameSync(ERROR_LOG, ERROR_LOG + '.1'); } catch { /* ignore */ }
      }
    } catch { /* file doesn't exist yet */ }
    const msg = err && err.message ? err.message : String(err);
    appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${stage}: ${msg}\n`);
  } catch { /* swallow */ }
}

export function passthrough() {
  process.stdout.write('{}\n');
  process.exit(0);
}

export async function readStdin() {
  let buf = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) buf += chunk;
  } catch { /* ignore */ }
  return buf;
}

/**
 * Spawn `cortexmd <args...>` and return { stdout, stderr, status }. ENOENT is
 * treated as a soft failure (binary not installed → hooks no-op silently).
 */
function runCortexmd(args, opts = {}) {
  const result = spawnSync(CORTEXMD_BIN, args, {
    timeout: opts.timeout ?? TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      // Binary not on PATH — return null instead of logging on every hook fire.
      return { stdout: '', stderr: '', status: -1, missing: true };
    }
    return { stdout: '', stderr: String(result.error), status: -1, missing: false };
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    missing: false,
  };
}

/**
 * Same shape as the server's `/api/recall` response:
 *   { query, memories: [...], notes: [...] }
 * Returns null when the binary is missing OR creds are unresolved OR the
 * call errored. Errors logged best-effort.
 */
export async function recall({ query, limit = 5, kinds = 'both' }) {
  const args = [
    'recall',
    '--query', query,
    '--limit', String(limit),
    '--kinds', kinds,
    '--format', 'json',
  ];
  const r = runCortexmd(args);
  if (r.missing) return null;
  if (r.status !== 0) {
    logError('recall:cortexmd', new Error(`status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`));
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    logError('recall:parse', err);
    return null;
  }
}

/**
 * Same shape as the server's `/api/recall` response, but rendered as a
 * markdown block by the Rust side (saves a JSON round-trip). Returns the
 * formatted string or "" when there's nothing to inject.
 */
export async function recallBlock({ query, limit = 3, kinds = 'both', header, maxChars = 800 }) {
  const args = [
    'recall',
    '--query', query,
    '--limit', String(limit),
    '--kinds', kinds,
    '--format', 'block',
    '--max-chars', String(maxChars),
  ];
  if (header) args.push('--header', header);
  const r = runCortexmd(args);
  if (r.missing) return '';
  if (r.status !== 0) {
    logError('recallBlock:cortexmd', new Error(`status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`));
    return '';
  }
  return (r.stdout || '').replace(/\s+$/, '');
}

export async function storeMemory({ content, category = 'observation', title, tags = [], source }) {
  const args = ['store-memory', '--content', content, '--category', category, '--format', 'json'];
  if (title) args.push('--title', title);
  if (source) args.push('--source', source);
  for (const t of tags) args.push('--tag', t);
  const r = runCortexmd(args);
  if (r.missing) return null;
  if (r.status !== 0) {
    logError('storeMemory:cortexmd', new Error(`status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`));
    return null;
  }
  try { return JSON.parse(r.stdout); }
  catch (err) {
    logError('storeMemory:parse', err);
    return null;
  }
}

const REPO_LIST_CACHE = join(dirname(ERROR_LOG), 'repo-list-cache.json');
const REPO_LIST_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * Repo list cache wrapper. Reads `${XDG_STATE_HOME}/cortexmd/repo-list-cache.json`
 * if fresh; otherwise spawns `cortexmd repo-list` to refresh it. The 10-min
 * TTL keeps the PreToolUse hot path cheap. Returns null if the binary is
 * missing AND the cache is empty.
 */
export async function codeRepoList({ maxAgeMs = REPO_LIST_TTL_MS } = {}) {
  try {
    const st = statSync(REPO_LIST_CACHE);
    if (Date.now() - st.mtimeMs < maxAgeMs) {
      return JSON.parse(readFileSync(REPO_LIST_CACHE, 'utf8'));
    }
  } catch { /* cache miss / unreadable */ }

  // Refresh via the Rust client (handles credentials).
  const r = runCortexmd(['repo-list']);
  if (!r.missing && r.status === 0 && r.stdout) {
    try {
      const payload = JSON.parse(r.stdout);
      if (payload && Array.isArray(payload.repos)) {
        try {
          mkdirSync(dirname(REPO_LIST_CACHE), { recursive: true });
          writeFileSync(REPO_LIST_CACHE, JSON.stringify(payload));
        } catch { /* cache write best-effort */ }
        return payload;
      }
    } catch (err) {
      logError('codeRepoList:parse', err);
    }
  } else if (!r.missing) {
    logError('codeRepoList:cortexmd', new Error(`status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`));
  }

  // Fall back to stale cache if any (better stale than nothing).
  try { return JSON.parse(readFileSync(REPO_LIST_CACHE, 'utf8')); }
  catch { return null; }
}

/**
 * Fire-and-forget spawn of `cortexmd <args...>`. Detaches from the parent so
 * the hook can exit immediately while indexing runs in the background. Returns
 * true if the spawn was issued, false if the binary is missing or spawn threw
 * synchronously. Errors are swallowed.
 */
export function spawnCortexmdDetached(args) {
  try {
    const child = spawn(CORTEXMD_BIN, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      if (err && err.code !== 'ENOENT') logError('spawnCortexmdDetached:child', err);
    });
    child.unref();
    return true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') logError('spawnCortexmdDetached', err);
    return false;
  }
}

const INDEX_STAMPS_DIR = join(dirname(ERROR_LOG), 'index-stamps');
const INDEX_RATE_LIMIT_MS = 30 * 60 * 1000;

/**
 * Per-path rate-limit gate for auto-indexing. Returns true if the caller
 * should kick off an index refresh now (and stamps the path so subsequent
 * calls within `withinMs` skip). Returns false when a recent stamp exists.
 *
 * The stamp is committed eagerly (before the actual index runs) so a slow /
 * crashing indexer doesn't loop on every SessionStart.
 */
export function shouldRefreshIndex(repoAbsPath, withinMs = INDEX_RATE_LIMIT_MS) {
  if (typeof repoAbsPath !== 'string' || !repoAbsPath) return false;
  const key = createHash('sha1').update(repoAbsPath).digest('hex').slice(0, 16);
  const stamp = join(INDEX_STAMPS_DIR, `${key}.txt`);
  try {
    const st = statSync(stamp);
    if (Date.now() - st.mtimeMs < withinMs) return false;
  } catch { /* no stamp */ }
  try {
    mkdirSync(INDEX_STAMPS_DIR, { recursive: true });
    writeFileSync(stamp, `${repoAbsPath}\n${new Date().toISOString()}\n`);
  } catch { /* best-effort */ }
  return true;
}

/**
 * Format up to N memories as a compact context block. Returns "" when
 * there's nothing useful to inject. Mirrors the Rust-side block renderer
 * so callers using `recall()` (JSON shape) can format client-side without
 * a second round-trip.
 */
export function formatMemoryBlock(memories = [], notes = [], header = '📌 Relevant memory', maxChars = 800) {
  const picks = [];
  for (const m of memories) {
    if (!m || !m.path) continue;
    const cat = m.category ? ` [${m.category}]` : '';
    const temp = m.temperature ? ` ${m.temperature}` : '';
    const snip = (m.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    picks.push(`- [[${m.path}]]${cat}${temp}: ${snip}`);
  }
  for (const n of notes) {
    if (!n || !n.path) continue;
    if (picks.length >= 5) break;
    const snip = (n.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    picks.push(`- [[${n.path}]]: ${snip}`);
  }
  if (picks.length === 0) return '';
  let body = `${header}:\n${picks.join('\n')}`;
  if (body.length > maxChars) body = body.slice(0, maxChars - 3) + '...';
  return body;
}
