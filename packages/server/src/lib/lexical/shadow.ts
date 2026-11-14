/**
 * Shadow-mode support (SEARCH_BACKEND=shadow): the primary backend answers, the
 * candidate runs the same query, and only aggregate agreement is recorded —
 * never the query text or paths (the vault is private).
 */

export interface RankOverlap {
  /** |top-k(a) ∩ top-k(b)| / max(|top-k(a)|, |top-k(b)|), 1 when both are empty. */
  overlap: number;
  top1: boolean;
  sizeA: number;
  sizeB: number;
}

export function rankOverlap(a: string[], b: string[], k = 10): RankOverlap {
  const ta = a.slice(0, k);
  const tb = new Set(b.slice(0, k));
  const denom = Math.max(ta.length, tb.size);
  let inter = 0;
  for (const p of ta) if (tb.has(p)) inter++;
  return { overlap: denom === 0 ? 1 : inter / denom, top1: a[0] === b[0], sizeA: ta.length, sizeB: tb.size };
}

/** Cumulative shadow aggregates since boot (what /health and the dashboard show). */
export interface ShadowSnapshot {
  /** Compared queries. */
  queries: number;
  /** Mean top-10 overlap (0..1). */
  overlapAt10: number;
  /** Share of queries whose #1 result is the same (0..1). */
  top1Agreement: number;
  /** Share of queries with identical top-10 sets. */
  exactTop10: number;
  primaryP50Ms: number;
  primaryP95Ms: number;
  shadowP50Ms: number;
  shadowP95Ms: number;
  shadowMaxMs: number;
  /** Shadow queries that threw (the primary answer was unaffected). */
  errors: number;
  /** Sampled queries skipped because the bounded shadow queue was full. */
  dropped: number;
  since: string;
}

/** Bounded latency reservoir (last `cap` samples) for p50 / p95. */
class Ring {
  private buf: number[] = [];
  private i = 0;
  constructor(private readonly cap = 1000) {}
  push(v: number): void {
    if (this.buf.length < this.cap) this.buf.push(v);
    else { this.buf[this.i] = v; this.i = (this.i + 1) % this.cap; }
  }
  quantile(q: number): number {
    if (this.buf.length === 0) return 0;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Rolling aggregate: a resettable window (`flush`, for periodic logs) + cumulative totals (`snapshot`). */
export class ShadowStats {
  /** Queries in the current flush window. */
  n = 0;
  private overlapSum = 0;
  private top1 = 0;
  private primaryMs = 0;
  private shadowMs = 0;
  private maxShadowMs = 0;
  private errors = 0;

  private total = { n: 0, overlap: 0, top1: 0, exact: 0, errors: 0, dropped: 0, maxShadowMs: 0 };
  private readonly primaryLat = new Ring();
  private readonly shadowLat = new Ring();
  private readonly since = new Date().toISOString();

  record(o: RankOverlap, primaryMs: number, shadowMs: number): void {
    this.n++;
    this.overlapSum += o.overlap;
    if (o.top1) this.top1++;
    this.primaryMs += primaryMs;
    this.shadowMs += shadowMs;
    if (shadowMs > this.maxShadowMs) this.maxShadowMs = shadowMs;

    const t = this.total;
    t.n++;
    t.overlap += o.overlap;
    if (o.top1) t.top1++;
    if (o.overlap === 1) t.exact++;
    if (shadowMs > t.maxShadowMs) t.maxShadowMs = shadowMs;
    this.primaryLat.push(primaryMs);
    this.shadowLat.push(shadowMs);
  }

  recordError(): void {
    this.errors++;
    this.total.errors++;
  }

  recordDropped(): void {
    this.total.dropped++;
  }

  /** Cumulative aggregates since construction (does not reset). */
  snapshot(): ShadowSnapshot {
    const t = this.total;
    return {
      queries: t.n,
      overlapAt10: t.n ? +(t.overlap / t.n).toFixed(3) : 0,
      top1Agreement: t.n ? +(t.top1 / t.n).toFixed(3) : 0,
      exactTop10: t.n ? +(t.exact / t.n).toFixed(3) : 0,
      primaryP50Ms: r2(this.primaryLat.quantile(0.5)),
      primaryP95Ms: r2(this.primaryLat.quantile(0.95)),
      shadowP50Ms: r2(this.shadowLat.quantile(0.5)),
      shadowP95Ms: r2(this.shadowLat.quantile(0.95)),
      shadowMaxMs: r2(t.maxShadowMs),
      errors: t.errors,
      dropped: t.dropped,
      since: this.since,
    };
  }

  /** Snapshot and reset the window (call from the logger tick). */
  flush(): Record<string, number> | null {
    if (this.n === 0 && this.errors === 0) return null;
    const out = {
      queries: this.n,
      overlapAt10: this.n ? +(this.overlapSum / this.n).toFixed(3) : 0,
      top1Agreement: this.n ? +(this.top1 / this.n).toFixed(3) : 0,
      primaryMeanMs: this.n ? +(this.primaryMs / this.n).toFixed(2) : 0,
      shadowMeanMs: this.n ? +(this.shadowMs / this.n).toFixed(2) : 0,
      shadowMaxMs: +this.maxShadowMs.toFixed(2),
      errors: this.errors,
    };
    this.n = 0; this.overlapSum = 0; this.top1 = 0; this.primaryMs = 0; this.shadowMs = 0;
    this.maxShadowMs = 0; this.errors = 0;
    return out;
  }
}
