/**
 * Local cross-encoder reranker (lib/cross-encoder.ts) with a mocked scorer —
 * no model download.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-ce-'));
process.env.BRAIN_VAULT = path.join(root, 'vault');
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-ce';
process.env.DASHBOARD_PASSWORD = 'test-ce';
delete process.env.ENABLE_CROSS_ENCODER;

const { config } = await import('../../config.js');
const ce = await import('../cross-encoder.js');
const hooks = ce.__crossEncoderTestHooks;

afterAll(() => {
  hooks.reset();
  rmSync(root, { recursive: true, force: true });
});

/** Logit = number of query words found in the passage. */
const calls: Array<Array<[string, string]>> = [];
const overlapScorer = async (pairs: Array<[string, string]>): Promise<number[]> => {
  calls.push(pairs);
  return pairs.map(([q, p]) => q.toLowerCase().split(/\s+/).filter((w) => p.toLowerCase().includes(w)).length);
};

beforeEach(() => {
  hooks.reset();
  calls.length = 0;
});

describe('rerankPassages', () => {
  it('is off by default: input order, no model touched', async () => {
    expect(config.enableCrossEncoder).toBe(false);
    hooks.install(overlapScorer);
    const out = await ce.rerankPassages('zebra', ['cat', 'zebra']);
    expect(out).toMatchObject({ reranked: false, reason: 'disabled', scored: 0 });
    expect(out.results.map((r) => r.index)).toEqual([0, 1]);
    expect(calls).toHaveLength(0);
    expect(ce.getCrossEncoderStats().calls).toBe(0);
  });

  it('reorders by score, best first, with sigmoid scores in (0,1)', async () => {
    hooks.install(overlapScorer);
    const passages = ['nothing relevant', 'the zebra', 'a striped zebra lives here', { text: 'zebra lives' }];
    const out = await ce.rerankPassages('striped zebra lives', passages, { force: true });
    expect(out.reranked).toBe(true);
    expect(out.scored).toBe(4);
    expect(out.results.map((r) => r.index)).toEqual([2, 3, 1, 0]);
    expect(out.results[0].text).toBe('a striped zebra lives here');
    for (const r of out.results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
    expect(out.results[0].score!).toBeGreaterThan(out.results[1].score!);
  });

  it('is deterministic and stable: ties keep input order', async () => {
    hooks.install(async (pairs) => pairs.map(() => 0.5));
    const passages = ['a', 'b', 'c', 'd', 'e'];
    const one = await ce.rerankPassages('q', passages, { force: true });
    const two = await ce.rerankPassages('q', passages, { force: true });
    expect(one.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(two.results).toEqual(one.results);
  });

  it('scores only the first topK; the rest keep their place after them', async () => {
    hooks.install(overlapScorer);
    const passages = ['x', 'zebra', 'y', 'zebra zebra best but beyond topK'];
    const out = await ce.rerankPassages('zebra', passages, { force: true, topK: 3 });
    expect(out.scored).toBe(3);
    expect(out.results.map((r) => r.index)).toEqual([1, 0, 2, 3]);
    expect(out.results[3].score).toBeNull();
    expect(calls.flat()).toHaveLength(3);
  });

  it('batches pairs and truncates long passages', async () => {
    hooks.install(overlapScorer);
    const passages = Array.from({ length: 7 }, (_, i) => `passage ${i} ` + 'z'.repeat(5000));
    await ce.rerankPassages('passage', passages, { force: true, batchSize: 3, maxChars: 100 });
    expect(calls.map((b) => b.length)).toEqual([3, 3, 1]);
    for (const [q, p] of calls.flat()) {
      expect(q).toBe('passage');
      expect(p.length).toBe(100);
    }
  });

  it('latency budget: a slow scorer falls back to the input order (all-or-nothing)', async () => {
    hooks.install(async (pairs) => {
      await new Promise((r) => setTimeout(r, 60));
      return overlapScorer(pairs);
    });
    const passages = ['x', 'zebra', 'y', 'zebra zebra'];
    const out = await ce.rerankPassages('zebra', passages, { force: true, batchSize: 1, timeoutMs: 80 });
    expect(out).toMatchObject({ reranked: false, reason: 'timeout' });
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(out.results.every((r) => r.score === null)).toBe(true);
    expect(out.ms).toBeLessThan(400);
    expect(ce.getCrossEncoderStats().timeouts).toBe(1);
    // The abandoned pass stops after its current batch instead of scoring everything.
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.length).toBeLessThan(4);
    // Without a budget the same call completes.
    const ok = await ce.rerankPassages('zebra', passages, { force: true, batchSize: 1, timeoutMs: 0 });
    expect(ok.reranked).toBe(true);
    expect(ok.results.map((r) => r.index)).toEqual([1, 3, 0, 2]);
  });

  it('lazy load: a model still loading returns the input order within the budget, then works', async () => {
    const pending = hooks.installPending();
    const out = await ce.rerankPassages('zebra', ['x', 'zebra'], { force: true, timeoutMs: 30 });
    expect(out).toMatchObject({ reranked: false, reason: 'loading' });
    expect(ce.getCrossEncoderStats().loaded).toBe(false);
    pending.release(overlapScorer);
    const next = await ce.rerankPassages('zebra', ['x', 'zebra'], { force: true, timeoutMs: 1000 });
    expect(next.reranked).toBe(true);
    expect(next.results.map((r) => r.index)).toEqual([1, 0]);
    expect(ce.getCrossEncoderStats().loaded).toBe(true);
  });

  it('never throws: scorer errors and bad output degrade to the input order', async () => {
    hooks.install(async () => { throw new Error('onnx exploded'); });
    const out = await ce.rerankPassages('q', ['a', 'b'], { force: true });
    expect(out).toMatchObject({ reranked: false, reason: 'error' });
    expect(out.results.map((r) => r.index)).toEqual([0, 1]);

    hooks.install(async () => [1]); // one score for two pairs
    const short = await ce.rerankPassages('q', ['a', 'b'], { force: true });
    expect(short.reranked).toBe(false);
    expect(short.results.map((r) => r.index)).toEqual([0, 1]);
  });

  it('empty query or no passages is a no-op', async () => {
    hooks.install(overlapScorer);
    expect(await ce.rerankPassages('', ['a'], { force: true })).toMatchObject({ reranked: false, reason: 'empty' });
    expect(await ce.rerankPassages('q', [], { force: true })).toMatchObject({ reranked: false, reason: 'empty', results: [] });
    expect(calls).toHaveLength(0);
  });
});
