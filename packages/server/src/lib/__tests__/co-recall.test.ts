import { describe, it, expect } from 'vitest';
import { CoRecallGraph } from '../co-recall.js';

const DAY = 24 * 60 * 60 * 1000;

describe('CoRecallGraph.record', () => {
  it('strengthens every pair symmetrically', () => {
    const g = new CoRecallGraph();
    g.record(['a.md', 'b.md', 'c.md']);
    // a–b, a–c, b–c each bumped once, both directions.
    expect(g.getAssociates('a.md').map((x) => x.path).sort()).toEqual(['b.md', 'c.md']);
    expect(g.getAssociates('b.md').map((x) => x.path).sort()).toEqual(['a.md', 'c.md']);
    expect(g.stats()).toEqual({ nodes: 3, edges: 3 });
  });

  it('repeated co-recall accumulates weight', () => {
    const g = new CoRecallGraph();
    g.record(['a.md', 'b.md']);
    g.record(['a.md', 'b.md']);
    g.record(['a.md', 'c.md']);
    const assoc = g.getAssociates('a.md');
    expect(assoc[0].path).toBe('b.md'); // b co-recalled twice → strongest
    expect(assoc[0].weight).toBe(2);
    expect(assoc[0].norm).toBe(1);
    expect(assoc[1].path).toBe('c.md');
    expect(assoc[1].norm).toBe(0.5); // 1 / 2
  });

  it('ignores singleton and duplicate paths', () => {
    const g = new CoRecallGraph();
    g.record(['only.md']);
    g.record(['x.md', 'x.md']);
    expect(g.stats()).toEqual({ nodes: 0, edges: 0 });
  });

  it('caps neighbors per node, pruning the weakest', () => {
    const g = new CoRecallGraph({ maxNeighbors: 3 });
    // Hub co-recalled with many leaves; keep only the strongest 3.
    g.record(['hub.md', 'strong.md']);
    g.record(['hub.md', 'strong.md']); // strong weight 2
    for (const leaf of ['l1.md', 'l2.md', 'l3.md', 'l4.md']) g.record(['hub.md', leaf]);
    const assoc = g.getAssociates('hub.md', 99);
    expect(assoc.length).toBe(3);
    expect(assoc.map((a) => a.path)).toContain('strong.md'); // strongest survives
  });

  it('prunes symmetrically, keeping the graph undirected', () => {
    const g = new CoRecallGraph({ maxNeighbors: 3 });
    g.record(['hub.md', 'strong.md']);
    g.record(['hub.md', 'strong.md']); // strong weight 2 — always survives
    for (const leaf of ['l1.md', 'l2.md', 'l3.md', 'l4.md']) g.record(['hub.md', leaf]);

    const survivors = g.getAssociates('hub.md', 99).map((a) => a.path);
    // Every leaf hub dropped must also drop its reverse edge back to hub —
    // otherwise the graph goes asymmetric and stats() reports a fractional count.
    for (const leaf of ['l1.md', 'l2.md', 'l3.md', 'l4.md']) {
      const back = g.getAssociates(leaf).map((a) => a.path);
      if (survivors.includes(leaf)) expect(back).toEqual(['hub.md']);
      else expect(back).toEqual([]); // reverse edge pruned with the forward one
    }
    // edges is an exact integer == one per surviving unordered pair (all via hub).
    const s = g.stats();
    expect(Number.isInteger(s.edges)).toBe(true);
    expect(s.edges).toBe(survivors.length);
  });
});

describe('CoRecallGraph.spreadingBoosts', () => {
  it('boosts associates of seeds proportional to association strength', () => {
    const g = new CoRecallGraph();
    g.record(['seed.md', 'close.md']);
    g.record(['seed.md', 'close.md']); // norm 1.0
    g.record(['seed.md', 'far.md']);   // norm 0.5
    const boosts = g.spreadingBoosts(['seed.md'], 0.2);
    expect(boosts.get('close.md')).toBeCloseTo(1.2, 5); // 1 + 0.2*1.0
    expect(boosts.get('far.md')).toBeCloseTo(1.1, 5);   // 1 + 0.2*0.5
  });

  it('never boosts the seed set itself, and is a no-op at weight 0', () => {
    const g = new CoRecallGraph();
    g.record(['a.md', 'b.md']);
    const boosts = g.spreadingBoosts(['a.md', 'b.md'], 0.2);
    expect(boosts.has('a.md')).toBe(false);
    expect(boosts.has('b.md')).toBe(false);
    expect(g.spreadingBoosts(['a.md'], 0).size).toBe(0);
  });

  it('takes the max boost when a candidate associates with multiple seeds', () => {
    const g = new CoRecallGraph();
    g.record(['s1.md', 'cand.md']);
    g.record(['s2.md', 'cand.md']);
    g.record(['s2.md', 'cand.md']); // cand stronger to s2
    const boosts = g.spreadingBoosts(['s1.md', 's2.md'], 0.2);
    // s1→cand norm 1.0 (cand is s1's only edge); s2→cand norm 1.0 too → 1.2.
    expect(boosts.get('cand.md')).toBeCloseTo(1.2, 5);
  });
});

describe('CoRecallGraph.decay (Hebbian forgetting)', () => {
  it('is a no-op within a day and decays/prunes after', () => {
    const g = new CoRecallGraph({ decayPerDay: 0.5, pruneEpsilon: 0.05 });
    const t0 = 1_000_000_000_000;
    g.record(['a.md', 'b.md']); // weight 1
    g.decay(t0); // first call just seeds lastDecayTs
    expect(g.getAssociates('a.md')[0].weight).toBe(1);

    g.decay(t0 + DAY * 0.5); // <1 day → no-op
    expect(g.getAssociates('a.md')[0].weight).toBe(1);

    g.decay(t0 + DAY); // 1 day → ×0.5
    expect(g.getAssociates('a.md')[0].weight).toBeCloseTo(0.5, 5);
  });

  it('prunes edges that decay below epsilon', () => {
    const g = new CoRecallGraph({ decayPerDay: 0.1, pruneEpsilon: 0.05 });
    const t0 = 1_000_000_000_000;
    g.record(['a.md', 'b.md']); // weight 1
    g.decay(t0);
    g.decay(t0 + DAY); // ×0.1 → 0.1, still above epsilon
    expect(g.getAssociates('a.md').length).toBe(1);
    g.decay(t0 + 2 * DAY); // ×0.1 → 0.01 < 0.05 → pruned
    expect(g.getAssociates('a.md').length).toBe(0);
    expect(g.stats()).toEqual({ nodes: 0, edges: 0 });
  });
});

describe('CoRecallGraph serialization', () => {
  it('round-trips through JSON preserving weights and decay clock', () => {
    const g = new CoRecallGraph();
    g.record(['a.md', 'b.md']);
    g.record(['a.md', 'b.md']);
    g.lastDecayTs = 12345;
    const restored = CoRecallGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(restored.lastDecayTs).toBe(12345);
    expect(restored.getAssociates('a.md')[0]).toMatchObject({ path: 'b.md', weight: 2 });
  });

  it('fromJSON tolerates garbage input', () => {
    expect(CoRecallGraph.fromJSON(null).stats()).toEqual({ nodes: 0, edges: 0 });
    expect(CoRecallGraph.fromJSON({ edges: 'nope' }).stats()).toEqual({ nodes: 0, edges: 0 });
  });
});
