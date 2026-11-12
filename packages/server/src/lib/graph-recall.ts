/**
 * Personalized-PageRank graph-recall arm (HippoRAG-2 style).
 *
 * A DORMANT, additive third retrieval arm. `buildRecallGraph` assembles ONE
 * undirected weighted graph over two node kinds — note nodes (keyed by the
 * exact vault-relative path used everywhere else) and entity router nodes
 * (`entity:<normalized-name>`) — from three edge sources that already exist in
 * the codebase:
 *
 *   - note ↔ note   (wikilinks)   from the link graph            weight 1.0
 *   - note ↔ entity (mentions)    from KG `mentions_*` triples    weight 0.7
 *   - note ↔ note   (synonymy)    from embedding cosine ≥ thresh  weight 0.5·cos
 *
 * `runPPR` seeds a personalization vector from the query (detected entities +
 * lexical-anchor note paths), then runs sparse power iteration with restart
 * (alpha=0.15). Node-specificity (graph-IDF) is folded into the transition
 * weights so hub nodes (a person mentioned in 200 notes) are down-weighted and
 * mass flows toward specific nodes — this is LOAD-BEARING (see the ablation
 * test in graph-recall.test.ts).
 *
 * Only note-path nodes are returned; entity nodes are pure routers. The output
 * shape (`{ path, score }[]`) matches `searchSemantic`, so it drops straight
 * into the RRF fusion loop in search.ts as a third arm. Because PPR only ADDS
 * RRF mass, enabling this arm can re-rank or introduce results but can never
 * drop an existing lexical/semantic hit.
 *
 * Nothing here has module-level side effects or singletons — every call takes
 * its inputs explicitly, so it is trivially unit-testable without a vault,
 * embeddings, or the KG.
 */

const ENTITY_PREFIX = 'entity:';

const W_LINK = 1.0;
const W_MENTION = 0.7;
const W_SYN_SCALE = 0.5; // synonymy edge weight = W_SYN_SCALE * cosine
const W_EDGE_MAX = 2.0; // cap on summed parallel-edge weight between a pair

const PPR_SYN_FANOUT = 8; // top-K semantic neighbours per note (bounds cost)

const DEFAULT_ALPHA = 0.15;
const DEFAULT_MAX_ITERS = 30;
const DEFAULT_TOL = 1e-6;
const DEFAULT_LEXICAL_SEEDS = 5;

