import { describe, it, expect } from 'vitest';
import {
  buildRecallGraph,
  runPPR,
  extractSeeds,
  pprRrfContribution,
  entityNodeId,
  type BuildRecallGraphInput,
} from '../graph-recall.js';

/** Helper: a link graph from a plain adjacency of note paths. */
function linkGraph(edges: Record<string, string[]>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(edges)) m.set(k, new Set(v));
  return m;
}

describe('buildRecallGraph', () => {
  it('produces symmetric (undirected) adjacency from directed wikilinks', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': ['B.md'] }),
      titleToPath: new Map(),
    });
    expect(g.adj.get('A.md')?.get('B.md')).toBeGreaterThan(0);
    // undirected: reverse edge exists with the same weight
    expect(g.adj.get('B.md')?.get('A.md')).toBe(g.adj.get('A.md')?.get('B.md'));
  });

  it('sums parallel edges and caps at the max edge weight', () => {
    // A wikilinks B (1.0) AND both mention the same entity giving another path;
    // a direct duplicate link + a synonymy edge between A and B stack.
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': ['B.md'] }),
      titleToPath: new Map(),
      synonymyNeighbors: new Map([['A.md', [{ path: 'B.md', score: 1.0 }]]]),
      synonymyThreshold: 0.8,
    });
    // 1.0 (link) + 0.5*1.0 (synonymy) = 1.5, under the 2.0 cap
    expect(g.adj.get('A.md')?.get('B.md')).toBeCloseTo(1.5, 6);
  });

  it('excludes entity router nodes from noteNodes', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [] }),
      titleToPath: new Map([['A', 'A.md']]),
      mentions: [{ subject: 'A', object: 'Alice' }],
    });
    expect(g.noteNodes.has('A.md')).toBe(true);
    expect(g.noteNodes.has(entityNodeId('Alice'))).toBe(false);
    // the entity node still exists in adjacency as a router
    expect(g.adj.has(entityNodeId('Alice'))).toBe(true);
  });

  it('drops mentions whose subject title does not resolve to a note', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [] }),
      titleToPath: new Map([['A', 'A.md']]),
      mentions: [{ subject: 'Ghost', object: 'Alice' }],
    });
    // "Ghost" title has no path -> no edge created to the entity
    expect(g.adj.get('A.md')?.size ?? 0).toBe(0);
  });
});

