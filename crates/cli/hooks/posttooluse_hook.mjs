#!/usr/bin/env node
// Claude Code PostToolUse hook — deterministic capture of high-signal tool
// outcomes. Pure regex over Bash commands and Edit/Write content. Captures
// only on success (no error in tool_response).
//
// Patterns we capture (each emits a single observation):
//   - systemctl enable|disable|restart|start|stop <unit>
//   - crontab -e / scheduled job changes
//   - chmod <mode> <file>  / chown <owner> <file>
//   - docker compose up|down|restart|build [services...]
//   - git commit -m "<message>"   (one-line summary, no body)
//
// LLM-based extraction is deferred (it spends model credits) and gated behind
// CORTEXMD_AUTO_EXTRACT=1.

import {
  readStdin, passthrough, logError, storeMemory,
  HOOK_DISABLED, HOOK_MINIMAL,
} from './_mcp_rest.mjs';

if (HOOK_DISABLED) passthrough();

const PATTERNS = [
  {
    name: 'systemctl',
    re: /^\s*(?:sudo\s+)?systemctl\s+(enable|disable|restart|start|stop|reload)\s+([\w@.\-]+)/m,
    title: (m) => `systemctl ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.trim().slice(0, 240)}\` — service \`${m[2]}\` was \`${m[1]}\`d.`,
    tags: ['systemd', 'auto-capture'],
  },
  {
    name: 'crontab',
    re: /^\s*(?:sudo\s+)?crontab\s+-(e|l)/m,
    title: (m) => `crontab -${m[1]}`,
    content: (_m, cmd) => `Edited or listed user crontab via \`${cmd.trim().slice(0, 240)}\`.`,
    tags: ['cron', 'auto-capture'],
  },
  {
    name: 'chmod',
    re: /^\s*(?:sudo\s+)?chmod\s+([0-7]{3,4}|[ugoa]*[+\-=][rwxXst]+)\s+(\S+)/m,
    title: (m) => `chmod ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.trim().slice(0, 240)}\` — mode \`${m[1]}\` on \`${m[2]}\`.`,
    tags: ['chmod', 'auto-capture'],
  },
  {
    name: 'chown',
    re: /^\s*(?:sudo\s+)?chown\s+(\S+)\s+(\S+)/m,
    title: (m) => `chown ${m[1]} ${m[2]}`,
    content: (m, cmd) => `Ran \`${cmd.trim().slice(0, 240)}\` — owner of \`${m[2]}\` set to \`${m[1]}\`.`,
    tags: ['chown', 'auto-capture'],
  },
  {
    name: 'docker-compose',
    re: /^\s*docker\s+compose\s+(up|down|restart|build|pull)(\s+(?:-d|--build|[a-z0-9_-]+))*/m,
    title: (m) => `docker compose ${m[1]}`,
    content: (m, cmd) => `Ran \`${cmd.trim().slice(0, 240)}\` — \`docker compose ${m[1]}\`.`,
    tags: ['docker', 'auto-capture'],
  },
  {
    name: 'git-commit',
    re: /git\s+commit\s+(?:[-\w]+\s+)*-m\s+(?:["']([^"']{4,200})["']|([^\s][^\n]{4,200}))/,
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

function captureFromBash(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  for (const p of PATTERNS) {
    const m = cmd.match(p.re);
    if (!m) continue;
    if (p.valid && !p.valid(m)) return null;
    return {
      title: p.title(m),
      content: p.content(m, cmd),
      tags: p.tags,
      pattern: p.name,
    };
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

  const tool = (evt.tool_name ?? evt.toolName ?? '').toLowerCase();
  const input = evt.tool_input ?? evt.toolInput ?? {};
  const response = evt.tool_response ?? evt.toolResponse ?? {};

  if (tool !== 'bash' && tool !== 'powershell') return passthrough();
  if (!isSuccess(response)) return passthrough();

  const cmd = input.command ?? input.cmd ?? input.script ?? '';
  const cap = captureFromBash(cmd);
  if (!cap) return passthrough();

  // Anchor the capture to its repo so it joins the graph instead of orphaning.
  const cwd = evt.cwd ?? evt.cwd_path ?? input.cwd ?? '';
  const repo = cwd ? String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  const repoLink = repo ? `\n\nRepo: [[${repo}]]` : '';

  try {
    await storeMemory({
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

  if (HOOK_MINIMAL) return passthrough();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `📝 Auto-captured (${cap.pattern}): ${cap.title}`,
    },
  }) + '\n');
}

main().catch((err) => { logError('PostToolUse:main', err); passthrough(); });
