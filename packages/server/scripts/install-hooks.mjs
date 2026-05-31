#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const HOOKS_DIR = join(REPO_ROOT, 'hooks');

const OUR_SCRIPTS = {
  'stop-hook.sh':                 { event: 'Stop',         runner: 'bash', timeout: 10, statusMessage: 'Checking if conversation context should be saved...' },
  'diary_stop_hook.mjs':          { event: 'Stop',         runner: 'node', timeout: 10, statusMessage: 'Checking if diary should be updated...' },
  'precompact-hook.sh':           { event: 'PreCompact',   runner: 'bash', timeout: 10, statusMessage: 'Saving context before compaction...' },
  'precompact_diary_hook.mjs':    { event: 'PreCompact',   runner: 'node', timeout: 10, statusMessage: 'Snapshotting diary before compaction...' },
  'code_nav_hint_hook.mjs':       { event: 'SessionStart', runner: 'node', timeout: 5,  statusMessage: 'Checking if code-nav tools are relevant...' },
  'code_nav_pretool_hook.mjs':    { event: 'PreToolUse',   runner: 'node', timeout: 5,  matcher: 'Read|Glob|Grep', statusMessage: 'Suggesting code-nav tools...' },
  // Optional shared deps copied to standalone dir alongside hooks that import them.
  '_mcp_rest.mjs':                { event: null,           runner: 'node', timeout: 0,  copyOnly: true, statusMessage: '' },
};

const RUNNERS = new Set(['bash', 'node', 'sh', 'python', 'python3']);

function scriptBasename(cmd) {
  if (typeof cmd !== 'string') return null;
  for (const tok of cmd.split(/\s+/)) {
    const clean = tok.replace(/["']/g, '').replace(/\$\{CLAUDE_PROJECT_DIR\}/g, '');
    if (RUNNERS.has(clean)) continue;
    if (/\.(sh|mjs|js)$/.test(clean)) return basename(clean);
  }
  return null;
}

function usage() {
  return `Usage: node scripts/install-hooks.mjs [options]

Installs (or uninstalls) Claude Code hooks for this repo into a settings.json.

Options:
  --dry-run           Print the JSON diff without writing.
  --node-only         Skip bash hooks (auto when no bash on PATH on Windows).
  --interval <N>      Set env.DIARY_STOP_EVERY to positive integer N.
  --global            Target ~/.claude/settings.json instead of project-local.
  --standalone        Like --global but also copy the Node hook scripts to
                      ~/.claude/hooks/cortexmd/ so they work even if this
                      repo is deleted or moved. Implies --global + --node-only.
  --uninstall         Remove our hook entries from target.
  --help              Show this message.
`;
}

function parseArgs(argv) {
  const opts = { dryRun: false, nodeOnly: false, interval: null, global: false, standalone: false, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--node-only': opts.nodeOnly = true; break;
      case '--global': opts.global = true; break;
      case '--standalone': opts.standalone = true; break;
      case '--uninstall': opts.uninstall = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--interval': {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          process.stderr.write(`Error: --interval requires a positive integer, got: ${v}\n`);
          process.exit(2);
        }
        opts.interval = n;
        break;
      }
      default:
        process.stderr.write(`Error: unknown flag: ${a}\n\n${usage()}`);
        process.exit(2);
    }
  }
  if (opts.standalone) {
    opts.global = true;
    opts.nodeOnly = true;
  }
  return opts;
}

function standaloneDir() {
  return join(homedir(), '.claude', 'hooks', 'cortexmd');
}

function copyStandaloneScripts() {
  const dest = standaloneDir();
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const [bn, meta] of Object.entries(OUR_SCRIPTS)) {
    if (meta.runner !== 'node') continue;
    writeFileSync(join(dest, bn), readFileSync(join(HOOKS_DIR, bn)));
    copied.push(bn);
  }
  return { dest, copied };
}

