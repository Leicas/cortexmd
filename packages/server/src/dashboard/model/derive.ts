/**
 * `computeDerived(payload)` — the single server-logic addition of the revamp.
 * Attaches a `derived` namespace to the SSE payload so every headline number can
 * answer "is this good, and which way is it moving?" without each tab
 * re-deriving the same ratios/trends. Pure + O(payload): every input is an
 * already-capped array (≤360 latency/temp, ≤50 recent buffers, ≤30 searches).
 *
 * The FOUNDATION phase implements the cross-tab helpers + the Overview signals
 * fully; the remaining per-tab signals are computed where cheap and otherwise
 * left for the per-tab agents to extend (they import the helpers + THRESHOLDS
 * from here). Adding a signal = compute it here and read `ctx.data.derived.*`.
 *
 * Mirrors the pure-helper style of `model/health.ts`. See REVAMP.md §7.
 */

// ── primitive helpers ────────────────────────────────────────────────────────

/** Safe ratio: n / max(d,1). */
export function ratio(n: number, d: number): number {
  return n / Math.max(d, 1);
}

export interface Trend {
  dir: 'up' | 'down' | 'flat';
  /** Percent change of the last point vs the first of the window (signed). */
  pct: number;
}

/**
 * Least-squares slope sign over the last N points → up/down/flat, plus the
 * percent change across the window. `flat` when the window is too short or the
 * slope is within an epsilon band relative to the mean.
 */
export function trend(points: number[], windowN = 12): Trend {
  const pts = points.filter((p) => typeof p === 'number' && isFinite(p));
  if (pts.length < 2) return { dir: 'flat', pct: 0 };
  const w = pts.slice(-windowN);
  const n = w.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += w[i]; sxy += i * w[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const mean = sy / n;
  const first = w[0], last = w[n - 1];
  const pct = first === 0 ? (last === 0 ? 0 : 100) : ((last - first) / Math.abs(first)) * 100;
  const eps = Math.abs(mean) * 0.02 + 1e-9;
  const dir: Trend['dir'] = slope > eps ? 'up' : slope < -eps ? 'down' : 'flat';
  return { dir, pct: Math.round(pct * 10) / 10 };
}

/**
 * Bucket a list of epoch-ms timestamps into per-minute counts over the last
 * `windowMin` minutes (oldest → newest). Shared by Logs + Rate Limits.
 */
export function bucketPerMinute(timestamps: number[], windowMin = 15): number[] {
  const out = new Array(windowMin).fill(0) as number[];
  const now = Date.now();
  for (const tsRaw of timestamps) {
    const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw) : tsRaw;
    if (!isFinite(ts)) continue;
    const minsAgo = Math.floor((now - ts) / 60000);
    if (minsAgo < 0 || minsAgo >= windowMin) continue;
    out[windowMin - 1 - minsAgo]++;
  }
  return out;
}