/** Normalize an entity name for use as a stable graph node id. */
export function normalizeEntity(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The graph node id for an entity name. */
export function entityNodeId(name: string): string {
  return ENTITY_PREFIX + normalizeEntity(name);
}

export interface RecallGraph {
  /** adjacency: nodeId -> (neighborId -> summed weight). Undirected (symmetric). */
  adj: Map<string, Map<string, number>>;
  /** weighted degree per node, for node-specificity IDF. */
  degree: Map<string, number>;
  /** set of note-path nodes (everything else is an `entity:` node). */
  noteNodes: Set<string>;
}

export interface BuildRecallGraphInput {
  /**
   * Forward wikilink graph — note path -> resolved target paths. Accepts the
   * `Set` shape used by graph.ts's `cachedGraph` or a plain iterable of paths.
   */
  linkGraph: Map<string, Iterable<string>>;
  /** title -> path resolver for KG-mention subjects (built from docMeta). */
  titleToPath: Map<string, string>;
  /**
   * Mention edges as raw {subject(title), object(entity)} pairs — pass
   * `kgAllMentionTriples()`. Subjects are resolved to paths via `titleToPath`;
   * unresolved subjects are dropped (they can't be a result), but the entity
   * node still bridges the notes that DO resolve.
   */
  mentions?: Array<{ subject: string; object: string }>;
  /**
   * Optional synonymy edges: for each note path, its top semantic neighbours
   * as `{ path, score }` (cosine). Only pairs with score ≥ `synonymyThreshold`
   * become edges. Omit entirely when embeddings are not ready — the graph is
   * then purely wikilink + mention, which is still enough for the multi-hop
   * person→project and service→owner→oncall bridges.
   */
  synonymyNeighbors?: Map<string, Array<{ path: string; score: number }>>;
  /** cosine floor for a synonymy edge (default 0.8). */
  synonymyThreshold?: number;
}

/** Insert an undirected weighted edge, summing parallels and capping at W_EDGE_MAX. */
function addEdge(adj: Map<string, Map<string, number>>, a: string, b: string, w: number): void {
  if (a === b || w <= 0) return;
  let ma = adj.get(a);
  if (!ma) { ma = new Map(); adj.set(a, ma); }
  let mb = adj.get(b);
  if (!mb) { mb = new Map(); adj.set(b, mb); }
  ma.set(b, Math.min(W_EDGE_MAX, (ma.get(b) ?? 0) + w));
  mb.set(a, Math.min(W_EDGE_MAX, (mb.get(a) ?? 0) + w));
}

/**
 * Assemble the unified note/entity recall graph. Synchronous + pure: all
 * expensive I/O (vault walk, embedding kNN) is done by the caller and passed in
 * as `linkGraph` / `mentions` / `synonymyNeighbors`.
 */
export function buildRecallGraph(input: BuildRecallGraphInput): RecallGraph {
  const adj = new Map<string, Map<string, number>>();
  const noteNodes = new Set<string>();

  const ensureNote = (p: string) => {
    noteNodes.add(p);
    if (!adj.has(p)) adj.set(p, new Map());
  };

  // 1. note ↔ note wikilink edges
  for (const [source, targets] of input.linkGraph) {
    ensureNote(source);
    for (const target of targets) {
      ensureNote(target);
      addEdge(adj, source, target, W_LINK);
    }
  }

  // 2. note ↔ entity mention edges (subject = title -> path via titleToPath)
  if (input.mentions) {
    for (const { subject, object } of input.mentions) {
      const notePath = input.titleToPath.get(subject);
      if (!notePath) continue; // subject not an indexed note — can't be a result
      ensureNote(notePath);
      const ent = entityNodeId(object);
      if (!adj.has(ent)) adj.set(ent, new Map());
      addEdge(adj, notePath, ent, W_MENTION);
    }
  }

  // 3. note ↔ note synonymy edges (only when caller supplied neighbours)
  if (input.synonymyNeighbors) {
    const threshold = input.synonymyThreshold ?? 0.8;
    for (const [notePath, neighbors] of input.synonymyNeighbors) {
      ensureNote(notePath);
      let taken = 0;
      for (const n of neighbors) {
        if (taken >= PPR_SYN_FANOUT) break;
        if (n.path === notePath) continue;
        if (n.score < threshold) continue;
        ensureNote(n.path);
        addEdge(adj, notePath, n.path, W_SYN_SCALE * n.score);
        taken++;
      }
    }
  }

  // weighted degree per node (used for node-specificity IDF)
  const degree = new Map<string, number>();
  for (const [node, nbrs] of adj) {
    let d = 0;
    for (const w of nbrs.values()) d += w;
    degree.set(node, d);
  }

  return { adj, degree, noteNodes };
}

/**
 * Transition matrix in CSR form over integer node ids: node `i`'s out-edges
 * are `targets[offsets[i] .. offsets[i+1])` with probabilities `probs[...]`
 * (each row sums to 1; a dangling node has an empty row).
 */
interface Transitions {
  ids: string[];
  indexOf: Map<string, number>;
  isNote: Uint8Array;
  offsets: Int32Array;
  targets: Int32Array;
  probs: Float64Array;
}

// Transitions depend only on the (immutable) graph and the specificity flag, so
// they are memoised per graph object: a caller that reuses a graph across
// queries (lib/search.ts caches it per index version) pays the O(E)
// normalisation once instead of on every query.
const transitionCache = new WeakMap<RecallGraph, { spec?: Transitions; plain?: Transitions }>();

/**
 * Row-normalised, specificity-weighted transition matrix. With `useSpec` the
 * weight of edge (u→v) is `w(u,v) · log(1 + N / (1 + deg(v)))` (graph-IDF).
 */
function transitionsFor(graph: RecallGraph, useSpec: boolean): Transitions {
  let slot = transitionCache.get(graph);
  if (!slot) { slot = {}; transitionCache.set(graph, slot); }
  const cached = useSpec ? slot.spec : slot.plain;
  if (cached) return cached;

  const { adj, degree, noteNodes } = graph;
  const N = adj.size;
  const ids = [...adj.keys()];
  const indexOf = new Map<string, number>();
  ids.forEach((id, i) => indexOf.set(id, i));
  const isNote = new Uint8Array(N);
  const spec = new Float64Array(N);
  let edgeCount = 0;
  ids.forEach((id, i) => {
    if (noteNodes.has(id)) isNote[i] = 1;
    spec[i] = useSpec ? Math.log(1 + N / (1 + (degree.get(id) ?? 0))) : 1;
    edgeCount += adj.get(id)!.size;
  });

  const offsets = new Int32Array(N + 1);
  const targets = new Int32Array(edgeCount);
  const probs = new Float64Array(edgeCount);
  let k = 0;
  ids.forEach((id, i) => {
    offsets[i] = k;
    const start = k;
    let total = 0;
    for (const [v, w] of adj.get(id)!) {
      const j = indexOf.get(v);
      if (j === undefined) continue;
      const tw = w * spec[j];
      if (tw > 0) { targets[k] = j; probs[k] = tw; total += tw; k++; }
    }
    // Dangling nodes (no positive out-transitions) contribute no push mass;
    // their rank leaks to restart via the alpha·p term, which is correct.
    for (let e = start; e < k; e++) probs[e] /= total;
  });
  offsets[N] = k;

  const trans: Transitions = { ids, indexOf, isNote, offsets, targets, probs };
  if (useSpec) slot.spec = trans; else slot.plain = trans;
  return trans;
}

export interface RunPPROptions {
  alpha?: number;           // restart probability (default 0.15)
  maxIters?: number;        // default 30
  tol?: number;             // L1 convergence tolerance (default 1e-6)
  nodeSpecificity?: boolean; // default true (LOAD-BEARING)
  limit?: number;           // top-N note results to return (default: all note nodes)
}

/**
 * Personalized PageRank via sparse power iteration with restart.
 *
 * `seeds` are node ids (note paths and/or `entity:` ids) that form the
 * personalization vector `p` (uniform over seeds). Returns note-path nodes
 * only, best-first, as `{ path, score }` — the same shape `searchSemantic`
 * returns, so it drops straight into the fusion loop.
 *
 * With `nodeSpecificity: true` (default) the transition weight of edge (u→v) is
 * `w(u,v) · spec(v)` where `spec(v) = log(1 + N / (1 + deg(v)))` — a graph-IDF
 * that down-weights hub destinations so a person mentioned in 200 notes does
 * not dominate the walk. Setting it false is the ablation the acceptance check
 * uses to prove the term is load-bearing.
 *
 * The iteration runs over typed arrays (CSR transitions cached per graph), so a
 * query costs O(iterations × edges) with no per-iteration allocation.
 */
export function runPPR(
  graph: RecallGraph,
  seeds: string[],
  opts: RunPPROptions = {},
): Array<{ path: string; score: number }> {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const maxIters = opts.maxIters ?? DEFAULT_MAX_ITERS;
  const tol = opts.tol ?? DEFAULT_TOL;
  const useSpec = opts.nodeSpecificity ?? true;

  const N = graph.adj.size;

  // No seeds (or seeds not in graph) => empty result; fusion is unaffected.
  const seedSet = [...new Set(seeds.filter((s) => graph.adj.has(s)))];
  if (N === 0 || seedSet.length === 0) return [];

  const { ids, indexOf, isNote, offsets, targets, probs } = transitionsFor(graph, useSpec);

  // Personalization vector: uniform over seeds.
  const p = new Float64Array(N);
  const seedMass = 1 / seedSet.length;
  for (const s of seedSet) p[indexOf.get(s)!] = seedMass;

  // Rank vector, initialized to p.
  let r = Float64Array.from(p);
  let next = new Float64Array(N);

  for (let iter = 0; iter < maxIters; iter++) {
    // restart term: alpha * p
    for (let i = 0; i < N; i++) next[i] = alpha * p[i];
    // push term: (1 - alpha) * Mᵀ · r — push each node's mass along its out-edges
    for (let u = 0; u < N; u++) {
      const ru = r[u];
      if (ru === 0) continue;
      const contrib = (1 - alpha) * ru;
      for (let e = offsets[u], end = offsets[u + 1]; e < end; e++) {
        next[targets[e]] += contrib * probs[e];
      }
    }

    // L1 convergence check
    let l1 = 0;
    for (let i = 0; i < N; i++) l1 += Math.abs(next[i] - r[i]);
    const tmp = r;
    r = next;
    next = tmp;
    if (l1 < tol) break;
  }

  // Keep note-path nodes only (entity nodes are routers, never results).
  const out: Array<{ path: string; score: number }> = [];
  for (let i = 0; i < N; i++) {
    if (r[i] <= 0 || !isNote[i]) continue;
    out.push({ path: ids[i], score: r[i] });
  }
  out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

/**
 * Query -> seed node ids. Two seed sources, unioned:
 *   1. entity seeds  — detected/registered entities whose `entity:` node exists
 *   2. lexical anchors — the top lexical-result note paths (grounds PPR even
 *      when NER finds nothing; this is what unblocks the service-owner-oncall
 *      case: query → billing note → entity(owner) → oncall note).
 *
 * `detectedEntityNames` and `registryMatchName` are passed in (the caller runs
 * `detectEntities` / `findEntity`) so this stays pure and testable.
 */
export function extractSeeds(
  graph: RecallGraph,
  lexicalTopPaths: string[],
  detectedEntityNames: string[] = [],
  opts: { lexicalSeeds?: number } = {},
): string[] {
  const lexicalSeeds = opts.lexicalSeeds ?? DEFAULT_LEXICAL_SEEDS;
  const seeds = new Set<string>();

  for (const name of detectedEntityNames) {
    const id = entityNodeId(name);
    if (graph.adj.has(id)) seeds.add(id);
  }

  for (const p of lexicalTopPaths.slice(0, lexicalSeeds)) {
    if (graph.adj.has(p)) seeds.add(p);
  }

  return [...seeds];
}

/**
 * RRF contribution of the PPR arm. Returns `path -> 1/(k+rank+1)` for the
 * ranked PPR results — the SAME reciprocal-rank-fusion term and `k` the
 * lexical/semantic arms use. Additive: the caller sums this into the existing
 * fused score, so it can only re-rank or introduce, never drop.
 */
export function pprRrfContribution(
  pprResults: Array<{ path: string; score: number }>,
  k: number,
): Map<string, number> {
  const out = new Map<string, number>();
  pprResults.forEach((r, rank) => {
    out.set(r.path, (out.get(r.path) ?? 0) + 1 / (k + rank + 1));
  });
  return out;
}
