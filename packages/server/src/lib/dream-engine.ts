/**
 * Dream Engine — automated memory maintenance cycle.
 *
 * Analyzes, organizes, and strengthens the memory system by detecting
 * themes, finding orphan memories, suggesting connections, and running
 * lifecycle maintenance (decay, archival). Think of it as the brain's
 * consolidation process during sleep.
 */

import { getDocMeta, getIndexedNoteCount } from './search.js';
import { getGraphStats } from './graph.js';
import {
  findConsolidationCandidates,
  decayMemories,
  autoArchiveColdMemories,
  applyAutoConsolidation,
  findROIDemotionCandidates,
  findAutoPromoteCandidates,
  applyPromotion,
  AUTO_CONSOLIDATE_MIN_GROUP_SIZE,
  AUTO_CONSOLIDATE_MIN_SHARED_TAGS,
  type ROIDemotionCandidate,
  type PromotionCandidate,
} from './memory-lifecycle.js';
import {
  clusterColdNotes,
  reconcileClusterIntoProject,
  type ProjectReconciliation,
} from './project-reconcile.js';
import { logger } from './logger.js';
import { config } from '../config.js';

/**
 * Tags we skip during theme detection: these are tags the system applies to
 * its own maintenance records (cron runs, dream cycles, auto-saves, …). If
 * we let them into theme detection the dream ends up "observing its own
 * exhaust" — e.g. a theme of "cron + memory" that is just the vault
 * describing its own dream runs. Kept at module top so this list is
 * editable as new self-observation tags appear.
 */
export const SELF_OBSERVATION_TAGS: ReadonlySet<string> = new Set([
  'temperature-refresh',
  'dream-cycle',
  'auto-save',
  'hook',
  'email-recap',
  'cron-run',
]);

// ── Types ───────────────────────────────────────────────────────────────

export interface DreamTheme {
  name: string;
  tags: string[];
  memoryPaths: string[];
  temperature: 'hot' | 'warm' | 'cold';
  summary: string;
}

export interface OrphanMemory {
  path: string;
  title: string;
  temperature: string;
  heat_score: number;
  daysSinceAccess: number;
  suggestedAction: 'link' | 'consolidate' | 'archive' | 'review';
}

export interface ConnectionSuggestion {
  sourcePath: string;
  targetPath: string;
  reason: string;
  sharedTags: string[];
  confidence: number;
}

export interface ConsolidationGroup {
  paths: string[];
  commonTags: string[];
  suggestedTitle: string;
  avgHeatScore: number;
  /** True when auto-apply criteria met (≥groupSize AND ≥sharedTags). */
  autoApplyEligible?: boolean;
  /** True when auto-apply actually ran (autoConsolidate + not dryRun). */
  autoApplied?: boolean;
  /** Set when auto-applied: path of the new consolidated summary note. */
  consolidatedPath?: string;
  /** Set when auto-applied: originals that were deleted. */
  deletedOriginals?: string[];
}

export interface DreamLlmBlock {
  ran: boolean;
  /** Populated when ran=false: concrete reason (e.g. 'llm-disconnected'). */
  skipReason?: string;
  summary?: string;
  model?: string;
  errors?: string[];
}

export interface DreamReport {
  timestamp: string;
  durationMs: number;

  activity: {
    totalNotes: number;
    hotCount: number;
    warmCount: number;
    coldCount: number;
    recentlyCreated: number;
    recentlyAccessed: number;
  };

  lifecycle: {
    decayed: number;
    archived: string[];
  };

  themes: DreamTheme[];
  orphans: OrphanMemory[];
  connectionSuggestions: ConnectionSuggestion[];
  consolidationGroups: ConsolidationGroup[];

  /** Auto-applied consolidation results (empty when dryRun or autoConsolidate=false). */
  autoConsolidations: Array<{
    consolidatedPath: string;
    sourcePaths: string[];
    deleted: string[];
    errors: string[];
  }>;

  /** Memories with negative ROI flagged for review/demotion (token-savior parity). */
  roiDemotions: ROIDemotionCandidate[];

  /** Observations promoted to canonical facts (≥5 hits in 30 days). */
  promotions: Array<PromotionCandidate & { applied: boolean }>;

  /**
   * Cold notes consolidated into project notes by shared entity/tag overlap:
   * each source's full body is folded into Projects/<slug>.md and the original
   * is deleted. Empty when reconcileProjects=false. In dryRun these are the
   * would-be reconciliations (nothing written/deleted).
   */
  projectReconciliations: ProjectReconciliation[];

  /** Always present — even when the LLM was skipped — so consumers get a uniform shape. */
  llm: DreamLlmBlock;

