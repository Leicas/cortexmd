#!/usr/bin/env node
// Claude Code PreCompact hook — diary snapshot before context compression.
//
// Always fires (compaction is rare and data-losing). Reads stdin only to
// detect stop_hook_active so we don't recurse inside our own block. Uses
// Node built-ins only.

import { diaryAgentName } from './_mcp_rest.mjs';

const agent = diaryAgentName();

const passthrough = () => {
  process.stdout.write('{}\n');
  process.exit(0);
};

const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
};

let stdinBuf = '';
try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdinBuf += chunk;
} catch {
  // stdin unavailable — treat as empty event
}

let stopHookActive = false;
try {
  if (stdinBuf.trim()) {
    const evt = JSON.parse(stdinBuf);
    stopHookActive = evt.stop_hook_active === true;
  }
} catch {
  // malformed stdin — proceed as normal PreCompact
}

if (stopHookActive) passthrough();

block(
  `Before compacting: call mcp__cortexmd__agent_diary_append with agentName="${agent}", ` +
    'silent=true, source="hook:PreCompact", and a paragraph summarizing the key context, ' +
    'decisions, and open work from this conversation. This will be used by memory_wakeup ' +
    'to bootstrap the next session.',
);
