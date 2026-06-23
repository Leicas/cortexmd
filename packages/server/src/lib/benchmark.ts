import { hybridSearch } from './search.js';
import { logger } from './logger.js';
import { config } from '../config.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { BenchmarkSummary } from './metrics.js';

export interface BenchmarkQuery {
  id: string;
  query: string;
  expectedPaths: string[];
  collections?: string[];
  description?: string;
}

// Default benchmark queries — covers different collections and query types
const DEFAULT_QUERIES: BenchmarkQuery[] = [
  {
    id: 'memory-decision',
    query: 'architecture decision',
    expectedPaths: [],
    collections: ['memories'],
    description: 'Recall architectural decisions from memories',
  },
  {
    id: 'memory-preference',
    query: 'user preference workflow',
    expectedPaths: [],
    collections: ['memories'],
    description: 'Find preference memories',
  },
  {
    id: 'crm-person',
    query: 'contact stakeholder',
    expectedPaths: [],
    collections: ['crm'],
    description: 'CRM person lookup',
  },
  {
    id: 'project-roadmap',
    query: 'roadmap plan milestones',
    expectedPaths: [],
    collections: ['projects'],
    description: 'Find project roadmaps',
  },
  {
    id: 'daily-recent',
    query: 'today meeting notes',
    expectedPaths: [],
    collections: ['daily-notes'],
    description: 'Recent daily notes',
  },
  {
    id: 'ops-mcp',
    query: 'MCP server configuration',
    expectedPaths: [],
    collections: ['ops'],
    description: 'Operations/infra notes',
  },
  {
    id: 'cross-collection',
    query: 'temperature heat score memory',
    expectedPaths: [],
    description: 'Cross-collection search for temperature system',
  },
  {
    id: 'semantic-test',
    query: 'haptic feedback force rendering',
    expectedPaths: [],
    description: 'Semantic similarity test — domain-specific terms',
  },
];

function getBenchmarkFilePath(): string {
  return path.join(config.dataDir, 'benchmark-queries.json');
}

function loadBenchmarkQueries(): BenchmarkQuery[] {
  const filePath = getBenchmarkFilePath();
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) return data as BenchmarkQuery[];
    } catch (err) {
      logger.warn('Failed to load custom benchmark queries', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return DEFAULT_QUERIES;
}

// IR scoring functions
function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (k === 0) return 0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(p => relevant.has(p)).length;
  return hits / k;
}

function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1; // vacuously true
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(p => relevant.has(p)).length;
  return hits / relevant.size;
}

function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  let idcg = 0;
  const idealCount = Math.min(relevant.size, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Run the retrieval benchmark suite.
 * If queries have no expectedPaths, we measure latency, result count, and
 * score distribution (useful for monitoring even without ground truth).
 */
export async function runBenchmark(): Promise<BenchmarkSummary> {
  const queries = loadBenchmarkQueries();

  const results: BenchmarkSummary['results'] = [];

  for (const q of queries) {
    const start = Date.now();
    try {
      const searchResults = await hybridSearch(q.query, {
        collections: q.collections,
        limit: 20,
      });
      const latencyMs = Date.now() - start;
      const retrieved = searchResults.map(r => r.path);
      const relevant = new Set(q.expectedPaths);

      const p5 = relevant.size > 0 ? precisionAtK(retrieved, relevant, 5) : -1;
      const p10 = relevant.size > 0 ? precisionAtK(retrieved, relevant, 10) : -1;
      const r5 = relevant.size > 0 ? recallAtK(retrieved, relevant, 5) : -1;
      const r10 = relevant.size > 0 ? recallAtK(retrieved, relevant, 10) : -1;
      const n10 = relevant.size > 0 ? ndcgAtK(retrieved, relevant, 10) : -1;

      results.push({
        queryId: q.id,
        query: q.query,
        precisionAt5: p5,
        precisionAt10: p10,
        recallAt5: r5,
        recallAt10: r10,
        ndcgAt10: n10,
        latencyMs,
        retrievedCount: retrieved.length,
        expectedCount: q.expectedPaths.length,
        retrievedPaths: searchResults.slice(0, 10).map(r => ({
          path: r.path,
          score: Math.round(r.fusedScore * 10000) / 10000,
        })),
        description: q.description,
      });
    } catch (err) {
      logger.warn('Benchmark query failed', {
        queryId: q.id,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        queryId: q.id,
        query: q.query,
        precisionAt5: -1,
        precisionAt10: -1,
        recallAt5: -1,
        recallAt10: -1,
        ndcgAt10: -1,
        latencyMs: Date.now() - start,
        retrievedCount: 0,
        expectedCount: q.expectedPaths.length,
        retrievedPaths: [],
      });
    }
  }

  // Compute averages (only for queries with ground truth, i.e. >= 0)
  const withTruth = results.filter(r => r.precisionAt5 >= 0);
  const hasTruth = withTruth.length > 0;
  const n = withTruth.length || 1;

  return {
    timestamp: Date.now(),
    results,
    avgPrecisionAt5: hasTruth ? withTruth.reduce((s, r) => s + r.precisionAt5, 0) / n : -1,
    avgPrecisionAt10: hasTruth ? withTruth.reduce((s, r) => s + r.precisionAt10, 0) / n : -1,
    avgRecallAt5: hasTruth ? withTruth.reduce((s, r) => s + r.recallAt5, 0) / n : -1,
    avgRecallAt10: hasTruth ? withTruth.reduce((s, r) => s + r.recallAt10, 0) / n : -1,
    avgNdcgAt10: hasTruth ? withTruth.reduce((s, r) => s + r.ndcgAt10, 0) / n : -1,
    totalQueries: results.length,
    totalLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
  };
}

// ── Quality Benchmark (JSONL dataset) ────────────────────────────────────

export interface QualityQueryEntry {
  query: string;
  expected_paths: string[];
  category?: string;
}

export interface QualityCategoryResult {
  category: string;
  queryCount: number;
  avgRecallAt5: number;
  avgRecallAt10: number;
  avgNdcgAt5: number;
  avgNdcgAt10: number;
  zeroRecallRate: number;
}

export interface QualityBenchmarkResult {
  timestamp: number;
  totalQueries: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt5: number;
  ndcgAt10: number;
  zeroRecallRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalLatencyMs: number;
  byCategory: QualityCategoryResult[];
}

/**
 * Compute NDCG@k correctly:
 *   DCG@k  = sum(1/log2(i+1) for i in 1..k where result[i-1] is relevant)
 *   IDCG@k = sum(1/log2(i+1) for i in 1..min(k, |expected|))
 *   NDCG   = DCG / IDCG  (0 if IDCG is 0)
 */
function computeNdcg(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;

  const topK = retrieved.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2); // i+2 because log2(1) = 0, we need log2(rank+1) where rank is 1-based
    }
  }

  const idealCount = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Compute recall@k: fraction of relevant items found in top-k results.
 */
