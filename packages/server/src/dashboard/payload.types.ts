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
