import { saveMetrics, loadMetrics } from './persistence.js';
import { logger } from './logger.js';
import {
  getCodeNavSavings,
  restoreCodeNavSavings,
  getCodeNavSavingsForPersistence,
  type CodeNavSavingsSnapshot,
} from './code-nav/savings.js';

export type { CodeNavSavingsSnapshot } from './code-nav/savings.js';

export interface ToolMetrics {
  count: number;
  totalLatency: number;
  maxLatency: number;
  errors: number;
  lastCalled?: number;
  latencies: number[]; // last 100 for percentile calc
}

export interface AuthFailureEntry {
  timestamp: number;
  ip: string;
  path: string;
  method: string;
}

export type RequestCategory = 'health' | 'mcp' | 'oauth' | 'dashboard' | 'other';

export interface RequestsByCategory {
  health: number;
  mcp: number;
  oauth: number;
  dashboard: number;
  other: number;
}

export interface VaultHealthSnapshot {
  fileCountByType: Record<string, number>;
  totalFiles: number;
  totalMdFiles: number;
  archivedNotes: number;
  staleNotes: number; // notes not accessed in 60+ days
}

export interface LinkDensitySnapshot {
  totalLinks: number;
  avgLinksPerNote: number;
  orphanNotes: number; // notes with no inbound or outbound links
  mostLinked: Array<{ path: string; inbound: number }>;
}

export interface MemoryLifecycleSnapshot {
  totalArchived: number;
  totalConsolidated: number;
  recentArchives: Array<{ timestamp: number; path: string }>;
  recentConsolidations: Array<{ timestamp: number; count: number }>;
  temperatureDistribution: { hot: number; warm: number; cold: number; unset: number };
}

export interface CodeNavStatsSnapshot {
  repoCount: number;
  symbolCount: number;
  fileCount: number;
  callCount: { resolved: number; unresolved: number };
  dbSizeBytes: number;
  perRepo: Array<{ slug: string; symbols: number; files: number; lastIndexedAt: number | null }>;
}

/**
 * Compact, bounded per-tool telemetry rollup that survives a restart. Unlike
 * `ToolMetrics` (which carries an unbounded-ish latency array pruned to 100),
 * this is fixed-size per tool: a handful of numbers. It is persisted verbatim
 * and re-seeded on boot so per-tool p50/p95/max baselines are known immediately,
 * before enough live calls accumulate to recompute them.
 */
export interface ToolRollup {
  count: number;
  errCount: number;
  p50: number;
  p95: number;
  max: number;
  lastCalledTs: number;
}

export interface SearchTypeStats {
  lexicalOnlyHits: number;
  semanticOnlyHits: number;
  bothHits: number;
  totalFused: number;
  avgLexicalContribution: number; // 0-1, fraction of fused score from lexical
  avgSemanticContribution: number;
}

export interface MetricsSnapshot {
  totalRequests: number;
  requestsByCategory: RequestsByCategory;
  errorResponses: number;
  activeSessionsCount: number;
  toolCalls: Record<string, ToolMetrics>;
  /**
   * Persisted per-tool baseline rollups (last saved snapshot). Additive field
   * used by the dashboard to flag regressions of the live p95 against the
   * baseline that survived the last restart. Empty until seeded from disk.
   */
  toolBaselines: Record<string, ToolRollup>;
  requestsPerMinute: number;
  indexedNotes: number;
  lastIndexRebuild: number;
  uptime: number;
  recentActivity: Array<{ timestamp: number; tool: string; status: string; duration: number }>;
  recentErrors: Array<{ timestamp: number; tool: string; message: string }>;
  recentToolCalls: DetailedToolCall[];
  latencyHistory: Array<{ timestamp: number; avgLatencyMs: number; requestCount: number }>;
  recentAuthFailures: AuthFailureEntry[];
  temperatureHistory: TemperatureSnapshot[];
  searchStats: SearchQueryStats;
  recentSearches: Array<{ timestamp: number; query: string; resultCount: number; latencyMs: number }>;
  searchTypeStats: SearchTypeStats;
  vaultHealth: VaultHealthSnapshot | null;
  linkDensity: LinkDensitySnapshot | null;
  memoryLifecycle: MemoryLifecycleSnapshot;
  codeNav: CodeNavStatsSnapshot | null;
  codeNavSavings: CodeNavSavingsSnapshot;
}

