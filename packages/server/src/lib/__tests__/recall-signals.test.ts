import { describe, it, expect } from 'vitest';
import { normalizeCentrality, centralityBoost, CENTRALITY_SATURATION, explainRecall } from '../recall-signals.js';
import { computeRescueAtK, type RescueCase } from '../benchmark.js';
import {
  computeValidity,
  VALIDITY_PRIOR_ALPHA,
  VALIDITY_PRIOR_BETA,
  VALIDITY_STALE_RANK_PENALTY,
} from '../memory.js';

describe('centrality signal', () => {
  it('orphan (0 inbound) is a no-op boost of exactly 1', () => {
    expect(normalizeCentrality(0)).toBe(0);
    expect(centralityBoost(0, 0.15)).toBe(1.0);
    expect(centralityBoost(undefined, 0.15)).toBe(1.0);
  });

  it('weight 0 disables the signal regardless of connectivity', () => {
    expect(centralityBoost(100, 0)).toBe(1.0);
  });

  it('is monotonic in inbound links and saturates at the cap', () => {
    expect(normalizeCentrality(1)).toBeGreaterThan(0);
    expect(normalizeCentrality(5)).toBeGreaterThan(normalizeCentrality(1));
    expect(normalizeCentrality(CENTRALITY_SATURATION)).toBeCloseTo(1, 5);
    // Above the cap is clamped to 1, never exceeds the full +weight lift.
    expect(centralityBoost(1000, 0.15)).toBeCloseTo(1.15, 5);
  });

  it('a well-connected note outranks an equal orphan', () => {
    const w = 0.15;
    const orphan = 10 * centralityBoost(0, w);
    const hub = 10 * centralityBoost(8, w);
    expect(hub).toBeGreaterThan(orphan);
  });
});

describe('explainRecall', () => {
  const base = {
    lexicalScore: 0.1, semanticScore: 0.1, temperature: 'warm',
    heatScore: 6, recency: 0.8, inboundLinks: 3, validity: 0.67,
    stale: false, related: false,
  };

  it('classifies the retrieval arm', () => {
    expect(explainRecall({ ...base, lexicalScore: 0.1, semanticScore: 0.1 }).match).toBe('hybrid');
    expect(explainRecall({ ...base, lexicalScore: 0, semanticScore: 0.1 }).match).toBe('semantic');
    expect(explainRecall({ ...base, lexicalScore: 0.1, semanticScore: 0 }).match).toBe('lexical');
  });

  it('builds a rationale from the active signals', () => {
    const r = explainRecall(base);
    expect(r.reason).toContain('lexical+semantic match');
    expect(r.reason).toContain('warm');
    expect(r.reason).toContain('central (3 links)');
    expect(r.reason).toContain('recent');
    expect(r.inboundLinks).toBe(3);
    expect(r.validity).toBe(0.67);
  });

  it('flags staleness and singular link wording', () => {
    const r = explainRecall({ ...base, stale: true, inboundLinks: 1, recency: 0.2 });
    expect(r.reason).toContain('central (1 link)');
    expect(r.reason).toContain('stale (contradicted)');
    expect(r.reason).not.toContain('recent');
    expect(r.stale).toBe(true);
  });

  it('omits validity when tracking is off', () => {
    expect(explainRecall({ ...base, validity: undefined }).validity).toBeUndefined();
  });
});

describe('Bayesian validity transitions (Rescue@k mechanism)', () => {
  // A fresh memory is mildly trustworthy; each detected contradiction bumps β.
  const fresh = () => ({ validity_alpha: VALIDITY_PRIOR_ALPHA, validity_beta: VALIDITY_PRIOR_BETA });

  it('a fresh memory is neither stale nor quarantined', () => {
    const v = computeValidity(fresh());
    expect(v.validity).toBeCloseTo(2 / 3, 5);
    expect(v.stale).toBe(false);
    expect(v.quarantined).toBe(false);
  });

  it('one contradiction makes the superseded memory stale (score halved)', () => {
    const v = computeValidity({ validity_alpha: 2, validity_beta: 2 }); // β bumped once
    expect(v.validity).toBeCloseTo(0.5, 5);
    expect(v.stale).toBe(true);
    expect(v.quarantined).toBe(false);
  });

  it('two contradictions quarantine the superseded memory (excluded)', () => {
    const v = computeValidity({ validity_alpha: 2, validity_beta: 3 }); // β bumped twice
    expect(v.validity).toBeCloseTo(0.4, 5);
    expect(v.quarantined).toBe(true);
  });
});

describe('Rescue@10 end-to-end ranking simulation', () => {
  // Mirrors the memory_recall scoring contract: quarantined results are
  // dropped, stale results take VALIDITY_STALE_RANK_PENALTY (×0.5). We feed
  // equal base scores so the validity pipeline is the *only* thing separating
  // the current fact from the superseded one — exactly the Rescue@10 setup.
  function rankAfterContradiction(supersededBeta: number): string[] {
    const baseScore = 10;
    const items = [
      { path: 'current.md', alpha: 2, beta: 1 },            // fresh, never contradicted
      { path: 'superseded.md', alpha: 2, beta: supersededBeta },
    ];
    const scored = items
      .map((it) => {
        const v = computeValidity({ validity_alpha: it.alpha, validity_beta: it.beta });
        if (v.quarantined) return null; // excluded from results
        const penalty = v.stale ? VALIDITY_STALE_RANK_PENALTY : 1.0;
        return { path: it.path, score: baseScore * penalty };
      })
      .filter((x): x is { path: string; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.path);
  }

  it('rescues the current fact and demotes the superseded one after a single contradiction', () => {
    const cases: RescueCase[] = [
      { currentPath: 'current.md', supersededPath: 'superseded.md', ranked: rankAfterContradiction(2) },
    ];
    const r = computeRescueAtK(cases, 10);
    expect(r.rescueAtK).toBe(1);
    expect(r.supersededDemoted).toBe(1);
  });

  it('quarantines the superseded fact entirely after repeated contradictions', () => {
    const ranked = rankAfterContradiction(3); // β=3 → quarantined → dropped
    expect(ranked).toEqual(['current.md']);
    const r = computeRescueAtK(
      [{ currentPath: 'current.md', supersededPath: 'superseded.md', ranked }],
      10,
    );
    expect(r.rescueAtK).toBe(1);
    expect(r.supersededDemoted).toBe(1);
  });

  it('computeRescueAtK respects the k cutoff', () => {
    const ranked = ['a', 'b', 'c', 'current.md']; // current at rank 4 (index 3)
    const cases: RescueCase[] = [{ currentPath: 'current.md', supersededPath: 'x', ranked }];
    expect(computeRescueAtK(cases, 3).rescueAtK).toBe(0); // outside top-3
    expect(computeRescueAtK(cases, 10).rescueAtK).toBe(1); // inside top-10
  });
});
