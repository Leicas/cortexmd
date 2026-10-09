#!/usr/bin/env node
// Write the semantic-release version into every file that carries one.
//
// Called by @semantic-release/exec (prepareCmd in .releaserc.json):
//   node scripts/bump-version.mjs ${nextRelease.version}
// and the resulting edits are committed by @semantic-release/git.
//
// Targets (relative to --root, default: repo root):
//   crates/cli/Cargo.toml                    [package] version = "..."
//   Cargo.lock, crates/cli/Cargo.lock        [[package]] name = "cortexmd-cli" entry
//   packages/server/package.json             "version"
//   package.json                             "version" (added after "name" if absent)
//   plugin/cortexmd/.claude-plugin/plugin.json  "version"
//
// Formatting-preserving: each file is edited with a targeted regex (no JSON
// re-serialization, no TOML round-trip) so unrelated lines never change and
// `cargo build --locked` keeps working. Missing files are skipped with a note.
//
// Flags: --root <dir>  --dry-run  --quiet
// Node built-ins only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const TARGETS = [
  { path: 'crates/cli/Cargo.toml', kind: 'cargo-toml' },
  { path: 'Cargo.lock', kind: 'cargo-lock', optional: true },
  { path: 'crates/cli/Cargo.lock', kind: 'cargo-lock', optional: true },
  { path: 'packages/server/package.json', kind: 'json' },
  { path: 'package.json', kind: 'json', addIfMissing: true },
  { path: 'plugin/cortexmd/.claude-plugin/plugin.json', kind: 'json' },
];

const CARGO_PACKAGE = 'cortexmd-cli';

/** Replace `version = "..."` inside the `[package]` table only. */
export function bumpCargoToml(text, version) {
  const start = text.search(/^\[package\]\s*$/m);
  if (start < 0) throw new Error('Cargo.toml: no [package] table');
  const rest = text.slice(start);
  const nextTable = rest.slice(1).search(/^\[/m);
  const end = nextTable < 0 ? text.length : start + 1 + nextTable;
  const section = text.slice(start, end);
  const re = /^(version\s*=\s*")([^"]*)(")/m;
  if (!re.test(section)) throw new Error('Cargo.toml: no version in [package]');
  const next = section.replace(re, `$1${version}$3`);
  return text.slice(0, start) + next + text.slice(end);
}

/** Replace the version of the `[[package]] name = "cortexmd-cli"` entry. */
export function bumpCargoLock(text, version, name = CARGO_PACKAGE) {
  const re = new RegExp(`(^name = "${name}"\\r?\\nversion = ")([^"]*)(")`, 'm');
  if (!re.test(text)) throw new Error(`Cargo.lock: no [[package]] entry for ${name}`);
  return text.replace(re, `$1${version}$3`);
}

/**
 * Replace the top-level "version" of a JSON document without re-serializing
 * it. The first `"version": "..."` is top-level in every target file; we
 * verify that by parsing the result. With `addIfMissing`, insert it right
 * after the top-level "name".
 */
export function bumpJson(text, version, { addIfMissing = false, label = 'json' } = {}) {
  const parsed = JSON.parse(text);
  let next;
  if (typeof parsed.version === 'string') {
    const re = /("version"\s*:\s*")([^"]*)(")/;
    next = text.replace(re, `$1${version}$3`);
  } else if (addIfMissing) {
    const re = /("name"\s*:\s*"[^"]*"\s*,?)(\r?\n)([ \t]*)/;
    const m = text.match(re);
    if (!m) throw new Error(`${label}: no "version" and no "name" to insert after`);
    const comma = m[1].endsWith(',') ? '' : ',';
    const nl = m[2];
    const indent = m[3];
    next = text.replace(re, `${m[1]}${comma}${nl}${indent}"version": "${version}",${nl}${indent}`);
  } else {
    throw new Error(`${label}: no top-level "version"`);
  }
  const check = JSON.parse(next);
  if (check.version !== version) throw new Error(`${label}: version did not land at top level`);
  return next;
}

export function bumpText(kind, text, version, opts = {}) {
  switch (kind) {
    case 'cargo-toml': return bumpCargoToml(text, version);
    case 'cargo-lock': return bumpCargoLock(text, version);
    case 'json': return bumpJson(text, version, opts);
    default: throw new Error(`unknown kind ${kind}`);
  }
}

/** Apply the bump to every target under `root`. Returns a per-file report. */
export function bumpAll(root, version, { dryRun = false } = {}) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${JSON.stringify(version)}`);
  const report = [];
  for (const t of TARGETS) {
    const file = join(root, t.path);
    if (!existsSync(file)) {
      if (!t.optional) throw new Error(`missing required file: ${t.path}`);
      report.push({ path: t.path, status: 'skipped (absent)' });
      continue;
    }
    const before = readFileSync(file, 'utf8');
    const after = bumpText(t.kind, before, version, { addIfMissing: t.addIfMissing, label: t.path });
    if (after === before) {
      report.push({ path: t.path, status: 'unchanged' });
      continue;
    }
    if (!dryRun) writeFileSync(file, after);
    report.push({ path: t.path, status: dryRun ? 'would update' : 'updated' });
  }
  return report;
}

function main(argv) {
  const args = argv.slice(2);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let dryRun = false;
  let quiet = false;
  let version;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = resolve(args[++i]);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--quiet') quiet = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else if (version === undefined) version = a.replace(/^v/, '');
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!version) {
    console.error('usage: node scripts/bump-version.mjs <version> [--root <dir>] [--dry-run] [--quiet]');
    process.exit(2);
  }
  const report = bumpAll(root, version, { dryRun });
  if (!quiet) {
    for (const r of report) console.log(`  ${r.status.padEnd(16)} ${r.path}`);
    console.log(`bump-version: ${version}${dryRun ? ' (dry run)' : ''}`);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main(process.argv);
  } catch (e) {
    console.error(`bump-version: ${e.message}`);
    process.exit(1);
  }
}
