#!/usr/bin/env node
// Claude Code Stop hook — periodic diary nudge
//
// Every Nth Stop attempt (default: 5) blocks and instructs Claude to call
// agent_diary_append(silent=true). Otherwise emits a no-op so the user can stop.
//
// State: small JSON counter next to this script. Reset by deleting the file.
// Env: DIARY_STOP_EVERY — throttle interval (default 5).
//
// Node built-ins only. Safe on any OS: we swallow all errors and emit a
// pass-through decision so a broken hook never blocks the user.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTERVAL = Math.max(1, Number.parseInt(process.env.DIARY_STOP_EVERY ?? '5', 10) || 5);
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, '.diary-stop-state.json');

const passthrough = () => {
  process.stdout.write('{}\n');
  process.exit(0);
};

const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
};

// Drain stdin so Claude Code doesn't hang writing to us; we don't need the body
// but we do peek at stop_hook_active to avoid re-firing inside our own block.
let stdinBuf = '';
try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdinBuf += chunk;
} catch {
  // ignore — stdin may be closed on some platforms
}

let stopHookActive = false;
try {
  if (stdinBuf.trim()) {
    const evt = JSON.parse(stdinBuf);
    stopHookActive = evt.stop_hook_active === true;
  }
} catch {
  // malformed stdin — treat as inactive
}

if (stopHookActive) passthrough();

let counter = 0;
try {
  const raw = readFileSync(STATE_PATH, 'utf8');
  counter = Number.parseInt(JSON.parse(raw).counter ?? 0, 10) || 0;
} catch {
  // file missing or unreadable — start at 0
}

counter += 1;

try {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ counter, updatedAt: new Date().toISOString() }, null, 2));
} catch {
  // writing state is best-effort; proceed using the in-memory counter
}

if (counter % INTERVAL !== 0) passthrough();

block(
  'Before stopping: call mcp__cortexmd__agent_diary_append with agentName="Claude Code", ' +
    'silent=true, source="hook:Stop", and a 2-3 sentence recap of this session ' +
    '(key decisions, open threads, file paths touched). Include [[wiki-links]] if relevant.',
);