/** Request-weighted ratio of num/den across items (e.g. p95÷avg over toolCalls). */
export function weightedRatio<T>(
  items: T[],
  num: (x: T) => number,
  den: (x: T) => number,
  weight: (x: T) => number,
): number {
  let wsum = 0, acc = 0;
  for (const it of items) {
    const w = weight(it);
    const d = den(it);
    if (w <= 0 || d <= 0) continue;
    acc += (num(it) / d) * w;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0;
}

// ── threshold map ─────────────────────────────────────────────────────────────

export type Direction = 'higher' | 'lower';
export type PillState = 'ok' | 'warn' | 'bad';

export interface Threshold {
  /** Value at/above (higher-better) or at/below (lower-better) which = ok. */
  good: number;
  /** Boundary between warn and bad. */
  warn: number;
  direction: Direction;
}

/**
 * Single source of truth for good/warn/bad cutoffs. Clients pass a value + key
 * to `pillState()` and never hard-code a color — keeps status consistent and
 * auditable across all tabs. Values are in the natural unit of each signal
 * (percentages as 0–100, ratios as multipliers).
 */
export const THRESHOLDS: Record<string, Threshold> = {
  errorRatePct:        { good: 1,    warn: 5,    direction: 'lower'  },
  latencyTailRatio:    { good: 2,    warn: 3,    direction: 'lower'  },
  topSessionShare:     { good: 0.5,  warn: 0.8,  direction: 'lower'  },
  zeroResultRate:      { good: 0.1,  warn: 0.25, direction: 'lower'  },
  staleRatio:          { good: 0.15, warn: 0.35, direction: 'lower'  },
  orphanRatio:         { good: 0.15, warn: 0.35, direction: 'lower'  },
  embeddingCoverage:   { good: 0.9,  warn: 0.6,  direction: 'higher' },
  entityConfirmationRate: { good: 0.6, warn: 0.3, direction: 'higher' },
  callResolutionPct:   { good: 0.9,  warn: 0.7,  direction: 'higher' },
  toolSuccessRate:     { good: 0.98, warn: 0.9,  direction: 'higher' },
  healthScore:         { good: 80,   warn: 60,   direction: 'higher' },
};

/** Map a value + threshold key to a pill state. Unknown key → 'ok'. */
export function pillState(value: number, key: string): PillState {
  const t = THRESHOLDS[key];
  if (!t) return 'ok';
  if (t.direction === 'lower') {
    if (value <= t.good) return 'ok';
    if (value <= t.warn) return 'warn';
    return 'bad';
  }
  if (value >= t.good) return 'ok';
  if (value >= t.warn) return 'warn';
  return 'bad';
}

// ── payload-shaped readers (defensive: payload is Record<string, unknown>) ────

type Dict = Record<string, unknown>;
function obj(v: unknown): Dict { return v && typeof v === 'object' ? (v as Dict) : {}; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function num(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

export interface DerivedSignals {
  // Operations
  errorRatePct: number;
  rpmSeries: number[];
  rpmTrend: Trend;
  latencyTrend: Trend;
  latencyTailRatio: number;
  requestMix: { health: number; mcp: number; oauth: number; dashboard: number; other: number };
  activeSessions: number;
  topSessionShare: number;
  // Throttling / security
  throttledNow: number;
  authFailPerMin: number[];
  // Knowledge
  embeddingCoverage: number;
  // Code
  savingsPerCall: number;
  savingsRunRate: number;
  callResolutionPct: number;
  // Health
  healthTrend: Trend;
  // generic
  [key: string]: unknown;
}

/** Compute the `derived` namespace from a fully-built SSE payload. */
export function computeDerived(payload: Dict): DerivedSignals {
  const totalRequests = num(payload.totalRequests);
  const errorResponses = num(payload.errorResponses);
  const rbc = obj(payload.requestsByCategory);
  const requestMix = {
    health: num(rbc.health),
    mcp: num(rbc.mcp),
    oauth: num(rbc.oauth),
    dashboard: num(rbc.dashboard),
    other: num(rbc.other),
  };
  // Error rate is computed against non-health requests (health checks are noise).
  const nonHealth = Math.max(0, totalRequests - requestMix.health);
  const errorRatePct = Math.round(ratio(errorResponses, nonHealth) * 100 * 10) / 10;

  const latencyHistory = arr(payload.latencyHistory) as Array<Dict>;
  const rpmSeries = latencyHistory.map((e) => num(e.requestCount));
  const latSeries = latencyHistory.map((e) => num(e.avgLatencyMs));
  const rpmTrend = trend(rpmSeries);
  const latencyTrend = trend(latSeries);

  // Request-weighted p95÷avg over toolCalls (tail heaviness).
  const toolCalls = obj(payload.toolCalls);
  const toolList = Object.values(toolCalls).map(obj);
  const latencyTailRatio = Math.round(
    weightedRatio(
      toolList,
      (t) => num(t.p95Latency),
      (t) => num(t.avgLatency),
      (t) => num(t.count),
    ) * 100,
  ) / 100;

  // Sessions: active in the last 60s + concentration of requests.
  const sessions = arr(payload.sessions) as Array<Dict>;
  const now = Date.now();
  let activeSessions = 0;
  let maxReq = 0, sumReq = 0;
  for (const s of sessions) {
    const last = s.lastActivity ?? s.lastActive ?? s.lastSeen;
    const lastTs = typeof last === 'string' ? Date.parse(last as string) : num(last);
    if (lastTs && now - lastTs < 60000) activeSessions++;
    const rc = num(s.requestCount);
    sumReq += rc;
    if (rc > maxReq) maxReq = rc;
  }
  const topSessionShare = Math.round(ratio(maxReq, sumReq) * 100) / 100;

  // Rate limits: how many keys are throttled right now (remaining === 0).
  const rateLimits = arr(payload.rateLimits) as Array<Dict>;
  let throttledNow = 0;
  for (const r of rateLimits) if (num(r.remaining) === 0) throttledNow++;

  // Auth-failure per-minute buckets (shared by Logs + Rate Limits).
  const authFailures = arr(payload.recentAuthFailures) as Array<Dict>;
  const authFailPerMin = bucketPerMinute(
    authFailures.map((a) => (typeof a.timestamp === 'string' ? Date.parse(a.timestamp as string) : num(a.timestamp))),
  );

  // Embedding coverage = embedded vectors / indexed notes.
  const embeddingStats = obj(payload.embeddingStats);
  const indexedNotes = num(payload.indexedNotes);
  const vectors = num(embeddingStats.vectors) || num(embeddingStats.indexSize);
  const embeddingCoverage = indexedNotes > 0 ? Math.min(1, ratio(vectors, indexedNotes)) : 0;

  // Code-nav savings KPIs.
  const cns = obj(payload.codeNavSavings);
  const totalSaved = num(cns.totalSaved);
  const totalCalls = num(cns.totalCalls);
  const savingsPerCall = totalCalls > 0 ? Math.round(ratio(totalSaved, totalCalls)) : 0;
  const cnsHistory = arr(cns.history) as Array<Dict>;
  let savingsRunRate = 0;
  if (cnsHistory.length >= 2) {
    const a = cnsHistory[0], b = cnsHistory[cnsHistory.length - 1];
    const dT = (num(b.ts) - num(a.ts)) / 86400000; // per day
    const dS = num(b.cumulativeSaved) - num(a.cumulativeSaved);
    savingsRunRate = dT > 0 ? Math.round(dS / dT) : 0;
  }
  const codeNav = obj(payload.codeNav);
  const callCount = obj(codeNav.callCount);
  const resolved = num(callCount.resolved);
  const unresolved = num(callCount.unresolved);
  const callResolutionPct = (resolved + unresolved) > 0
    ? Math.round(ratio(resolved, resolved + unresolved) * 100) / 100 : 0;

  // Health trend over dream history.
  const dreamHistory = arr(payload.dreamHistory) as Array<Dict>;
  const healthTrend = trend(dreamHistory.map((d) => num(d.healthScore)));

  return {
    errorRatePct,
    rpmSeries,
    rpmTrend,
    latencyTrend,
    latencyTailRatio,
    requestMix,
    activeSessions,
    topSessionShare,
    throttledNow,
    authFailPerMin,
    embeddingCoverage: Math.round(embeddingCoverage * 100) / 100,
    savingsPerCall,
    savingsRunRate,
    callResolutionPct,
    healthTrend,
  };
}
