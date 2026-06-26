/**
 * Co-recall associative memory (Hebbian / HippoRAG-style spreading activation).
 *
 * "Neurons that fire together wire together." When memory_recall returns a set
 * of memories for a query, those memories were useful *together* — that
 * co-occurrence is a free associative signal the lexical/semantic/graph layers
 * don't capture. This module accumulates a weighted, undirected association
 * graph over note paths from real recalls, then uses it at query time:
 *
 *   query → base ranking → take top seeds → spread activation over the
 *   association graph → boost candidates strongly associated with the seeds.
 *
 * So a memory that is *consistently recalled alongside* the current strong
 * matches rises, even if its own lexical/semantic score is middling — the
 * vault's own usage history teaches it which memories belong together.
 *
 * Properties that keep it safe and bounded:
 *   - Never mutates user notes. The association graph is a derived, separate
 *     store (one JSON file in the data dir) — losing it only loses learned
 *     associations, never content.
 *   - Hebbian *forgetting*: weights decay daily so stale associations fade and
 *     the graph tracks how the vault is actually used over time.
 *   - Per-node neighbor cap with weakest-edge pruning, so a hub note can't grow
 *     an unbounded association list.
 *
 * The pure graph lives in `CoRecallGraph` (no I/O — directly unit-testable);
 * the module-level singleton adds lazy load + debounced atomic persistence.
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CoRecallOptions {
  /** Max neighbors retained per node (weakest pruned past this). */
  maxNeighbors?: number;
  /** Multiplicative weight decay applied per elapsed day. */
  decayPerDay?: number;
  /** Edges below this weight are pruned after decay. */
  pruneEpsilon?: number;
  /** Only the top-N returned paths participate in a co-recall event. */
  maxEventPaths?: number;
}

export interface Associate {
  path: string;
  weight: number;
  /** Weight normalized to 0..1 by this node's strongest edge. */
  norm: number;
}

const DEFAULTS: Required<CoRecallOptions> = {
  maxNeighbors: 32,
  decayPerDay: 0.98,
  pruneEpsilon: 0.05,
  maxEventPaths: 8,
};

export class CoRecallGraph {
  private edges = new Map<string, Map<string, number>>();
  private opts: Required<CoRecallOptions>;
  /** Timestamp (ms) of the last decay pass — drives lazy daily forgetting. */
  lastDecayTs = 0;

  constructor(opts: CoRecallOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private bumpDirected(a: string, b: string, inc: number): void {
    let m = this.edges.get(a);
    if (!m) { m = new Map(); this.edges.set(a, m); }
    m.set(b, (m.get(b) ?? 0) + inc);
    // Prune to the neighbor cap (drop the weakest) if we've exceeded it.
    if (m.size > this.opts.maxNeighbors) {
      let weakest: string | undefined;
      let min = Infinity;
      for (const [k, w] of m) {
        if (w < min) { min = w; weakest = k; }
      }
      if (weakest !== undefined && weakest !== b) {
        m.delete(weakest);
        // Keep the graph undirected: drop the reverse edge too. Otherwise
        // a→weakest can survive while weakest→a is pruned (or vice-versa),
        // which makes spreadingBoosts order-dependent and corrupts stats().
        const rev = this.edges.get(weakest);
        if (rev) { rev.delete(a); if (rev.size === 0) this.edges.delete(weakest); }
      }
    }
  }

  /**
   * Record one co-recall event: every unordered pair among the top
   * `maxEventPaths` returned memories gets its association strengthened.
   * Idempotent-safe to call fire-and-forget after each recall.
   */
  record(paths: string[], inc = 1): void {
    const uniq = [...new Set(paths)].slice(0, this.opts.maxEventPaths);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        this.bumpDirected(uniq[i], uniq[j], inc);
        this.bumpDirected(uniq[j], uniq[i], inc);
      }
    }
  }

  /** Strongest associates of `path`, normalized by the node's top edge. */
  getAssociates(path: string, limit = 8): Associate[] {
    const m = this.edges.get(path);
    if (!m || m.size === 0) return [];
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const max = sorted[0][1] || 1;
    return sorted.slice(0, limit).map(([p, w]) => ({
      path: p,
      weight: Math.round(w * 1000) / 1000,
      norm: Math.round((w / max) * 1000) / 1000,
    }));
  }

  /**
   * Spreading activation: from a set of seed paths (the top base-ranked
   * results), produce a multiplicative boost per associated candidate:
   *
   *   boost(c) = 1 + weight × maxSeedAssociationNorm(c)
   *
   * Candidates with no association to any seed are absent from the map (caller
   * treats that as ×1.0). Seeds themselves are never boosted by their own row.
   */
  spreadingBoosts(seeds: string[], weight: number, limit = 8): Map<string, number> {
    const boosts = new Map<string, number>();
    if (!weight || weight <= 0) return boosts;
    const seedSet = new Set(seeds);
    for (const seed of seeds) {
      for (const a of this.getAssociates(seed, limit)) {
        if (seedSet.has(a.path)) continue; // don't re-boost the seed set itself
        const candidate = 1 + weight * a.norm;
        const prev = boosts.get(a.path) ?? 1;
        if (candidate > prev) boosts.set(a.path, candidate);
      }
    }
    return boosts;
  }

  /**
   * Apply Hebbian forgetting: multiply every weight by decayPerDay^(elapsed
   * days) and prune edges that fall below pruneEpsilon. No-op if less than a
   * day has elapsed. Returns the number of edges pruned.
   */
  decay(now: number): number {
    if (this.lastDecayTs === 0) { this.lastDecayTs = now; return 0; }
    const days = (now - this.lastDecayTs) / DAY_MS;
    if (days < 1) return 0;
    const factor = Math.pow(this.opts.decayPerDay, days);
    let pruned = 0;
    for (const [node, m] of this.edges) {
      for (const [k, w] of m) {
        const nw = w * factor;
        if (nw < this.opts.pruneEpsilon) { m.delete(k); pruned++; }
        else m.set(k, nw);
      }
      if (m.size === 0) this.edges.delete(node);
    }
    this.lastDecayTs = now;
    return pruned;
  }

  stats(): { nodes: number; edges: number } {
    // Count each unordered pair once. Robust even if the graph is momentarily
    // asymmetric (an integer count, never a fractional `edges/2`), which is
    // what the dashboard's "Co-recall Links" KPI renders.
    const seen = new Set<string>();
    for (const [a, m] of this.edges) {
      // JSON-array key: unambiguous even for paths that contain spaces.
      for (const b of m.keys()) seen.add(JSON.stringify(a < b ? [a, b] : [b, a]));
    }
    return { nodes: this.edges.size, edges: seen.size };
  }

  toJSON(): { version: number; lastDecayTs: number; edges: Array<[string, Array<[string, number]>]> } {
    const out: Array<[string, Array<[string, number]>]> = [];
    for (const [node, m] of this.edges) out.push([node, [...m.entries()]]);
    return { version: 1, lastDecayTs: this.lastDecayTs, edges: out };
  }

  static fromJSON(obj: unknown, opts: CoRecallOptions = {}): CoRecallGraph {
    const g = new CoRecallGraph(opts);
    if (obj && typeof obj === 'object' && Array.isArray((obj as any).edges)) {
      const o = obj as { lastDecayTs?: number; edges: Array<[string, Array<[string, number]>]> };
      g.lastDecayTs = typeof o.lastDecayTs === 'number' ? o.lastDecayTs : 0;
      for (const [node, neighbors] of o.edges) {
        if (!Array.isArray(neighbors)) continue;
        g.edges.set(node, new Map(neighbors.filter((n) => Array.isArray(n) && n.length === 2)));
      }
    }
    return g;
  }
}