describe('runPPR', () => {
  it('ranks a 2-hop-connected note above an unconnected one', () => {
    // A —entity(e)— B ; C is isolated. Seed on A. B should beat C.
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [], 'B.md': [], 'C.md': [] }),
      titleToPath: new Map([['A', 'A.md'], ['B', 'B.md'], ['C', 'C.md']]),
      mentions: [
        { subject: 'A', object: 'shared' },
        { subject: 'B', object: 'shared' },
      ],
    });
    const ranked = runPPR(g, ['A.md']);
    const byPath = new Map(ranked.map((r) => [r.path, r.score]));
    expect(byPath.get('B.md') ?? 0).toBeGreaterThan(byPath.get('C.md') ?? 0);
  });

  it('walks the service-owner-oncall bridge (note -> entity -> note)', () => {
    // billing note mentions entity "owner"; oncall note also mentions "owner".
    // Seeding the billing note must surface the oncall note via the shared entity.
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'Billing.md': [], 'Oncall.md': [], 'Unrelated.md': [] }),
      titleToPath: new Map([
        ['Billing', 'Billing.md'],
        ['Oncall', 'Oncall.md'],
        ['Unrelated', 'Unrelated.md'],
      ]),
      mentions: [
        { subject: 'Billing', object: 'owner' },
        { subject: 'Oncall', object: 'owner' },
      ],
    });
    const ranked = runPPR(g, ['Billing.md']);
    const paths = ranked.map((r) => r.path);
    expect(paths).toContain('Oncall.md');
    const byPath = new Map(ranked.map((r) => [r.path, r.score]));
    expect(byPath.get('Oncall.md') ?? 0).toBeGreaterThan(byPath.get('Unrelated.md') ?? 0);
  });

  it('node-specificity is LOAD-BEARING: it beats hub domination', () => {
    // A hub entity is mentioned by 50 generic notes AND by the true 2-hop
    // target. A specific entity bridges the seed note to the target only.
    // With nodeSpecificity ON, the specific target should outrank the generic
    // hub neighbours; with it OFF, the hub's mass floods its neighbours.
    const hubNotes = Array.from({ length: 50 }, (_, i) => `Hub${i}.md`);
    const links: Record<string, string[]> = { 'Seed.md': [], 'Target.md': [] };
    for (const h of hubNotes) links[h] = [];
    const titleToPath = new Map<string, string>([
      ['Seed', 'Seed.md'],
      ['Target', 'Target.md'],
    ]);
    for (const h of hubNotes) titleToPath.set(h.replace('.md', ''), h);

    const mentions: BuildRecallGraphInput['mentions'] = [
      // specific bridge: Seed <-> Target via a rare entity
      { subject: 'Seed', object: 'rareEntity' },
      { subject: 'Target', object: 'rareEntity' },
      // Seed also touches the hub entity...
      { subject: 'Seed', object: 'hubEntity' },
    ];
    // ...which 50 generic notes also mention (making it a hub).
    for (const h of hubNotes) mentions!.push({ subject: h.replace('.md', ''), object: 'hubEntity' });

    const g = buildRecallGraph({ linkGraph: linkGraph(links), titleToPath, mentions });

    const rankSpec = new Map(
      runPPR(g, ['Seed.md'], { nodeSpecificity: true }).map((r) => [r.path, r.score]),
    );
    const rankNoSpec = new Map(
      runPPR(g, ['Seed.md'], { nodeSpecificity: false }).map((r) => [r.path, r.score]),
    );

    const meanHubSpec =
      hubNotes.reduce((s, h) => s + (rankSpec.get(h) ?? 0), 0) / hubNotes.length;
    const meanHubNoSpec =
      hubNotes.reduce((s, h) => s + (rankNoSpec.get(h) ?? 0), 0) / hubNotes.length;

    // With specificity, Target's advantage over the average hub note is larger
    // than without it — i.e. turning specificity OFF regresses the target's
    // relative standing (hub domination). This proves the term is load-bearing.
    const advSpec = (rankSpec.get('Target.md') ?? 0) - meanHubSpec;
    const advNoSpec = (rankNoSpec.get('Target.md') ?? 0) - meanHubNoSpec;
    expect(advSpec).toBeGreaterThan(advNoSpec);
  });

  it('returns empty when there are no seeds (fusion unaffected)', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': ['B.md'] }),
      titleToPath: new Map(),
    });
    expect(runPPR(g, [])).toEqual([]);
    expect(runPPR(g, ['does-not-exist.md'])).toEqual([]);
  });

  it('converges (total mass stays ~1) and is deterministic', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': ['B.md'], 'B.md': ['C.md'], 'C.md': ['A.md'] }),
      titleToPath: new Map(),
    });
    const run1 = runPPR(g, ['A.md']);
    const run2 = runPPR(g, ['A.md']);
    expect(run1).toEqual(run2); // deterministic

    const totalMass = run1.reduce((s, r) => s + r.score, 0);
    // Only note nodes here (no entity routers), so mass should be close to 1.
    expect(totalMass).toBeGreaterThan(0.9);
    expect(totalMass).toBeLessThanOrEqual(1.0001);
  });

  it('respects the limit option', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': ['B.md', 'C.md', 'D.md'] }),
      titleToPath: new Map(),
    });
    expect(runPPR(g, ['A.md'], { limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});

describe('extractSeeds', () => {
  it('unions entity seeds and lexical-anchor note paths', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [], 'B.md': [] }),
      titleToPath: new Map([['A', 'A.md']]),
      mentions: [{ subject: 'A', object: 'Alice' }],
    });
    const seeds = extractSeeds(g, ['A.md', 'B.md'], ['Alice']);
    expect(seeds).toContain('A.md');
    expect(seeds).toContain('B.md');
    expect(seeds).toContain(entityNodeId('Alice'));
  });

  it('ignores seeds not present in the graph and respects lexicalSeeds cap', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [], 'B.md': [], 'C.md': [] }),
      titleToPath: new Map(),
    });
    const seeds = extractSeeds(g, ['A.md', 'B.md', 'C.md'], ['Nobody'], { lexicalSeeds: 2 });
    expect(seeds).not.toContain(entityNodeId('Nobody'));
    expect(seeds.length).toBe(2);
  });
});

