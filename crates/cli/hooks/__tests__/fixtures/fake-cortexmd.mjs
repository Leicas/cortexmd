#!/usr/bin/env node
// Stub for the `cortexmd` binary used by the hook test-suite.
//
// Hooks spawn it through CORTEXMD_BIN=<this file> (a `.mjs` CORTEXMD_BIN is run
// with the current Node executable, see cortexmdCommand() in _mcp_rest.mjs).
// It answers the three subcommands the hooks use with canned JSON and records
// every invocation (argv) in FAKE_CORTEXMD_LOG (one JSON line per call) so the
// tests can assert what was stored.
//
//   recall --format json  → one relevant hot memory, one weak memory, one
//                           consolidated digest, one auto-capture memory,
//                           one note
//   store-memory          → { stored: true, path: "Memories/preference/test.md" }
//   repo-list             → one repo whose abs_path = FAKE_REPO_ROOT
//   anything else         → {} (exit 0)

import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';

try {
  if (process.env.FAKE_CORTEXMD_LOG) {
    appendFileSync(process.env.FAKE_CORTEXMD_LOG, JSON.stringify({ cmd, argv }) + '\n');
  }
} catch { /* ignore */ }

function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.env.FAKE_CORTEXMD_FAIL === '1') {
  process.stderr.write('simulated failure\n');
  process.exit(2);
}

let out;
switch (cmd) {
  case 'recall':
    if (process.env.FAKE_CORTEXMD_RRF === '1') {
      // Live-server-like rank-fusion scores (~0.01–0.05): the relative floor
      // (0.4 × top) must apply, the absolute 0.25 floor must not.
      out = {
        query: arg('--query') ?? '',
        memories: [
          { path: 'Memories/decision/a.md', title: 'a', snippet: 'Decision A.', category: 'decision', temperature: 'cold', score: 0.035 },
          { path: 'Memories/observation/b.md', title: 'b', snippet: 'Observation B.', category: 'observation', temperature: 'cold', score: 0.0194 },
          { path: 'Memories/observation/c.md', title: 'c', snippet: 'Below floor C.', category: 'observation', temperature: 'cold', score: 0.005 },
        ],
        notes: [{ path: 'Memories/consolidated/7-marketing-2026-W24.md', title: 'digest', snippet: 'Fold.', score: 0.039 }],
      };
      break;
    }
    out = {
      query: arg('--query') ?? '',
      memories: [
        {
          path: 'Memories/decision/2026-09-01-use-node-test-runner.md',
          title: 'Use node:test',
          snippet: '# Use node:test\nWe use the built-in node:test runner for hook tests, no dev dependency.',
          category: 'decision',
          temperature: 'hot',
          score: 0.91,
        },
        {
          path: 'Memories/consolidated/2026-09-weekly-digest.md',
          title: 'Weekly digest',
          snippet: 'Marketing digest: 40 newsletters folded.',
          category: 'observation',
          temperature: 'cold',
          score: 0.80,
        },
        {
          path: 'Memories/observation/2026-09-02-git-commit-fix-x.md',
          title: 'git commit: fix x',
          snippet: 'Made a commit with message: "fix: x".',
          category: 'observation',
          temperature: 'warm',
          score: 0.70,
          tags: ['git', 'auto-capture'],
        },
        {
          path: 'Memories/observation/2026-08-01-weak-match.md',
          title: 'Weak match',
          snippet: 'Barely related note that should fall under the relevance floor.',
          category: 'observation',
          temperature: 'cold',
          score: 0.10,
        },
      ],
      notes: [
        {
          path: 'Projects/cortexmd.md',
          title: 'cortexmd',
          snippet: '# cortexmd\nSecond brain MCP server + Rust CLI + Claude Code plugin.',
          score: 0.55,
        },
      ],
    };
    break;
  case 'store-memory':
    out = { stored: true, path: 'Memories/preference/test.md', category: arg('--category') ?? 'observation' };
    break;
  case 'repo-list':
    out = {
      machineId: 'test-machine',
      repos: [
        { slug: 'fixture-repo', paths: [{ abs_path: process.env.FAKE_REPO_ROOT ?? '/nonexistent/fixture-repo' }] },
      ],
    };
    break;
  default:
    out = {};
}

process.stdout.write(JSON.stringify(out) + '\n');
