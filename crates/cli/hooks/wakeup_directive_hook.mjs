#!/usr/bin/env node
// Claude Code SessionStart hook — machine-scoped memory_wakeup directive.
//
// Emits a SessionStart `additionalContext` directive telling the agent that
// its FIRST action should be to call memory_wakeup with the machine-scoped
// diary agentName (`Claude Code (<hostname>)`). Diaries are kept per-machine,
// so each machine reads/writes its own directory under `Ops/Agent Diaries/`.
//
// The hostname is baked into the emitted text literally so the model copies
// the exact agentName the diary write-hooks use.
//
// Pattern matches the other hooks: read stdin → emit JSON to stdout → exit 0.
// On ANY error, emit `{}` so a broken hook never blocks the user.
//
// Disable via CORTEXMD_HOOKS_DISABLE=1 or CORTEXMD_WAKEUP_DISABLE=1.
// Node built-ins only (plus the shared _mcp_rest helper).

import { diaryAgentName, passthrough, logError, HOOK_DISABLED } from './_mcp_rest.mjs';

function envFlag(name) {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
  if (HOOK_DISABLED || envFlag('CORTEXMD_WAKEUP_DISABLE')) return passthrough();

  // Drain stdin so Claude Code doesn't hang writing to us. We don't need the
  // body, but reading it keeps the contract consistent with the other hooks.
  let stdinBuf = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) stdinBuf += chunk;
  } catch { /* ignore — stdin may be closed on some platforms */ }

  const agent = diaryAgentName();

  const context = [
    `**Your FIRST action this session:** call memory_wakeup (e.g. mcp__cortexmd__memory_wakeup) with agentName="${agent}".`,
    `Diaries are per-machine: this machine reads/writes \`Ops/Agent Diaries/${agent}/\`, so pass that exact agentName to recover the previous session's diary recap and open threads before doing anything else.`,
  ].join('\n');

  return emit(context);
}

main().catch((err) => { logError('wakeup-directive:main', err); passthrough(); });
