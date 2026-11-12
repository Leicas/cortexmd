import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { encodeSseFrame } from '../sse-frame.js';
import { normalizeRun, readEvalRuns, diffRuns, aggregate } from '../eval-runs.js';
import { extractL1Notes } from '../wakeup-preview.js';
import { provenanceOf, snippetOf } from '../memories.js';
import { buildSignalBars, parseRecallLabParams, toList } from '../recall-lab.js';
import type { RescoredResult } from '../../../lib/memory.js';

describe('encodeSseFrame', () => {
  it('sends a full frame first, then only changed sections, then removals', () => {
    const last = new Map<string, string>();
    const s1 = new Map([['a', '1'], ['b', '{"x":1}']]);
    expect(JSON.parse(encodeSseFrame(s1, last))).toEqual({ a: 1, b: { x: 1 } });

    const s2 = new Map([['a', '1'], ['b', '{"x":2}']]);
    expect(JSON.parse(encodeSseFrame(s2, last))).toEqual({ _delta: true, b: { x: 2 } });

    expect(JSON.parse(encodeSseFrame(s2, last))).toEqual({ _delta: true });

    const s3 = new Map([['b', '{"x":2}']]);
    expect(JSON.parse(encodeSseFrame(s3, last))).toEqual({ _delta: true, _removed: ['a'] });
  });
});

