#!/usr/bin/env node
// Claude Code PreCompact hook — one diary handoff line before context
// compression, at most ONCE per session.
//
// Compaction is data-losing, so the first PreCompact of a session (manual or
// auto, keyed on the event's `session_id`) blocks and asks for a single
// self-contained handoff line via agent_diary_append(silent=true). A second
// PreCompact in the same session passes through: blocking again with a full
// context would just loop. Uses Node built-ins only.
//
// Every diary entry must link the PROJECT and the MACHINE it was written from
// (`· [[Projects/<slug>]] @ [[Machines/<host>]]`) — see diaryLinkContext() in
// _mcp_rest.mjs. Env: CORTEXMD_PROJECT overrides the project slug;
// CORTEXMD_AGENT_CLIENT the client label in the agentName.
// State: `<stateRoot>/sessions/<session_id>/precompact.json` ({ blocked }).

import {
  diaryAgentName, diaryLinkContext, readStdin, logError,
  sessionStatePath, readState, writeState, HOOK_DISABLED,
  isServerUnreachable,
} from './_mcp_rest.mjs';

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
  let trigger = 'auto';
  try {
    if (stdinBuf.trim()) {
      const evt = JSON.parse(stdinBuf);
      if (evt && typeof evt === 'object') {
        // Not part of the PreCompact event today; harmless guard against recursion.
        stopHookActive = evt.stop_hook_active === true;
        if (typeof evt.cwd === 'string') cwd = evt.cwd;
        if (typeof evt.session_id === 'string') sessionId = evt.session_id;
        if (typeof evt.trigger === 'string' && evt.trigger) trigger = evt.trigger;
      }
    }
  } catch {
    // malformed stdin — proceed as normal PreCompact
  }
  if (!cwd) {
    try { cwd = process.cwd(); } catch { /* leave empty */ }
  }

  if (stopHookActive) return passthrough();

  // Server found unreachable earlier this session (marker still fresh): the
  // handoff write would fail, so pass through WITHOUT consuming the one-shot —
  // a later PreCompact can still ask once the server is back.
  if (sessionId && isServerUnreachable(sessionId)) return passthrough();

  const statePath = sessionStatePath('precompact', sessionId);
  if (readState(statePath).blocked === true) return passthrough();
  writeState(statePath, { blocked: true, trigger });

  const agent = diaryAgentName();
  let links = { project: '', machine: '', suffix: '' };
  try { links = diaryLinkContext(cwd); } catch { /* links are best-effort */ }

  const linkParams = [
    links.project ? `project="${links.project}"` : '',
    links.machine ? `machine="${links.machine}"` : '',
  ].filter(Boolean).join(', ');

  return block([
    `cortexmd PreCompact hook (${trigger}): the context is about to be compacted — save a handoff first, then compact again.`,
    `Call agent_diary_append(agentName="${agent}", silent=true, source="hook:PreCompact"${linkParams ? `, ${linkParams}` : ''}, topic="${links.project || 'session'} handoff",`,
    `  entry="<ONE line, no newlines, ≤120 words: goal → decisions and why → current state → next steps → files, branch and commands needed to resume>")`,
    links.suffix ? `The server appends "${links.suffix.trim()}" when project/machine are passed; if the tool does not accept them, end the entry with that suffix yourself.` : '',
    `memory_wakeup reads this line after compaction, so it must be self-contained. Facts only — no secrets or pasted third-party text. If a decision is durable, also memory_store(category="decision") it.`,
  ].filter(Boolean).join('\n'));
}

main().catch((err) => { logError('precompact-diary:main', err); passthrough(); });
