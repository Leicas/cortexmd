#!/usr/bin/env node
// Claude Code SessionStart hook — code-nav directive + auto-refresh.
//
// When a session starts inside a git repo that contains TS/TSX/JS/JSX/Python/
// Rust/Go/C/C++/Java/Kotlin/Ruby/PHP/Dart source files, this hook:
//   1. Tells the agent that `code_*` MCP tools are the primary way to read
//      code in this repo (Read/Grep are the fallback, not the default).
//   2. Looks the cwd up in the server's repo list. If the repo isn't yet
//      registered, it fire-and-forget spawns `cortexmd <cwd>` so the index
//      gets populated in the background.
//   3. Rate-limits auto-indexing per-cwd so re-opening sessions doesn't
//      kick off a fresh index on every spawn.
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
  passthrough,
  logError,
  HOOK_DISABLED,
} from './_mcp_rest.mjs';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

if (HOOK_DISABLED || envFlag('CORTEXMD_CODE_NAV_HINT_DISABLE')) passthrough();

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go',
  '.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hxx', '.h++', '.h', '.c',
  '.java', '.kt', '.kts', '.rb', '.php', '.dart',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  'target', '__pycache__', 'venv', '.venv', 'vendor',
  '.obsidian', '.sync', '.trash',
]);

const SCAN_DEPTH = 3;
const TIME_BUDGET_MS = 50;

const CONTEXT_INDEXED = [
  "**Code repo — USE cortexmd's `code_*` MCP tools instead of Read/Grep.** They are 60-100× cheaper on TS/TSX/JS/JSX/Python/Rust/Go/C/C++/Java/Kotlin/Ruby/PHP/Dart:",
  "- code_symbol_search(query) — find symbols by name/sig/docstring (~60 tokens/result)",
  "- code_file_outline(repo, path) — file overview without reading the whole file",
  "- code_symbol_get(id) — body of one symbol (capped 200 lines)",
  "- code_symbol_callers(id) / code_symbol_callees(id) — call-graph navigation",
  "- code_change_impact(id) — transitive callers (refactor blast radius)",
  "Read/Grep are the **fallback**: only use them if the symbol is missing from the index, or you genuinely need literal file content (comments, non-source lines, exact bytes).",
].join('\n');

const CONTEXT_REINDEX_KICKED = [
  "**Code repo — USE cortexmd's `code_*` MCP tools instead of Read/Grep** (60-100× cheaper for source-code lookups).",
  "This repo wasn't in the code DB; `cortexmd <cwd>` was just spawned in the background to populate it. Indexing typically completes in <30s for small repos, longer for big ones.",
  "If `code_symbol_search` returns empty, the index isn't ready yet — fall back to Read/Grep for now and retry the code_* tools shortly.",
].join('\n');

const CONTEXT_NO_INDEXER = [
  "**Code repo — USE cortexmd's `code_*` MCP tools instead of Read/Grep** when the repo is indexed.",
  "This repo isn't registered with the code DB and `cortexmd` isn't on PATH. Install from https://github.com/Leicas/cortexmd to enable code_* tools for this repo.",
].join('\n');

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
  return p.replace(/^\\\\\?\\/, '').toLowerCase().replace(/\\/g, '/');
}

function isCwdRegistered(payload, cwd) {
  if (!payload || !Array.isArray(payload.repos)) return false;
  const t = normalizePath(cwd);
  if (!t) return false;
  for (const repo of payload.repos) {
    for (const p of repo.paths ?? []) {
      const abs = normalizePath(p.abs_path);
      if (!abs) continue;
      if (t === abs || t.startsWith(abs + '/') || abs.startsWith(t + '/')) {
        return true;
      }
    }
  }
  return false;
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
  let stdinBuf = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) stdinBuf += chunk;
  } catch { /* ignore */ }

  let cwd = null;
  try {
    if (stdinBuf.trim()) {
      const evt = JSON.parse(stdinBuf);
      if (typeof evt.cwd === 'string' && evt.cwd.length > 0) cwd = evt.cwd;
    }
  } catch {
    return passthrough();
  }
  if (!cwd) return passthrough();

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

  if (payload && isCwdRegistered(payload, cwd)) {
    return emit(CONTEXT_INDEXED);
  }

  // Repo not registered (or repo-list unavailable). If we have a payload,
  // we know the indexer binary works → kick off a background re-index.
  // If payload is null, we can't be sure why; show the install hint.
  if (payload === null) {
    return emit(CONTEXT_NO_INDEXER);
  }

  // Rate-limit per cwd so re-opening sessions doesn't keep spawning.
  if (envFlag('CORTEXMD_CODE_NAV_AUTOINDEX_DISABLE')) {
    return emit(CONTEXT_NO_INDEXER);
  }
  if (!shouldRefreshIndex(cwd)) {
    // We already kicked off recently — assume it's still running or just
    // finished; tell the agent the index is being populated.
    return emit(CONTEXT_REINDEX_KICKED);
  }

  const ok = spawnCortexmdDetached([cwd]);
  if (!ok) return emit(CONTEXT_NO_INDEXER);
  return emit(CONTEXT_REINDEX_KICKED);
}

main().catch((err) => { logError('code-nav-hint:main', err); passthrough(); });