  /** True if this run was a dry run (no mutations applied). */
  dryRun: boolean;

  /**
   * True if the cycle hit its overall time budget and skipped one or more of
   * the expensive optional passes (connections, consolidation, reconciliation,
   * ROI/promotion). A safety backstop so a pathological vault state can never
   * hang the server in the dream — individual passes are also capped.
   */
  budgetExceeded?: boolean;

  health: {
    orphanRatio: number;
    avgHeatScore: number;
    temperatureDistribution: { hot: number; warm: number; cold: number };
    tagCoverage: number;
    linkDensity: number;
  };

  narrative: string;
}

export interface DreamOptions {
  daysBack?: number;
  autoDecay?: boolean;
  autoArchive?: boolean;
  /** Auto-apply high-confidence consolidation groups (≥5 notes, ≥3 shared tags). Default: true. */
  autoConsolidate?: boolean;
  /** If true, return the plan without performing any vault mutations. Default: false. */
  dryRun?: boolean;
  /** Run the LLM synthesis pass (requires reranker config). Default: true when reranker configured. */
  runLlm?: boolean;
  maxThemes?: number;
  maxOrphans?: number;
  maxConnections?: number;
  maxConsolidations?: number;
  /**
   * AGENT-B scope expansion — controls which collections the temperature
   * lifecycle (theme detection + orphan detection) covers.
   *   'memories' (default, backwards-compatible) — only the Memories/ tree
   *   'vault'                                    — every collection
   * Decay and auto-archive already operate on the whole vault (any note
   * that carries a heat_score), so they ignore this flag.
   */
  scope?: 'memories' | 'vault';

  /**
   * Reconcile clusters of related cold notes into project notes (fold each
   * source's body into Projects/<slug>.md, then delete the originals). Runs
   * alongside the existing tag-consolidation path. Default: true.
   */
  reconcileProjects?: boolean;
  /** Restrict reconciliation to cold notes only (default true; false also pulls warm). */
  reconcileColdOnly?: boolean;
  /** Minimum cluster size before a project is created/updated (default 2). */
  reconcileMinClusterSize?: number;

  /**
   * Overall wall-clock budget for the cycle (ms). Once exceeded, the remaining
   * expensive optional passes are skipped and report.budgetExceeded is set.
   * Backstop only — individual passes are independently capped. Default 120s.
   */
  budgetMs?: number;
}

/** Default overall dream-cycle time budget (see DreamOptions.budgetMs). */
const DREAM_DEFAULT_BUDGET_MS = 120_000;

/**
 * Shared helper for dream-engine scoping. Returns true if a note's collection
 * should be considered under the given scope. Keeping this as a tiny function
 * avoids duplicating the check and makes the merge with Agent A's
 * tag-exclusion changes easier (those hunks live in the same functions).
 */
