#!/usr/bin/env node
/* eslint-disable no-console */
// Client-side code-nav indexer.
//
// Walks a git checkout, parses with tree-sitter, and POSTs the resulting
// payload to a deployed cortexmd server via the `code_ingest_repo` tool.
// Use this when the server cannot reach the source tree (e.g. Docker MCP
// without the dev tree mounted on the container).
//
// Usage:
//   node bin/code-index.mjs <repo-path> [--slug NAME] [--server URL]
//                           [--api-key KEY] [--full-replace=true|false] [--dry-run]
// Env (CLI flags override):
//   MCP_URL        — server URL (http://localhost:3000 by default)
//   MCP_API_KEY    — required (Bearer); never logged
//   MACHINE_ID     — overrides hostname
//
// IMPORTANT — symbol-id parity:
//   The server-side `code_ingest_repo` validates that symbol IDs match what
//   the server-side parser would produce for the same source. This requires
//   identical tree-sitter grammar versions on both ends. The shipped
//   `package.json` versions are the source of truth.

import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Provide a stub API_KEY so the project's config module loads. The CLI never
// uses it — server auth uses the user-supplied MCP_API_KEY only.
process.env.API_KEY = process.env.API_KEY || 'cli-stub';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// Lazy ESM imports of compiled modules — pinned to dist so the CLI works on
// any node-runtime without tsx. firstCommitSha and gitOrigin are config-free.
const { firstCommitSha, gitOrigin, walkRepoStandalone } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, 'dist', 'lib', 'code-nav', 'repos.js')).href
);
const { parseFile, normalizeNewlines, sha1Hex } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, 'dist', 'lib', 'code-nav', 'parser.js')).href
);
const { glob } = await import('glob');
const { mcpInitialize, mcpToolsCall } = await import(
  pathToFileURL(path.join(HERE, 'mcp-client.mjs')).href
);

// ─── argv parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = 'true';
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));

if (positional.length < 1 || flags.help) {
  console.error(`Usage: code-index <repo-path> [--slug NAME] [--server URL]`);
  console.error(`                  [--api-key KEY] [--full-replace=true|false] [--dry-run]`);
  process.exit(positional.length < 1 ? 2 : 0);
}

const repoPath = path.resolve(positional[0]);
const slug = (flags.slug ?? path.basename(repoPath)).trim();
const serverUrl = flags.server ?? process.env.MCP_URL ?? 'http://localhost:3000';
const apiKey = flags['api-key'] ?? process.env.MCP_API_KEY;
const fullReplace = (flags['full-replace'] ?? 'true').toLowerCase() !== 'false';
const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === '' || flags['dry-run'] === true;
const machineId = process.env.MACHINE_ID || os.hostname();

if (!dryRun && !apiKey) {
  console.error('error: --api-key or MCP_API_KEY is required (omit only with --dry-run).');
  process.exit(2);
}

if (!existsSync(repoPath)) {
  console.error(`error: path does not exist: ${repoPath}`);
  process.exit(2);
}
if (!existsSync(path.join(repoPath, '.git'))) {
  console.error(`error: not a git repo (no .git/): ${repoPath}`);
  process.exit(2);
}

// ─── git identity ─────────────────────────────────────────────────────────
console.log(`[code-index] repo: ${repoPath}`);
console.log(`[code-index] slug: ${slug}`);
console.log(`[code-index] machine_id: ${machineId}`);

const sha = await firstCommitSha(repoPath);
const repoId = sha.slice(0, 16);
const origin = await gitOrigin(repoPath);
console.log(`[code-index] first_commit_sha: ${sha}`);
console.log(`[code-index] repo_id: ${repoId}`);
console.log(`[code-index] git_origin: ${origin ?? '(none)'}`);

// ─── package.json + workspaces ────────────────────────────────────────────
const packageWorkspaces = {};
const pkgJsonPath = path.join(repoPath, 'package.json');
if (existsSync(pkgJsonPath)) {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      packageWorkspaces.name = pkg.name;
    }
    const wsRaw = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.workspaces?.packages)
        ? pkg.workspaces.packages
        : [];
    if (wsRaw.length > 0) {
      packageWorkspaces.workspaces = wsRaw;
      const wsPkgs = [];
      for (const w of wsRaw) {
        let matches;
        try {
          matches = await glob(w, { cwd: repoPath, posix: true });
        } catch { continue; }
        for (const m of matches) {
          const wsPkgJson = path.join(repoPath, m, 'package.json');
          if (!existsSync(wsPkgJson)) continue;
          try {
            const wsPkg = JSON.parse(readFileSync(wsPkgJson, 'utf-8'));
            if (typeof wsPkg.name !== 'string') continue;
            wsPkgs.push({ name: wsPkg.name, relative_path: m.split(path.sep).join('/') });
          } catch { /* skip bad json */ }
        }
      }
      if (wsPkgs.length > 0) packageWorkspaces.workspace_packages = wsPkgs;
    }
  } catch (err) {
    console.warn(`[code-index] warning: failed to parse package.json: ${err.message}`);
  }
}
if (packageWorkspaces.name) {
  console.log(`[code-index] package_name: ${packageWorkspaces.name}`);
}
if (packageWorkspaces.workspace_packages?.length) {
  console.log(`[code-index] workspace_packages: ${packageWorkspaces.workspace_packages.length}`);
}