describe('eval-runs reader', () => {
  it('derives overall + per-category metrics from per-query rows', () => {
    const run = normalizeRun({
      timestamp: '2026-11-01T00:00:00Z', label: 'base',
      queries: [
        { id: 'q1', query: 'a', category: 'entity', rank: 1, latencyMs: 10 },
        { id: 'q2', query: 'b', category: 'entity', rank: 4, latencyMs: 20 },
        { id: 'q3', query: 'c', category: 'temporal', rank: null, latencyMs: 30 },
      ],
    }, 'r1.json', new Date());
    expect(run).not.toBeNull();
    expect(run!.overall.recallAt5).toBeCloseTo(2 / 3);
    expect(run!.overall.mrr).toBeCloseTo((1 + 0.25 + 0) / 3);
    expect(run!.categories.entity.recallAt5).toBe(1);
    expect(run!.categories.temporal.recallAt5).toBe(0);
  });

  it('accepts alternative metric spellings and ignores junk', () => {
    const run = normalizeRun({ summary: { 'recall@5': 0.8, MRR: 0.5, latencyP95: 120 } }, 'x.json', new Date());
    expect(run!.overall).toMatchObject({ recallAt5: 0.8, mrr: 0.5, p95Ms: 120 });
    expect(normalizeRun('nope', 'y.json', new Date())).toBeNull();
    expect(aggregate([]).recallAt5).toBeNull();
  });

  it('reads a directory, skips bad files and flags regressions first', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'evalruns-'));
    try {
      writeFileSync(nodePath.join(dir, 'a.json'), JSON.stringify({ timestamp: '2026-01-01', queries: [{ id: 'q1', rank: 1 }, { id: 'q2', rank: 6 }] }));
      writeFileSync(nodePath.join(dir, 'b.json'), JSON.stringify({ timestamp: '2026-01-02', queries: [{ id: 'q1', rank: 3 }, { id: 'q2', rank: 2 }] }));
      writeFileSync(nodePath.join(dir, 'broken.json'), '{not json');
      const runs = readEvalRuns(dir);
      expect(runs.map((r) => r.id)).toEqual(['a', 'b']);
      const diffs = diffRuns(runs[0], runs[1]);
      expect(diffs[0]).toMatchObject({ key: 'q1', status: 'regressed' });
      expect(diffs.find((d) => d.key === 'q2')?.status).toBe('improved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands a recall-eval.ts multi-arm file into one row per arm', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'evalarms-'));
    try {
      const agg = (r5: number) => ({ n: 2, nScored: 1, recallAt5: r5, mrr: r5, p95LatencyMs: 40 });
      writeFileSync(nodePath.join(dir, 'run-x.json'), JSON.stringify({
        label: 'run-x', createdAt: '2026-11-11T00:00:00Z',
        arms: [
          { arm: 'lexical', overall: agg(0.5), byCategory: { fact: agg(0.5) }, perQuery: [
            { id: 'a', query: 'q a', category: 'fact', kind: 'scored', latencyMs: 5, score: { recallAt5: 1, reciprocalRank: 0.5, goldRanks: [2, null] } },
            { id: 'n', query: 'q n', category: 'negative', kind: 'negative', latencyMs: 3 },
          ] },
          { arm: 'recall', overall: agg(0.7), byCategory: {}, perQuery: [
            { id: 'a', query: 'q a', category: 'fact', kind: 'scored', latencyMs: 6, score: { recallAt5: 0, reciprocalRank: 0, goldRanks: [null] } },
          ] },
        ],
      }));
      const runs = readEvalRuns(dir);
      expect(runs.map((r) => r.id)).toEqual(['run-x#lexical', 'run-x#recall']);
      expect(runs[0].overall).toMatchObject({ recallAt5: 0.5, p95Ms: 40 });
      expect(runs[0].queries.find((q) => q.key === 'a')).toMatchObject({ rank: 2, rr: 0.5, hit: true });
      expect(runs[0].queries.find((q) => q.key === 'n')).toMatchObject({ hit: null, rr: null });
      expect(runs[1].queries[0]).toMatchObject({ rank: null, rr: 0, hit: false });
      expect(diffRuns(runs[0], runs[1])[0]).toMatchObject({ key: 'a', status: 'regressed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing directory', () => {
    expect(readEvalRuns(nodePath.join(tmpdir(), 'definitely-missing-dir-xyz'))).toEqual([]);
  });
});

describe('wakeup preview helpers', () => {
  it('extracts unique L1 note paths from wikilinks', () => {
    const notes = extractL1Notes('- [[Memories/fact/a|A]] and [[Memories/fact/a|A again]]\n- [[Concepts/BM25]] [[x.md#h|X]]');
    expect(notes).toEqual([
      { path: 'Memories/fact/a.md', title: 'A' },
      { path: 'Concepts/BM25.md', title: 'BM25' },
      { path: 'x.md', title: 'X' },
    ]);
  });
});

describe('memories helpers', () => {
  it('reads provenance from frontmatter keys and Projects links', () => {
    expect(provenanceOf({ agent: 'Claude Code (box)', machine: 'box', related: ['[[Projects/Helios Search.md]]'] }))
      .toMatchObject({ agent: 'Claude Code (box)', machine: 'box', project: 'Helios Search' });
    expect(provenanceOf({ context: { source: 'hook' } }).source).toBe('hook');
  });

  it('builds a one-line snippet without the repeated heading or link brackets', () => {
    expect(snippetOf('# Title\n\nUses [[Concepts/BM25.md]] and [[x|the X]].')).toBe('Uses BM25 and the X.');
  });
});

describe('recall lab', () => {
  it('parses list params from strings or arrays and clamps limit', () => {
    expect(toList('a, b,,c')).toEqual(['a', 'b', 'c']);
    const p = parseRecallLabParams({ q: 'hello', limit: '500', category: 'fact', relatedTo: ['x', ' '] });
    expect(p).toMatchObject({ query: 'hello', limit: 50, categories: ['fact'], relatedTo: ['x'] });
  });

  it('turns a rescored result into readable signal bars', () => {
    const r = {
      path: 'p.md', title: 't', category: 'fact', temperature: 'hot', importance: 'high',
      score: 1, lexicalScore: 0.5, semanticScore: 0, fusedScore: 0.5, snippet: '',
      signals: { match: 'lexical', temperature: 'hot', heatScore: 8, inboundLinks: 3, recency: 0.9, stale: true, related: false, validity: 0.5, reason: 'x' },
    } as RescoredResult;
    const bars = buildSignalBars(r, { lex: 1, sem: 0, graph: 0 });
    const by = Object.fromEntries(bars.map((b) => [b.key, b]));
    expect(by.lexical.value).toBe(0.5);
    expect(by.semantic.text).toBe('no match');
    expect(by.heat.value).toBe(0.5);
    expect(by.importance.text).toBe('high');
    expect(by.centrality.text).toBe('3 inbound links');
    expect(by.stale.value).toBe(1);
    expect(by.stale.text).toMatch(/stale/);
    // every bar carries a text value (never colour-only)
    for (const b of bars) expect(b.text.length).toBeGreaterThan(0);
  });
});
