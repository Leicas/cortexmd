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
