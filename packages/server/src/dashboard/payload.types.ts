/**
 * `DashboardPayload` — the single SSE payload shape streamed to all dashboard
 * tab modules. This is the de-facto view-model and the contract shared between
 * the server (`model/payload.ts`) and the client tab modules (referenced from
 * their JSDoc). Keys here are byte-identical to what the legacy dashboard
 * emitted; do not rename without updating every consumer.
 *
 * Most fields arrive via the `...getMetrics()` spread (see `model/payload.ts`),
 * so this interface is intentionally permissive (index signature) — it documents
 * the keys clients read, not an exhaustive closed shape.
 */

export interface ToolCallStat {
  count: number;
  avgLatency: number;
  p95Latency: number;
  maxLatency: number;
  errors: number;
  lastCalled: number | null;
}

export interface MemoryTemperature {
  hot: number;
  warm: number;
  cold: number;
}

export interface HealthFactor {
  name: string;
  value: number;
  weight: number;
  contribution: number;
}

export interface HealthScore {
  score: number;
  grade: string;
  factors: HealthFactor[];
}

// ── Retrieval tab payload (multi-arm fused recall + PPR graph + bitemporal KG
//    + live eval quality). Frozen contract shared with the RetrievalView agent:
//    the top-level payload key is `retrieval`. Field names below are load-bearing
//    — the view module reads them verbatim. See dashboard design doc §3. ──

/** One persisted eval-report arm row (baseline is the delta reference). */
export interface RetrievalQualityArm {
  arm: 'baseline' | 'bitemporal' | 'ppr' | 'ppr-bitemporal';
  recallAtK: number;
  pointInTimeAccuracy: number;  // 0 for real-vault mode
  staleLeakRate: number;        // 0 for real-vault mode
  mrr: number | null;           // real-vault only, else null
  avgLatencyMs: number | null;  // real-vault only, else null
}

/** One recent supersession event (a fact whose validity was closed by a newer one). */
export interface RetrievalSupersession {
  subject: string;
  predicate: string;
  oldObject: string;
  newObject: string;
  validFrom: string | null;    // ISO
  validTo: string | null;      // ISO (= new fact's validFrom)
  supersededAt: string | null; // invalidated_at, ISO
}

export interface RetrievalPayload {
  // ── arm mix (Recall Arms panel) — aggregate over recentArmBreakdown ──
  armMix: {
    lexical: number;       // 0–1 fraction of fused score from lexical, over recent queries
    semantic: number;      // 0–1
    graph: number;         // 0–1 (0 when arm dormant)
    sampleQueries: number; // how many recent queries this averages over
  };
  armWeights: {
    centrality: number;       // config.recallCentralityWeight
    coRecall: number | null;  // config.coRecallWeight, null when coRecallEnabled=false
    graph: number | null;     // graph arm weight, null when pprRecall=false (dormant)
  };
  armsActive: {
    lexical: true;    // always on
    semantic: boolean; // embeddings ready
    graph: boolean;    // config.pprRecall || any recent opts.graph
  };
  recentArmBreakdown: Array<{
    timestamp: number;
    query: string;
    lexical: number; semantic: number; graph: number; // per-query fused fractions 0–1
  }>;

  // ── quality (Recall Quality hero) — from the persisted eval report ──
  quality: {
    ranAt: number | null;
    mode: 'temporal' | 'real-vault' | null;
    k: number;
    arms: RetrievalQualityArm[];
  } | null;
  qualityHistory: Array<{
    ranAt: number;
    recallAtK: number;
    pointInTimeAccuracy: number;
    staleLeakRate: number;
  }>;

  // ── bitemporal (Bitemporal KG panel) ──
  bitemporal: {
    enabled: boolean;   // config.bitemporalKg
    active: number;     // kgStats().activeTriples
    superseded: number; // kgStats().expiredTriples
    recentSupersessions: RetrievalSupersession[];
  };

  // ── graph (Graph Recall panel) ──
  graph: {
    enabled: boolean;   // config.pprRecall
    nodes: number;
    edges: number;
    bridgeTriples: number; // kgAllMentionTriples().length (entity bridges)
    avgDegree: number;
    lastSeedSpread: {
      query: string;
      seeds: number;
      hop1: number; hop2: number; hop3: number;
    } | null;
  };
}

/**
 * The streamed dashboard payload. Index signature keeps it open because the
 * `getMetrics()` spread contributes many keys (toolCalls, latencyHistory,
 * requestsByCategory, codeNav, codeNavSavings, …) that are typed elsewhere.
 */
export interface DashboardPayload {
  uptime?: number;
  toolCalls?: Record<string, ToolCallStat>;
  rateLimits?: unknown[];
  sessions?: unknown[];
  oauthClients?: unknown[];
  memoryTemperature?: MemoryTemperature;
  healthScore?: HealthScore;
  [key: string]: unknown;
}
