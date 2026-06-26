/**
 * `buildSsePayload()` — assembles the full SSE payload object that feeds every
 * dashboard tab. Lifted verbatim from the legacy `dashboard.ts` SSE `send()`
 * body. This is the de-facto view-model (see payload.types.ts). The
 * `...getMetrics()` spread is preserved exactly — it is the source of
 * `codeNav`, `codeNavSavings`, `toolCalls`, `latencyHistory`, etc.
 *
 * Mutable cross-push state (memory-stack cache, agent-diary cache, dream
 * history, LLM status, dismissed suggestions) lives in `model/state.ts`.
 */
import { getMetrics, getRecentSearchScores, getBenchmarkResults, getRescueResults } from '../../lib/metrics.js';
import { getRateLimitSnapshot } from '../../lib/rate-limit.js';
import { getSessionSnapshots } from '../../index.js';
import { getOAuthClients } from '../../oauth.js';
import { getDocMeta, getDocMetaSummary, getCollectionDistribution, getIndexHealth } from '../../lib/search.js';
import { getEmbeddingStats } from '../../lib/embeddings.js';
import { getRecentLogs } from '../../lib/logger.js';
import { wakeUp } from '../../lib/memory-stack.js';
import { isKgInitialized, kgStats } from '../../lib/knowledge-graph.js';
import { listEntities } from '../../lib/entity-registry.js';
import { listAgents } from '../../lib/journal.js';
import { computeHealth as computeDreamHealth } from '../../lib/dream-engine.js';
import { getCoRecallStats } from '../../lib/co-recall.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { computeHealthScore } from './health.js';
import { computeDerived } from './derive.js';
import {
  getMemoryStackCache, setMemoryStackCache,
  getAgentDiaryCache, setAgentDiaryCache,
  getDreamHistory, getLastDreamReport,
  isDreamRunning, getLlmStatus, isDismissed,
} from './state.js';

