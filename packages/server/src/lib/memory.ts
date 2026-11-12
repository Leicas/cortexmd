import { readNote, writeNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { categorizeMemory as _categorizeMemory, MEMORY_CATEGORIES } from './categorize.js';
import type { MemoryCategory as _MemoryCategory } from './categorize.js';
import { isEmbeddingsReady, embedText } from './embeddings.js';
import { getDocMeta, bestPassage, chunkSnippet, hybridSearch } from './search.js';
import { logger } from './logger.js';
import type { SearchResult, SearchOptions } from './search.js';
import {
  memoryKindOf, resolveKindScope, isUnrestrictedScope, MEMORY_KINDS, type MemoryKind,
} from './memory-kind.js';
import { getInboundLinkCounts } from './graph.js';
import { centralityBoost, normalizeCentrality, explainRecall, type RecallSignalBreakdown } from './recall-signals.js';
import { coRecallBoosts } from './co-recall.js';
import { foldText, STOPWORDS as ANALYZER_STOPWORDS } from './text-analyzer.js';
import { isDigestNote, isEmailNote } from './vault-hygiene/patterns.js';
import { parseTimeQuery, hasDateFilter } from './time-query.js';
import { config } from '../config.js';

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
// write). Contradictions bump β; mere recall does not change truth confidence.
// validity = α/(α+β).
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
    const { content, etag } = await readNote(path);
    const { data, body } = parseFrontmatter(content);
    const cur = computeValidity(data);
    if (outcome === 'success') data.validity_alpha = Math.round((cur.alpha + 1) * 1000) / 1000;
    else data.validity_beta = Math.round((cur.beta + 1) * 1000) / 1000;
    data.validity_last_checked = new Date().toISOString().slice(0, 10);
    const updated = stringifyFrontmatter(data, body);
    await writeNote(path, updated, etag);
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

// ───────────────────────────── Recall rescoring ─────────────────────────────
//
// Shared by the `memory_recall` tool and the hook-facing `/api/recall`
// (lib/recall-api.ts) so both callers rank with the same signals: heat,
// importance, category half-life recency, relatedTo, context keywords,
// graph centrality, Bayesian validity, archive penalty, co-recall spreading
// activation and MMR diversity. Pure over the in-memory docMeta index: no
// disk reads, no side effects (access bumps live in touchRecalledMemories).

export const CATEGORY_HALF_LIFE_DAYS: Record<string, number> = {
  observation: 14,
  decision: 30,
  insight: 30,
  conversation: 7,
  fact: 90,
  preference: 60,
  plan: 7,
  reflection: 30,
};
export const DEFAULT_HALF_LIFE_DAYS = 30;

export const TEMPERATURE_BOOST: Record<string, number> = { hot: 1.5, warm: 1.0, cold: 0.5 };
export const IMPORTANCE_BOOST: Record<string, number> = { critical: 2.0, high: 1.5, medium: 1.0, low: 0.7 };
export const IMPORTANCE_ORDER = ['low', 'medium', 'high', 'critical'] as const;

const CONTEXT_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been',
  'are', 'was', 'were', 'will', 'can', 'could', 'would', 'should',
  'not', 'but', 'they', 'their', 'them', 'what', 'which', 'when',
  'where', 'how', 'who', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'just', 'about', 'above', 'after', 'again', 'also', 'because',
  'before', 'between', 'does', 'done', 'down', 'during', 'into',
  'its', 'only', 'our', 'out', 'over', 'own', 'same', 'then',
  'there', 'these', 'those', 'through', 'under', 'until', 'upon',
  'your', 'you', 'she', 'her', 'his', 'him',
]);

/**
 * Keywords (>3 chars, de-duplicated, stopwords removed) from a context
 * snippet. Accent-folded (`réseau` → `reseau`) so French context matches.
 */
