#!/usr/bin/env node
// Claude Code SessionStart hook — code-nav status line + auto-refresh.
//
// When a session starts inside a git repo that contains TS/TSX/JS/JSX/Python/
// Rust/Go/C/C++/Java/Kotlin/Ruby/PHP/Dart source files, this hook:
//   1. Tells the agent whether this repo is indexed (slug) and the three-step
//      code_* path to use before Read/Grep (the full tool list lives in the
//      instruction file — CORTEXMD.md rule 2 / plugin SKILL.md §1 — and is
//      not repeated here).
//   2. Looks the cwd up in the server's repo list. If the repo isn't yet
//      registered, it fire-and-forget spawns `cortexmd <cwd>` so the index
//      gets populated in the background.
//   3. Rate-limits auto-indexing per-cwd so re-opening sessions doesn't
//      kick off a fresh index on every spawn.
//
// `source` awareness: "resume" → nothing (the context is still there);
// "compact" → the one-line indexed reminder only; startup/clear → full text.
// No indexer available → `{}` (CORTEXMD_HOOK_VERBOSE=1 for a one-liner).
//
// Pattern matches the other hooks: read stdin → emit JSON to stdout → exit 0.
// On ANY error, emit `{}` so a broken hook never blocks the user.
//
// Disable via CORTEXMD_HOOKS_DISABLE=1 or CORTEXMD_CODE_NAV_HINT_DISABLE=1.
// Disable just the auto-refresh via CORTEXMD_CODE_NAV_AUTOINDEX_DISABLE=1.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeRepoList,
  spawnCortexmdDetached,
  shouldRefreshIndex,
  readStdin,
  passthrough,
  logError,
  CODE_EXTS,
  HOOK_DISABLED,
  HOOK_VERBOSE,
} from './_mcp_rest.mjs';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

if (HOOK_DISABLED || envFlag('CORTEXMD_CODE_NAV_HINT_DISABLE')) passthrough();

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  'target', '__pycache__', 'venv', '.venv', 'vendor',
  '.obsidian', '.sync', '.trash',
]);

const SCAN_DEPTH = 3;
const TIME_BUDGET_MS = 50;

const CONTEXT_INDEXED = (slug) => [
  `cortexmd: this repo is indexed as \`${slug}\`. For source files use code_* before Read/Grep:`,
  `  code_file_outline(repo="${slug}", path="<rel>") → code_symbol_search(query, repo="${slug}") → code_symbol_get(id)`,
  `Read/Grep only for literal text or after an empty code_* result (then \`cortexmd index <repo>\` and retry).`,
].join('\n');

const CONTEXT_INDEXED_COMPACT = (slug) =>
  `cortexmd: this repo is indexed as \`${slug}\` — prefer code_file_outline / code_symbol_search / code_symbol_get over Read/Grep for source files.`;

const CONTEXT_REINDEX_KICKED = [
  `cortexmd: indexing this repo in the background (\`cortexmd <cwd>\`, usually under 30 s).`,
  `Use Read/Grep for now; once code_symbol_search(query, repo) returns results, switch to code_* tools (code_file_outline → code_symbol_search → code_symbol_get).`,
].join('\n');

const CONTEXT_NO_INDEXER =
  'cortexmd: repo not indexed and `cortexmd` is not on PATH — code_* tools are unavailable here; use Read/Grep.';

function hasCodeFile(root, deadlineMs) {
  const queue = [{ p: root, d: 0 }];
  while (queue.length > 0) {
    if (Date.now() > deadlineMs) return false;
    const { p, d } = queue.shift();
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (Date.now() > deadlineMs) return false;
      const name = e.name;
      if (e.isFile()) {
        const dot = name.lastIndexOf('.');
        if (dot >= 0) {
          const ext = name.slice(dot).toLowerCase();
          if (CODE_EXTS.has(ext)) return true;
        }
      } else if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.') continue;
        if (d + 1 <= SCAN_DEPTH) queue.push({ p: join(p, name), d: d + 1 });
      }
    }
  }
  return false;
}

function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  return p.replace(/^\\\\\?\\/, '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Slug of the registered repo containing (or contained in) `cwd`, or null. */
function registeredSlug(payload, cwd) {
  if (!payload || !Array.isArray(payload.repos)) return null;
  const t = normalizePath(cwd);
  if (!t) return null;
  let best = null;
  for (const repo of payload.repos) {
    for (const p of repo.paths ?? []) {
      const abs = normalizePath(p.abs_path);
      if (!abs) continue;
      if (t === abs || t.startsWith(abs + '/') || abs.startsWith(t + '/')) {
        if (!best || abs.length > best.len) best = { slug: repo.slug, len: abs.length };
      }
    }
  }
  return best ? String(best.slug || '') || null : null;
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }) + '\n');
}

async function main() {
  const stdinBuf = await readStdin();

  let cwd = null;
  let source = '';
  try {
    if (stdinBuf.trim()) {
      const evt = JSON.parse(stdinBuf);
      if (evt && typeof evt.cwd === 'string' && evt.cwd.length > 0) cwd = evt.cwd;
      if (evt && typeof evt.source === 'string') source = evt.source;
    }
  } catch {
    return passthrough();
  }
  if (!cwd) return passthrough();
  if (source === 'resume') return passthrough();

  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) return passthrough();
  } catch {
    return passthrough();
  }
  if (!existsSync(join(cwd, '.git'))) return passthrough();

  const deadline = Date.now() + TIME_BUDGET_MS;
  let isCodeRepo = false;
  try {
    isCodeRepo = hasCodeFile(cwd, deadline);
  } catch {
    return passthrough();
  }
  if (!isCodeRepo) return passthrough();

  // Check whether the cwd is already registered with the code DB.
  let payload = null;
  try {
    payload = await codeRepoList();
  } catch (err) {
    logError('code-nav-hint:repoList', err);
  }

  const slug = registeredSlug(payload, cwd);
  if (slug) {
    return emit(source === 'compact' ? CONTEXT_INDEXED_COMPACT(slug) : CONTEXT_INDEXED(slug));
  }
  if (source === 'compact') return passthrough();

  // Repo not registered (or repo-list unavailable). If we have a payload,
  // we know the indexer binary works → kick off a background re-index.
  // If payload is null, we can't be sure why; stay quiet unless verbose.
  if (payload === null || envFlag('CORTEXMD_CODE_NAV_AUTOINDEX_DISABLE')) {
    return HOOK_VERBOSE ? emit(CONTEXT_NO_INDEXER) : passthrough();
  }

  // Rate-limit per cwd so re-opening sessions doesn't keep spawning.
  if (!shouldRefreshIndex(cwd)) {
    // We already kicked off recently — assume it's still running or just
    // finished; tell the agent the index is being populated.
    return emit(CONTEXT_REINDEX_KICKED);
  }

  const ok = spawnCortexmdDetached([cwd]);
  if (!ok) return HOOK_VERBOSE ? emit(CONTEXT_NO_INDEXER) : passthrough();
  return emit(CONTEXT_REINDEX_KICKED);
}

main().catch((err) => { logError('code-nav-hint:main', err); passthrough(); });
