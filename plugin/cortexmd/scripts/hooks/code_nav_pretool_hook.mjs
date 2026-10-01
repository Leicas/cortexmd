#!/usr/bin/env node
// Claude Code PreToolUse hook — code-nav advisory for Read / Grep.
//
// When the agent is about to Read / Grep inside a repo that's been indexed by
// `cortexmd`, this hook injects a short additionalContext string suggesting
// the cheaper `code_*` MCP tools (`code_file_outline`, `code_symbol_search`,
// `code_symbol_get`).
//
// Awareness-only by design: NEVER blocks the tool, NEVER prompts the user,
// and says each thing ONCE: one suggestion per (session, file|pattern) and at
// most 15 per session (state under stateRoot()/sessions/<session_id>/).
// Glob always passes through. Paths under a git worktree (a `.git` FILE
// between the registered repo root and the target) pass through too — the
// index belongs to the main checkout.
//
// On any error, emits `{}` and exits 0 so a broken hook can never break a
// session. Pattern matches `code_nav_hint_hook.mjs` (SessionStart variant).
//
// Disable via CORTEXMD_HOOKS_DISABLE=1 or CORTEXMD_CODE_NAV_HINT_DISABLE=1.

import { statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  readStdin, passthrough, logError, codeRepoList, CODE_EXTS,
  sessionStatePath, readState, writeState, HOOK_DISABLED,
} from './_mcp_rest.mjs';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

if (HOOK_DISABLED || envFlag('CORTEXMD_CODE_NAV_HINT_DISABLE')) passthrough();

const MAX_HINTS_PER_SESSION = 15;

function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  // Strip Windows extended-length prefix \\?\
  const s = p.replace(/^\\\\\?\\/, '');
  return s.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function extOf(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return '';
  return path.slice(i).toLowerCase();
}

/**
 * Find the registered repo whose abs_path is a prefix of `target`.
 * Returns { slug, repoAbs, relPosix } or null.
 */
function matchRepo(target, payload) {
  if (!payload || !Array.isArray(payload.repos)) return null;
  const t = normalizePath(target);
  if (!t) return null;
  let best = null;
  for (const repo of payload.repos) {
    for (const p of repo.paths ?? []) {
      const abs = normalizePath(p.abs_path);
      if (!abs) continue;
      if (t === abs || t.startsWith(abs + '/')) {
        if (!best || abs.length > best.absLen) {
          const rel = t === abs ? '' : t.slice(abs.length + 1);
          best = { slug: repo.slug, repoAbs: abs, absLen: abs.length, relPosix: rel };
        }
      }
    }
  }
  return best;
}

/**
 * True when a directory strictly between the registered repo root and the
 * target holds a `.git` FILE (git worktree pointer). Walks the ORIGINAL path
 * (normalizePath lowercases, which would break stat on case-sensitive FS).
 */
function isUnderWorktree(originalTarget, match) {
  try {
    let dir = dirname(resolvePath(String(originalTarget).replace(/^\\\\\?\\/, '')));
    for (let i = 0; i < 64; i++) {
      const n = normalizePath(dir);
      if (!n || n === match.repoAbs || !n.startsWith(match.repoAbs + '/')) break;
      try { if (statSync(join(dir, '.git')).isFile()) return true; } catch { /* no .git here */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* best-effort */ }
  return false;
}

function suggestForRead(rel, slug) {
  return [
    `cortexmd: \`${rel}\` is in indexed repo \`${slug}\`. For the next lookups prefer`,
    `  code_file_outline(repo="${slug}", path="${rel}") → code_symbol_get(id)   (≈60 tokens/symbol instead of the whole file)`,
    `Read stays right for literal text (comments, strings, config). Shown once per file.`,
  ].join('\n');
}

function suggestForGrep(q, slug) {
  return [
    `cortexmd: for identifier lookups in \`${slug}\`, code_symbol_search(query="${q}", repo="${slug}") returns ranked symbols (~60 tokens each).`,
    `Keep Grep for free text, comments and non-source files. Shown once per pattern.`,
  ].join('\n');
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }
  if (!evt || typeof evt !== 'object') return passthrough();

  const tool = evt.tool_name ?? evt.toolName;
  const input = evt.tool_input ?? evt.toolInput ?? {};
  if (tool !== 'Read' && tool !== 'Grep') return passthrough();

  // Resolve target path: Read uses file_path; Grep may use `path`.
  let target = null;
  let key = '';
  if (tool === 'Read') {
    target = typeof input.file_path === 'string' ? input.file_path : null;
    if (!target || !CODE_EXTS.has(extOf(target))) return passthrough();
  } else {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (!pattern || pattern.length < 3) return passthrough();
    // Skip patterns that look like regex (structural search, not symbol lookup).
    if (/[\\^$()|+?{}\[\]]/.test(pattern)) return passthrough();
    target = typeof input.path === 'string' && input.path ? input.path : (evt.cwd ?? null);
    key = `grep:${pattern}`;
  }
  if (!target) return passthrough();

  let payload;
  try { payload = await codeRepoList(); }
  catch (err) { logError('code-nav-pretool:repoList', err); return passthrough(); }
  if (!payload) return passthrough();

  const match = matchRepo(target, payload);
  if (!match) return passthrough();
  if (tool === 'Read' && !match.relPosix) return passthrough(); // repo root itself
  if (isUnderWorktree(target, match)) return passthrough();
  if (!key) key = `read:${match.slug}:${match.relPosix}`;

  // Once per (session, key) and at most N per session.
  const statePath = sessionStatePath('pretool-hints', evt.session_id);
  const state = readState(statePath);
  const seen = Array.isArray(state.seen) ? state.seen : [];
  if (seen.includes(key) || seen.length >= MAX_HINTS_PER_SESSION) return passthrough();
  writeState(statePath, { seen: [...seen, key] });

  const hint = tool === 'Read'
    ? suggestForRead(match.relPosix, match.slug)
    : suggestForGrep(String(input.pattern).replace(/"/g, '\\"'), match.slug);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: hint,
    },
  }) + '\n');
}

main().catch((err) => { logError('code-nav-pretool:main', err); passthrough(); });