export function extractContextKeywords(contextSnippet: string | undefined): string[] {
  if (!contextSnippet) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of foldText(contextSnippet).split(/\s+/)) {
    const clean = w.replace(/[^a-z0-9]/g, '');
    if (clean.length > 3 && !CONTEXT_STOPWORDS.has(clean) && !ANALYZER_STOPWORDS.has(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

// MMR diversity (avoid near-duplicate recalls): cheap lexical similarity on
// title+head tokens (accent-folded), no embedding round-trip.
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of foldText(text).split(/[^a-z0-9]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Maximal Marginal Relevance selection. `items` must be pre-sorted by score
 * descending. Picks `limit` results balancing relevance (lambda) against
 * novelty vs. already-selected items (1 - lambda). 0.7 keeps relevance dominant;
 * lambda ≥ 1 disables diversity (plain top-`limit`). `textOf` overrides the text
 * compared for novelty (default: title + snippet).
 */
export function mmrSelect<T extends { title: string; snippet: string; score: number }>(
  items: T[],
  limit: number,
  lambda = 0.7,
  textOf?: (item: T) => string,
): T[] {
  if (items.length <= limit) return items;
  if (lambda >= 1) return items.slice(0, limit);
  const maxScore = items[0].score || 1;
  const toks = new Map<T, Set<string>>();
  const tokensFor = (r: T): Set<string> => {
    let t = toks.get(r);
    if (!t) { t = tokenSet(textOf ? textOf(r) : `${r.title} ${r.snippet}`); toks.set(r, t); }
    return t;
  };
  const selected: T[] = [];
  const remaining = [...items];
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccardSets(tokensFor(cand), tokensFor(s));
        if (sim > maxSim) maxSim = sim;
      }
      const relNorm = cand.score / maxScore;
      const mmr = lambda * relNorm - (1 - lambda) * maxSim;
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}

export interface RescoreOptions {
  /** Final number of results after MMR selection. */
  limit: number;
  categories?: string[];
  /** 'any' (default) or a temperature bucket. */
  temperature?: string;
  minImportance?: string;
  /** Vault paths (with or without `.md`); notes [[linked]] to any of them are boosted. */
  relatedTo?: string[];
  /** Raw context snippet; keywords are extracted with extractContextKeywords. */
  contextSnippet?: string;
  /** Pre-extracted keywords (wins over contextSnippet when given). */
  contextKeywords?: string[];
  /** Paths to drop before selection (e.g. a hook's per-session seen-set). */
  exclude?: Iterable<string>;
  explain?: boolean;
  /** Apply co-recall spreading activation from the top seeds (default true). */
  coRecall?: boolean;
  /**
   * The user's query. Lets the episodic tier (digests, email captures) rank
   * normally when the query explicitly asks for it.
   */
  query?: string;
  /**
   * Candidate pool (default: config.recallScope). 'memory': `type: memory`
   * notes (+ `type: digest`). 'durable': additionally keeps durable non-memory
   * notes (project notes, references, CRM entities…) at a lower weight;
   * machine-made note kinds (indexes, tasks, templates, code projections)
   * stay out.
   */
  scope?: 'memory' | 'durable';
  /**
   * Memory kinds that may be returned (strict filter). Omitted: every kind in
   * the candidate list. Callers normally get this from searchRecallPool.
   */
  kinds?: ReadonlySet<MemoryKind>;
  /**
   * The caller explicitly asked for episodic notes (`kinds` / `includeEpisodic`):
   * they rank at full weight instead of as the low-priority tier.
   */
  episodicOptIn?: boolean;
  /**
   * Mild preference for recently written notes ("latest", "most recent",
   * "en ce moment" — see lib/time-query.ts). A tie-breaker of at most
   * ±PREFER_RECENT_WEIGHT on top of the bounded prior; never a filter.
   */
  preferRecent?: boolean;
  /** Apply the minimum-evidence floor (default: config.recallMinEvidence). */
  minEvidence?: boolean;
}

/**
 * Which pool a recalled note came from (drives its tier weight):
 *   memory   semantic / procedural `type: memory` note
 *   note     semantic / procedural durable non-memory note (scope 'durable')
 *   digest | email | episodic   the episodic kind — the low-priority tier
 */
export type RecallTier = 'memory' | 'note' | 'digest' | 'email' | 'episodic';
const EPISODIC_TIERS: ReadonlySet<RecallTier> = new Set<RecallTier>(['digest', 'email', 'episodic']);

export interface RescoredResult {
  path: string;
  title: string;
  category: string;
  temperature: string;
  importance: string;
  archived?: boolean;
  consolidatedInto?: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  graphScore?: number;
  fusedScore: number;
  snippet: string;
  content?: string;
  tier?: RecallTier;
  signals?: RecallSignalBreakdown;
}

/** `[[Projects/x|alias]]`, `Projects/x.md`, `projects/X` all normalise to `projects/x`. */
function normalizeLinkTarget(raw: string): string {
  return raw
    .replace(/^\[\[/, '').replace(/\]\]$/, '')
    .split('|')[0].split('#')[0]
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

// ── Bounded priors (config.recallScoring = 'bounded') ───────────────────────
//
// final = relevance × (1 + prior) × explicit
//
//   relevance  fused score ÷ best fused score among the candidates (0..1)
//   prior      Σ of the small additive terms below, clamped to
//              ±config.recallPriorBound — a tie-breaker between notes of
//              similar relevance, never a substitute for relevance
//   explicit   caller intent and hard facts, deliberately NOT bounded:
//              relatedTo, contextSnippet, stale validity, archived, tier
//
// Durable categories (decision / preference / fact) are never penalised for
// being cold or old: a two-year-old decision is still the decision.

/** Additive prior per importance level. */
export const IMPORTANCE_PRIOR: Record<string, number> = { critical: 0.06, high: 0.04, medium: 0, low: -0.05 };
/** Additive prior per category: curated knowledge over raw captures. */
export const CATEGORY_PRIOR: Record<string, number> = {
  decision: 0.05, preference: 0.05, fact: 0.05, insight: 0.05,
  plan: 0, reflection: 0,
  observation: -0.05, conversation: -0.05,
};
export const DURABLE_CATEGORIES: ReadonlySet<string> = new Set(['decision', 'preference', 'fact']);
/** Max additive swing of the heat / recency / centrality / co-recall terms. */
export const HEAT_PRIOR_WEIGHT = 0.04;
export const RECENCY_PRIOR_WEIGHT = 0.03;
export const CENTRALITY_PRIOR_WEIGHT = 0.03;
export const CO_RECALL_PRIOR_CAP = 0.05;
/** Explicit-intent multipliers. */
export const RELATED_BOOST = 1.5;
export const CONTEXT_BOOST_PER_KEYWORD = 0.05;
export const CONTEXT_BOOST_MAX = 1.25;
export const ARCHIVED_PENALTY = 0.35;
/** Weight of a durable non-memory note relative to a memory (scope 'durable'). */
export const NOTE_TIER_WEIGHT = 0.8;
/** Max additive swing of the explicit "prefer recent" query intent. */
export const PREFER_RECENT_WEIGHT = 0.06;
/** Age (days) at which a note is neutral for the "prefer recent" intent. */
export const PREFER_RECENT_HALF_LIFE_DAYS = 45;

const DIGEST_QUERY_RE = /\b(digests?|summary|summaries|recaps?|weekly|consolidated|roll-?ups?|resumes?|recapitulatifs?|hebdo(madaire)?s?|synthese)\b/;
const EMAIL_QUERY_RE = /\b(e-?mails?|mails?|courriels?|inbox|newsletters?|sender|expediteur|messages?)\b/;

/** Does the query explicitly ask for the low-priority tier (digests / email captures)? */
export function queryAsksForTier(query: string | undefined): { digest: boolean; email: boolean } {
  if (!query) return { digest: false, email: false };
  const q = foldText(query);
  return { digest: DIGEST_QUERY_RE.test(q), email: EMAIL_QUERY_RE.test(q) };
}

/** Note kinds that are never recalled through the durable scope (machine-made / structural). */
const NON_DURABLE_TYPES: ReadonlySet<string> = new Set(['index', 'task', 'redirect', 'email', 'agent', 'skill', 'template']);
const NON_DURABLE_COLLECTIONS: ReadonlySet<string> = new Set(['code', 'archive']);

interface TierMeta {
  type?: string;
  tags?: readonly string[];
  title?: string;
  collection?: string;
  source?: string;
  category?: string;
  memory_kind?: MemoryKind;
}

/** A note's memory kind: the indexed value, else classified on the spot. */
function kindOfMeta(notePath: string, meta: TierMeta): MemoryKind {
  return meta.memory_kind
    ?? memoryKindOf(meta as Record<string, unknown>, notePath, { machineSourcePatterns: config.machineCaptureSourcePatterns });
}

/**
 * Classify a note for recall, or `undefined` when it is outside `scope`.
 *
 * ONE rule, with the memory-kind classifier (lib/memory-kind.ts) as the source
 * of truth: semantic and procedural notes are the primary tier ('memory', or
 * 'note' for a durable non-memory note); EPISODIC notes — consolidation
 * digests, email captures, hook / n8n exhaust, diaries, conversation logs —
 * are the low-priority tier ('digest' | 'email' | 'episodic'), whatever their
 * `type`. Whether the episodic tier is searched at all is the caller's kind
 * scope (searchRecallPool); how it is weighted is rescoreRecall.
 */
export function recallTierOf(notePath: string, meta: TierMeta, scope: 'memory' | 'durable' = 'memory'): RecallTier | undefined {
  const like = { path: notePath, type: meta.type, tags: meta.tags, title: meta.title, source: meta.source };
  const isMemory = meta.type === 'memory';
  if (!isMemory && meta.type !== 'digest') {
    if (scope !== 'durable') return undefined;
    if (meta.type && NON_DURABLE_TYPES.has(meta.type)) return undefined;
    if (meta.collection && NON_DURABLE_COLLECTIONS.has(meta.collection)) return undefined;
    if (/(^|\/)Templates?\//i.test(notePath)) return undefined;
  }
  // An explicit `memory_kind: semantic` in frontmatter wins over path / tags.
  if (kindOfMeta(notePath, meta) !== 'episodic') return isMemory ? 'memory' : 'note';
  // The durable scope adds durable KNOWLEDGE only: a non-memory episodic note
  // (diary day, journal, EmailLog capture, email digest) stays out.
  if (!isMemory && meta.type !== 'digest') return undefined;
  if (meta.type === 'digest' || isDigestNote(like)) return 'digest';
  if (isEmailNote(like)) return 'email';
  return 'episodic';
}

// ── Time-aware queries (shared by memory_recall and /api/recall) ───────────

/** What recall understood of the temporal part of a query (shown to the agent). */
export interface RecallTimeInfo {
  /** Temporal phrases recognised in the query, as written. */
  phrases: string[];
  /** Inclusive day bounds / as-of day applied as filters (nominal, without slack). */
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  /** The query asked for recent information (a ranking preference, never a filter). */
  preferRecent?: boolean;
  /** Event anchors that could not be dated ("before the v1.18 release"): not filtered on. */
  unresolved?: string[];
  /** Explicit dateFrom / dateTo / asOf parameters overrode the parsed period. */
  overridden?: boolean;
  /** Nothing matched inside the parsed period: the results are from outside it. */
  outsidePeriod?: boolean;
}

export interface RecallTimePlan {
  /** Query to search: temporal phrases stripped (the original when nothing is left). */
  query: string;
  /** Bounds to hand to hybridSearch (parsed bounds carry the day slack). */
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  preferRecent: boolean;
  /** The bounds come from the query text, not from explicit parameters: eligible for the no-result retry. */
  parsedFilter: boolean;
  /** Undefined when the query has no temporal part. */
  info?: RecallTimeInfo;
}

function shiftDay(day: string, n: number): string {
  const t = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return day;
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * Turn the temporal part of a query into search bounds. Explicit parameters
 * always win. Parsed day bounds are widened by config.recallTimeSlackDays on
 * each side: notes are stamped in UTC while "yesterday" is the user's local
 * day, so a strict bound would drop a note written late in the evening.
 */
export function planRecallTime(
  query: string,
  explicit: { dateFrom?: string; dateTo?: string; asOf?: string } = {},
  now: Date = new Date(),
): RecallTimePlan {
  const hasExplicit = Boolean(explicit.dateFrom || explicit.dateTo || explicit.asOf);
  const passthrough: RecallTimePlan = {
    query, dateFrom: explicit.dateFrom, dateTo: explicit.dateTo, asOf: explicit.asOf,
    preferRecent: false, parsedFilter: false,
  };
  if (!config.recallTimeQuery) return passthrough;
  let tq: ReturnType<typeof parseTimeQuery>;
  try {
    tq = parseTimeQuery(query, now, explicit);
  } catch {
    return passthrough;
  }
  if (tq.matched.length === 0) return passthrough;

  const parsedFilter = !hasExplicit && hasDateFilter(tq);
  const slack = Math.max(0, config.recallTimeSlackDays);
  const info: RecallTimeInfo = { phrases: tq.matched.map((m) => m.phrase) };
  if (parsedFilter) {
    if (tq.dateFrom) info.dateFrom = tq.dateFrom;
    if (tq.dateTo) info.dateTo = tq.dateTo;
    if (tq.asOf) info.asOf = tq.asOf;
  }
  if (tq.preferRecent) info.preferRecent = true;
  if (tq.unresolved?.length) info.unresolved = tq.unresolved;
  if (tq.overridden) info.overridden = true;

  return {
    query: tq.strippedQuery.trim() || query,
    dateFrom: parsedFilter ? (tq.dateFrom ? shiftDay(tq.dateFrom, -slack) : undefined) : explicit.dateFrom,
    dateTo: parsedFilter ? (tq.dateTo ? shiftDay(tq.dateTo, slack) : undefined) : explicit.dateTo,
    // A parsed as-of DAY includes that whole day.
    asOf: parsedFilter ? (tq.asOf ? `${tq.asOf.slice(0, 10)}T23:59:59.999Z` : undefined) : explicit.asOf,
    preferRecent: Boolean(tq.preferRecent),
    parsedFilter,
    info,
  };
}

/** One short line telling the agent what was understood of the query's time part ('' when nothing). */
export function describeRecallTime(info: RecallTimeInfo | undefined): string {
  if (!info) return '';
  const quoted = info.phrases.length ? ` (${info.phrases.map((p) => `"${p.trim()}"`).join(', ')})` : '';
  const parts: string[] = [];
  const period = info.asOf
    ? `as of ${info.asOf}`
    : info.dateFrom && info.dateTo
      ? (info.dateFrom === info.dateTo ? info.dateFrom : `${info.dateFrom} → ${info.dateTo}`)
      : info.dateFrom ? `since ${info.dateFrom}` : info.dateTo ? `until ${info.dateTo}` : '';
  if (period) {
    parts.push(info.outsidePeriod
      ? `nothing dated ${period}${quoted} — results are OUTSIDE the requested period`
      : `filtered to ${period}${quoted}`);
  } else if (info.overridden) {
    parts.push(`explicit date parameters used instead of the query's own period${quoted}`);
  }
  if (info.preferRecent) parts.push(period || info.overridden ? 'recent notes preferred' : `recent notes preferred${quoted}`);
  if (info.unresolved?.length) parts.push(`not filtered on ${info.unresolved.map((a) => `"${a}"`).join(', ')} (no known date)`);
  if (parts.length === 0) return '';
  const text = parts.join('; ');
  return `_Time: ${text}._`;
}

// ── Kind-scoped candidate pool (shared by memory_recall and /api/recall) ────

export interface RecallPoolOptions {
  /** Explicit kinds to recall (strict: nothing else is searched). */
  kinds?: readonly string[] | null;
  /** true: episodic notes join the pool at full weight. false: never searched. */
  includeEpisodic?: boolean | null;
}

export interface RecallPool {
  results: SearchResult[];
  /** Kinds that may be returned (pass to rescoreRecall `kinds`). */
  kinds: ReadonlySet<MemoryKind>;
  /** Episodic notes were explicitly requested: full weight (pass to rescoreRecall). */
  episodicOptIn: boolean;
}

/**
 * Resolve the memory-kind scope of one recall.
 *
 *   - `kinds` given             → exactly those kinds (strict filter).
 *   - `includeEpisodic: true`   → every kind, episodic at full weight.
 *   - `includeEpisodic: false`  → semantic + procedural only (strict).
 *   - default                   → semantic + procedural are the primary tier;
 *     episodic notes stay reachable as the LOW-PRIORITY tier (demoted by
 *     config.recallLowTierPenalty / recallEpisodicPenalty in rescoreRecall), so
 *     they only surface when nothing durable answers the query as well. On the
 *     real-vault eval a strict default costs 2.7 pt Recall@5 (10 pt on temporal
 *     queries, whose answers often live in dated captures), hence the tier.
 *     RECALL_EPISODIC=exclude makes the default strict; a query that asks for
 *     the tier by name ("email from…", "weekly digest") still reaches it.
 */
export function resolveRecallKinds(query: string, o: RecallPoolOptions = {}): { kinds: ReadonlySet<MemoryKind>; episodicOptIn: boolean } {
  const explicit = (Array.isArray(o.kinds) && o.kinds.length > 0) || typeof o.includeEpisodic === 'boolean';
  const scope = resolveKindScope({ kinds: o.kinds, includeEpisodic: o.includeEpisodic });
  if (explicit) return { kinds: scope, episodicOptIn: scope.has('episodic') };
  if (config.recallEpisodic === 'exclude') {
    const asks = queryAsksForTier(query);
    if (!asks.digest && !asks.email) return { kinds: scope, episodicOptIn: false };
  }
  return { kinds: new Set<MemoryKind>(MEMORY_KINDS), episodicOptIn: false };
}

/** Search recall's candidate pool under the memory-kind scope (see resolveRecallKinds). */
export async function searchRecallPool(query: string, base: SearchOptions, o: RecallPoolOptions = {}): Promise<RecallPool> {
  const { kinds, episodicOptIn } = resolveRecallKinds(query, o);
  const results = await hybridSearch(query, { ...base, kinds: isUnrestrictedScope(kinds) ? undefined : [...kinds] });
  return { results, kinds, episodicOptIn };
}

export interface RecallEvidence {
  /** Best normalised lexical evidence among the candidates (BM25 ÷ query IDF mass). */
  lexical: number;
  /** Best cosine similarity among the candidates (0 when no semantic arm). */
  similarity: number;
  /** 'none' → below the floor (abstain); 'low' → weak, flag it; 'ok'. */
  level: 'none' | 'low' | 'ok';
}

/**
 * Minimum-evidence assessment over a candidate list. Rank-relative scores
 * cannot tell "the best of a bad lot" from a real match, so this uses the two
 * ABSOLUTE signals the arms expose: the best hit's BM25 per unit of query IDF
 * mass, and the best cosine similarity. A query is unanswerable when BOTH are
 * under their floor. Lists without evidence fields (legacy callers, tests) are
 * always 'ok'.
 */
export function assessRecallEvidence(results: ReadonlyArray<Pick<SearchResult, 'lexicalEvidence' | 'semanticSim'>>): RecallEvidence {
  let lexical = 0;
  let similarity = 0;
  let known = false;
  for (const r of results) {
    if (typeof r.lexicalEvidence === 'number') { known = true; if (r.lexicalEvidence > lexical) lexical = r.lexicalEvidence; }
    if (typeof r.semanticSim === 'number') { known = true; if (r.semanticSim > similarity) similarity = r.semanticSim; }
  }
  if (!known) return { lexical, similarity, level: 'ok' };
  const weakSim = similarity < config.recallMinSimilarity;
  const level = weakSim && lexical < config.recallMinLexicalEvidence
    ? 'none'
    : weakSim && lexical < config.recallLowConfidenceEvidence ? 'low' : 'ok';
  return { lexical, similarity, level };
}

/**
 * Post-filter and re-score hybrid-search hits. Returns the MMR-selected top
 * `opts.limit`, sorted by final score. Never bumps access counters or
 * validity: surfacing a memory is not evidence it is true.
 *
 * Scoring is `relevance × (1 + bounded prior) × explicit intent` (see the
 * constants above); `RECALL_SCORING=legacy` restores the old unbounded
 * multiplicative boosts. Returns `[]` when the candidates carry no real
 * evidence for the query (see {@link assessRecallEvidence}).
 */
export function rescoreRecall(results: SearchResult[], opts: RescoreOptions): RescoredResult[] {
  if (config.recallScoring === 'legacy') return rescoreRecallLegacy(results, opts);

  const docMeta = getDocMeta();
  const categories = opts.categories && opts.categories.length > 0 ? opts.categories : undefined;
  const temperature = opts.temperature ?? 'any';
  const minImportanceIdx = opts.minImportance
    ? (IMPORTANCE_ORDER as readonly string[]).indexOf(opts.minImportance)
    : -1;
  // Category / temperature / importance are memory frontmatter: when the
  // caller filters on them, non-memory notes cannot qualify.
  const memoryOnlyFilters = !!categories || temperature !== 'any' || minImportanceIdx >= 0;
  const relatedSet = opts.relatedTo && opts.relatedTo.length > 0
    ? new Set(opts.relatedTo.map(normalizeLinkTarget))
    : undefined;
  const contextKeywords = opts.contextKeywords ?? extractContextKeywords(opts.contextSnippet);
  const exclude = opts.exclude ? new Set(opts.exclude) : undefined;
  const explain = opts.explain ?? false;
  const scope = opts.scope ?? config.recallScope;
  const kindScope = opts.kinds && !isUnrestrictedScope(opts.kinds) ? opts.kinds : undefined;
  const asks = queryAsksForTier(opts.query);
  const nowMs = Date.now();
  const bound = Math.max(0, config.recallPriorBound);
  const clampPrior = (x: number): number => Math.max(-bound, Math.min(bound, x));

  // Graph-centrality signal (null until the graph is built, then a no-op).
  const centralityScale = config.recallCentralityWeight > 0 ? Math.min(config.recallCentralityWeight / 0.15, 2) : 0;
  const inboundCounts = centralityScale > 0 ? getInboundLinkCounts() : null;

  interface Scored { result: RescoredResult; relevance: number; prior: number; explicit: number; head: string }
  const scored: Scored[] = [];
  const inScope: SearchResult[] = [];
  let maxFused = 0;
  for (const r of results) if (r.score > maxFused) maxFused = r.score;
  if (maxFused <= 0) maxFused = 1;

  for (const result of results) {
    if (exclude?.has(result.path)) continue;
    const meta = docMeta.get(result.path);
    if (!meta) continue;
    const tier = recallTierOf(result.path, meta, scope);
    if (!tier) continue;
    if (kindScope && !kindScope.has(kindOfMeta(result.path, meta))) continue;
    const isMemory = meta.type === 'memory';
    if (!isMemory && memoryOnlyFilters) continue;

    const noteCategory = meta.category || (isMemory ? 'observation' : 'note');
    const noteTemperature = meta.temperature || 'warm';
    const noteImportance = meta.importance || 'medium';

    if (categories && !categories.includes(noteCategory)) continue;
    if (temperature !== 'any' && noteTemperature !== temperature) continue;
    if (minImportanceIdx >= 0) {
      const noteImportanceIdx = (IMPORTANCE_ORDER as readonly string[]).indexOf(noteImportance);
      if (noteImportanceIdx < minImportanceIdx) continue;
    }

    // Bayesian validity: filter quarantined, penalize stale.
    let validityPenalty = 1.0;
    let validityScore: number | undefined;
    let validityStale = false;
    if (config.memoryValidity && isMemory) {
      const v = computeValidity({ validity_alpha: meta.validity_alpha, validity_beta: meta.validity_beta });
      if (v.quarantined) continue;
      validityScore = v.validity;
      if (v.stale) { validityPenalty = VALIDITY_STALE_RANK_PENALTY; validityStale = true; }
    }
    inScope.push(result);

    // ── Bounded prior (memories only: other notes carry no such frontmatter) ──
    const durable = DURABLE_CATEGORIES.has(noteCategory);
    const heatScore = typeof meta.heat_score === 'number' ? meta.heat_score : undefined;
    let recency = 0.5;
    if (meta.last_accessed) {
      const lastAccessedTime = new Date(meta.last_accessed).getTime();
      if (!isNaN(lastAccessedTime)) {
        const daysSinceLastAccess = (Date.now() - lastAccessedTime) / (1000 * 60 * 60 * 24);
        const halfLifeDays = CATEGORY_HALF_LIFE_DAYS[noteCategory] ?? DEFAULT_HALF_LIFE_DAYS;
        recency = 1 / (1 + Math.max(daysSinceLastAccess, 0) / halfLifeDays);
      }
    }
    const inboundLinks = inboundCounts?.get(result.path) ?? 0;
    let prior = 0;
    if (isMemory) {
      prior += IMPORTANCE_PRIOR[noteImportance] ?? 0;
      prior += CATEGORY_PRIOR[noteCategory] ?? 0;
      // Heat: numeric heat_score (0-16) or the temperature bucket, centred on 0.
      const heatNorm = heatScore !== undefined
        ? Math.min(Math.max(heatScore, 0), 16) / 16
        : noteTemperature === 'hot' ? 1 : noteTemperature === 'cold' ? 0 : 0.5;
      const heatTerm = HEAT_PRIOR_WEIGHT * (2 * heatNorm - 1);
      const recencyTerm = RECENCY_PRIOR_WEIGHT * (2 * recency - 1);
      prior += durable ? Math.max(0, heatTerm) : heatTerm;
      prior += durable ? Math.max(0, recencyTerm) : recencyTerm;
    }
    if (inboundCounts) prior += CENTRALITY_PRIOR_WEIGHT * centralityScale * normalizeCentrality(inboundLinks);
    prior = clampPrior(prior);
    // Explicit "latest / most recent" intent: favour recently WRITTEN notes
    // (note date, else last access). Added on top of the clamp so it still
    // breaks ties when the other priors already saturate the bound.
    if (opts.preferRecent) {
      const written = Date.parse(meta.date ?? '') || Date.parse(meta.last_accessed ?? '');
      if (!Number.isNaN(written) && written > 0) {
        const ageDays = Math.max(0, (nowMs - written) / 86_400_000);
        prior += PREFER_RECENT_WEIGHT * (2 / (1 + ageDays / PREFER_RECENT_HALF_LIFE_DAYS) - 1);
      }
    }

    const body = meta.content ?? '';

    // ── Explicit caller intent (unbounded) ──
    // relatedTo: frontmatter `related`, tags, or a body [[wiki-link]].
    let related = false;
    if (relatedSet) {
      const noteRelated = Array.isArray(meta.related) ? meta.related : [];
      related = noteRelated.some((r: string) => relatedSet.has(normalizeLinkTarget(r)));
      if (!related && Array.isArray(meta.tags)) {
        related = meta.tags.some((t) => relatedSet.has(normalizeLinkTarget(String(t))));
      }
      if (!related && body) {
        const lower = body.toLowerCase();
        for (const rel of relatedSet) {
          if (lower.includes(`[[${rel}]]`) || lower.includes(`[[${rel}|`) || lower.includes(`[[${rel}.md]]`)) {
            related = true;
            break;
          }
        }
      }
    }
    // Context: reward notes containing keywords from contextSnippet.
    let contextBoost = 1.0;
    if (contextKeywords.length > 0) {
      const bodyFolded = foldText(body);
      let matchCount = 0;
      for (const kw of contextKeywords) if (bodyFolded.includes(kw)) matchCount++;
      if (matchCount > 0) contextBoost = Math.min(1.0 + CONTEXT_BOOST_PER_KEYWORD * matchCount, CONTEXT_BOOST_MAX);
    }
    // Tier: the episodic kind (digests, email captures, machine exhaust) is
    // low priority unless the caller opted in or the query asks for it.
    const demotable = EPISODIC_TIERS.has(tier) && !opts.episodicOptIn &&
      !((tier === 'digest' && asks.digest) || (tier === 'email' && asks.email));
    const tierPenalty = demotable ? (tier === 'episodic' ? config.recallEpisodicPenalty : config.recallLowTierPenalty) : 1;
    const lowTier = tierPenalty < 1;
    const tierWeight = tierPenalty * (isMemory || meta.type === 'digest' ? 1 : NOTE_TIER_WEIGHT);
    const explicit = (related ? RELATED_BOOST : 1) * contextBoost * validityPenalty *
      (meta.archived ? ARCHIVED_PENALTY : 1) * tierWeight;

    const relevance = result.score / maxFused;
    scored.push({
      relevance,
      prior,
      explicit,
      head: `${meta.title || result.title} ${body.slice(0, 200)}`,
      result: {
        path: result.path,
        title: meta.title || result.title,
        category: noteCategory,
        temperature: noteTemperature,
        importance: noteImportance,
        archived: meta.archived,
        consolidatedInto: meta.consolidated_into,
        score: relevance * (1 + prior) * explicit,
        lexicalScore: result.lexicalScore,
        semanticScore: result.semanticScore,
        graphScore: result.graphScore,
        fusedScore: result.fusedScore,
        snippet: result.snippet,
        tier,
        signals: explain
          ? explainRecall({
              lexicalScore: result.lexicalScore,
              semanticScore: result.semanticScore,
              graphScore: result.graphScore,
              temperature: noteTemperature,
              heatScore,
              recency,
              inboundLinks,
              validity: validityScore,
              stale: validityStale,
              related,
              prior,
              tier,
              lowTier,
            })
          : undefined,
      },
    });
  }

  // Minimum-evidence floor: nothing in scope really matches → return nothing.
  if ((opts.minEvidence ?? config.recallMinEvidence) && assessRecallEvidence(inScope).level === 'none') return [];

  // Sort, then co-recall spreading activation from the top seeds (folded into
  // the bounded prior, so it too can only break ties), then MMR.
  scored.sort((a, b) => b.result.score - a.result.score);
  if (opts.coRecall ?? true) {
    const seeds = scored.slice(0, 5).map((s) => s.result.path);
    const coBoosts = coRecallBoosts(seeds);
    if (coBoosts.size > 0) {
      for (const s of scored) {
        const boost = coBoosts.get(s.result.path);
        if (boost && boost > 1) {
          const add = Math.min(boost - 1, CO_RECALL_PRIOR_CAP);
          s.prior = clampPrior(s.prior + add);
          s.result.score = s.relevance * (1 + s.prior) * s.explicit;
          if (s.result.signals) {
            s.result.signals.coRecall = Math.round(add * 1000) / 1000;
            s.result.signals.prior = Math.round(s.prior * 1000) / 1000;
            s.result.signals.reason += '; co-recalled with top matches';
          }
        }
      }
      scored.sort((a, b) => b.result.score - a.result.score);
    }
  }
  const heads = new Map<RescoredResult, string>();
  for (const s of scored) heads.set(s.result, s.head);
  const selected = mmrSelect(scored.map((s) => s.result), opts.limit, config.recallMmrLambda, (r) => heads.get(r) ?? `${r.title} ${r.snippet}`);
  // Snippets only for the survivors: the query's best-matching passage when
  // the search did not already build one, else the head of the note.
  // A hit the lexical arm did not find has no query term to centre a passage
  // on: show its best-matching embedding chunk instead of the note's head.
  let chunkText: Map<string, string> | undefined;
  for (const r of selected) {
    if (r.snippet) continue;
    const body = docMeta.get(r.path)?.content ?? '';
    if (r.lexicalScore <= 0) {
      if (!chunkText) {
        chunkText = new Map();
        for (const s of results) if (s.chunk?.text) chunkText.set(s.path, s.chunk.text);
      }
      const text = chunkText.get(r.path);
      if (text) { r.snippet = chunkSnippet(text); continue; }
    }
    r.snippet = opts.query ? bestPassage(body, opts.query) : body.slice(0, 200);
  }
  return selected;
}

/**
 * Pre-1.21 scoring (`RECALL_SCORING=legacy`): fused score × heat (0.5–1.5) ×
 * importance (0.7–2) × recency × centrality × relatedTo (2×) × context ×
 * validity × archive. Unbounded — kept only as an escape hatch.
 */
function rescoreRecallLegacy(results: SearchResult[], opts: RescoreOptions): RescoredResult[] {
  const docMeta = getDocMeta();
  const categories = opts.categories && opts.categories.length > 0 ? opts.categories : undefined;
  const temperature = opts.temperature ?? 'any';
  const minImportanceIdx = opts.minImportance
    ? (IMPORTANCE_ORDER as readonly string[]).indexOf(opts.minImportance)
    : -1;
  const relatedSet = opts.relatedTo && opts.relatedTo.length > 0
    ? new Set(opts.relatedTo.map(normalizeLinkTarget))
    : undefined;
  const contextKeywords = opts.contextKeywords ?? extractContextKeywords(opts.contextSnippet);
  const exclude = opts.exclude ? new Set(opts.exclude) : undefined;
  const explain = opts.explain ?? false;

  // Graph-centrality signal (null until the graph is built, then a no-op).
  const inboundCounts = config.recallCentralityWeight > 0 ? getInboundLinkCounts() : null;

  const scored: RescoredResult[] = [];
  for (const result of results) {
    if (exclude?.has(result.path)) continue;
    const meta = docMeta.get(result.path);
    if (!meta) continue;
    if (meta.type !== 'memory') continue;

    const noteCategory = meta.category || 'observation';
    const noteTemperature = meta.temperature || 'warm';
    const noteImportance = meta.importance || 'medium';

    if (categories && !categories.includes(noteCategory)) continue;
    if (temperature !== 'any' && noteTemperature !== temperature) continue;
    if (minImportanceIdx >= 0) {
      const noteImportanceIdx = (IMPORTANCE_ORDER as readonly string[]).indexOf(noteImportance);
      if (noteImportanceIdx < minImportanceIdx) continue;
    }

    // Bayesian validity: filter quarantined, penalize stale.
    let validityPenalty = 1.0;
    let validityScore: number | undefined;
    let validityStale = false;
    if (config.memoryValidity) {
      const v = computeValidity({ validity_alpha: meta.validity_alpha, validity_beta: meta.validity_beta });
      if (v.quarantined) continue;
      validityScore = v.validity;
      if (v.stale) { validityPenalty = VALIDITY_STALE_RANK_PENALTY; validityStale = true; }
    }

    // Heat boost: numeric heat_score (0-16) mapped onto 0.5..1.5, else bucket.
    const heatScore = typeof meta.heat_score === 'number' ? meta.heat_score : undefined;
    const tempBoost = heatScore !== undefined
      ? 0.5 + Math.min(Math.max(heatScore, 0), 16) / 16
      : (TEMPERATURE_BOOST[noteTemperature] ?? 1.0);
    const impBoost = IMPORTANCE_BOOST[noteImportance] ?? 1.0;

    // Temporal decay: category half-life on last_accessed.
    let recencyBoost = 1.0;
    if (meta.last_accessed) {
      const lastAccessedTime = new Date(meta.last_accessed).getTime();
      if (!isNaN(lastAccessedTime)) {
        const daysSinceLastAccess = (Date.now() - lastAccessedTime) / (1000 * 60 * 60 * 24);
        const halfLifeDays = CATEGORY_HALF_LIFE_DAYS[noteCategory] ?? DEFAULT_HALF_LIFE_DAYS;
        recencyBoost = 1 / (1 + daysSinceLastAccess / halfLifeDays);
      }
    }

    const body = meta.content ?? '';

    // relatedTo boost: frontmatter `related`, tags, or a body [[wiki-link]]
    // to one of the requested paths.
    let relBoost = 1.0;
    if (relatedSet) {
      const noteRelated = Array.isArray(meta.related) ? meta.related : [];
      let hasRelation = noteRelated.some((r: string) => relatedSet.has(normalizeLinkTarget(r)));
      if (!hasRelation && Array.isArray(meta.tags)) {
        hasRelation = meta.tags.some((t) => relatedSet.has(normalizeLinkTarget(String(t))));
      }
      if (!hasRelation && body) {
        const lower = body.toLowerCase();
        for (const rel of relatedSet) {
          if (lower.includes(`[[${rel}]]`) || lower.includes(`[[${rel}|`) || lower.includes(`[[${rel}.md]]`)) {
            hasRelation = true;
            break;
          }
        }
      }
      if (hasRelation) relBoost = 2.0;
    }

    // Context boost: reward notes containing keywords from contextSnippet.
    let contextBoost = 1.0;
    if (contextKeywords.length > 0) {
      const bodyLower = foldText(body);
      let matchCount = 0;
      for (const kw of contextKeywords) if (bodyLower.includes(kw)) matchCount++;
      if (matchCount > 0) contextBoost = Math.min(1.0 + 0.1 * matchCount, 1.5);
    }

    const inboundLinks = inboundCounts?.get(result.path) ?? 0;
    const centBoost = inboundCounts ? centralityBoost(inboundLinks, config.recallCentralityWeight) : 1.0;
    const sourcePenalty = meta.archived ? 0.35 : 1;
    const finalScore = result.score * tempBoost * impBoost * relBoost * recencyBoost * contextBoost * validityPenalty * centBoost * sourcePenalty;

    scored.push({
      path: result.path,
      title: meta.title || result.title,
      category: noteCategory,
      temperature: noteTemperature,
      importance: noteImportance,
      archived: meta.archived,
      consolidatedInto: meta.consolidated_into,
      score: finalScore,
      lexicalScore: result.lexicalScore,
      semanticScore: result.semanticScore,
      graphScore: result.graphScore,
      fusedScore: result.fusedScore,
      snippet: result.snippet || body.slice(0, 200),
      signals: explain
        ? explainRecall({
            lexicalScore: result.lexicalScore,
            semanticScore: result.semanticScore,
            graphScore: result.graphScore,
            temperature: noteTemperature,
            heatScore,
            recency: recencyBoost,
            inboundLinks,
            validity: validityScore,
            stale: validityStale,
            related: relBoost > 1,
          })
        : undefined,
    });
  }

  // Sort, then co-recall spreading activation from the top seeds, then MMR.
  scored.sort((a, b) => b.score - a.score);
  if (opts.coRecall ?? true) {
    const seeds = scored.slice(0, 5).map((s) => s.path);
    const coBoosts = coRecallBoosts(seeds);
    if (coBoosts.size > 0) {
      for (const s of scored) {
        const boost = coBoosts.get(s.path);
        if (boost && boost > 1) {
          s.score *= boost;
          if (s.signals) {
            s.signals.coRecall = Math.round((boost - 1) * 1000) / 1000;
            s.signals.reason += '; co-recalled with top matches';
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  }
  return mmrSelect(scored, opts.limit);
}

/**
 * [eval no-touch opt-out] `RECALL_NO_TOUCH=1|true` turns recall into a pure
 * read: no access bumps (vault writes) and no co-recall recording (data-dir
 * writes that change later rankings). Used by the recall eval harness so runs
 * are repeatable and never write into a frozen vault snapshot. Read at call
 * time (not frozen in config) so a harness can set it after imports.
 */
export function recallTouchDisabled(): boolean {
  const v = process.env.RECALL_NO_TOUCH;
  return v === '1' || v === 'true';
}

/**
 * Fire-and-forget access bump for recalled memories: increments
 * `access_count` and stamps `last_accessed` once per day per note. Access is
 * a salience signal only; validity is never touched here. Never throws and
 * never blocks the caller. No-op when {@link recallTouchDisabled}.
 */
export function touchRecalledMemories(paths: string[]): void {
  if (recallTouchDisabled()) return; // [eval no-touch opt-out]
  const today = new Date().toISOString().slice(0, 10);
  for (const resultPath of paths) {
    (async () => {
      try {
        const { content: noteContent, etag } = await readNote(resultPath);
        const { data, body } = parseFrontmatter(noteContent);
        const currentCount = typeof data.access_count === 'number' ? data.access_count : 0;
        const currentAccessed = data.last_accessed as string | undefined;
        if (currentAccessed === today && currentCount > 0) return; // already tracked today
        data.access_count = currentCount + 1;
        data.last_accessed = today;
        await writeNote(resultPath, stringifyFrontmatter(data, body), etag);
      } catch {
        // best-effort tracking
      }
    })();
  }
}
