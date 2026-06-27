#!/usr/bin/env node
// Contract parity harness: run the TS parser (the SAME parseFile() the server
// uses) over contract/fixtures/sample-repo/ and diff the resulting symbol_id +
// signature_normalized against the Rust-generated source of truth
// (contract/fixtures/expected-symbol-ids.json).
//
// The Rust output is authoritative. This script NEVER rewrites the expected
// file; it only reports drift. Exit code 0 = full parity, 1 = mismatch/error.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Quiet the server's startup logger (config.js reads LOG_LEVEL at module load)
// so stdout stays a single clean JSON document. Set BEFORE the dynamic import
// of the parser module below, which transitively loads logger.js -> config.js.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

// Import the COMPILED parser so we exercise the exact module the server loads.
// Dynamic import keeps it after the env tweak above.
const { parseFile } = await import('../dist/lib/code-nav/parser.js');

// Mirror of parser.ts `normalizeSignature` — the exact rule parseFile() uses
// to build the string it hashes into the symbol id.
function normalizeSignature(sig) {
  return sig.replace(/\s+/g, ' ').trim();
}

// Mirror of repos.ts `languageForPath`. Inlined here so the harness does not
// pull in the server's config/db side-effects just to map extensions.
function languageForPath(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hxx', '.h++', '.h'].includes(ext)) return 'cpp';
  if (ext === '.c') return 'c';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.rb') return 'ruby';
  if (ext === '.php') return 'php';
  // .dart is intentionally omitted: tree-sitter-dart's npm grammar targets a
  // newer ABI than the pinned runtime, so the TS parser can't load it. The Rust
  // CLI still indexes Dart; it's just excluded from this golden parity fixture.
  return null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..'); // packages/server/scripts -> repo root
const SAMPLE_REPO = path.join(REPO_ROOT, 'contract/fixtures/sample-repo');
const EXPECTED = path.join(REPO_ROOT, 'contract/fixtures/expected-symbol-ids.json');
const OUT_DIR = path.join(REPO_ROOT, 'contract/fixtures/out');
const OUT_TS = path.join(OUT_DIR, 'ts.json');

// repo_id is the fixed literal documented in contract/fixtures/README.md so IDs
// are reproducible without a git checkout or running server.
const REPO_ID = 'fixture';

async function listSourceFiles(dir, base) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSourceFiles(abs, rel)));
    } else if (languageForPath(rel)) {
      out.push({ abs, rel });
    }
  }
  return out;
}

async function buildTsMap() {
  const files = await listSourceFiles(SAMPLE_REPO, '');
  const map = {};
  for (const { abs, rel } of files) {
    const lang = languageForPath(rel);
    const source = await readFile(abs, 'utf8');
    const { symbols } = await parseFile(REPO_ID, rel, lang, source);
    map[rel] = symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      id: s.id,
      // IMPORTANT: ParsedSymbol.signature is the RAW signature. The server's
      // parseFile() derives the symbol id from normalizeSignature(signature)
      // (collapse all whitespace runs to a single space, then trim) — that
      // normalized form is the contract's `signature_normalized`. Apply the
      // identical rule here so we compare the value that actually feeds the id.
      signature_normalized: normalizeSignature(s.signature ?? ''),
    }));
  }
  return map;
}

function compare(expected, actual) {
  const mismatches = [];
  let symbolCount = 0;

  const allPaths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const p of [...allPaths].sort()) {
    const exp = expected[p] ?? [];
    const act = actual[p] ?? [];

    // Index TS symbols by (name|kind) for order-independent matching; the
    // contract cares about the SET of symbols, not emission order.
    const actByKey = new Map();
    for (const s of act) actByKey.set(`${s.name}|${s.kind}`, s);
    const seen = new Set();

    for (const e of exp) {
      symbolCount++;
      const key = `${e.name}|${e.kind}`;
      const a = actByKey.get(key);
      if (!a) {
        mismatches.push(
          `${p} :: ${key} -> MISSING in TS (rust id=${e.id}, sig="${e.signature_normalized}")`,
        );
        continue;
      }
      seen.add(key);
      if (a.id !== e.id) {
        mismatches.push(
          `${p} :: ${key} -> id drift: rust=${e.id} ts=${a.id}`,
        );
      }
      if (a.signature_normalized !== e.signature_normalized) {
        mismatches.push(
          `${p} :: ${key} -> signature_normalized drift:\n      rust="${e.signature_normalized}"\n      ts  ="${a.signature_normalized}"`,
        );
      }
    }
    for (const a of act) {
      const key = `${a.name}|${a.kind}`;
      if (!seen.has(key)) {
        mismatches.push(
          `${p} :: ${key} -> EXTRA in TS (ts id=${a.id}, sig="${a.signature_normalized}")`,
        );
      }
    }
  }
  return { mismatches, symbolCount };
}

async function main() {
  const expected = JSON.parse(await readFile(EXPECTED, 'utf8'));
  const actual = await buildTsMap();
  const { mismatches, symbolCount } = compare(expected, actual);

  const report = {
    repoId: REPO_ID,
    tsMatches: mismatches.length === 0,
    symbolCount,
    mismatches,
    tsOutput: actual,
  };

  // Emit the per-toolchain TS symbol map to the gitignored out/ dir (the path
  // the contract README designates for diffing) and print a clean summary.
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_TS, JSON.stringify(actual, null, 2) + '\n', 'utf8');

  const ok = mismatches.length === 0;
  process.stderr.write(
    `[contract-check] tsMatches=${ok} symbolCount=${symbolCount} mismatches=${mismatches.length}\n`,
  );
  if (!ok) {
    for (const m of mismatches) process.stderr.write(`  - ${m}\n`);
  }
  process.stderr.write(`[contract-check] wrote ${OUT_TS}\n`);
  // Machine-readable report on stdout (single JSON document, nothing else).
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('contract-check failed:', err);
  process.exit(2);
});
