#!/usr/bin/env node
// Claude Code PreToolUse hook — code-nav advisory for Read / Glob / Grep.
//
// When the agent is about to Read / Glob / Grep inside a repo that's been
// indexed by `cortexmd`, this hook injects a short additionalContext string
// suggesting the cheaper `code_*` MCP tools (`code_file_outline`,
// `code_symbol_search`, `code_symbol_get`, `code_symbol_callers/callees`).
//
// Awareness-only by design: NEVER blocks the tool, NEVER prompts the user.
// On any error, emits `{}` and exits 0 so a broken hook can never break a
// session. Pattern matches `code_nav_hint_hook.mjs` (SessionStart variant).
//
// Disable via CORTEXMD_HOOKS_DISABLE=1 or CORTEXMD_CODE_NAV_HINT_DISABLE=1.

import { readStdin, passthrough, logError, codeRepoList, HOOK_DISABLED } from './_mcp_rest.mjs';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

if (HOOK_DISABLED || envFlag('CORTEXMD_CODE_NAV_HINT_DISABLE')) passthrough();

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go',
]);

function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  // Strip Windows extended-length prefix \\?\
  let s = p.replace(/^\\\\\?\\/, '');
  return s.toLowerCase().replace(/\\/g, '/');
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

function suggestForRead(filePath, match) {
  const ext = extOf(filePath);
  if (!SOURCE_EXTS.has(ext)) return null;
  if (!match.relPosix) return null; // reading the repo root itself — skip
  return [
    `**Use code_* MCP tools, not Read.** This file is in the indexed repo \`${match.slug}\`:`,
    `  • code_file_outline(repo="${match.slug}", path="${match.relPosix}") — symbols only, no body`,
    `  • code_symbol_search(query="<name>", repo="${match.slug}") — jump to a specific symbol`,
    `  • code_symbol_get(id="<16-hex>") — body of one symbol (capped 200 lines)`,
    `Read is the **fallback** — only use it if you need literal bytes (comments, non-source content, exact imports), or if a code_* tool returned empty.`,
  ].join('\n');
}

function suggestForGrep(input, match) {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern || pattern.length < 3) return null;
  // Skip patterns that look like regex (likely structural search, not symbol lookup)
  if (/[\\^$()|+?{}\[\]]/.test(pattern)) return null;
  // Plain identifier-ish queries map well to code_symbol_search
  const q = pattern.replace(/"/g, '\\"');
  return [
    `**Use code_symbol_search, not Grep**, for symbol-shaped queries in indexed repo \`${match.slug}\`:`,
    `  • code_symbol_search(query="${q}", repo="${match.slug}") — name/signature/docstring search (~60 tokens/result)`,
    `Grep is the **fallback** — only use it for free-text, comments, or non-source files.`,
  ].join('\n');
}

function suggestForGlob(input, match) {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  // Only nudge when the glob pattern targets source extensions
  const targetsSource = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go)(\b|$)/i.test(pattern);
  if (!targetsSource) return null;
  return [
    `**Use code_symbol_search, not Glob**, to enumerate symbols across indexed repo \`${match.slug}\`:`,
    `  • code_symbol_search(query="<term>", repo="${match.slug}") — FTS over names/sigs/docstrings`,
    `  • code_repo_list — confirm what's indexed; combine with code_file_outline per file`,
    `Glob is the **fallback** for non-source files or when the index is incomplete.`,
  ].join('\n');
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }

  const tool = evt.tool_name ?? evt.toolName;
  const input = evt.tool_input ?? evt.toolInput ?? {};
  if (!tool) return passthrough();

  // Resolve target path: Read uses file_path; Grep/Glob may use `path`.
  let target = null;
  if (tool === 'Read') {
    target = typeof input.file_path === 'string' ? input.file_path : null;
  } else if (tool === 'Grep' || tool === 'Glob') {
    target = typeof input.path === 'string' && input.path ? input.path : (evt.cwd ?? null);
  }
  if (!target) return passthrough();

  let payload;
  try { payload = await codeRepoList(); }
  catch (err) { logError('code-nav-pretool:repoList', err); return passthrough(); }
  if (!payload) return passthrough();

  const match = matchRepo(target, payload);
  if (!match) return passthrough();

  let hint = null;
  if (tool === 'Read') hint = suggestForRead(target, match);
  else if (tool === 'Grep') hint = suggestForGrep(input, match);
  else if (tool === 'Glob') hint = suggestForGlob(input, match);

  if (!hint) return passthrough();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: hint,
    },
  }) + '\n');
}

main().catch((err) => { logError('code-nav-pretool:main', err); passthrough(); });