function collectionInScope(collection: string, scope: 'memories' | 'vault'): boolean {
  if (scope === 'vault') return true;
  return collection === 'memories';
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Compute days between a date string and now. Returns Infinity if unparseable. */
function daysSince(dateStr: string | undefined): number {
  if (!dateStr) return Infinity;
  const ts = new Date(dateStr).getTime();
  if (isNaN(ts)) return Infinity;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

/** Pick the dominant temperature from a list of temperature strings. */
function dominantTemperature(temps: string[]): 'hot' | 'warm' | 'cold' {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const t of temps) {
    if (t === 'hot') hot++;
    else if (t === 'warm') warm++;
    else cold++;
  }
  if (hot >= warm && hot >= cold) return 'hot';
  if (warm >= cold) return 'warm';
  return 'cold';
}

// ── 1. analyzeActivity ─────────────────────────────────────────────────

export function analyzeActivity(daysBack: number): DreamReport['activity'] {
  const dm = getDocMeta();
  let totalNotes = 0;
  let hotCount = 0;
  let warmCount = 0;
  let coldCount = 0;
  let recentlyCreated = 0;
  let recentlyAccessed = 0;

  for (const [, meta] of dm) {
    totalNotes++;

    switch (meta.temperature) {
      case 'hot':  hotCount++;  break;
      case 'warm': warmCount++; break;
      case 'cold': coldCount++; break;
      // notes without temperature are uncategorized — don't count
    }

    // "created" approximation: use the date field (creation / frontmatter date)
    if (meta.date && daysSince(meta.date) <= daysBack) {
      recentlyCreated++;
    }

    if (meta.last_accessed && daysSince(meta.last_accessed) <= daysBack) {
      recentlyAccessed++;
    }
  }

  return { totalNotes, hotCount, warmCount, coldCount, recentlyCreated, recentlyAccessed };
}

// ── 2. detectThemes ────────────────────────────────────────────────────

export function detectThemes(maxThemes: number, scope: 'memories' | 'vault' = 'memories'): DreamTheme[] {
  const dm = getDocMeta();

  // Collect hot/warm notes with tags (scope decides which collections qualify)
  const candidates: Array<{
    path: string;
    tags: string[];
    temperature: string;
  }> = [];

  for (const [path, meta] of dm) {
    if (!collectionInScope(meta.collection, scope)) continue;
    if (meta.temperature !== 'hot' && meta.temperature !== 'warm') continue;
    // Exclude self-observation tags (see SELF_OBSERVATION_TAGS above) so
    // the dream doesn't feed on its own exhaust.
    const usableTags = meta.tags.filter((t) => !SELF_OBSERVATION_TAGS.has(t));
    if (usableTags.length === 0) continue;
    candidates.push({ path, tags: usableTags, temperature: meta.temperature ?? '' });
  }

  if (candidates.length === 0) return [];

  // Build tag co-occurrence matrix
  const cooccurrence = new Map<string, number>();
  const tagFrequency = new Map<string, number>();

  for (const c of candidates) {
    for (const tag of c.tags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
    // Count pairs
    const sorted = [...c.tags].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  // Track which candidates have been assigned to a theme
  const assigned = new Set<string>();
  const themes: DreamTheme[] = [];

  // Greedily extract pair-based themes
  const sortedPairs = [...cooccurrence.entries()].sort((a, b) => b[1] - a[1]);

  for (const [pairKey, count] of sortedPairs) {
    if (themes.length >= maxThemes) break;
    if (count < 2) break; // need at least 2 co-occurrences to form a theme

    const [tagA, tagB] = pairKey.split('|||');
    // Collect unassigned candidates sharing both tags
    const matching = candidates.filter(
      (c) => !assigned.has(c.path) && c.tags.includes(tagA) && c.tags.includes(tagB),
    );
    if (matching.length < 2) continue;

    for (const m of matching) assigned.add(m.path);

    const temps = matching.map((m) => m.temperature);
    themes.push({
      name: `${tagA} + ${tagB}`,
      tags: [tagA, tagB],
      memoryPaths: matching.map((m) => m.path),
      temperature: dominantTemperature(temps),
      summary: `${matching.length} memories linked by ${tagA} and ${tagB}`,
    });
  }

  // Fill remaining slots with single-tag themes (5+ occurrences among hot/warm memories)
  if (themes.length < maxThemes) {
    const sortedTags = [...tagFrequency.entries()].sort((a, b) => b[1] - a[1]);

    for (const [tag, freq] of sortedTags) {
      if (themes.length >= maxThemes) break;
      if (freq < 5) break;

      // Skip tags already used as part of a pair-theme
      if (themes.some((t) => t.tags.includes(tag))) continue;

      const matching = candidates.filter(
        (c) => !assigned.has(c.path) && c.tags.includes(tag),
      );
      if (matching.length < 3) continue;

      for (const m of matching) assigned.add(m.path);

      const temps = matching.map((m) => m.temperature);
      themes.push({
        name: tag,
        tags: [tag],
        memoryPaths: matching.map((m) => m.path),
        temperature: dominantTemperature(temps),
        summary: `${matching.length} memories centered on ${tag}`,
      });
    }
  }

  return themes;
}

// ── 3. findOrphanMemories ──────────────────────────────────────────────

export function findOrphanMemories(scope: 'memories' | 'vault' = 'memories'): OrphanMemory[] {
  const dm = getDocMeta();
  const graphStats = getGraphStats();
  const orphans: OrphanMemory[] = [];

  // If graph is not built yet, we can still detect tag-less memories
  // but we cannot determine link-orphan status precisely.
  // We'll use a heuristic: check if content contains any [[wikilinks]]
  const wikilinkPattern = /\[\[[^\]]+\]\]/;

  for (const [path, meta] of dm) {
    // AGENT-B scope expansion — merge with AGENT-A tag exclusion if present
    if (!collectionInScope(meta.collection, scope)) continue;
    if (meta.archived) continue;

    const hasLinks = wikilinkPattern.test(meta.content);
    const hasTags = meta.tags.length > 0;

    // We consider a memory an orphan if it has no tags AND no wiki-links
    if (hasTags && hasLinks) continue;
    if (hasTags || hasLinks) {
      // Partially connected — only flag if also cold with low heat
      if (meta.temperature !== 'cold' || (meta.heat_score ?? 0) > 2) continue;
    }

    const dsa = daysSince(meta.last_accessed);
    const heatScore = meta.heat_score ?? 0;
    const temperature = meta.temperature ?? 'cold';

    let suggestedAction: OrphanMemory['suggestedAction'];
    if (temperature === 'hot') {
      suggestedAction = 'link';
    } else if (temperature === 'warm') {
      suggestedAction = 'review';
    } else if (temperature === 'cold' && meta.tags.length >= 2) {
      suggestedAction = 'consolidate';
    } else {
      // cold with low heat or no tags
      suggestedAction = heatScore <= 2 ? 'archive' : 'review';
    }

    orphans.push({
      path,
      title: meta.title,
      temperature,
      heat_score: heatScore,
      daysSinceAccess: dsa === Infinity ? -1 : Math.round(dsa),
      suggestedAction,
    });
  }

  // Sort: hot first (they need immediate attention), then by heat_score descending
  const tempOrder: Record<string, number> = { hot: 0, warm: 1, cold: 2 };
  orphans.sort((a, b) => {
    const ta = tempOrder[a.temperature] ?? 3;
    const tb = tempOrder[b.temperature] ?? 3;
    if (ta !== tb) return ta - tb;
    return b.heat_score - a.heat_score;
  });

  return orphans;
}

// ── 4. suggestConnections ──────────────────────────────────────────────

/**
 * Tags that appear on more than this many notes are skipped as pair anchors:
 * a tag shared by hundreds of notes (e.g. a project-wide tag) makes that
 * bucket O(n²) on its own and is not a meaningful "connection" signal anyway.
 * Pairs whose shared tags include a rarer tag are still found via that tag's
 * (smaller) bucket, so we only drop the all-generic-tag pairs.
 */
const SUGGEST_MAX_TAG_BUCKET = 80;

/** Overall safety budget on pair comparisons so this can never become an
 * event-loop-blocking O(N²) sweep on a large, densely-tagged vault. */
const SUGGEST_MAX_COMPARISONS = 1_000_000;

export function suggestConnections(limit: number): ConnectionSuggestion[] {
  const dm = getDocMeta();

  // Collect non-archived notes with 2+ tags
  const notes: Array<{ path: string; tags: Set<string>; collection: string; temperature: string }> = [];
  for (const [path, meta] of dm) {
    if (meta.archived) continue;
    if (meta.tags.length < 2) continue;
    notes.push({
      path,
      tags: new Set(meta.tags),
      collection: meta.collection,
      temperature: meta.temperature ?? '',
    });
  }

  // Build inverted index: tag -> list of note indices
  const tagIndex = new Map<string, number[]>();
  for (let i = 0; i < notes.length; i++) {
    for (const tag of notes[i].tags) {
      let list = tagIndex.get(tag);
      if (!list) {
        list = [];
        tagIndex.set(tag, list);
      }
      list.push(i);
    }
  }

  // For each pair sharing 2+ tags, compute confidence and collect suggestions
  const seen = new Set<string>();
  const suggestions: ConnectionSuggestion[] = [];

  // Iterate through tag pairs via the inverted index for efficiency
  let comparisons = 0;
  const tagEntries = [...tagIndex.entries()];
  outer:
  for (let ti = 0; ti < tagEntries.length; ti++) {
    const [, noteIndicesA] = tagEntries[ti];
    // Skip overly-common tags — their bucket alone is O(n²) and the pairs they
    // anchor are low-signal (and recoverable via rarer shared tags).
    if (noteIndicesA.length > SUGGEST_MAX_TAG_BUCKET) continue;
    for (const idxA of noteIndicesA) {
      for (const idxB of noteIndicesA) {
        if (idxB <= idxA) continue;
        if (++comparisons > SUGGEST_MAX_COMPARISONS) {
          logger.warn('suggestConnections hit comparison budget — returning partial set', {
            budget: SUGGEST_MAX_COMPARISONS,
          });
          break outer;
        }
        const pairKey = `${idxA}:${idxB}`;
        if (seen.has(pairKey)) continue;

        const noteA = notes[idxA];
        const noteB = notes[idxB];

        // Compute shared tags
        const sharedTags: string[] = [];
        for (const tag of noteA.tags) {
          if (noteB.tags.has(tag)) sharedTags.push(tag);
        }
        if (sharedTags.length < 2) continue;

        seen.add(pairKey);

        // Check if already linked (heuristic: one mentions the other in content)
        const metaA = dm.get(noteA.path);
        const metaB = dm.get(noteB.path);
        if (metaA && metaB) {
          const titleA = metaA.title;
          const titleB = metaB.title;
          // If either note already references the other via wikilink, skip
          if (metaA.content.includes(`[[${titleB}]]`) || metaB.content.includes(`[[${titleA}]]`)) {
            continue;
          }
        }

        // Confidence: base from shared tags, bonus for same collection and temperature
        let confidence = Math.min(sharedTags.length * 0.25, 0.8);
        if (noteA.collection === noteB.collection) confidence += 0.1;
        if (noteA.temperature && noteA.temperature === noteB.temperature) confidence += 0.05;
        confidence = Math.min(confidence, 1.0);
        // Round to 2 decimals
        confidence = Math.round(confidence * 100) / 100;

        suggestions.push({
          sourcePath: noteA.path,
          targetPath: noteB.path,
          reason: `Share ${sharedTags.length} tags: ${sharedTags.join(', ')}`,
          sharedTags,
          confidence,
        });
      }
    }
  }

  // Sort by confidence descending, then limit
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, limit);
}

// ── 5. runDreamCycle ───────────────────────────────────────────────────

export async function runDreamCycle(options: DreamOptions = {}): Promise<DreamReport> {
  const {
    daysBack = 7,
    autoDecay = true,
    autoArchive = true,        // P2.a: default changed from false → true
    autoConsolidate = true,    // P2.b: default on
    dryRun = false,            // P2.a: when true, no mutations are applied
    runLlm,                    // P2.c: undefined → auto-detect from config
    maxThemes = 5,
    maxOrphans = 20,
    maxConnections = 10,
    maxConsolidations = 5,
    scope = 'memories',
    reconcileProjects = true,
    reconcileColdOnly = true,
    reconcileMinClusterSize = 2,
    budgetMs = DREAM_DEFAULT_BUDGET_MS,
  } = options;

  const startTime = Date.now();
  const deadline = startTime + budgetMs;
  let budgetExceeded = false;
  // Returns true once past the budget; logs the skipped phase the first time.
  const overBudget = (phase: string): boolean => {
    if (Date.now() <= deadline) return false;
    if (!budgetExceeded) {
      logger.warn('Dream cycle over time budget — skipping remaining expensive passes', {
        budgetMs, firstSkipped: phase,
      });
    }
    budgetExceeded = true;
    return true;
  };
  logger.info('Dream cycle starting', {
    daysBack, autoDecay, autoArchive, autoConsolidate, dryRun, scope, budgetMs,
  });

  // 1. Activity analysis
  const activity = analyzeActivity(daysBack);

  // 2. Lifecycle maintenance — respect dryRun
  let decayed = 0;
  let archived: string[] = [];

  if (autoDecay && !dryRun) {
    try {
      const result = await decayMemories();
      decayed = result.decayed;
    } catch (err) {
      logger.warn('Dream cycle: decay failed', { error: String(err) });
    }
  }

  if (autoArchive && !dryRun) {
    try {
      const result = await autoArchiveColdMemories();
      archived = result.archived;
    } catch (err) {
      logger.warn('Dream cycle: auto-archive failed', { error: String(err) });
    }
  }

  // 3. Theme detection
  let themes: DreamTheme[] = [];
  try {
    themes = detectThemes(maxThemes, scope);
  } catch (err) {
    logger.warn('Dream cycle: theme detection failed', { error: String(err) });
  }

  // 4. Orphan detection
  let orphans: OrphanMemory[] = [];
  try {
    orphans = findOrphanMemories(scope).slice(0, maxOrphans);
  } catch (err) {
    logger.warn('Dream cycle: orphan detection failed', { error: String(err) });
  }

  // 5. Connection suggestions
  let connectionSuggestions: ConnectionSuggestion[] = [];
  if (!overBudget('connections')) {
    try {
      connectionSuggestions = suggestConnections(maxConnections);
    } catch (err) {
      logger.warn('Dream cycle: connection suggestions failed', { error: String(err) });
    }
  }

  // 6. Consolidation candidates + optional auto-apply
  let consolidationGroups: ConsolidationGroup[] = [];
  const autoConsolidations: DreamReport['autoConsolidations'] = [];
  if (!overBudget('consolidation')) {
   try {
    const raw = await findConsolidationCandidates();
    const dm = getDocMeta();
    consolidationGroups = raw.slice(0, maxConsolidations).map((group) => {
      // Compute avg heat score for the group
      let totalHeat = 0;
      let count = 0;
      for (const p of group.paths) {
        const meta = dm.get(p);
        if (meta && meta.heat_score !== undefined) {
          totalHeat += meta.heat_score;
          count++;
        }
      }
      const autoApplyEligible =
        group.paths.length >= AUTO_CONSOLIDATE_MIN_GROUP_SIZE &&
        group.commonTags.length >= AUTO_CONSOLIDATE_MIN_SHARED_TAGS;
      return {
        paths: group.paths,
        commonTags: group.commonTags,
        suggestedTitle: group.suggestedTitle,
        avgHeatScore: count > 0 ? Math.round((totalHeat / count) * 100) / 100 : 0,
        autoApplyEligible,
        autoApplied: false,
      };
    });

    // Auto-apply the eligible groups when requested and not dryRun
    if (autoConsolidate && !dryRun) {
      for (const group of consolidationGroups) {
        if (!group.autoApplyEligible) continue;
        try {
          const result = await applyAutoConsolidation({
            paths: group.paths,
            commonTags: group.commonTags,
            suggestedTitle: group.suggestedTitle,
          });
          if (result.consolidatedPath) {
            group.autoApplied = true;
            group.consolidatedPath = result.consolidatedPath;
            group.deletedOriginals = result.deleted;
            autoConsolidations.push({
              consolidatedPath: result.consolidatedPath,
              sourcePaths: group.paths,
              deleted: result.deleted,
              errors: result.errors,
            });
          }
        } catch (err) {
          logger.warn('Dream cycle: auto-consolidation failed', {
            group: group.suggestedTitle,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
   } catch (err) {
     logger.warn('Dream cycle: consolidation detection failed', { error: String(err) });
   }
  }

  // 6.6. Project reconciliation — cluster related cold notes by shared
  // entity/tag overlap and LINK them into a project note (never delete).
  // Additive to the destructive tag-consolidation above. Respects dryRun.
  let projectReconciliations: ProjectReconciliation[] = [];
  if (reconcileProjects && !overBudget('reconciliation')) {
    try {
      const clusters = clusterColdNotes({
        includeWarm: !reconcileColdOnly,
        minClusterSize: reconcileMinClusterSize,
      });
      for (const cluster of clusters) {
        try {
          const result = await reconcileClusterIntoProject(cluster, dryRun);
          if (result) projectReconciliations.push(result);
        } catch (err) {
          logger.warn('Dream cycle: project reconciliation failed', {
            cluster: cluster.suggestedTitle,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('Dream cycle: cold-note clustering failed', { error: String(err) });
    }
  }

  // 6.5. ROI demotion + auto-promotion (token-savior parity)
  let roiDemotions: ROIDemotionCandidate[] = [];
  if (!overBudget('roi-demotion')) {
    try {
      roiDemotions = (await findROIDemotionCandidates({ minDaysSinceAccess: 30 })).slice(0, 50);
    } catch (err) {
      logger.warn('Dream cycle: ROI demotion scan failed', { error: String(err) });
    }
  }

  let promotions: Array<PromotionCandidate & { applied: boolean }> = [];
  if (!overBudget('promotion')) {
    try {
      const candidates = await findAutoPromoteCandidates();
      for (const c of candidates) {
        let applied = false;
        if (!dryRun) {
          applied = await applyPromotion(c);
        }
        promotions.push({ ...c, applied });
      }
    } catch (err) {
      logger.warn('Dream cycle: auto-promotion failed', { error: String(err) });
    }
  }

  // 7. Health metrics
  const health = computeHealth();

  // 8. LLM block — always present, even when skipped
  const llm = await runLlmSynthesis({
    runLlm,
    dryRun,
    themes,
    orphans,
    connectionSuggestions,
    consolidationGroups,
    activity,
    health,
    lifecycle: { decayed, archived },
  });

  // 9. Build report
  const durationMs = Date.now() - startTime;
  const report: DreamReport = {
    timestamp: new Date().toISOString(),
    durationMs,
    activity,
    lifecycle: { decayed, archived },
    themes,
    orphans,
    connectionSuggestions,
    consolidationGroups,
    autoConsolidations,
    roiDemotions,
    promotions,
    projectReconciliations,
    llm,
    dryRun,
    budgetExceeded,
    health,
    narrative: '', // filled below
  };

  report.narrative = generateNarrative(report);

  logger.info('Dream cycle complete', {
    durationMs,
    themes: themes.length,
    orphans: orphans.length,
    autoConsolidated: autoConsolidations.length,
    llmRan: llm.ran,
    dryRun,
  });
  return report;
}

// ── LLM synthesis ──────────────────────────────────────────────────────

/**
 * Run a single LLM synthesis pass over the dream report. Uses the reranker
 * config (same endpoint / model / key as semantic reranking). Always returns
 * a populated DreamLlmBlock so callers see a uniform shape; when the LLM is
 * skipped, skipReason carries a concrete value like 'llm-disconnected',
 * 'rate-limited', 'no-content', 'disabled-by-caller', 'dry-run'.
 */
async function runLlmSynthesis(input: {
  runLlm?: boolean;
  dryRun: boolean;
  themes: DreamTheme[];
  orphans: OrphanMemory[];
  connectionSuggestions: ConnectionSuggestion[];
  consolidationGroups: ConsolidationGroup[];
  activity: DreamReport['activity'];
  health: DreamReport['health'];
  lifecycle: DreamReport['lifecycle'];
}): Promise<DreamLlmBlock> {
  const errors: string[] = [];

  // Caller explicitly disabled
  if (input.runLlm === false) {
    return { ran: false, skipReason: 'disabled-by-caller' };
  }

  // Config missing
  if (!config.enableReranker || !config.rerankerBaseUrl) {
    return {
      ran: false,
      skipReason: 'llm-disconnected',
      errors: ['reranker not configured (ENABLE_RERANKER/RERANKER_BASE_URL missing)'],
    };
  }

  // Check there's something worth summarizing
  const hasContent =
    input.themes.length > 0 ||
    input.orphans.length > 0 ||
    input.connectionSuggestions.length > 0 ||
    input.consolidationGroups.length > 0 ||
    input.activity.recentlyCreated > 0 ||
    input.activity.recentlyAccessed > 0;
  if (!hasContent) {
    return { ran: false, skipReason: 'no-content', model: config.rerankerModel };
  }

  const themeList = input.themes.length > 0
    ? input.themes.map((t) => `"${t.name}" (${t.memoryPaths.length} notes, ${t.temperature})`).join(', ')
    : 'no themes detected';

  const prompt = `You are a knowledge management assistant analyzing a personal knowledge vault.

Dream cycle results:
- ${input.activity.totalNotes} notes (${input.activity.hotCount} hot, ${input.activity.warmCount} warm, ${input.activity.coldCount} cold)
- ${input.activity.recentlyCreated} recently created, ${input.activity.recentlyAccessed} recently accessed
- Themes: ${themeList}
- ${input.orphans.length} orphan memories (disconnected, no links/tags)
- ${input.connectionSuggestions.length} suggested connections between unlinked notes
- ${input.consolidationGroups.length} consolidation groups (${input.consolidationGroups.filter((g) => g.autoApplied).length} auto-applied)
- Health: ${Math.round(input.health.tagCoverage * 100)}% tag coverage, ${input.health.linkDensity.toFixed(1)} avg links/note, ${Math.round(input.health.orphanRatio * 100)}% orphan ratio
- Decayed ${input.lifecycle.decayed} stale memories, archived ${input.lifecycle.archived.length}

Give a brief 3-4 sentence analysis: what patterns do you see, what should the user focus on, and one specific actionable suggestion to improve vault health.`;

  try {
    const res = await fetch(`${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.rerankerApiKey ? { Authorization: `Bearer ${config.rerankerApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.rerankerModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(config.rerankerTimeoutMs),
    });

    if (!res.ok) {
      let skipReason = 'llm-error';
      if (res.status === 429) skipReason = 'rate-limited';
      else if (res.status >= 500) skipReason = 'llm-server-error';
      else if (res.status === 401 || res.status === 403) skipReason = 'llm-unauthorized';
      errors.push(`HTTP ${res.status}`);
      return { ran: false, skipReason, model: config.rerankerModel, errors };
    }

    const data = await res.json() as any;
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) {
      return { ran: false, skipReason: 'no-content', model: config.rerankerModel };
    }
    return { ran: true, summary: text, model: config.rerankerModel };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    let skipReason = 'llm-error';
    if (err?.name === 'AbortError' || /timeout/i.test(msg)) skipReason = 'llm-timeout';
    else if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) skipReason = 'llm-disconnected';
    errors.push(msg);
    return { ran: false, skipReason, model: config.rerankerModel, errors };
  }
}

// ── Health metrics ─────────────────────────────────────────────────────

export function computeHealth(): DreamReport['health'] {
  const dm = getDocMeta();
  const graphStats = getGraphStats();

  let totalNotes = 0;
  let totalHeat = 0;
  let heatCount = 0;
  let hot = 0;
  let warm = 0;
  let cold = 0;
  let withTags = 0;

  for (const [, meta] of dm) {
    totalNotes++;
    if (meta.heat_score !== undefined) {
      totalHeat += meta.heat_score;
      heatCount++;
    }
    switch (meta.temperature) {
      case 'hot':  hot++;  break;
      case 'warm': warm++; break;
      case 'cold': cold++; break;
    }
    if (meta.tags.length > 0) withTags++;
  }

  const orphanCount = graphStats?.orphanNotes ?? 0;
  const avgLinksPerNote = graphStats?.avgLinksPerNote ?? 0;

  return {
    orphanRatio: totalNotes > 0 ? Math.round((orphanCount / totalNotes) * 1000) / 1000 : 0,
    avgHeatScore: heatCount > 0 ? Math.round((totalHeat / heatCount) * 100) / 100 : 0,
    temperatureDistribution: { hot, warm, cold },
    tagCoverage: totalNotes > 0 ? Math.round((withTags / totalNotes) * 1000) / 1000 : 0,
    linkDensity: Math.round(avgLinksPerNote * 100) / 100,
  };
}

// ── 6. generateNarrative ───────────────────────────────────────────────

function generateNarrative(report: DreamReport): string {
  const parts: string[] = [];

  parts.push(
    `Dream cycle completed in ${report.durationMs}ms.`,
  );

  parts.push(
    `Vault has ${report.activity.totalNotes} notes`
    + ` (${report.activity.hotCount} hot, ${report.activity.warmCount} warm, ${report.activity.coldCount} cold).`,
  );

  if (report.activity.recentlyCreated > 0 || report.activity.recentlyAccessed > 0) {
    parts.push(
      `Recently active: ${report.activity.recentlyCreated} created,`
      + ` ${report.activity.recentlyAccessed} accessed.`,
    );
  }

  if (report.lifecycle.decayed > 0) {
    parts.push(`Decayed ${report.lifecycle.decayed} stale memories.`);
  }

  if (report.lifecycle.archived.length > 0) {
    parts.push(`Archived ${report.lifecycle.archived.length} cold memories.`);
  }

  if (report.themes.length > 0) {
    const themeNames = report.themes.map((t) => t.name).join(', ');
    parts.push(`Found ${report.themes.length} active themes: ${themeNames}.`);
  } else {
    parts.push('No active themes detected.');
  }

  if (report.orphans.length > 0) {
    parts.push(`Identified ${report.orphans.length} orphan memories needing attention.`);
  }

  if (report.connectionSuggestions.length > 0) {
    parts.push(`${report.connectionSuggestions.length} potential connections discovered.`);
  }

  if (report.projectReconciliations.length > 0) {
    const created = report.projectReconciliations.filter((r) => r.created).length;
    const linked = report.projectReconciliations.reduce((n, r) => n + r.deleted.length, 0);
    parts.push(
      `Consolidated ${linked} cold ${linked === 1 ? 'memory' : 'memories'} into ` +
      `${report.projectReconciliations.length} project${report.projectReconciliations.length === 1 ? '' : 's'}` +
      `${created > 0 ? ` (${created} new)` : ''}.`,
    );
  }

  if (report.consolidationGroups.length > 0) {
    const autoApplied = report.consolidationGroups.filter((g) => g.autoApplied).length;
    if (autoApplied > 0) {
      parts.push(
        `${report.consolidationGroups.length} consolidation groups (${autoApplied} auto-applied, ${report.consolidationGroups.length - autoApplied} suggested).`,
      );
    } else {
      parts.push(
        `${report.consolidationGroups.length} consolidation groups ready for merging.`,
      );
    }
  }

  if (report.roiDemotions.length > 0) {
    parts.push(`${report.roiDemotions.length} memories flagged with negative ROI (review for demotion).`);
  }

  if (report.promotions.length > 0) {
    const applied = report.promotions.filter((p) => p.applied).length;
    parts.push(`${report.promotions.length} promotion candidates (${applied} applied) — frequently-recalled observations becoming canonical facts.`);
  }

  if (report.dryRun) {
    parts.push('(Dry run — no vault mutations applied.)');
  }

  if (report.budgetExceeded) {
    parts.push('(Time budget exceeded — some expensive passes were skipped this run.)');
  }

  if (report.llm.ran) {
    parts.push(`LLM synthesis: ${report.llm.summary?.slice(0, 160) ?? ''}`);
  } else if (report.llm.skipReason) {
    parts.push(`LLM skipped: ${report.llm.skipReason}.`);
  }

  // Health summary
  const h = report.health;
  parts.push(
    `Health: ${Math.round(h.tagCoverage * 100)}% tag coverage,`
    + ` ${h.linkDensity} avg links/note,`
    + ` ${Math.round(h.orphanRatio * 100)}% orphan ratio.`,
  );

  return parts.join(' ');
}