function computeRecall(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((p) => relevant.has(p)).length;
  return hits / relevant.size;
}

/**
 * Run a quality benchmark from a JSONL dataset file.
 * Each line: {"query": "...", "expected_paths": ["..."], "category?": "..."}
 *
 * Streams the file line by line to avoid accumulating all in memory.
 * Computes: Recall@5, Recall@10, NDCG@5, NDCG@10, zero-recall rate, avg/p95 latency.
 */
export async function runQualityBenchmark(
  datasetPath: string,
  maxQueries?: number,
): Promise<QualityBenchmarkResult> {
  // Stream JSONL line by line
  const entries: QualityQueryEntry[] = [];

  const rl = createInterface({
    input: createReadStream(datasetPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    try {
      const parsed = JSON.parse(trimmed) as QualityQueryEntry;
      if (parsed.query && Array.isArray(parsed.expected_paths)) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
    if (maxQueries && entries.length >= maxQueries) break;
  }

  if (entries.length === 0) {
    return {
      timestamp: Date.now(),
      totalQueries: 0,
      recallAt5: 0,
      recallAt10: 0,
      ndcgAt5: 0,
      ndcgAt10: 0,
      zeroRecallRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      totalLatencyMs: 0,
      byCategory: [],
    };
  }

  // Per-query metrics accumulators
  const latencies: number[] = [];
  let sumRecall5 = 0;
  let sumRecall10 = 0;
  let sumNdcg5 = 0;
  let sumNdcg10 = 0;
  let zeroRecallCount = 0;

  // Per-category accumulators
  const catAccum = new Map<
    string,
    { count: number; recall5: number; recall10: number; ndcg5: number; ndcg10: number; zeroRecall: number }
  >();

  for (const entry of entries) {
    const relevant = new Set(entry.expected_paths);

    const start = Date.now();
    let retrieved: string[];
    try {
      const results = await hybridSearch(entry.query, { limit: 20 });
      retrieved = results.map((r) => r.path);
    } catch {
      retrieved = [];
    }
    const latency = Date.now() - start;
    latencies.push(latency);

    const r5 = computeRecall(retrieved, relevant, 5);
    const r10 = computeRecall(retrieved, relevant, 10);
    const n5 = computeNdcg(retrieved, relevant, 5);
    const n10 = computeNdcg(retrieved, relevant, 10);
    const isZeroRecall = r10 === 0 && relevant.size > 0 ? 1 : 0;

    sumRecall5 += r5;
    sumRecall10 += r10;
    sumNdcg5 += n5;
    sumNdcg10 += n10;
    zeroRecallCount += isZeroRecall;

    // Category breakdown
    const cat = entry.category ?? 'uncategorized';
    const existing = catAccum.get(cat) ?? { count: 0, recall5: 0, recall10: 0, ndcg5: 0, ndcg10: 0, zeroRecall: 0 };
    existing.count++;
    existing.recall5 += r5;
    existing.recall10 += r10;
    existing.ndcg5 += n5;
    existing.ndcg10 += n10;
    existing.zeroRecall += isZeroRecall;
    catAccum.set(cat, existing);
  }

  const n = entries.length;
  const totalLatency = latencies.reduce((a, b) => a + b, 0);

  // P95 latency
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95Idx = Math.min(Math.ceil(n * 0.95) - 1, n - 1);
  const p95Latency = sortedLatencies[p95Idx] ?? 0;

  // Category results
  const byCategory: QualityCategoryResult[] = [];
  for (const [cat, acc] of catAccum) {
    const c = acc.count;
    byCategory.push({
      category: cat,
      queryCount: c,
      avgRecallAt5: Math.round((acc.recall5 / c) * 10000) / 10000,
      avgRecallAt10: Math.round((acc.recall10 / c) * 10000) / 10000,
      avgNdcgAt5: Math.round((acc.ndcg5 / c) * 10000) / 10000,
      avgNdcgAt10: Math.round((acc.ndcg10 / c) * 10000) / 10000,
      zeroRecallRate: Math.round((acc.zeroRecall / c) * 10000) / 10000,
    });
  }
  byCategory.sort((a, b) => b.queryCount - a.queryCount);

  return {
    timestamp: Date.now(),
    totalQueries: n,
    recallAt5: Math.round((sumRecall5 / n) * 10000) / 10000,
    recallAt10: Math.round((sumRecall10 / n) * 10000) / 10000,
    ndcgAt5: Math.round((sumNdcg5 / n) * 10000) / 10000,
    ndcgAt10: Math.round((sumNdcg10 / n) * 10000) / 10000,
    zeroRecallRate: Math.round((zeroRecallCount / n) * 10000) / 10000,
    avgLatencyMs: Math.round(totalLatency / n),
    p95LatencyMs: p95Latency,
    totalLatencyMs: totalLatency,
    byCategory,
  };
}

// ── Rescue@k (contradiction-resilience metric) ───────────────────────────
//
// LongMemEval/iai-pme-style "Rescue@k": after a fact is contradicted by a
// newer memory, does the *current* (superseding) fact still rank in the top-k
// while the superseded one is demoted? A naive vector store fails this — the
// stale fact keeps its high cosine score. cortexmd's contradiction→Bayesian-
// validity pipeline (memory_store bumps the older note's β; memory_recall
// quarantines/penalizes by validity) is what should make this pass.
//
// `computeRescueAtK` is a pure scorer over an already-ranked result list, so it
// can be driven both by a live end-to-end run and by a deterministic unit test
// of the ranking pipeline.

export interface RescueCase {
  /** Path of the current/superseding memory that SHOULD rank well. */
  currentPath: string;
  /** Path of the superseded memory that SHOULD be demoted/excluded. */
  supersededPath: string;
  /** Ranked recall result paths (best-first) after contradiction. */
  ranked: string[];
}

export interface RescueResult {
  /** Fraction of cases where the current fact ranks within top-k. */
  rescueAtK: number;
  /** Fraction of cases where the superseded fact was demoted below the current one (or dropped). */
  supersededDemoted: number;
  cases: number;
}

/**
 * Score a set of rescue cases. A case "rescues" when the current fact is in the
 * top-k. It additionally counts as "demoted" when the superseded fact ranks
 * strictly below the current one (or is absent from the results entirely —
 * e.g. quarantined).
 */
export function computeRescueAtK(cases: RescueCase[], k = 10): RescueResult {
  if (cases.length === 0) return { rescueAtK: 0, supersededDemoted: 0, cases: 0 };
  let rescued = 0;
  let demoted = 0;
  for (const c of cases) {
    const curIdx = c.ranked.indexOf(c.currentPath);
    const supIdx = c.ranked.indexOf(c.supersededPath);
    if (curIdx >= 0 && curIdx < k) rescued++;
    // Superseded is demoted if dropped (supIdx < 0) or ranked below current.
    if (curIdx >= 0 && (supIdx < 0 || supIdx > curIdx)) demoted++;
  }
  const n = cases.length;
  return {
    rescueAtK: Math.round((rescued / n) * 10000) / 10000,
    supersededDemoted: Math.round((demoted / n) * 10000) / 10000,
    cases: n,
  };
}

/**
 * Save current benchmark results as ground truth.
 * Takes the top-K retrieved paths from each query and writes them
 * as expectedPaths in benchmark-queries.json for future comparisons.
 */
export function saveAsGroundTruth(summary: BenchmarkSummary, topK = 5): void {
  const queries = loadBenchmarkQueries();
  const resultMap = new Map(summary.results.map(r => [r.queryId, r]));

  const updated = queries.map(q => {
    const result = resultMap.get(q.id);
    if (result && result.retrievedPaths.length > 0) {
      return {
        ...q,
        expectedPaths: result.retrievedPaths.slice(0, topK).map(p => p.path),
      };
    }
    return q;
  });

  const filePath = getBenchmarkFilePath();
  writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  logger.info('Saved benchmark ground truth', { path: filePath, queries: updated.length });
}
