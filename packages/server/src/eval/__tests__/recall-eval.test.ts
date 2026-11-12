/**
 * Plumbing test for the recall eval harness (recall-core.ts) on the committed
 * SYNTHETIC fixture (src/eval/fixtures/recall-vault + recall-queries.jsonl).
 * Embeddings off. Asserts metric plumbing, gold resolution, side-effect
 * freedom and the compare gate — NOT a retrieval-quality bar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRecallDatasets, makeGoldResolver, normalizePathKey, scoreQuery, subsampleQueries,
  runArm, buildArmReport, compareRuns, makeRecallRunner, makeRawSearchRunner,
  type ArmReport, type PerQueryRecord,
} from '../recall-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureVault = path.join(here, '..', 'fixtures', 'recall-vault');
const fixtureQueries = path.join(here, '..', 'fixtures', 'recall-queries.jsonl');

// Work on a temp COPY so even a harness bug could never dirty the fixture.
const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-recall-eval-'));
const vault = path.join(root, 'vault');
cpSync(fixtureVault, vault, { recursive: true });
process.env.BRAIN_VAULT = vault;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.ENABLE_EMBEDDINGS = 'false';
process.env.ENABLE_KG = 'false';
process.env.AUTO_LINK = 'false';
process.env.AUTO_SEED_KG = 'false';
delete process.env.SOURCE_VAULTS;
delete process.env.VAULT_RO_PERSO;
delete process.env.VAULT_RO_HAPLY;

function snapshotFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out.set(r, `${statSync(path.join(dir, r)).mtimeMs}:${readFileSync(path.join(dir, r), 'utf-8')}`);
    }
  };
  walk('');
  return out;
}

describe('recall-core pure helpers', () => {
  it('normalizes case, .md suffix, slashes and leading ./', () => {
    const k = normalizePathKey('Memories/Fact/X.md');
    expect(normalizePathKey('memories\\fact\\x')).toBe(k);
    expect(normalizePathKey('./Memories//fact/x.MD')).toBe(k);
  });

  it('scoreQuery computes R@k, RR, nDCG, top1 and noise slots', () => {
    const ranked = ['EmailLog/a.md', 'g1.md', 'x.md', 'Memories/consolidated/d.md', 'y.md', 'g2.md'];
    const s = scoreQuery(ranked, ['g1.md', 'g2.md'], ['Memories/consolidated/', 'EmailLog/']);
    expect(s.recallAt5).toBe(0.5);
    expect(s.recallAt10).toBe(1);
    expect(s.reciprocalRank).toBe(0.5);
    expect(s.top1).toBe(0);
    expect(s.noiseTop5).toBe(2);
    expect(s.slotsTop5).toBe(5);
    expect(s.goldRanks).toEqual([2, 6]);
    const ideal = 1 + 1 / Math.log2(3);
    expect(s.ndcgAt10).toBeCloseTo((1 / Math.log2(3) + 1 / Math.log2(7)) / ideal, 6);
  });

  it('subsampling is deterministic and bounded', () => {
    const { queries } = loadRecallDatasets(fixtureQueries);
    const a = subsampleQueries(queries, 4).map((q) => q.id);
    const b = subsampleQueries(queries, 4).map((q) => q.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    expect(subsampleQueries(queries)).toHaveLength(queries.length);
  });

  it('compareRuns passes on identical runs and fails on a >2pt drop', () => {
    const rec = (id: string, rr: number): PerQueryRecord => ({
      id, category: 'c', file: 'f', query: id, gold: ['g'], missingGold: [], outOfScopeGold: [],
      kind: 'scored', ranked: rr ? ['g'] : ['x'], latencyMs: 5,
      score: { recallAt5: rr ? 1 : 0, recallAt10: rr ? 1 : 0, reciprocalRank: rr, ndcgAt10: rr, top1: rr, noiseTop5: 0, slotsTop5: 1, goldRanks: [rr ? 1 : null] },
    });
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const base = { arms: [buildArmReport('recall', ids.map((id) => rec(id, 1)))] };
    expect(compareRuns(base, base).failures).toEqual([]);
    const worse = { arms: [buildArmReport('recall', ids.map((id, i) => rec(id, i === 0 ? 0 : 1)))] };
    const cmp = compareRuns(base, worse);
    expect(cmp.failures.some((f) => f.includes('Recall@5'))).toBe(true);
    expect(cmp.failures.some((f) => f.includes('MRR'))).toBe(true);
  });
});

describe('recall eval on the synthetic fixture (embeddings off)', () => {
  let before: Map<string, string>;
  let recall: ArmReport;
  let noprior: ArmReport;
  let lexical: ArmReport;
  let resolveGold: ReturnType<typeof makeGoldResolver>;
  const ds = loadRecallDatasets(fixtureQueries);

  beforeAll(async () => {
    before = snapshotFiles(vault);
    const search = await import('../../lib/search.js');
    await search.rebuildIndex();
    resolveGold = makeGoldResolver(search.getDocMeta());
    lexical = await runArm('lexical', ds.queries, await makeRawSearchRunner({ limit: 10 }), { resolveGold });
    recall = await runArm('recall', ds.queries, await makeRecallRunner({ limit: 10 }), { resolveGold });
    noprior = await runArm('noprior', ds.queries, await makeRecallRunner({ limit: 10, noPrior: true }), { resolveGold });
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads every row and resolves gold path variants', () => {
    expect(ds.queries).toHaveLength(10);
    expect(resolveGold(['memories/preference/TERMINAL-FONT']).gold).toEqual(['Memories/preference/terminal-font.md']);
    expect(resolveGold(['Memories\\fact\\greenhouse-sensor-calibration.md']).gold).toHaveLength(1);
  });

  it('flags missing gold and out-of-scope gold', () => {
    const miss = recall.perQuery.find((q) => q.id === 'missing-gold')!;
    expect(miss.missingGold).toEqual(['Memories/fact/does-not-exist.md']);
    expect(miss.kind).toBe('unscorable');
    const scope = recall.perQuery.find((q) => q.id === 'scope-lumen')!;
    // "Out of scope" = not a type:memory note (the pre-1.21 recall pool).
    expect(scope.outOfScopeGold).toEqual(['Projects/Lumen.md']);
    // Since the default RECALL_SCOPE is 'durable', memory_recall also returns
    // durable non-memory notes (semantic / procedural kind): this gold is
    // reachable. RECALL_SCOPE=memory restores the memory-only pool.
    expect(scope.ranked).toContain('Projects/Lumen.md');
  });

  it('aggregates counts and bounded metrics per category', () => {
    for (const rep of [recall, noprior, lexical]) {
      expect(rep.overall.n).toBe(10);
      expect(rep.overall.nNegative).toBe(2);
      expect(rep.overall.nUnscorable).toBe(1);
      expect(rep.overall.nScored).toBe(7);
      for (const v of [rep.overall.recallAt5, rep.overall.recallAt10, rep.overall.mrr, rep.overall.ndcgAt10, rep.overall.top1]) {
        expect(v).not.toBeNull();
        expect(v!).toBeGreaterThanOrEqual(0);
        expect(v!).toBeLessThanOrEqual(1);
      }
      expect(Object.keys(rep.byCategory).sort()).toEqual(['factual', 'fr', 'negative', 'out-of-scope', 'preference']);
      expect(rep.byCategory.negative.negAbstention).not.toBeNull();
      expect(rep.overall.p95LatencyMs).toBeGreaterThanOrEqual(rep.overall.p50LatencyMs);
    }
    // Only the recall arms render a response.
    expect(recall.overall.meanResponseChars).toBeGreaterThan(0);
    expect(lexical.overall.meanResponseChars).toBeNull();
  });

  it('per-query ranks are consistent with the metrics', () => {
    for (const q of recall.perQuery.filter((r) => r.kind === 'scored')) {
      const s = q.score!;
      expect(s.top1).toBe(s.goldRanks[0] === 1 ? 1 : 0);
      if (s.goldRanks.every((r) => r === null)) expect(s.reciprocalRank).toBe(0);
      expect(q.ranked.length).toBeLessThanOrEqual(10);
    }
  });

  it('counts the hot digest / EmailLog note as top-5 noise', () => {
    // The digest and newsletter mention every topic and carry max heat, so
    // they surface on at least one query in the real recall path.
    expect(recall.overall.noiseTop5).not.toBeNull();
    expect(recall.overall.noiseTop5!).toBeGreaterThan(0);
  });

  it('never writes into the vault (touch:false)', async () => {
    await new Promise((r) => setTimeout(r, 200)); // let any stray fire-and-forget land
    expect(snapshotFiles(vault)).toEqual(before);
  });

  it('benchmark_run core measures the memory_recall path with a compatible shape', async () => {
    const { runQualityBenchmark } = await import('../../lib/benchmark.js');
    const r = await runQualityBenchmark(fixtureQueries);
    expect(r.mode).toBe('memory_recall');
    expect(r.totalQueries).toBe(10);
    for (const k of ['recallAt5', 'recallAt10', 'ndcgAt5', 'ndcgAt10', 'zeroRecallRate', 'avgLatencyMs', 'p95LatencyMs', 'totalLatencyMs'] as const) {
      expect(typeof r[k]).toBe('number');
    }
    expect(Array.isArray(r.byCategory)).toBe(true);
    expect(typeof r.mrr).toBe('number');
    expect(snapshotFiles(vault)).toEqual(before);
  });
});
