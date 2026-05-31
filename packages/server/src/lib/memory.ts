import { readNote, writeNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { categorizeMemory as _categorizeMemory, MEMORY_CATEGORIES } from './categorize.js';
import type { MemoryCategory as _MemoryCategory } from './categorize.js';
import { isEmbeddingsReady, embedText } from './embeddings.js';
import { getDocMeta } from './search.js';
import { logger } from './logger.js';

// Re-export so existing consumers keep working after the helper moved to
// ./categorize.ts (see detectCategory / inferNoteCategory there).
export type MemoryCategory = _MemoryCategory;
export { MEMORY_CATEGORIES };
export const categorizeMemory = _categorizeMemory;

/**
 * Compute a heat score (0-16) and temperature label for a memory note.
 */
export function computeHeatScore(
  data: Record<string, any>,
  opts: { incomingLinkCount: number; hasOpenTask: boolean; now?: number; fileMtimeMs?: number },
): { score: number; temperature: 'hot' | 'warm' | 'cold' } {
  const now = opts.now ?? Date.now();
  const DAY = 86_400_000;

  let score = 0;

  // Recency of last_updated (max 4) — falls back to file modification time
  const updatedTs = data.last_updated
    ? new Date(data.last_updated).getTime()
    : (opts.fileMtimeMs ?? 0);
  if (updatedTs > 0) {
    const age = now - updatedTs;
    if (age <= 1 * DAY) score += 4;
    else if (age <= 3 * DAY) score += 3;
    else if (age <= 7 * DAY) score += 2;
    else if (age <= 30 * DAY) score += 1;
  }

  // Recency of created date as minor signal (max 1) — for notes without access tracking
  if (!data.last_accessed && data.created) {
    const createdAge = now - new Date(data.created).getTime();
    if (createdAge <= 7 * DAY) score += 1;
  }

  // Access recency (max 3)
  if (data.last_accessed) {
    const age = now - new Date(data.last_accessed).getTime();
    if (age <= 1 * DAY) score += 3;
    else if (age <= 3 * DAY) score += 2;
    else if (age <= 7 * DAY) score += 1;
  }

  // Access frequency (max 3)
  const accessCount = typeof data.access_count === 'number' ? data.access_count : 0;
  if (accessCount >= 20) score += 3;
  else if (accessCount >= 10) score += 2;
  else if (accessCount >= 3) score += 1;

  // Incoming links (max 3)
  if (opts.incomingLinkCount >= 10) score += 3;
  else if (opts.incomingLinkCount >= 5) score += 2;
  else if (opts.incomingLinkCount >= 1) score += 1;

  // Has open task linked (2)
  if (opts.hasOpenTask) score += 2;

  // Is open task itself (1)
  if (data.type === 'task' && data.status !== 'done' && data.status !== 'cancelled') {
    score += 1;
  }

  const temperature: 'hot' | 'warm' | 'cold' =
    score >= 10 ? 'hot' : score >= 4 ? 'warm' : 'cold';

  return { score, temperature };
}

/**
 * Promote a note on access: update last_accessed, increment access_count
 * with diminishing returns, recompute heat_score and temperature.
 *
 * Daily cap: only promotes if last_accessed is not today.
 * Diminishing returns: boost = max(0.1, 1 / (1 + log2(max(1, accessCount))))
 */
export async function promoteOnAccess(notePath: string): Promise<void> {
  const { content } = await readNote(notePath);
  const { data, body } = parseFrontmatter(content);

  const today = new Date().toISOString().slice(0, 10);
  const prevAccessed = typeof data.last_accessed === 'string' ? data.last_accessed : '';

  // Daily cap: skip promotion if already accessed today
  if (prevAccessed === today) return;

  const prevCount = typeof data.access_count === 'number' ? data.access_count : 0;

  // Diminishing returns boost (not used to inflate heat_score directly;
  // access_count is incremented fractionally so the canonical scoring
  // buckets still apply via computeHeatScore).
  const boost = Math.max(0.1, 1 / (1 + Math.log2(Math.max(1, prevCount))));

  data.last_accessed = today;
  data.access_count = prevCount + boost;

  const { score, temperature } = computeHeatScore(data, {
    incomingLinkCount: 0, // caller doesn't have graph context here; use 0 as baseline
    hasOpenTask: false,
  });

  const changed =
    prevAccessed !== today ||
    data.heat_score !== score ||
    data.temperature !== temperature;

  if (!changed) return;

  data.heat_score = score;
  data.temperature = temperature;

  const updated = stringifyFrontmatter(data, body);
  await writeNote(notePath, updated);
}

/**
 * Categories that don't benefit from year/month subfolders (accumulate slowly).
 */
const TIMELESS_CATEGORIES = new Set<MemoryCategory>(['fact', 'preference']);

/**
 * Extract the first wiki-link target from a markdown body. Returns the path
 * inside [[...]] (without surrounding brackets), or undefined if none.
 * Used as a heuristic for "the most-prominent entity" in contradiction
 * detection — the first wiki-link is usually the subject.
 */
export function firstWikiLink(body: string): string | undefined {
  const m = body.match(/\[\[([^\]\|#]+?)(?:[#|][^\]]*)?\]\]/);
  return m ? m[1].trim() : undefined;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'she', 'so', 'than', 'that', 'the', 'their', 'them', 'they', 'this', 'to',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with',
  'would', 'you', 'your', 'yours', 'us', 'about', 'all', 'any', 'can', 'could',
  'should', 'may', 'might', 'must', 'shall', 'just', 'only', 'also', 'too',
]);

/**
 * Tokenize text into lowercase non-stopword content tokens (length ≥ 3).
 * Strips wiki-links, urls, frontmatter syntax, and code-fence markers.
 */
function contentTokens(text: string): Set<string> {
  const cleaned = text
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .toLowerCase();
  const out = new Set<string>();
  for (const tok of cleaned.split(/[^a-z0-9]+/g)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface MemoryConflict {
  path: string;
  score: number;
  snippet: string;
}

// ────────────────────── Bayesian validity (token-savior parity) ──────────────────────
//
// Each memory carries a Beta(α, β) posterior over "this memory is still
// trustworthy". Default prior α=2, β=1 → 0.667 (mildly trustworthy on first
// write). Recall successes bump α; contradictions bump β. validity = α/(α+β).
//
// Recall-time behavior:
//   validity ≤ 0.40  → quarantined (excluded from results)
//   validity ≤ 0.60  → stale (kept but score halved)
//
// Hardcoded prior matches token-savior v2.9.0; intentionally not env-tunable
// to match their behavior. Toggle the entire system via MEMORY_VALIDITY=false.

export const VALIDITY_PRIOR_ALPHA = 2;
export const VALIDITY_PRIOR_BETA = 1;
export const VALIDITY_QUARANTINE = 0.40;
export const VALIDITY_STALE = 0.60;
export const VALIDITY_STALE_RANK_PENALTY = 0.5;

export type ValidityOutcome = 'success' | 'failure';

export function computeValidity(data: Record<string, unknown>): {
  alpha: number; beta: number; validity: number;
  quarantined: boolean; stale: boolean;
} {
  const alpha = typeof data.validity_alpha === 'number' && Number.isFinite(data.validity_alpha)
    ? Math.max(0, data.validity_alpha as number)
    : VALIDITY_PRIOR_ALPHA;
  const beta = typeof data.validity_beta === 'number' && Number.isFinite(data.validity_beta)
    ? Math.max(0, data.validity_beta as number)
    : VALIDITY_PRIOR_BETA;
  const denom = alpha + beta;
  const validity = denom > 0 ? alpha / denom : VALIDITY_PRIOR_ALPHA / (VALIDITY_PRIOR_ALPHA + VALIDITY_PRIOR_BETA);
  return {
    alpha,
    beta,
    validity,
    quarantined: validity <= VALIDITY_QUARANTINE,
    stale: validity > VALIDITY_QUARANTINE && validity <= VALIDITY_STALE,
  };
}

/**
 * Update a memory's Beta posterior. `success` bumps α (memory was useful);
 * `failure` bumps β (memory was contradicted or wrong). Rounded counters are
 * persisted in frontmatter as `validity_alpha` / `validity_beta` /
 * `validity_last_checked`. Best-effort: silently swallows write failures.
 */
export async function updateValidity(path: string, outcome: ValidityOutcome): Promise<void> {
  try {
    const { content } = await readNote(path);
    const { data, body } = parseFrontmatter(content);
    const cur = computeValidity(data);
    if (outcome === 'success') data.validity_alpha = Math.round((cur.alpha + 1) * 1000) / 1000;
    else data.validity_beta = Math.round((cur.beta + 1) * 1000) / 1000;
    data.validity_last_checked = new Date().toISOString().slice(0, 10);
    const updated = stringifyFrontmatter(data, body);
    await writeNote(path, updated);
  } catch (err) {
    logger.debug('updateValidity failed (non-fatal)', {
      path,
      outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Detect potential contradictions for a new memory by comparing it against
 * existing memories that share the same primary wiki-linked entity.
 *
 * Algorithm:
 *   1. Pick the new memory's "primary entity": first wiki-link in body, or
 *      any of `entities` passed in.
 *   2. Walk indexed memories that contain that wiki-link.
 *   3. Embed the new body + each candidate body, take cosine similarity.
 *   4. A candidate is a *conflict* if similarity ≥ 0.85 AND content tokens
 *      are disjoint (no shared non-stopword tokens). High semantic
 *      similarity + zero lexical overlap is a strong signal of paraphrased
 *      contradiction (e.g. "X is enabled" vs "X is disabled").
 *   5. Return up to 3 conflicts, ranked by score desc.
 *
 * Silently returns empty if embeddings aren't ready or anything fails — this
 * runs on the memory_store hot path and must never crash it.
 */
export async function detectMemoryConflicts(
  newBody: string,
  entities: string[] = [],
  opts: { excludePath?: string; maxConflicts?: number } = {},
): Promise<MemoryConflict[]> {
  const maxConflicts = opts.maxConflicts ?? 3;
  if (!isEmbeddingsReady()) return [];

  // Identify primary entity
  let primary = firstWikiLink(newBody);
  if (!primary && entities.length > 0) primary = entities[0];
  if (!primary) return [];

  const primaryNorm = primary.toLowerCase().trim();

  try {
    const dm = getDocMeta();
    // Candidates: indexed memories whose body or tags reference the primary entity.
    const candidates: Array<{ path: string; content: string; title: string }> = [];
    for (const [p, meta] of dm) {
      if (opts.excludePath && p === opts.excludePath) continue;
      if (meta.type !== 'memory') continue;
      const haystack = ((meta.content ?? '') + ' ' + (meta.title ?? '')).toLowerCase();
      // Cheap substring + wiki-link check (no need to fully parse the body)
      if (
        !haystack.includes(`[[${primaryNorm}`) &&
        !haystack.includes(primaryNorm)
      ) {
        continue;
      }
      candidates.push({ path: p, content: meta.content ?? '', title: meta.title ?? '' });
      if (candidates.length >= 50) break; // bound work
    }
    if (candidates.length === 0) return [];

    const newEmbed = await embedText(newBody.slice(0, 1024));
    const newTokens = contentTokens(newBody);

    const scored: MemoryConflict[] = [];
    for (const cand of candidates) {
      try {
        const cText = (cand.title + ' ' + cand.content).slice(0, 1024).trim();
        if (!cText) continue;
        const cEmbed = await embedText(cText);
        const score = cosineSim(newEmbed, cEmbed);
        if (score < 0.65) continue;

        // Conflict gate: high semantic similarity + low Jaccard token
        // overlap signals a paraphrased contradiction (same topic, different
        // claim — e.g. "X is enabled" vs "X is disabled"). Pure
        // disjoint-tokens is too strict: any two memories about the same
        // entity share "obsidian", "tool", etc. — so we use a ratio.
        const cTokens = contentTokens(cText);
        let shared = 0;
        for (const t of newTokens) if (cTokens.has(t)) shared++;
        const union = new Set([...newTokens, ...cTokens]).size;
        const jaccard = union > 0 ? shared / union : 0;
        // Cosine ≥ 0.80 + Jaccard < 0.5 catches the paraphrase case without
        // flooding on near-duplicates (which dedup already handles).
        const isConflict = score >= 0.80 && jaccard < 0.5;
        if (!isConflict) continue;

        const snippet = cand.content.replace(/\s+/g, ' ').trim().slice(0, 200);
        scored.push({
          path: cand.path,
          score: Math.round(score * 10000) / 10000,
          snippet,
        });
      } catch {
        // skip individual embed failures — keep scanning
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxConflicts);
  } catch (err) {
    logger.debug('detectMemoryConflicts failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Return the vault-relative directory for a given memory category.
 * Temporal categories use year/month subfolders; timeless ones stay flat.
 */
export function memoryDir(category: MemoryCategory, date?: Date): string {
  const d = date ?? new Date();
  if (TIMELESS_CATEGORIES.has(category)) {
    return `Memories/${category}/`;
  }
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `Memories/${category}/${year}/${month}/`;
}