/** Assemble the enriched SSE payload (called every 2s by the SSE route). */
export function buildSsePayload(): Record<string, unknown> {
  const metrics = getMetrics();
  const payload: Record<string, unknown> = { ...metrics };

  // Enrich tool calls with percentile stats
  const tc = metrics.toolCalls;
  const enriched: Record<string, unknown> = {};
  for (const [name, m] of Object.entries(tc)) {
    const sorted = [...m.latencies].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    enriched[name] = {
      count: m.count,
      avgLatency: m.count > 0 ? Math.round(m.totalLatency / m.count) : 0,
      p95Latency: sorted.length > 0 ? sorted[Math.min(p95Index, sorted.length - 1)] : 0,
      maxLatency: m.maxLatency,
      errors: m.errors,
      lastCalled: m.lastCalled ?? null,
    };
  }
  payload.toolCalls = enriched;

  // Additional data for dashboard tabs
  payload.rateLimits = getRateLimitSnapshot();
  payload.sessions = getSessionSnapshots();
  payload.oauthClients = getOAuthClients();
  payload.latencyHistory = metrics.latencyHistory;
  payload.recentToolCalls = metrics.recentToolCalls;
  payload.recentErrors = metrics.recentErrors;
  payload.recentAuthFailures = metrics.recentAuthFailures;

  // Memory temperature counts from the search index docMeta (single pass)
  const docMeta = getDocMeta();
  let hot = 0, warm = 0, cold = 0, unset = 0;
  for (const [, meta] of docMeta) {
    switch (meta.temperature) {
      case 'hot': hot++; break;
      case 'warm': warm++; break;
      case 'cold': cold++; break;
      default: unset++; break;
    }
  }
  payload.memoryTemperature = { hot, warm, cold };

  // Enrich memory lifecycle with current temperature distribution
  if (payload.memoryLifecycle) {
    (payload.memoryLifecycle as Record<string, unknown>).temperatureDistribution = { hot, warm, cold, unset };
  }

  // Enriched vault/memory data for verbose dashboard
  const summary = getDocMetaSummary();
  payload.topNotes = summary.topByHeat;
  payload.categoryBreakdown = summary.categoryBreakdown;
  payload.heatHistogram = summary.heatHistogram;
  payload.embeddingStats = getEmbeddingStats();

  // Collections, score breakdowns, benchmark
  payload.collectionDistribution = getCollectionDistribution();
  payload.searchScoreBreakdowns = getRecentSearchScores();
  payload.benchmarkSummary = getBenchmarkResults();

  // Index health (errors during last rebuild)
  payload.indexHealth = getIndexHealth();

  // System logs ring buffer for dashboard
  payload.systemLogs = getRecentLogs();

  // Memory stack layers (L0 + L1) — fetched async, cached by the module
  wakeUp().then(layers => {
    setMemoryStackCache(layers);
  }).catch(() => { /* non-critical */ });
  payload.memoryStack = getMemoryStackCache();

  // Knowledge Graph stats
  if (isKgInitialized()) {
    try {
      const stats = kgStats();
      payload.knowledgeGraph = {
        entities: stats.entityCount,
        triples: stats.tripleCount,
        predicates: stats.topPredicates,
      };
    } catch { /* non-critical */ }
  }

  // Entity Registry
  try {
    const tierConfidence: Record<string, number> = { confirmed: 1.0, detected: 0.7, suggested: 0.4 };
    const entities = listEntities();
    payload.entityRegistry = entities.map(e => ({
      name: e.name,
      type: e.type,
      confidence: tierConfidence[e.tier] ?? 0.5,
      confirmed: e.confirmed,
    }));
  } catch { /* non-critical */ }

  // Agent Diaries — async, cached like memoryStack
  listAgents().then(agents => {
    setAgentDiaryCache(agents.map(a => ({
      agentId: a.name,
      lastActive: a.lastActive,
      entryCount: a.entryCount,
    })));
  }).catch(() => { /* non-critical */ });
  payload.agentDiaries = getAgentDiaryCache();

  // Dream cycle data for Intelligence tab
  const lastDreamReport = getLastDreamReport();
  if (lastDreamReport) {
    payload.lastDream = {
      timestamp: lastDreamReport.timestamp,
      durationMs: lastDreamReport.durationMs,
      narrative: lastDreamReport.narrative,
      themes: lastDreamReport.themes,
      orphans: lastDreamReport.orphans.slice(0, 15),
      connectionSuggestions: lastDreamReport.connectionSuggestions.filter(s => !isDismissed(`conn:${s.sourcePath}:${s.targetPath}`)),
      consolidationGroups: lastDreamReport.consolidationGroups.filter(g => !isDismissed(`cons:${g.suggestedTitle}`)),
      health: lastDreamReport.health,
      activity: lastDreamReport.activity,
      lifecycle: lastDreamReport.lifecycle,
    };
    payload.healthScore = computeHealthScore(lastDreamReport.health);
  } else {
    // Compute live health even without a dream report
    try {
      const liveHealth = computeDreamHealth();
      payload.liveHealth = liveHealth;
      payload.healthScore = computeHealthScore(liveHealth);
    } catch { /* non-critical */ }
  }

  // Dream history summary for sparkline/trend
  payload.dreamHistory = getDreamHistory().map(r => ({
    timestamp: r.timestamp,
    themes: r.themes.length,
    orphans: r.orphans.length,
    connections: r.connectionSuggestions.length,
    healthScore: computeHealthScore(r.health).score,
    decayed: r.lifecycle.decayed,
  }));

  // Dream running flag
  payload.dreamRunning = isDreamRunning();

  // LLM status — check health inline (throttled to every 30s)
  const llmStatus = getLlmStatus();
  const llmNow = Date.now();
  if (config.enableReranker && config.rerankerBaseUrl && llmNow - llmStatus.lastCheck > 30000) {
    const checkUrl = `${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/models`;
    fetch(checkUrl, { signal: AbortSignal.timeout(3000) })
      .then(r => {
        llmStatus.available = r.ok;
        llmStatus.lastError = r.ok ? undefined : `HTTP ${r.status}`;
        llmStatus.lastCheck = Date.now();
        if (!r.ok) logger.warn('LLM health check failed', { url: checkUrl, status: r.status });
      })
      .catch((err: any) => {
        llmStatus.available = false;
        llmStatus.lastError = `${err.name}: ${err.message}`;
        llmStatus.lastCheck = Date.now();
        logger.warn('LLM health check error', { url: checkUrl, error: err.message, code: err.cause?.code });
      });
  } else if (!config.enableReranker || !config.rerankerBaseUrl) {
    llmStatus.available = false;
    if (!llmStatus.lastError) llmStatus.lastError = 'Reranker not configured';
  }
  payload.llmStatus = {
    configured: config.enableReranker && !!config.rerankerBaseUrl,
    available: llmStatus.available,
    model: config.enableReranker ? config.rerankerModel : null,
    baseUrl: config.enableReranker ? config.rerankerBaseUrl : null,
    lastError: llmStatus.lastError,
    recentSuggestions: llmStatus.recentSuggestions.slice(-5),
  };

  // Entity registry enriched with tier breakdown
  try {
    const entities = listEntities();
    const tierCounts = { confirmed: 0, detected: 0, suggested: 0 };
    const typeCounts: Record<string, number> = {};
    for (const e of entities) {
      tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    payload.entityStats = { tierCounts, typeCounts, total: entities.length };
  } catch { /* non-critical */ }

  // Recall engine — multi-signal recall fusion stats (v1.10.0): the learned
  // co-recall association graph + the active signal weights, so the dashboard
  // surfaces how memory_recall ranks beyond plain lexical/semantic match.
  payload.recallIntelligence = {
    coRecall: getCoRecallStats(),
    centralityWeight: config.recallCentralityWeight,
    coRecallEnabled: config.coRecallEnabled,
    coRecallWeight: config.coRecallWeight,
    // Reproducible contradiction-resilience benchmark (Rescue@10), run at boot.
    rescue: getRescueResults(),
  };

  // Derived insight signals (errorRatePct, rpmTrend, healthTrend, …) — computed
  // once per tick over the already-capped arrays. Attached under `derived` so
  // every existing field is untouched and the single-EventSource model is intact.
  payload.derived = computeDerived(payload);

  return payload;
}