const MAX_LATENCIES = 100;
const MAX_RECENT_ACTIVITY = 50;
const MAX_RECENT_ERRORS = 50;
const MAX_RECENT_TOOL_CALLS = 50;
const MAX_LATENCY_HISTORY = 360; // 1 hour at 10s intervals
const MAX_AUTH_FAILURES = 50;

export interface TemperatureSnapshot {
  timestamp: number;
  hot: number;
  warm: number;
  cold: number;
}

export interface SearchQueryStats {
  totalSearches: number;
  avgResultCount: number;
  avgLatencyMs: number;
  zeroResultCount: number;
}

const MAX_TEMP_HISTORY = 360;
const temperatureHistory: TemperatureSnapshot[] = [];

let searchTotalCount = 0;
let searchTotalResults = 0;
let searchTotalLatency = 0;
let searchZeroResults = 0;

const recentSearches: Array<{
  timestamp: number;
  query: string;
  resultCount: number;
  latencyMs: number;
}> = [];
const MAX_RECENT_SEARCHES = 30;

// ── Search type tracking ───────────────────────────────────────────────
let searchLexicalOnlyHits = 0;
let searchSemanticOnlyHits = 0;
let searchBothHits = 0;
let searchTotalFused = 0;
let searchTotalLexicalContribution = 0;
let searchTotalSemanticContribution = 0;

// ── Memory lifecycle tracking ──────────────────────────────────────────
const MAX_RECENT_ARCHIVES = 30;
const MAX_RECENT_CONSOLIDATIONS = 20;
const recentArchives: Array<{ timestamp: number; path: string }> = [];
const recentConsolidations: Array<{ timestamp: number; count: number }> = [];
let totalArchivedCount = 0;
let totalConsolidatedCount = 0;

// ── Vault health (sampled periodically) ────────────────────────────────
let cachedVaultHealth: VaultHealthSnapshot | null = null;
let cachedLinkDensity: LinkDensitySnapshot | null = null;

type VaultHealthSampler = () => VaultHealthSnapshot;
type LinkDensitySampler = () => LinkDensitySnapshot;
let vaultHealthSampler: VaultHealthSampler | null = null;
let linkDensitySampler: LinkDensitySampler | null = null;

export function registerVaultHealthSampler(fn: VaultHealthSampler): void {
  vaultHealthSampler = fn;
}

export function registerLinkDensitySampler(fn: LinkDensitySampler): void {
  linkDensitySampler = fn;
}

type TemperatureSampler = () => { hot: number; warm: number; cold: number };
let temperatureSampler: TemperatureSampler | null = null;

export function registerTemperatureSampler(fn: TemperatureSampler): void {
  temperatureSampler = fn;
}

type CodeNavSampler = () => CodeNavStatsSnapshot;
let codeNavSampler: CodeNavSampler | null = null;
let cachedCodeNavStats: CodeNavStatsSnapshot | null = null;

export function registerCodeNavSampler(fn: CodeNavSampler): void {
  codeNavSampler = fn;
}

const startTime = Date.now();

let totalRequests = 0;
let activeSessionsCount = 0;
let indexedNotes = 0;
let lastIndexRebuild = 0;
let errorResponses = 0;

const requestsByCategory: RequestsByCategory = {
  health: 0,
  mcp: 0,
  oauth: 0,
  dashboard: 0,
  other: 0,
};

const toolCalls: Record<string, ToolMetrics> = {};

// Compact per-tool rollups. `toolBaselines` is the snapshot seeded from disk on
// boot (the regression baseline); `toolRollups` is the live rollup recomputed
// from the current latency window and is what gets persisted.
const toolBaselines: Record<string, ToolRollup> = {};
const toolRollups: Record<string, ToolRollup> = {};

/** Percentile (0–1) of an already-sorted ascending array. Empty → 0. */
function percentileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Recompute the compact rollup for one tool from its ToolMetrics entry. */
function updateToolRollup(name: string, tc: ToolMetrics): void {
  const sorted = [...tc.latencies].sort((a, b) => a - b);
  toolRollups[name] = {
    count: tc.count,
    errCount: tc.errors,
    p50: percentileSorted(sorted, 0.5),
    p95: percentileSorted(sorted, 0.95),
    max: tc.maxLatency,
    lastCalledTs: tc.lastCalled ?? 0,
  };
}

const recentActivity: Array<{ timestamp: number; tool: string; status: string; duration: number }> = [];
const recentErrors: Array<{ timestamp: number; tool: string; message: string }> = [];

