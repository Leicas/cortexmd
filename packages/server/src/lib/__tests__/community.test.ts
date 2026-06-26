import { describe, it, expect } from 'vitest';
import { louvain, type WeightedEdge } from '../community.js';

/** Undirected clique among `nodes` with the given per-edge weight. */
function clique(nodes: string[], weight = 1): WeightedEdge[] {
  const edges: WeightedEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      edges.push({ a: nodes[i], b: nodes[j], weight });
    }
  }
  return edges;
}

describe('louvain community detection', () => {
  it('returns each node as its own community when there are no edges', () => {
    const r = louvain(['a', 'b', 'c'], []);
    expect(r.communities).toEqual([['a'], ['b'], ['c']]);
    expect(r.modularity).toBe(0);
  });

  it('keeps a single clique as one community', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const r = louvain(nodes, clique(nodes));
    expect(r.communities).toHaveLength(1);
    expect(r.communities[0]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('separates two dense cliques joined by a single weak bridge (anti tag-soup)', () => {
    // This is the case union-find gets wrong: one bridge edge transitively
    // merges both cliques into a blob. Louvain should keep them apart.
    const left = ['a1', 'a2', 'a3', 'a4'];
    const right = ['b1', 'b2', 'b3', 'b4'];
    const edges = [
      ...clique(left, 3),
      ...clique(right, 3),
      { a: 'a1', b: 'b1', weight: 1 }, // weak bridge
    ];
    const r = louvain([...left, ...right], edges);
    expect(r.communities).toHaveLength(2);
    const sets = r.communities.map((c) => c.join(','));
    expect(sets).toContain('a1,a2,a3,a4');
    expect(sets).toContain('b1,b2,b3,b4');
    expect(r.modularity).toBeGreaterThan(0.3);
  });

  it('isolated nodes outside any clique stay as singletons', () => {
    const clq = ['a', 'b', 'c'];
    const r = louvain([...clq, 'lonely'], clique(clq));
    expect(r.communities).toContainEqual(['a', 'b', 'c']);
    expect(r.communities).toContainEqual(['lonely']);
  });

  it('is deterministic — identical input yields identical partition', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [...clique(['a', 'b', 'c'], 2), ...clique(['d', 'e', 'f'], 2), { a: 'c', b: 'd', weight: 1 }];
    const r1 = louvain(nodes, edges);
    const r2 = louvain(nodes, edges);
    expect(r1.communities).toEqual(r2.communities);
    expect(r1.modularity).toEqual(r2.modularity);
  });

  it('ignores edges to unknown nodes and non-positive weights', () => {
    const r = louvain(['a', 'b'], [
      { a: 'a', b: 'b', weight: 2 },
      { a: 'a', b: 'ghost', weight: 5 }, // unknown node
      { a: 'a', b: 'b', weight: -1 },    // non-positive
    ]);
    expect(r.communities).toEqual([['a', 'b']]);
  });
});
