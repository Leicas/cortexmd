/**
 * Recall ranking signals — pure, side-effect-free scoring helpers.
 *
 * These are the multiplicative "boost" factors `memory_recall` applies on top
 * of the fused lexical+semantic score. Keeping them here (rather than inline in
 * the tool) makes each signal independently unit-testable and documents the
 * shape of the recall ranker in one place.
 *
 * Today this module owns the **graph-centrality** signal — the one recall
 * input that the in-tool scorer lacked. Heat, recency, validity, related, and
 * context boosts already live in `memory-recall.ts`; centrality joins them so a
 * well-connected note (many inbound `[[wikilinks]]`) ranks above an otherwise
 * equal orphan, matching the link-strength term other memory engines fuse in.
 */

/**
 * Squash a raw inbound-link count into a 0..1 centrality score with a
 * logarithmic curve: the first few backlinks matter most, and the signal
 * saturates so a single hyper-connected hub note can't dominate ranking.
 *
 * 0 links → 0.0, ~CAP links → ~1.0.
 */
export const CENTRALITY_SATURATION = 25;

export function normalizeCentrality(inboundLinks: number, cap = CENTRALITY_SATURATION): number {
  if (!Number.isFinite(inboundLinks) || inboundLinks <= 0) return 0;
  const norm = Math.log1p(inboundLinks) / Math.log1p(cap);
  return Math.min(Math.max(norm, 0), 1);
}

/**
 * Multiplicative recall boost from graph centrality.
 *
 *   boost = 1 + weight × normalizeCentrality(inboundLinks)
 *
 * With the default weight a note at/above the saturation point gets at most a
 * `+weight` (e.g. +15%) lift; an orphan (0 inbound) gets exactly 1.0 (no-op).
 * `weight = 0` disables the signal entirely (byte-for-byte unchanged ranking).
 */
export function centralityBoost(
  inboundLinks: number | undefined,
  weight: number,
): number {
  if (!weight || weight <= 0) return 1.0;
  return 1 + weight * normalizeCentrality(inboundLinks ?? 0);
}

// ── Recall explainability ─────────────────────────────────────────────────
//
// A consuming agent gets far more from recall when it can tell *why* a memory
// surfaced — a hot, canonical, well-connected fact deserves more trust than a
// stale, contradicted observation that merely matched lexically. `explainRecall`
// turns the per-result scoring inputs into a compact, human-readable breakdown
// (opt-in, so it never inflates the default response).

export interface RecallSignalBreakdown {
  /** Whether the hit came from semantic, lexical, or both retrieval arms. */
  match: 'semantic' | 'lexical' | 'hybrid';
  temperature: string;
  heatScore?: number;
  /** Inbound [[wikilink]] count (graph centrality). */
  inboundLinks: number;
  /** Recency boost in 0..1 (1 = just accessed). */
  recency: number;
  /** Bayesian validity in 0..1 (undefined when validity tracking is off). */
  validity?: number;
  /** True when the memory is contradicted/stale (validity-penalised). */
  stale: boolean;
  /** True when the memory is linked to a relatedTo anchor. */
  related: boolean;
  /** Co-recall spreading-activation boost fraction (e.g. 0.12 = +12%), if any. */
  coRecall?: number;
  /** One-line "why this surfaced" rationale. */
  reason: string;
}

export interface RecallSignalInputs {
  lexicalScore: number;
  semanticScore: number;
  temperature: string;
  heatScore?: number;
  recency: number;
  inboundLinks: number;
  validity?: number;
  stale: boolean;
  related: boolean;
}

export function explainRecall(x: RecallSignalInputs): RecallSignalBreakdown {
  const match: RecallSignalBreakdown['match'] =
    x.lexicalScore > 0 && x.semanticScore > 0
      ? 'hybrid'
      : x.semanticScore > 0
        ? 'semantic'
        : 'lexical';

  const parts: string[] = [];
  parts.push(match === 'hybrid' ? 'lexical+semantic match' : `${match} match`);
  if (x.temperature === 'hot' || x.temperature === 'warm') parts.push(x.temperature);
  if (x.related) parts.push('linked to context');
  if (x.inboundLinks > 0) parts.push(`central (${x.inboundLinks} link${x.inboundLinks === 1 ? '' : 's'})`);
  if (x.recency >= 0.5) parts.push('recent');
  if (x.stale) parts.push('stale (contradicted)');

  return {
    match,
    temperature: x.temperature,
    heatScore: x.heatScore,
    inboundLinks: x.inboundLinks,
    recency: Math.round(x.recency * 100) / 100,
    validity: x.validity !== undefined ? Math.round(x.validity * 100) / 100 : undefined,
    stale: x.stale,
    related: x.related,
    reason: parts.join('; '),
  };
}
