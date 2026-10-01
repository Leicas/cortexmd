#!/usr/bin/env node
// Claude Code Stop hook — periodic diary nudge, bounded per session.
//
// Every Nth Stop OF THE SESSION (default: 5, keyed on the event's
// `session_id`) blocks and instructs Claude to call
// agent_diary_append(silent=true) with ONE line. Otherwise emits a no-op so
// the user can stop. `stop_hook_active` is always respected (never re-fires
// inside its own block).
//
// Every diary entry must link the PROJECT and the MACHINE it was written from
// (`· [[Projects/<slug>]] @ [[Machines/<host>]]`): the project slug is derived
// from the event's `cwd` (git repo root basename), the machine from the
// hostname — see diaryLinkContext() in _mcp_rest.mjs.
//
// State: `<stateRoot>/sessions/<session_id>/diary-stop.json` ({ counter }),
// see stateRoot() in _mcp_rest.mjs. Old session dirs are purged (7 days)
// roughly once every ten runs.
// Env: DIARY_STOP_EVERY — throttle interval (default 5).
//      CORTEXMD_PROJECT — override the project slug.
//      CORTEXMD_AGENT_CLIENT — client label in the agentName.
//
// Node built-ins only. Safe on any OS: we swallow all errors and emit a
// pass-through decision so a broken hook never blocks the user.

import {
  diaryAgentName, diaryLinkContext, readStdin, logError,
  sessionStatePath, readState, writeState, purgeOldSessions, HOOK_DISABLED,
} from './_mcp_rest.mjs';

const INTERVAL = Math.max(1, Number.parseInt(process.env.DIARY_STOP_EVERY ?? '5', 10) || 5);

const passthrough = () => {
  process.stdout.write('{}\n');
  process.exit(0);
};

const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
};

async function main() {
  if (HOOK_DISABLED) return passthrough();

  const stdinBuf = await readStdin();

  let stopHookActive = false;
  let cwd = '';
  let sessionId = '';
  try {
    if (stdinBuf.trim()) {
      const evt = JSON.parse(stdinBuf);
      if (evt && typeof evt === 'object') {
        stopHookActive = evt.stop_hook_active === true;
        if (typeof evt.cwd === 'string') cwd = evt.cwd;
        if (typeof evt.session_id === 'string') sessionId = evt.session_id;
      }
    }
  } catch {
    // malformed stdin — treat as inactive
  }
  if (!cwd) {
    try { cwd = process.cwd(); } catch { /* leave empty */ }
  }

  if (stopHookActive) return passthrough();

  const statePath = sessionStatePath('diary-stop', sessionId);
  const state = readState(statePath);
  const counter = (Number.parseInt(state.counter ?? 0, 10) || 0) + 1;
  writeState(statePath, { counter });
  if (counter % 10 === 0) {
    try { purgeOldSessions(7); } catch { /* best-effort */ }
  }

  if (counter % INTERVAL !== 0) return passthrough();

  const agent = diaryAgentName();
  let links = { project: '', machine: '', suffix: '' };
  try { links = diaryLinkContext(cwd); } catch { /* links are best-effort */ }

  const linkParams = [
    links.project ? `project="${links.project}"` : '',
    links.machine ? `machine="${links.machine}"` : '',
  ].filter(Boolean).join(', ');

  return block([
    `cortexmd Stop hook: write one diary line before finishing, then stop.`,
    `Call agent_diary_append(agentName="${agent}", silent=true, source="hook:Stop"${linkParams ? `, ${linkParams}` : ''}, topic="${links.project || 'session'}",`,
    `  entry="<ONE line, no newlines, ≤60 words: what was done → what is still open → files touched>")`,
    links.suffix ? `The server appends "${links.suffix.trim()}" when project/machine are passed; if the tool does not accept them, end the entry with that suffix yourself.` : '',
    `Facts only — no secrets, credentials or pasted third-party text. If nothing changed since your last diary line in this session, stop without writing.`,
  ].filter(Boolean).join('\n'));
}

main().catch((err) => { logError('diary-stop:main', err); passthrough(); });