function ensureMatchedGroup(settings, event, matcher) {
  settings.hooks = settings.hooks || {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  let group = settings.hooks[event].find((g) => g && g.matcher === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    settings.hooks[event].push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  return group;
}

function hasBash() {
  try {
    const cmd = platform() === 'win32' ? 'where bash' : 'command -v bash';
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveTarget(opts) {
  if (opts.global) {
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(cfgDir, 'settings.json');
  }
  return join(REPO_ROOT, '.claude', 'settings.local.json');
}

function readSettings(target) {
  if (!existsSync(target)) return {};
  try {
    const raw = readFileSync(target, 'utf8').replace(/^﻿/, '');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Error: failed to parse ${target}: ${err.message}\n`);
    process.exit(3);
  }
}

function desiredCommand(basename_, runner, opts) {
  if (opts.standalone) {
    const abs = join(standaloneDir(), basename_).replace(/\\/g, '/');
    return abs.includes(' ') ? `${runner} '${abs}'` : `${runner} ${abs}`;
  }
  if (opts.global) {
    const abs = join(HOOKS_DIR, basename_).replace(/\\/g, '/');
    return abs.includes(' ') ? `${runner} '${abs}'` : `${runner} ${abs}`;
  }
  return `${runner} \${CLAUDE_PROJECT_DIR}/hooks/${basename_}`;
}

function ensureEventGroup(settings, event) {
  settings.hooks = settings.hooks || {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  let group = settings.hooks[event].find(g => !('matcher' in g));
  if (!group) {
    group = { hooks: [] };
    settings.hooks[event].push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  return group;
}

function mergeInstall(settings, opts) {
  const changes = { added: [], updated: [], unchanged: [], skipped: [], foreignPreserved: 0 };

  for (const [bn, meta] of Object.entries(OUR_SCRIPTS)) {
    if (meta.copyOnly) {
      // Shared dep — copied alongside hooks (handled by copyStandaloneScripts)
      // but never wired as a settings.json entry.
      continue;
    }
    if (opts.nodeOnly && meta.runner === 'bash') {
      changes.skipped.push({ event: meta.event, basename: bn, reason: 'node-only' });
      continue;
    }
    const cmd = desiredCommand(bn, meta.runner, opts);
    const group = meta.matcher
      ? ensureMatchedGroup(settings, meta.event, meta.matcher)
      : ensureEventGroup(settings, meta.event);
    const idx = group.hooks.findIndex(e => scriptBasename(e && e.command) === bn);
    if (idx === -1) {
      group.hooks.push({ type: 'command', command: cmd, timeout: meta.timeout, statusMessage: meta.statusMessage });
      changes.added.push({ event: meta.event, basename: bn });
    } else {
      const cur = group.hooks[idx];
      const same = cur.command === cmd && cur.timeout === meta.timeout && cur.statusMessage === meta.statusMessage && cur.type === 'command';
      group.hooks[idx] = { ...cur, type: 'command', command: cmd, timeout: meta.timeout, statusMessage: meta.statusMessage };
      if (same) changes.unchanged.push({ event: meta.event, basename: bn });
      else changes.updated.push({ event: meta.event, basename: bn });
    }
  }

  // Count foreign entries preserved
  if (settings.hooks) {
    for (const [ev, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) continue;
        for (const e of g.hooks) {
          const bn = scriptBasename(e && e.command);
          if (!bn || !(bn in OUR_SCRIPTS) || OUR_SCRIPTS[bn].event !== ev) {
            changes.foreignPreserved++;
          }
        }
      }
    }
  }

  if (opts.interval !== null) {
    settings.env = { ...(settings.env || {}), DIARY_STOP_EVERY: String(opts.interval) };
  }

  return changes;
}

function uninstall(settings) {
  const removed = [];
  if (!settings.hooks || typeof settings.hooks !== 'object') return removed;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const kept = [];
      for (const e of g.hooks) {
        const bn = scriptBasename(e && e.command);
        if (bn && bn in OUR_SCRIPTS && OUR_SCRIPTS[bn].event === event) {
          removed.push({ event, basename: bn, command: e.command });
        } else {
          kept.push(e);
        }
      }
      g.hooks = kept;
    }
    settings.hooks[event] = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function simpleDiff(before, after) {
  const a = (before + '\n').split('\n');
  const b = (after + '\n').split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out.join('\n');
}

function backupTarget(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${target}.bak-${stamp}`;
  writeFileSync(bak, readFileSync(target));
  return bak;
}

function atomicWrite(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

function verifyFiles(opts) {
  const missing = [];
  const baseDir = opts.standalone ? standaloneDir() : HOOKS_DIR;
  for (const [bn, meta] of Object.entries(OUR_SCRIPTS)) {
    if (opts.nodeOnly && meta.runner === 'bash') continue;
    if (!existsSync(join(baseDir, bn))) missing.push(bn);
  }
  return missing;
}

function warnNodeVersion() {
  const m = process.versions.node.match(/^(\d+)/);
  const major = m ? Number(m[1]) : 0;
  if (major < 22) return `Warning: Node ${process.versions.node} detected; hooks target Node 22+.`;
  return null;
}

function warnPython() {
  for (const c of ['python3', 'python']) {
    try {
      const cmd = platform() === 'win32' ? `where ${c}` : `command -v ${c}`;
      execSync(cmd, { stdio: 'ignore' });
      return null;
    } catch {}
  }
  return 'Warning: neither python3 nor python found on PATH (bash hooks need it for JSON parsing).';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(usage()); process.exit(0); }

  if (!opts.nodeOnly && platform() === 'win32' && !hasBash()) {
    opts.nodeOnly = true;
  }

  const target = resolveTarget(opts);
  const beforeSettings = readSettings(target);
  const beforeJson = JSON.stringify(beforeSettings, null, 2);
  const settings = JSON.parse(JSON.stringify(beforeSettings));

  const warnings = [];
  const nv = warnNodeVersion();
  if (nv) warnings.push(nv);

  let changes = null;
  let removed = null;

  if (opts.uninstall) {
    removed = uninstall(settings);
  } else {
    changes = mergeInstall(settings, opts);
    if (!opts.nodeOnly) {
      const py = warnPython();
      if (py) warnings.push(py);
    }
  }

  const afterJson = JSON.stringify(settings, null, 2);

  const lines = [];
  lines.push(`Target: ${target}`);
  if (opts.dryRun) lines.push('(dry-run — no files will be written)');
  lines.push('');

  if (opts.uninstall) {
    lines.push(`Removed entries: ${removed.length}`);
    for (const r of removed) lines.push(`  - [${r.event}] ${r.basename}  (${r.command})`);
  } else {
    lines.push('Install results:');
    const groupBy = (arr) => {
      const by = {};
      for (const x of arr) { (by[x.event] = by[x.event] || []).push(x.basename); }
      return by;
    };
    for (const [label, arr] of [['added', changes.added], ['updated', changes.updated], ['unchanged', changes.unchanged], ['skipped', changes.skipped]]) {
      const by = groupBy(arr);
      for (const [ev, names] of Object.entries(by)) {
        for (const n of names) lines.push(`  - [${ev}] ${n} (${label})`);
      }
    }
    lines.push('');
    lines.push(`Counts: added=${changes.added.length} updated=${changes.updated.length} unchanged=${changes.unchanged.length} skipped=${changes.skipped.length} foreign-preserved=${changes.foreignPreserved}`);
    if (opts.interval !== null) lines.push(`env.DIARY_STOP_EVERY = "${opts.interval}"`);
  }

  if (beforeJson !== afterJson) {
    lines.push('');
    lines.push('Diff:');
    lines.push(simpleDiff(beforeJson, afterJson));
  } else {
    lines.push('');
    lines.push('No changes to write.');
  }

  if (warnings.length) {
    lines.push('');
    for (const w of warnings) lines.push(w);
  }

  if (opts.dryRun) {
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  }

  if (beforeJson === afterJson) {
    process.stdout.write(lines.join('\n') + '\n');
    process.stdout.write('\nNext: restart Claude Code\n');
    process.exit(0);
  }

  let backupPath = null;
  if (existsSync(target)) backupPath = backupTarget(target);

  let standaloneCopy = null;
  if (opts.standalone && !opts.uninstall) {
    standaloneCopy = copyStandaloneScripts();
  }

  atomicWrite(target, afterJson + '\n');

  if (!opts.uninstall) {
    const missing = verifyFiles(opts);
    if (missing.length) {
      if (backupPath) {
        writeFileSync(target, readFileSync(backupPath));
        process.stderr.write(`Error: missing hook files: ${missing.join(', ')}\nRestored from ${backupPath}\n`);
      } else {
        unlinkSync(target);
        process.stderr.write(`Error: missing hook files: ${missing.join(', ')}\nRemoved newly-written ${target}\n`);
      }
      process.exit(4);
    }
  }

  lines.push('');
  if (backupPath) lines.push(`Backup: ${backupPath}`);
  lines.push(`Wrote: ${target}`);
  if (standaloneCopy) {
    lines.push(`Copied scripts: ${standaloneCopy.dest}`);
    for (const bn of standaloneCopy.copied) lines.push(`  - ${bn}`);
  }
  lines.push('Next: restart Claude Code');
  process.stdout.write(lines.join('\n') + '\n');
}

main();
