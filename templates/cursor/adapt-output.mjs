#!/usr/bin/env node
// where to put this: ~/.cursor/hooks/cortexmd/adapt-output.mjs (see templates/cursor/hooks.json).
// Runs one cortexmd Claude Code hook script and converts its output to Cursor's hook schema:
//   hookSpecificOutput.additionalContext  →  { additional_context }   (sessionStart / beforeSubmitPrompt)
//   { decision: "block", reason }          →  { followup_message }     (stop — never blocks)
// Maps Cursor's event fields onto the Claude Code shape the scripts read
// (workspace_roots[0] → cwd, conversation_id → session_id). Node built-ins only; any error → {}.
import { spawnSync } from 'node:child_process';
const script = process.argv[2];
let input = '';
try { for await (const c of process.stdin) input += c; } catch {}
let evt = {};
try { evt = JSON.parse(input || '{}'); } catch {}
const mapped = { ...evt, cwd: evt.cwd ?? evt.workspace_roots?.[0] ?? process.cwd(), session_id: evt.session_id ?? evt.conversation_id ?? '' };
const env = { CORTEXMD_AGENT_CLIENT: 'Cursor', ...process.env };
const r = script ? spawnSync(process.execPath, [script], { input: JSON.stringify(mapped), env, encoding: 'utf8', timeout: 8000, windowsHide: true }) : null;
let out = {};
try { out = JSON.parse((r?.stdout ?? '').trim() || '{}'); } catch {}
const ctx = out?.hookSpecificOutput?.additionalContext;
const res = ctx ? { additional_context: ctx } : out?.decision === 'block' && out.reason ? { followup_message: out.reason } : {};
process.stdout.write(JSON.stringify(res) + '\n');
