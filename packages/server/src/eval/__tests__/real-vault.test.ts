import { describe, it, expect } from 'vitest';
import {
  deriveGoldSets,
  scoreRanking,
  aggregateArm,
  type GoldNote,
} from '../real-vault.js';
// The snapshot script is plain ESM (.mjs) with a pure exported helper.
import { shouldInclude } from '../../../scripts/snapshot-vault.mjs';

describe('deriveGoldSets', () => {
  const notes: GoldNote[] = [
    { path: 'Projects/Billing.md', title: 'Billing', links: ['People/Alice.md'] },
    { path: 'People/Alice.md', title: 'Alice', links: [] },
    { path: 'Notes/Orphan.md', title: 'Orphan', links: [] },
    { path: 'Notes/Untitled.md', title: '   ', links: ['Projects/Billing.md'] },
  ];

  it('self-retrieval: query = title, relevant = {self}; skips titleless notes', () => {
    const { selfRetrieval } = deriveGoldSets(notes);
    // Untitled note is skipped entirely (no title to query by).
    expect(selfRetrieval.map((q) => q.query).sort()).toEqual(['Alice', 'Billing', 'Orphan']);
    const billing = selfRetrieval.find((q) => q.query === 'Billing')!;
    expect([...billing.relevant]).toEqual(['Projects/Billing.md']);
  });

  it('multi-hop: relevant = resolved links; notes with no links are excluded', () => {
    const { multiHop } = deriveGoldSets(notes);
    // Only Billing has resolved links AND a title. Untitled is skipped despite
    // having a link (no title → no query). Alice/Orphan have no links.
    expect(multiHop.map((q) => q.query)).toEqual(['Billing']);
    expect([...multiHop[0].relevant]).toEqual(['People/Alice.md']);
  });

  it('drops self-links from the multi-hop relevant set', () => {
    const selfLinking: GoldNote[] = [
      { path: 'A.md', title: 'A', links: ['A.md', 'B.md'] },
    ];
    const { multiHop } = deriveGoldSets(selfLinking);
    expect([...multiHop[0].relevant]).toEqual(['B.md']);
  });

  it('honors the include toggles', () => {
    const onlySelf = deriveGoldSets(notes, { includeMultiHop: false });
    expect(onlySelf.multiHop).toHaveLength(0);
    expect(onlySelf.selfRetrieval.length).toBeGreaterThan(0);
    const onlyMulti = deriveGoldSets(notes, { includeSelfRetrieval: false });
    expect(onlyMulti.selfRetrieval).toHaveLength(0);
    expect(onlyMulti.multiHop.length).toBeGreaterThan(0);
  });
});

describe('scoreRanking', () => {
  it('recall@k is the fraction of the relevant set found in the top-k', () => {
    const ranked = ['a', 'b', 'c', 'd'];
    expect(scoreRanking(ranked, new Set(['a']), 10).recall).toBe(1);
    expect(scoreRanking(ranked, new Set(['a', 'b']), 10).recall).toBe(1);
    // c is at rank 3 → outside top-2 → half of a 2-element relevant set found.
    expect(scoreRanking(ranked, new Set(['a', 'c']), 2).recall).toBe(0.5);
    expect(scoreRanking(ranked, new Set(['z']), 10).recall).toBe(0);
  });

  it('reciprocal rank uses the FULL ranking, not the top-k cutoff', () => {
    const ranked = ['x', 'y', 'target'];
    // target is at 1-based rank 3 → RR = 1/3, even with k=1.
    expect(scoreRanking(ranked, new Set(['target']), 1).reciprocalRank).toBeCloseTo(1 / 3);
    // first relevant wins when several are present.
    expect(scoreRanking(['a', 'b'], new Set(['a', 'b']), 5).reciprocalRank).toBe(1);
    expect(scoreRanking(['a', 'b'], new Set(['z']), 5).reciprocalRank).toBe(0);
  });

  it('empty relevant set scores zero (no gold)', () => {
    expect(scoreRanking(['a'], new Set(), 5)).toEqual({ recall: 0, reciprocalRank: 0 });
  });
});

describe('aggregateArm', () => {
  it('averages recall/MRR and reports avg + p95 latency', () => {
    const report = aggregateArm('lexical', [
      { recall: 1, reciprocalRank: 1, latencyMs: 10 },
      { recall: 0, reciprocalRank: 0, latencyMs: 20 },
      { recall: 0.5, reciprocalRank: 0.5, latencyMs: 30 },
      { recall: 1, reciprocalRank: 1, latencyMs: 40 },
    ]);
    expect(report.arm).toBe('lexical');
    expect(report.nQueries).toBe(4);
    expect(report.recallAtK).toBeCloseTo(0.625);
    expect(report.mrr).toBeCloseTo(0.625);
    expect(report.avgLatencyMs).toBeCloseTo(25);
    // p95 nearest-rank over [10,20,30,40]: ceil(0.95*4)-1 = 3 → 40ms.
    expect(report.p95LatencyMs).toBe(40);
  });

  it('is well-defined for zero queries', () => {
    const report = aggregateArm('ppr', []);
    expect(report).toEqual({
      arm: 'ppr',
      nQueries: 0,
      recallAtK: 0,
      mrr: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    });
  });
});

describe('shouldInclude (snapshot-vault path filter)', () => {
  it('includes everything when no include list and no exclude', () => {
    expect(shouldInclude('Projects/Billing.md', {})).toBe(true);
    expect(shouldInclude('anything.md', { include: [], exclude: [] })).toBe(true);
  });

  it('exclude ALWAYS wins, even inside an included parent', () => {
    // EmailLog is excluded even though its parent-ish include would allow it.
    expect(
      shouldInclude('EmailLog/2026/msg.md', { include: ['EmailLog'], exclude: ['EmailLog'] }),
    ).toBe(false);
    expect(shouldInclude('Ops/secrets/key.md', { exclude: ['Ops/secrets'] })).toBe(false);
    // sibling under Ops that isn't the secrets folder is kept.
    expect(shouldInclude('Ops/runbook.md', { exclude: ['Ops/secrets'] })).toBe(true);
  });

  it('include list restricts to matching prefixes', () => {
    const f = { include: ['Projects', 'CRM'] };
    expect(shouldInclude('Projects/Billing.md', f)).toBe(true);
    expect(shouldInclude('CRM/Acme.md', f)).toBe(true);
    expect(shouldInclude('Areas/Health.md', f)).toBe(false);
  });

  it('prefix matching is segment-boundary aware (no false partial match)', () => {
    // `EmailLog` must NOT match `EmailLogArchive` (different folder).
    expect(shouldInclude('EmailLogArchive/x.md', { exclude: ['EmailLog'] })).toBe(true);
    expect(shouldInclude('EmailLog/x.md', { exclude: ['EmailLog'] })).toBe(false);
    // the folder itself (no trailing content) still matches.
    expect(shouldInclude('EmailLog', { exclude: ['EmailLog'] })).toBe(false);
  });

  it('normalizes backslashes and leading ./', () => {
    expect(shouldInclude('.\\EmailLog\\x.md', { exclude: ['EmailLog'] })).toBe(false);
    expect(shouldInclude('./Projects/x.md', { include: ['Projects'] })).toBe(true);
  });
});
