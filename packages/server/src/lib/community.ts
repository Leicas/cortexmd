// Louvain community detection over a weighted, undirected graph.
//
// Replaces shared-tag union-find for consolidation clustering. Union-find takes
// connected components: any chain of "shares ≥2 tags" links transitively merges
// notes into one cluster, so a few generic bridge-tags collapse unrelated notes
// into a single tag-soup blob (the documented over-consolidation failure mode).
// Louvain instead maximises modularity — it finds *densely* interconnected
// communities and leaves weakly-linked notes in separate groups.
//
// This implementation is **deterministic**: nodes are processed in the caller's
// insertion order and ties are broken by keeping the current community (strict
// improvement only), so the same graph always yields the same partition — which
// matters for reproducible consolidation and for tests. No randomness.

export interface WeightedEdge {
  a: string;
  b: string;
  /** Must be > 0. Edges are undirected; {a,b} and {b,a} are the same edge. */
  weight: number;
}

export interface CommunityResult {
  /** Communities as node-id lists, each sorted, ordered by size descending. */
  communities: string[][];
  /** Modularity of the final partition (−0.5 … 1). Higher is better-separated. */
  modularity: number;
}

const MAX_LEVELS = 20;
const MAX_LOCAL_PASSES = 100;

/**
 * Detect communities in a weighted undirected graph via the Louvain method.
 * Isolated nodes (no positive-weight edges) each form their own singleton
 * community. Pass every node you want represented in `nodes`, even if it has no
 * edges.
 */
