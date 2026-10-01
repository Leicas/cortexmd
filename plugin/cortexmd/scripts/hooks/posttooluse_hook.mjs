#!/usr/bin/env node
// Claude Code PostToolUse hook — deterministic capture of high-signal tool
// outcomes. Pure regex over Bash commands. Captures only on success (no error
// in tool_response) and stays silent by default (`{}` after the store);
// CORTEXMD_HOOK_VERBOSE=1 adds a one-line confirmation.
//
// Patterns we capture (each emits a single observation):
//   - systemctl enable|disable|restart|start|stop <unit>
//   - crontab -e / scheduled job changes
//   - chmod <mode> <file>  / chown <owner> <file>
//   - docker compose up|down|restart|build [services...]
//   - git commit -m "<message>"   (one-line summary, no body)
//
// Patterns are evaluated per sub-command (split on && || ; | and newlines),
// anchored at the start of the sub-command, and sub-commands that merely print
// or interpret text (echo, printf, cat, node, python, bash -c …) are ignored —
// `echo 'git commit -m x'` must not create a memory.
//
// Captured memories are tagged `auto-capture` (+ `repo:<slug>`) and excluded
// from hook recall (see RECALL_EXCLUDE tags in _mcp_rest.mjs).
//
// LLM-based extraction is deferred (it spends model credits) and gated behind
// CORTEXMD_AUTO_EXTRACT=1.

import {
  readStdin, passthrough, logError, storeMemory, projectSlug,
  HOOK_DISABLED, HOOK_VERBOSE,
} from './_mcp_rest.mjs';

if (HOOK_DISABLED) passthrough();

const PATTERNS = [
  {
    name: 'systemctl',
    re: /^(?:sudo\s+)?systemctl\s+(enable|disable|restart|start|stop|reload)\s+([\w@.\-]+)/,
    title: (m) => `systemctl ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.slice(0, 240)}\` — service \`${m[2]}\` was \`${m[1]}\`d.`,
    tags: ['systemd', 'auto-capture'],
  },
  {
    name: 'crontab',
    re: /^(?:sudo\s+)?crontab\s+-(e|l)/,
    title: (m) => `crontab -${m[1]}`,
    content: (_m, cmd) => `Edited or listed user crontab via \`${cmd.slice(0, 240)}\`.`,
    tags: ['cron', 'auto-capture'],
  },
  {
    name: 'chmod',
    re: /^(?:sudo\s+)?chmod\s+([0-7]{3,4}|[ugoa]*[+\-=][rwxXst]+)\s+(\S+)/,
    title: (m) => `chmod ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.slice(0, 240)}\` — mode \`${m[1]}\` on \`${m[2]}\`.`,
    tags: ['chmod', 'auto-capture'],
  },
  {
    name: 'chown',
    re: /^(?:sudo\s+)?chown\s+(\S+)\s+(\S+)/,
    title: (m) => `chown ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.slice(0, 240)}\` — owner of \`${m[2]}\` set to \`${m[1]}\`.`,
    tags: ['chown', 'auto-capture'],
  },
  {
    name: 'docker-compose',
    re: /^(?:sudo\s+)?docker\s+compose\s+(up|down|restart|build|pull)(\s+(?:-d|--build|[a-z0-9_-]+))*/,
    title: (m) => `docker compose ${m[1]}`,
    content: (m, cmd) => `Ran \`${cmd.slice(0, 240)}\` — \`docker compose ${m[1]}\`.`,
    tags: ['docker', 'auto-capture'],
  },
  {
    name: 'git-commit',
    re: /^(?:sudo\s+)?git\s+commit\b(?:\s+[-\w=]+)*\s+-m\s+(?:["']([^"']{4,200})["']|([^\s"'][^\n]{3,200}))/,
    // Skip programmatic commits whose message is built via command
    // substitution / heredoc ($(...), backticks, <<EOF) — the real text isn't
    // in the command line, so the capture would just be shell plumbing.
    valid: (m) => {
      const msg = (m[1] ?? m[2] ?? '').trim();
      return msg.length >= 4 && !/\$\(|`|<</.test(msg);
    },
    title: (m) => {
      const msg = (m[1] ?? m[2] ?? '').trim();
      return `git commit: ${msg.slice(0, 60)}`;
    },
    content: (m, _cmd) => {
      const msg = (m[1] ?? m[2] ?? '').trim();
      return `Made a commit with message: "${msg.slice(0, 220)}".`;
    },
    tags: ['git', 'auto-capture'],
  },
];

// Sub-commands that print or interpret their arguments: whatever follows is
// data, not an executed high-signal command.
const PASSIVE_HEAD = /^(?:sudo\s+)?(?:echo|printf|cat|less|more|grep|rg|node|python3?|bash\s+-c|sh\s+-c|pwsh\s+-c|powershell\s+-c)\b/i;

/** Split a shell line into sub-commands on && || ; | and newlines (quotes are not tracked — good enough for an allow-list). */
function splitSubcommands(cmd) {
  return String(cmd)
    .split(/\|\||&&|;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function captureFromBash(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  for (const sub of splitSubcommands(cmd)) {
    if (PASSIVE_HEAD.test(sub)) continue;
    for (const p of PATTERNS) {
      const m = sub.match(p.re);
      if (!m) continue;
      if (p.valid && !p.valid(m)) continue;
      return {
        title: p.title(m),
        content: p.content(m, sub),
        tags: p.tags,
        pattern: p.name,
      };
    }
  }
  return null;
}

function isSuccess(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return true; // best guess
  if (toolResponse.isError === true) return false;
  if (toolResponse.is_error === true) return false;
  if (typeof toolResponse.exit_code === 'number' && toolResponse.exit_code !== 0) return false;
  if (typeof toolResponse.exitCode === 'number' && toolResponse.exitCode !== 0) return false;
  return true;
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }
  if (!evt || typeof evt !== 'object') return passthrough();

  const tool = String(evt.tool_name ?? evt.toolName ?? '').toLowerCase();
  const input = evt.tool_input ?? evt.toolInput ?? {};
  const response = evt.tool_response ?? evt.toolResponse ?? {};

  if (tool !== 'bash' && tool !== 'powershell') return passthrough();
  if (!isSuccess(response)) return passthrough();

  const cmd = input.command ?? input.cmd ?? input.script ?? '';
  const cap = captureFromBash(cmd);
  if (!cap) return passthrough();

  // Anchor the capture to its repo so it joins the graph instead of orphaning.
  const cwd = evt.cwd ?? evt.cwd_path ?? input.cwd ?? '';
  let repo = '';
  try { repo = projectSlug(cwd); } catch { /* best-effort */ }
  const repoLink = repo ? `\n\nProject: [[Projects/${repo}]]` : '';

  let stored = null;
  try {
    stored = await storeMemory({
      content: cap.content + repoLink,
      category: 'observation',
      title: cap.title,
      tags: repo ? [...cap.tags, `repo:${repo}`] : cap.tags,
      source: `hook:PostToolUse:${cap.pattern}`,
    });
  } catch (err) {
    logError('PostToolUse:storeMemory', err);
    return passthrough();
  }

  if (!HOOK_VERBOSE || !stored || typeof stored.path !== 'string') return passthrough();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `📝 cortexmd stored: ${cap.title} → [[${stored.path}]]`,
    },
  }) + '\n');
}

main().catch((err) => { logError('PostToolUse:main', err); passthrough(); });
