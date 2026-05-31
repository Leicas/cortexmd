#!/usr/bin/env node
// Claude Code PreToolUse hook — memory injection before tool fires.
//
// Classifies the upcoming tool into a mode (read | edit | bash | search | mcp),
// pulls a small set of relevant memories/notes from the deployed cortexmd
// server, and injects them as additionalContext so the agent has scoped recall
// before it acts.
//
// Failures are non-blocking: any error path emits `{}` and exits 0.
//
// Configuration: see hooks/_mcp_rest.mjs.
//
// Modes covered:
//   read|edit  — extract file path, query against the path basename + parent
//                folder name. Useful for "have I touched this file before".
//   bash       — extract first binary + service/container/script names from the
//                command, query for ruled_out / known-failure observations.
//   search     — passthrough (Glob/Grep are already cheap; injection adds noise)
//   mcp        — passthrough (the MCP tool is already vault-aware)

import { readStdin, passthrough, logError, recall, formatMemoryBlock, HOOK_DISABLED, MEMORY_DISABLED, HOOK_MINIMAL } from './_mcp_rest.mjs';

if (HOOK_DISABLED || MEMORY_DISABLED) passthrough();

function classify(toolName) {
  const n = (toolName ?? '').toLowerCase();
  if (n === 'read' || n.includes('readmcpresource')) return 'read';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit') return 'edit';
  if (n === 'bash' || n === 'powershell') return 'bash';
  if (n === 'glob' || n === 'grep') return 'search';
  if (n.startsWith('mcp__')) return 'mcp';
  return 'unknown';
}

function fileQueryFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file !== 'string' || !file) return null;
  // Use basename + parent dir as the recall query
  const parts = file.split(/[\\/]/);
  const base = parts.pop() ?? file;
  const parent = parts.pop() ?? '';
  const trimmed = base.replace(/\.[^.]+$/, ''); // strip extension
  return parent ? `${trimmed} ${parent}` : trimmed;
}

function bashQueryFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  const cmd = input.command;
  if (typeof cmd !== 'string' || !cmd) return null;
  const tokens = new Set();
  // First word (binary)
  const first = cmd.trim().split(/\s+/)[0];
  if (first) tokens.add(first.replace(/^.*[\\/]/, ''));
  // service / container / script targets
  const svc = cmd.match(/(?:systemctl|docker compose|docker exec|docker logs)\s+\S+\s+(\S+)/);
  if (svc) tokens.add(svc[1]);
  const scripts = cmd.match(/(\S+\.(?:sh|py|mjs|ts|tsx|js|jsx|go|rs))\b/g);
  if (scripts) for (const s of scripts) tokens.add(s.replace(/^.*[\\/]/, ''));
  const out = Array.from(tokens).filter(Boolean).slice(0, 4);
  return out.length > 0 ? out.join(' ') : null;
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }

  const tool = evt.tool_name ?? evt.toolName;
  const input = evt.tool_input ?? evt.toolInput ?? {};
  const mode = classify(tool);

  if (mode === 'unknown' || mode === 'search' || mode === 'mcp') return passthrough();

  let query = null;
  if (mode === 'read' || mode === 'edit') query = fileQueryFromInput(input);
  else if (mode === 'bash') query = bashQueryFromInput(input);
  if (!query) return passthrough();

  let res;
  try {
    res = await recall({ query, limit: 3, kinds: 'both' });
  } catch (err) {
    logError('PreToolUse:recall', err);
    return passthrough();
  }
  if (!res) return passthrough();

  const memories = Array.isArray(res.memories) ? res.memories : [];
  const notes = Array.isArray(res.notes) ? res.notes : [];
  if (memories.length === 0 && notes.length === 0) return passthrough();

  const header = HOOK_MINIMAL ? `Relevant memory (${mode})` : `📌 Relevant memory (${mode}, q="${query.slice(0, 40)}")`;
  const block = formatMemoryBlock(memories, notes, header, 700);
  if (!block) return passthrough();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: block,
    },
  }) + '\n');
}

main().catch((err) => { logError('PreToolUse:main', err); passthrough(); });