describe('pprRrfContribution', () => {
  it('emits the same 1/(k+rank+1) RRF term used by the other arms', () => {
    const contrib = pprRrfContribution(
      [{ path: 'A.md', score: 9 }, { path: 'B.md', score: 4 }],
      60,
    );
    expect(contrib.get('A.md')).toBeCloseTo(1 / 61, 10);
    expect(contrib.get('B.md')).toBeCloseTo(1 / 62, 10);
  });
});

describe('runPPR on a reused graph (cached transitions)', () => {
  const chain = (n: number): Record<string, string[]> => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) edges[`N${i}.md`] = i + 1 < n ? [`N${i + 1}.md`] : [];
    return edges;
  };

  it('returns identical rankings on repeated calls and per specificity flag', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ ...chain(30), 'Hub.md': ['N0.md', 'N5.md', 'N10.md', 'N15.md'] }),
      titleToPath: new Map([['N3', 'N3.md'], ['N20', 'N20.md']]),
      mentions: [{ subject: 'N3', object: 'Alice' }, { subject: 'N20', object: 'Alice' }],
    });
    const first = runPPR(g, ['N3.md'], { limit: 10 });
    const second = runPPR(g, ['N3.md'], { limit: 10 });
    expect(second).toEqual(first);
    // A different seed on the SAME graph object must not be served stale state.
    const other = runPPR(g, ['N20.md'], { limit: 10 });
    expect(other[0].path).toBe('N20.md');
    expect(other).not.toEqual(first);
    // The two specificity variants are cached independently.
    const plain = runPPR(g, ['N3.md'], { limit: 10, nodeSpecificity: false });
    expect(runPPR(g, ['N3.md'], { limit: 10, nodeSpecificity: false })).toEqual(plain);
    expect(runPPR(g, ['N3.md'], { limit: 10 })).toEqual(first);
  });

  it('keeps rank mass a probability distribution and reaches notes across an entity bridge', () => {
    const g = buildRecallGraph({
      linkGraph: linkGraph({ 'A.md': [], 'B.md': [], 'C.md': [] }),
      titleToPath: new Map([['A', 'A.md'], ['B', 'B.md']]),
      mentions: [{ subject: 'A', object: 'Alice' }, { subject: 'B', object: 'Alice' }],
    });
    const out = runPPR(g, ['A.md', 'A.md']); // duplicate seeds collapse
    const byPath = new Map(out.map((r) => [r.path, r.score]));
    expect(byPath.get('A.md')!).toBeGreaterThan(byPath.get('B.md')!);
    expect(byPath.get('B.md')!).toBeGreaterThan(0);
    expect(byPath.has('C.md')).toBe(false); // unreachable
    for (const r of out) expect(r.score).toBeLessThanOrEqual(1);
  });

  it('stays fast on a 10k-node graph once the transitions are cached', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 10_000; i++) edges[`N${i}.md`] = [`N${(i * 7 + 1) % 10_000}.md`, `N${(i * 13 + 5) % 10_000}.md`];
    const g = buildRecallGraph({ linkGraph: linkGraph(edges), titleToPath: new Map() });
    runPPR(g, ['N0.md'], { limit: 50 }); // builds + caches
    const t0 = performance.now();
    for (let i = 1; i <= 5; i++) runPPR(g, [`N${i}.md`], { limit: 50 });
    // ~2 ms per query in practice; the pre-cache Map-based walk took ~200 ms.
    expect((performance.now() - t0) / 5).toBeLessThan(100);
  });
});