// ─── walk + parse ─────────────────────────────────────────────────────────
function languageForPath(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  return null;
}

const relPaths = await walkRepoStandalone({ absolutePath: repoPath });
console.log(`[code-index] discovered ${relPaths.length} candidate files`);

const files = [];
let parsed = 0;
let skipped = 0;
for (const rel of relPaths) {
  const lang = languageForPath(rel);
  if (!lang) { skipped++; continue; }
  const abs = path.join(repoPath, rel);
  let raw;
  let sizeBytes;
  try {
    const buf = await readFile(abs);
    sizeBytes = buf.byteLength;
    raw = buf.toString('utf-8');
  } catch {
    skipped++;
    continue;
  }
  const normalized = normalizeNewlines(raw);
  const contentHash = sha1Hex(normalized);

  let result;
  try {
    result = await parseFile(repoId, rel, lang, normalized);
  } catch (err) {
    skipped++;
    continue;
  }

  files.push({
    relative_path: rel,
    language: lang,
    content_hash: contentHash,
    size_bytes: sizeBytes,
    symbols: result.symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      qualified_name: s.qualifiedName,
      signature: s.signature ?? null,
      docstring: s.docstring ?? null,
      start_line: s.startLine,
      end_line: s.endLine,
      parent_id: s.parentId ?? null,
      content_hash: s.contentHash,
    })),
    calls: result.calls.map((c) => ({
      caller_id: c.callerId,
      callee_name: c.calleeName,
      call_line: c.callLine,
    })),
    imports: result.imports.map((i) => ({
      imported_name: i.importedName,
      source_module: i.sourceModule,
    })),
  });
  parsed++;

  // Progress every 50 files.
  if (parsed % 50 === 0) {
    process.stderr.write(`\r[code-index] parsed ${parsed}/${relPaths.length}`);
  }
}
process.stderr.write(`\r[code-index] parsed ${parsed}/${relPaths.length}\n`);
if (skipped > 0) console.log(`[code-index] skipped ${skipped} (unsupported / unreadable / unparseable)`);

const totalSymbols = files.reduce((a, f) => a + f.symbols.length, 0);
const totalCalls = files.reduce((a, f) => a + f.calls.length, 0);
const totalImports = files.reduce((a, f) => a + f.imports.length, 0);

const payload = {
  repo_id: repoId,
  slug,
  git_origin: origin,
  first_commit_sha: sha,
  machine_id: machineId,
  abs_path: repoPath,
  ...(Object.keys(packageWorkspaces).length > 0 ? { package_workspaces: packageWorkspaces } : {}),
  files,
  full_replace: fullReplace,
};

const payloadJson = JSON.stringify(payload);
const payloadKb = (payloadJson.length / 1024).toFixed(1);
console.log(`[code-index] files=${files.length} symbols=${totalSymbols} calls=${totalCalls} imports=${totalImports}`);
console.log(`[code-index] payload size: ${payloadKb} KB`);

if (dryRun) {
  console.log(`[code-index] --dry-run: not contacting server.`);
  console.log(`[code-index] full_replace=${fullReplace}`);
  console.log(`[code-index] would POST to ${serverUrl}/mcp (tool: code_ingest_repo)`);
  process.exit(0);
}

if (payloadJson.length > 9.5 * 1024 * 1024) {
  console.warn(`[code-index] WARN: payload ${payloadKb} KB approaches the server's 10 MB body limit. Consider chunking (deferred to phase 4).`);
}

// ─── ship to server ───────────────────────────────────────────────────────
console.log(`[code-index] connecting to ${serverUrl} ...`);
let sessionId;
try {
  const init = await mcpInitialize({ url: serverUrl, apiKey });
  sessionId = init.sessionId;
} catch (err) {
  // Never log apiKey. Redact even if the error message somehow contains it.
  const msg = String(err.message ?? err).replaceAll(apiKey, '***');
  console.error(`[code-index] initialize failed: ${msg}`);
  process.exit(1);
}
console.log(`[code-index] session opened: ${sessionId.slice(0, 8)}…`);

let toolResult;
try {
  toolResult = await mcpToolsCall({
    url: serverUrl,
    apiKey,
    sessionId,
    toolName: 'code_ingest_repo',
    args: payload,
  });
} catch (err) {
  const msg = String(err.message ?? err).replaceAll(apiKey, '***');
  console.error(`[code-index] tool call failed: ${msg}`);
  process.exit(1);
}

// MCP wraps results as { content: [{type:'text', text:'<json>'}], ... }
let parsedResult = toolResult;
if (toolResult?.content?.[0]?.type === 'text') {
  try { parsedResult = JSON.parse(toolResult.content[0].text); } catch { /* keep raw */ }
}
console.log('[code-index] ingest result:', JSON.stringify(parsedResult, null, 2));
process.exit(0);