// Detailed circular buffers
export interface DetailedToolCall {
  timestamp: number;
  tool: string;
  durationMs: number;
  status: 'ok' | 'error';
  detail?: string;  // human-readable summary of what happened (e.g. query, path, result count)
}
const recentToolCalls: DetailedToolCall[] = [];
const latencyHistory: Array<{ timestamp: number; avgLatencyMs: number; requestCount: number }> = [];
const recentAuthFailures: AuthFailureEntry[] = [];

// Rolling window for requests-per-minute calculation (MCP requests only)
const requestTimestamps: number[] = [];

// Track requests since last sample for latency history
let sampleAccumLatency = 0;
let sampleAccumCount = 0;
let metricsSamplingInterval: ReturnType<typeof setInterval> | undefined;
let metricsFlushInterval: ReturnType<typeof setInterval> | undefined;

function pruneRequestTimestamps(): void {
  const cutoff = Date.now() - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

export function getMetrics(): MetricsSnapshot {
  pruneRequestTimestamps();
  return {
    totalRequests,
    requestsByCategory: { ...requestsByCategory },
    errorResponses,
    activeSessionsCount,
    toolCalls: { ...toolCalls },
    toolBaselines: { ...toolBaselines },
    requestsPerMinute: requestTimestamps.length,
    indexedNotes,
    lastIndexRebuild,
    uptime: Date.now() - startTime,
    recentActivity: recentActivity.slice(-20),
    recentErrors: recentErrors.slice(-10),
    recentToolCalls: recentToolCalls.slice(-MAX_RECENT_TOOL_CALLS),
    latencyHistory: latencyHistory.slice(-MAX_LATENCY_HISTORY),
    recentAuthFailures: recentAuthFailures.slice(-MAX_AUTH_FAILURES),
    temperatureHistory: temperatureHistory.slice(-MAX_TEMP_HISTORY),
    searchStats: {
      totalSearches: searchTotalCount,
      avgResultCount: searchTotalCount > 0 ? Math.round(searchTotalResults / searchTotalCount) : 0,
      avgLatencyMs: searchTotalCount > 0 ? Math.round(searchTotalLatency / searchTotalCount) : 0,
      zeroResultCount: searchZeroResults,
    },
    recentSearches: recentSearches.slice(-MAX_RECENT_SEARCHES),
    searchTypeStats: {
      lexicalOnlyHits: searchLexicalOnlyHits,
      semanticOnlyHits: searchSemanticOnlyHits,
      bothHits: searchBothHits,
      totalFused: searchTotalFused,
      avgLexicalContribution: searchTotalFused > 0 ? searchTotalLexicalContribution / searchTotalFused : 0,
      avgSemanticContribution: searchTotalFused > 0 ? searchTotalSemanticContribution / searchTotalFused : 0,
    },
    vaultHealth: cachedVaultHealth,
    linkDensity: cachedLinkDensity,
    memoryLifecycle: {
      totalArchived: totalArchivedCount,
      totalConsolidated: totalConsolidatedCount,
      recentArchives: recentArchives.slice(-MAX_RECENT_ARCHIVES),
      recentConsolidations: recentConsolidations.slice(-MAX_RECENT_CONSOLIDATIONS),
      temperatureDistribution: { hot: 0, warm: 0, cold: 0, unset: 0 }, // filled by SSE enrichment
    },
    codeNav: (() => {
      if (codeNavSampler) {
        try { cachedCodeNavStats = codeNavSampler(); } catch { /* keep last */ }
      }
      return cachedCodeNavStats;
    })(),
    codeNavSavings: getCodeNavSavings(),
  };
}

export function recordToolCall(toolName: string, durationMs: number, error?: string): void {
  if (!toolCalls[toolName]) {
    toolCalls[toolName] = {
      count: 0,
      totalLatency: 0,
      maxLatency: 0,
      errors: 0,
      latencies: [],
    };
  }

  const tc = toolCalls[toolName];
  tc.count++;
  tc.totalLatency += durationMs;
  if (durationMs > tc.maxLatency) tc.maxLatency = durationMs;
  tc.lastCalled = Date.now();
  tc.latencies.push(durationMs);
  if (tc.latencies.length > MAX_LATENCIES) tc.latencies.shift();

  const status = error ? 'error' : 'ok';
  if (error) {
    tc.errors++;
    recentErrors.push({ timestamp: Date.now(), tool: toolName, message: error });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
  }

  recentActivity.push({ timestamp: Date.now(), tool: toolName, status, duration: durationMs });
  if (recentActivity.length > MAX_RECENT_ACTIVITY) recentActivity.shift();

  // Keep the compact rollup in lockstep so it is ready to persist at any flush.
  updateToolRollup(toolName, tc);
}

/**
 * Record a detailed tool call entry into the circular buffer and accumulate
 * latency data for the latency-history sampler.
 */
export function recordToolCallDetailed(toolName: string, durationMs: number, error?: string, detail?: string): void {
  const status: 'ok' | 'error' = error ? 'error' : 'ok';
  recentToolCalls.push({ timestamp: Date.now(), tool: toolName, durationMs, status, detail });
  if (recentToolCalls.length > MAX_RECENT_TOOL_CALLS) recentToolCalls.shift();

  // Accumulate for latency sampling
  sampleAccumLatency += durationMs;
  sampleAccumCount++;
}

/**
 * Record a categorized request. Only MCP requests feed into requestsPerMinute.
 */
export function recordCategorizedRequest(category: RequestCategory): void {
  totalRequests++;
  requestsByCategory[category]++;
  if (category === 'mcp') {
    requestTimestamps.push(Date.now());
  }
}

/**
 * Record an error response (status >= 400).
 */
export function recordErrorResponse(): void {
  errorResponses++;
}

/**
 * Start periodic sampling of latency metrics (every 10 seconds).
 * Kept for 1 hour (360 entries).
 * Also starts the metrics flush interval if flushIntervalMs > 0 and dataDir is provided.
 */
export function startMetricsSampling(flushIntervalMs?: number, dataDir?: string): void {
  if (metricsSamplingInterval) return; // already running
  metricsSamplingInterval = setInterval(() => {
    pruneRequestTimestamps();
    const avgLatencyMs = sampleAccumCount > 0 ? Math.round(sampleAccumLatency / sampleAccumCount) : 0;
    latencyHistory.push({
      timestamp: Date.now(),
      avgLatencyMs,
      requestCount: requestTimestamps.length,
    });
    if (latencyHistory.length > MAX_LATENCY_HISTORY) latencyHistory.shift();
    // Reset accumulators
    sampleAccumLatency = 0;
    sampleAccumCount = 0;

    // Sample temperature counts
    if (temperatureSampler) {
      const t = temperatureSampler();
      temperatureHistory.push({ timestamp: Date.now(), ...t });
      if (temperatureHistory.length > MAX_TEMP_HISTORY) temperatureHistory.shift();
    }

    // Sample vault health and link density every 60s (every 6th sample)
    if (latencyHistory.length % 6 === 0) {
      if (vaultHealthSampler) {
        try { cachedVaultHealth = vaultHealthSampler(); } catch { /* skip */ }
      }
      if (linkDensitySampler) {
        try { cachedLinkDensity = linkDensitySampler(); } catch { /* skip */ }
      }
    }
  }, 10_000);

  // Start periodic disk flush
  if (flushIntervalMs && flushIntervalMs > 0 && dataDir) {
    metricsFlushInterval = setInterval(() => {
      persistMetricsToDisk(dataDir);
    }, flushIntervalMs);
  }
}

export function stopMetricsSampling(): void {
  if (metricsSamplingInterval) {
    clearInterval(metricsSamplingInterval);
    metricsSamplingInterval = undefined;
  }
  if (metricsFlushInterval) {
    clearInterval(metricsFlushInterval);
    metricsFlushInterval = undefined;
  }
}

/** @deprecated Use recordCategorizedRequest instead */
export function recordRequest(): void {
  totalRequests++;
  requestTimestamps.push(Date.now());
}

export function setActiveSessionsCount(count: number): void {
  activeSessionsCount = count;
}

export function setIndexedNotes(count: number): void {
  indexedNotes = count;
}

export function recordIndexRebuild(): void {
  lastIndexRebuild = Date.now();
}

export function recordAuthFailure(ip: string, path: string, method: string): void {
  recentAuthFailures.push({ timestamp: Date.now(), ip, path, method });
  if (recentAuthFailures.length > MAX_AUTH_FAILURES) recentAuthFailures.shift();
}

// ── Search score breakdown tracking ─────────────────────────────────────

interface SearchScoreEntry {
  timestamp: number;
  query: string;
  results: Array<{ path: string; lexical: number; semantic: number; fused: number }>;
}

const recentSearchScores: SearchScoreEntry[] = [];
const MAX_SEARCH_SCORES = 20;

export function recordSearchScoreBreakdown(query: string, results: Array<{ path: string; lexicalScore: number; semanticScore: number; fusedScore: number }>): void {
  recentSearchScores.push({
    timestamp: Date.now(),
    query,
    results: results.slice(0, 5).map(r => ({ path: r.path, lexical: r.lexicalScore, semantic: r.semanticScore, fused: r.fusedScore })),
  });
  if (recentSearchScores.length > MAX_SEARCH_SCORES) recentSearchScores.splice(0, recentSearchScores.length - MAX_SEARCH_SCORES);
}

export function getRecentSearchScores(): SearchScoreEntry[] {
  return recentSearchScores.slice();
}

export function recordSearchQuery(query: string, resultCount: number, latencyMs: number): void {
  searchTotalCount++;
  searchTotalResults += resultCount;
  searchTotalLatency += latencyMs;
  if (resultCount === 0) searchZeroResults++;

  recentSearches.push({ timestamp: Date.now(), query, resultCount, latencyMs });
  if (recentSearches.length > MAX_RECENT_SEARCHES) recentSearches.shift();
}

// ── Search type breakdown tracking ──────────────────────────────────────

/**
 * Record per-result search type contributions from a hybrid search.
 * Called once per search, passing all result entries.
 */
export function recordSearchTypeBreakdown(results: Array<{ lexicalScore: number; semanticScore: number; fusedScore: number }>): void {
  for (const r of results) {
    const hasLex = r.lexicalScore > 0;
    const hasSem = r.semanticScore > 0;
    if (hasLex && hasSem) {
      searchBothHits++;
    } else if (hasLex) {
      searchLexicalOnlyHits++;
    } else if (hasSem) {
      searchSemanticOnlyHits++;
    }
    if (r.fusedScore > 0) {
      searchTotalFused++;
      searchTotalLexicalContribution += r.lexicalScore / r.fusedScore;
      searchTotalSemanticContribution += r.semanticScore / r.fusedScore;
    }
  }
}

// ── Memory lifecycle recording ──────────────────────────────────────────

export function recordArchive(path: string): void {
  totalArchivedCount++;
  recentArchives.push({ timestamp: Date.now(), path });
  if (recentArchives.length > MAX_RECENT_ARCHIVES) recentArchives.shift();
}

export function recordConsolidation(count: number): void {
  totalConsolidatedCount++;
  recentConsolidations.push({ timestamp: Date.now(), count });
  if (recentConsolidations.length > MAX_RECENT_CONSOLIDATIONS) recentConsolidations.shift();
}

// ── Benchmark results ───────────────────────────────────────────────────

export interface BenchmarkSummary {
  timestamp: number;
  results: Array<{
    queryId: string;
    query: string;
    precisionAt5: number;
    precisionAt10: number;
    recallAt5: number;
    recallAt10: number;
    ndcgAt10: number;
    latencyMs: number;
    retrievedCount: number;
    expectedCount: number;
    retrievedPaths: Array<{ path: string; score: number }>;
    description?: string;
  }>;
  avgPrecisionAt5: number;
  avgPrecisionAt10: number;
  avgRecallAt5: number;
  avgRecallAt10: number;
  avgNdcgAt10: number;
  totalQueries: number;
  totalLatencyMs: number;
}

let lastBenchmark: BenchmarkSummary | null = null;

export function setBenchmarkResults(summary: BenchmarkSummary): void {
  lastBenchmark = summary;
}

export function getBenchmarkResults(): BenchmarkSummary | null {
  return lastBenchmark;
}

// ── Rescue@k (contradiction-resilience) results ──────────────────────────
//
// Reproducible, vault-independent metric: after a fact is contradicted, does
// the current fact still rank top-k while the superseded one is demoted? See
// `runRescueBenchmark` in benchmark.ts — it is grounded in the real validity
// constants, so the published number is CI-guarded, not asserted.

export interface RescueSummary {
  timestamp: number;
  /** Fraction of cases where the current fact ranks within top-k. */
  rescueAtK: number;
  /** Fraction of cases where the superseded fact was demoted below / dropped. */
  supersededDemoted: number;
  cases: number;
  k: number;
  scenarios: Array<{ name: string; contradictions: number; ranked: string[] }>;
}

let lastRescue: RescueSummary | null = null;

export function setRescueResults(summary: RescueSummary): void {
  lastRescue = summary;
}

export function getRescueResults(): RescueSummary | null {
  return lastRescue;
}

// ── Persistence helpers ───────────────────────────────────────────────────

interface PersistedMetrics {
  totalRequests?: number;
  requestsByCategory?: Partial<RequestsByCategory>;
  errorResponses?: number;
  toolCalls?: Record<string, {
    count: number;
    totalLatency: number;
    maxLatency: number;
    errors: number;
    lastCalled?: number;
  }>;
  /** Compact per-tool baseline rollups (bounded, no latency arrays). */
  toolRollups?: Record<string, Partial<ToolRollup>>;
  codeNavSavings?: unknown;
}

/**
 * Load metrics from disk and seed in-memory counters.
 * Handles missing or corrupt data gracefully.
 */
export function initMetricsFromDisk(dataDir: string): void {
  const raw = loadMetrics(dataDir);
  if (!raw) return;

  try {
    const persisted = raw as PersistedMetrics;

    if (typeof persisted.totalRequests === 'number') {
      totalRequests = persisted.totalRequests;
    }
    if (typeof persisted.errorResponses === 'number') {
      errorResponses = persisted.errorResponses;
    }
    if (persisted.requestsByCategory && typeof persisted.requestsByCategory === 'object') {
      for (const key of Object.keys(requestsByCategory) as RequestCategory[]) {
        const val = persisted.requestsByCategory[key];
        if (typeof val === 'number') {
          requestsByCategory[key] = val;
        }
      }
    }
    if (persisted.toolCalls && typeof persisted.toolCalls === 'object') {
      for (const [name, data] of Object.entries(persisted.toolCalls)) {
        if (data && typeof data.count === 'number') {
          toolCalls[name] = {
            count: data.count,
            totalLatency: typeof data.totalLatency === 'number' ? data.totalLatency : 0,
            maxLatency: typeof data.maxLatency === 'number' ? data.maxLatency : 0,
            errors: typeof data.errors === 'number' ? data.errors : 0,
            lastCalled: typeof data.lastCalled === 'number' ? data.lastCalled : undefined,
            latencies: [], // latency arrays are not persisted
          };
        }
      }
    }
    if (persisted.toolRollups && typeof persisted.toolRollups === 'object') {
      for (const [name, data] of Object.entries(persisted.toolRollups)) {
        if (data && typeof data === 'object') {
          toolBaselines[name] = {
            count: typeof data.count === 'number' ? data.count : 0,
            errCount: typeof data.errCount === 'number' ? data.errCount : 0,
            p50: typeof data.p50 === 'number' ? data.p50 : 0,
            p95: typeof data.p95 === 'number' ? data.p95 : 0,
            max: typeof data.max === 'number' ? data.max : 0,
            lastCalledTs: typeof data.lastCalledTs === 'number' ? data.lastCalledTs : 0,
          };
        }
      }
    }
    if (persisted.codeNavSavings) {
      restoreCodeNavSavings(persisted.codeNavSavings);
    }

    logger.info('Loaded persisted metrics', {
      totalRequests,
      toolCount: Object.keys(toolCalls).length,
      baselineCount: Object.keys(toolBaselines).length,
    });
  } catch {
    logger.warn('Failed to parse persisted metrics, starting fresh');
  }
}

/**
 * Return the subset of metrics worth persisting (counters and tool stats without latency arrays).
 */
export function getMetricsForPersistence(): object {
  const persistedToolCalls: Record<string, object> = {};
  for (const [name, tc] of Object.entries(toolCalls)) {
    persistedToolCalls[name] = {
      count: tc.count,
      totalLatency: tc.totalLatency,
      maxLatency: tc.maxLatency,
      errors: tc.errors,
      lastCalled: tc.lastCalled,
    };
  }

  // Compact per-tool rollups: fixed-size numeric summaries, no latency arrays.
  const persistedRollups: Record<string, ToolRollup> = {};
  for (const [name, r] of Object.entries(toolRollups)) {
    persistedRollups[name] = { ...r };
  }

  return {
    totalRequests,
    requestsByCategory: { ...requestsByCategory },
    errorResponses,
    toolCalls: persistedToolCalls,
    toolRollups: persistedRollups,
    codeNavSavings: getCodeNavSavingsForPersistence(),
    savedAt: Date.now(),
  };
}

/**
 * Persist current metrics to disk.
 */
export function persistMetricsToDisk(dataDir: string): void {
  try {
    saveMetrics(dataDir, getMetricsForPersistence());
  } catch (err) {
    logger.error('Failed to persist metrics', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
