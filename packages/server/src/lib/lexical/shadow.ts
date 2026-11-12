/**
 * Shadow-mode support (SEARCH_BACKEND=shadow): the primary backend answers, the
 * candidate runs the same query, and only aggregate agreement is logged —
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

/** Rolling aggregate for periodic logging (counts + means + latency). */
export class ShadowStats {
  n = 0;
  private overlapSum = 0;
  private top1 = 0;
  private primaryMs = 0;
  private shadowMs = 0;
  private maxShadowMs = 0;
  private errors = 0;

  record(o: RankOverlap, primaryMs: number, shadowMs: number): void {
    this.n++;
    this.overlapSum += o.overlap;
    if (o.top1) this.top1++;
    this.primaryMs += primaryMs;
    this.shadowMs += shadowMs;
    if (shadowMs > this.maxShadowMs) this.maxShadowMs = shadowMs;
  }

  recordError(): void {
    this.errors++;
  }

  /** Snapshot and reset (call from the logger tick). */
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