// ── Module-level persisted singleton ──────────────────────────────────────

let singleton: CoRecallGraph | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function filePath(): string {
  return path.join(config.dataDir, 'co-recall.json');
}

function graph(): CoRecallGraph {
  if (singleton) return singleton;
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8');
    singleton = CoRecallGraph.fromJSON(JSON.parse(raw));
    logger.info('Co-recall graph loaded', singleton.stats());
  } catch {
    singleton = new CoRecallGraph();
  }
  return singleton;
}

/** Synchronously write the current graph to disk (atomic tmp + rename). */
function persistNow(): void {
  if (!singleton) return;
  try {
    const fp = filePath();
    const tmp = fp + '.tmp';
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(singleton.toJSON()), { mode: 0o600 });
    fs.renameSync(tmp, fp);
  } catch (err) {
    logger.warn('Co-recall persist failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 5_000);
  // Don't keep the event loop alive just to flush associations.
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

/**
 * Synchronously flush a pending co-recall write. Call from the server shutdown
 * path: the debounced persist timer is `unref()`'d, so without this every
 * graceful restart inside the 5s debounce window silently drops the most
 * recent batch of learned associations (and can desync the decay clock, which
 * `record()` advances in memory before the write commits). No-op when nothing
 * is pending. Best-effort; never throws.
 */
export function flushCoRecall(): void {
  if (!persistTimer) return; // nothing dirty
  clearTimeout(persistTimer);
  persistTimer = null;
  persistNow();
}

/**
 * Record a co-recall event from the paths memory_recall actually returned.
 * Applies lazy daily decay first. Best-effort; never throws.
 */
export function recordCoRecall(paths: string[]): void {
  if (!config.coRecallEnabled || paths.length < 2) return;
  try {
    const g = graph();
    g.decay(Date.now());
    g.record(paths);
    schedulePersist();
  } catch (err) {
    logger.warn('recordCoRecall failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Spreading-activation boosts for the current recall's top seeds. Returns an
 * empty map when the feature is disabled or no associations exist (caller
 * treats a missing path as ×1.0).
 */
export function coRecallBoosts(seeds: string[]): Map<string, number> {
  if (!config.coRecallEnabled || config.coRecallWeight <= 0 || seeds.length === 0) {
    return new Map();
  }
  try {
    const g = graph();
    // Decay on the read path too — otherwise the first recall after a long idle
    // spreads stale, un-decayed weights (decay() previously ran only on record).
    // Guarded no-op when <1 day elapsed; in-memory advance is made durable by
    // the next recordCoRecall persist.
    g.decay(Date.now());
    return g.spreadingBoosts(seeds, config.coRecallWeight);
  } catch {
    return new Map();
  }
}

export function getCoRecallStats(): { nodes: number; edges: number } {
  try { return graph().stats(); } catch { return { nodes: 0, edges: 0 }; }
}

/** Test hook: reset the singleton so a test starts from an empty graph. */
export function __resetCoRecallForTests(): void {
  singleton = new CoRecallGraph();
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
}