export function louvain(nodes: string[], edges: WeightedEdge[]): CommunityResult {
  // ── Build the initial adjacency (super-node level 0 = original nodes) ──────
  // Each "super-node" is an index; level 0 super-node i owns [nodes[i]].
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n, i));

  // adj[i] = Map<neighborIndex, weight> (off-diagonal only, symmetric).
  let adj: Map<number, number>[] = nodes.map(() => new Map<number, number>());
  let selfLoop: number[] = nodes.map(() => 0);
  // members[i] = original node ids collapsed into super-node i.
  let members: string[][] = nodes.map((n) => [n]);

  let totalWeight = 0;
  for (const e of edges) {
    if (e.weight <= 0) continue;
    const ai = index.get(e.a);
    const bi = index.get(e.b);
    if (ai === undefined || bi === undefined) continue; // edge to unknown node
    if (ai === bi) {
      selfLoop[ai] += e.weight;
      totalWeight += e.weight;
      continue;
    }
    adj[ai].set(bi, (adj[ai].get(bi) ?? 0) + e.weight);
    adj[bi].set(ai, (adj[bi].get(ai) ?? 0) + e.weight);
    totalWeight += e.weight;
  }

  // No edges at all → every node is its own community.
  if (totalWeight === 0) {
    return {
      communities: nodes.map((n) => [n]).sort(sortBySizeThenName),
      modularity: 0,
    };
  }

  const m = totalWeight; // 2m = Σ degrees (self-loops counted twice)

  // ── Iterate levels: local-move → aggregate → repeat while it helps ────────
  for (let level = 0; level < MAX_LEVELS; level++) {
    const n = adj.length;
    const degree = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let d = 2 * selfLoop[i];
      for (const w of adj[i].values()) d += w;
      degree[i] = d;
    }

    const comm = new Array<number>(n);
    for (let i = 0; i < n; i++) comm[i] = i;
    const sigmaTot = degree.slice(); // Σ degrees of members, per community

    let movedAny = false;
    let moved = true;
    let pass = 0;
    while (moved && pass < MAX_LOCAL_PASSES) {
      moved = false;
      pass++;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        const ki = degree[i];

        // Pull i out of its community.
        sigmaTot[ci] -= ki;

        // Sum edge weight from i into each candidate neighbour community.
        const weightToComm = new Map<number, number>();
        for (const [nb, w] of adj[i]) {
          const c = comm[nb];
          weightToComm.set(c, (weightToComm.get(c) ?? 0) + w);
        }

        // Best community = max modularity gain. Start from staying in ci so a
        // tie never moves the node (determinism).
        let bestComm = ci;
        let bestGain = (weightToComm.get(ci) ?? 0) - (sigmaTot[ci] * ki) / (2 * m);
        for (const [c, wsum] of weightToComm) {
          if (c === ci) continue;
          const gain = wsum - (sigmaTot[c] * ki) / (2 * m);
          if (gain > bestGain) {
            bestGain = gain;
            bestComm = c;
          }
        }

        sigmaTot[bestComm] += ki;
        comm[i] = bestComm;
        if (bestComm !== ci) {
          moved = true;
          movedAny = true;
        }
      }
    }

    // Relabel communities to a dense 0..k-1 range and collect members.
    const remap = new Map<number, number>();
    const newMembers: string[][] = [];
    for (let i = 0; i < n; i++) {
      const c = comm[i];
      let nc = remap.get(c);
      if (nc === undefined) {
        nc = newMembers.length;
        remap.set(c, nc);
        newMembers.push([]);
      }
      newMembers[nc].push(...members[i]);
    }

    // Converged: local moving didn't reduce the community count this level.
    if (!movedAny || newMembers.length === adj.length) {
      return {
        communities: newMembers.map((g) => g.slice().sort()).sort(sortBySizeThenName),
        modularity: modularityOf(adj, selfLoop, comm, m),
      };
    }

    // ── Aggregate: each community becomes a super-node for the next level ─────
    const k = newMembers.length;
    const newAdj: Map<number, number>[] = Array.from({ length: k }, () => new Map<number, number>());
    const newSelf = new Array<number>(k).fill(0);
    for (let i = 0; i < adj.length; i++) {
      const ci = remap.get(comm[i])!;
      newSelf[ci] += selfLoop[i];
      for (const [nb, w] of adj[i]) {
        const cj = remap.get(comm[nb])!;
        if (ci === cj) {
          newSelf[ci] += w / 2; // each intra edge seen twice across i,nb
        } else {
          newAdj[ci].set(cj, (newAdj[ci].get(cj) ?? 0) + w / 2);
        }
      }
    }
    adj = newAdj;
    selfLoop = newSelf;
    members = newMembers;
  }

  return {
    communities: members.map((g) => g.slice().sort()).sort(sortBySizeThenName),
    modularity: modularityOf(adj, selfLoop, members.map((_, i) => i), m),
  };
}

/** Modularity of the partition given by `comm` over the current super-graph. */
function modularityOf(
  adj: Map<number, number>[],
  selfLoop: number[],
  comm: number[],
  m: number,
): number {
  if (m === 0) return 0;
  // Σ_in (intra-community edge weight, including self-loops) and Σ_tot per comm.
  const sigmaIn = new Map<number, number>();
  const sigmaTot = new Map<number, number>();
  for (let i = 0; i < adj.length; i++) {
    const c = comm[i];
    let deg = 2 * selfLoop[i];
    for (const w of adj[i].values()) deg += w;
    sigmaTot.set(c, (sigmaTot.get(c) ?? 0) + deg);
    let inW = 2 * selfLoop[i];
    for (const [nb, w] of adj[i]) {
      if (comm[nb] === c) inW += w;
    }
    sigmaIn.set(c, (sigmaIn.get(c) ?? 0) + inW);
  }
  let q = 0;
  for (const c of sigmaTot.keys()) {
    const sin = sigmaIn.get(c) ?? 0;
    const stot = sigmaTot.get(c) ?? 0;
    q += sin / (2 * m) - (stot / (2 * m)) ** 2;
  }
  return q;
}

function sortBySizeThenName(a: string[], b: string[]): number {
  if (b.length !== a.length) return b.length - a.length;
  return (a[0] ?? '').localeCompare(b[0] ?? '');
}
