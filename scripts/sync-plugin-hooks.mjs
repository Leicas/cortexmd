#!/usr/bin/env node
// Sync the canonical Claude Code hook scripts into the plugin.
//
// Source of truth: crates/cli/hooks/*.mjs (installed by `cortexmd init`).
// Target:          plugin/cortexmd/scripts/hooks/*.mjs (shipped by the plugin,
//                  referenced from plugin/cortexmd/hooks/hooks.json as
//                  ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<name>.mjs).
//
// The plugin must wire exactly the same template as `cortexmd init`, so the
// copies are never edited by hand — run this script instead:
//
//   npm run sync-plugin-hooks          # copy (overwrite) every hook
//   npm run check-plugin-hooks         # exit 1 if any copy differs (CI)
//
// Node built-ins only. Ignores crates/cli/hooks/__tests__/ and non-.mjs files
// (README.md, legacy .sh hooks).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'crates', 'cli', 'hooks');
const DST_DIR = join(ROOT, 'plugin', 'cortexmd', 'scripts', 'hooks');

const check = process.argv.includes('--check');

function listHooks(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => e.name)
    .sort();
}

// Normalise line endings so a CRLF checkout on Windows does not count as drift.
const norm = (s) => s.replace(/\r\n/g, '\n');

const sources = listHooks(SRC_DIR);
if (sources.length === 0) {
  console.error(`sync-plugin-hooks: no .mjs hooks found in ${SRC_DIR}`);
  process.exit(1);
}

let drift = 0;
let copied = 0;
let removed = 0;

if (!check) mkdirSync(DST_DIR, { recursive: true });

for (const name of sources) {
  const src = join(SRC_DIR, name);
  const dst = join(DST_DIR, name);
  const want = norm(readFileSync(src, 'utf8'));
  const have = existsSync(dst) ? norm(readFileSync(dst, 'utf8')) : null;
  if (have === want) continue;
  if (check) {
    console.error(`  drift: plugin/cortexmd/scripts/hooks/${name} ${have === null ? '(missing)' : '(differs)'}`);
    drift += 1;
  } else {
    writeFileSync(dst, want);
    copied += 1;
    console.log(`  copied: ${name}`);
  }
}

// Stale copies (hook removed upstream) are drift too.
if (existsSync(DST_DIR)) {
  for (const name of listHooks(DST_DIR)) {
    if (sources.includes(name)) continue;
    if (check) {
      console.error(`  drift: plugin/cortexmd/scripts/hooks/${name} (stale, not in crates/cli/hooks)`);
      drift += 1;
    } else {
      unlinkSync(join(DST_DIR, name));
      removed += 1;
      console.log(`  removed stale: ${name}`);
    }
  }
}

if (check) {
  if (drift > 0) {
    console.error(`sync-plugin-hooks: ${drift} file(s) out of sync — run \`npm run sync-plugin-hooks\`.`);
    process.exit(1);
  }
  console.log(`sync-plugin-hooks: ${sources.length} hook(s) in sync.`);
} else {
  console.log(`sync-plugin-hooks: ${sources.length} hook(s) checked, ${copied} copied, ${removed} removed.`);
}
