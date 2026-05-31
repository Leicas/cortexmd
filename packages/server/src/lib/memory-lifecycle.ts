import { listFiles, readNote, writeNote, resolveSafePathForRead, deleteNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { getDocMeta, indexNote, removeFromIndex } from './search.js';
import { recordConsolidation } from './metrics.js';
import { logger } from './logger.js';
import { lstat } from 'node:fs/promises';

/**
 * Thresholds for auto-apply consolidation during the dream cycle.
 *   - groupSize:    minimum number of notes in a consolidation group before
 *                   we'll auto-apply (≥5).
 *   - sharedTags:   minimum number of shared tags (≥3).
 * Below these thresholds, consolidation stays as a suggestion for the user.
 */
export const AUTO_CONSOLIDATE_MIN_GROUP_SIZE = 5;
export const AUTO_CONSOLIDATE_MIN_SHARED_TAGS = 3;

// Category-specific decay rate multipliers.
// Multiplier scales the base decay amount: <1 means slower decay, >1 means faster.
// Calibrated so canonical knowledge (facts/preferences) effectively never decays,
// while ephemeral chatter (conversation/plan) cools off quickly.
const CATEGORY_DECAY_MULTIPLIER: Record<string, number> = {
  fact: 0.25,         // 4× slower
  preference: 0.25,   // 4× slower
  decision: 0.5,      // 2× slower
  insight: 1 / 1.5,   // 1.5× slower (~0.667)
  observation: 1.0,   // unchanged
  reflection: 1.0,    // unchanged
  plan: 1 / 0.7,      // ~1.43× — plans become stale quickly when not executed
  conversation: 2.0,  // 2× faster — chat exhaust cools fast
};

const DEFAULT_CATEGORY_DECAY_MULTIPLIER = 1.0;

// Importance-specific decay rate multipliers
const IMPORTANCE_DECAY_MULTIPLIER: Record<string, number> = {
  critical: 0.5,
  high: 0.75,
  medium: 1.0,
  low: 1.5,
};

const DEFAULT_IMPORTANCE_DECAY_MULTIPLIER = 1.0;

/**
 * Decay heat scores of memories that haven't been accessed recently.
 * - >7 days since last_accessed: subtract 1 (min 0)
 * - >30 days since last_accessed: subtract 2 (min 0)
 * The base decay amount is multiplied by category-specific and
 * importance-specific multipliers before being applied.
 * Recomputes temperature from the new score.
 *
 * Uses docMeta from the search index to pre-filter candidates,
 * avoiding reading every file from disk.
 */
export async function decayMemories(): Promise<{ decayed: number }> {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let decayed = 0;

  // Pre-filter using indexed metadata: only read files with heat_score > 0
  const dm = getDocMeta();
  const candidates: string[] = [];
  for (const [filePath, meta] of dm) {
    if (meta.heat_score !== undefined && meta.heat_score > 0) {
      // Quick pre-filter: if last_accessed is recent, skip without disk I/O
      if (meta.last_accessed && meta.last_accessed >= sevenDaysAgo) continue;
      candidates.push(filePath);
    }
  }

  for (const f of candidates) {
    try {
      const { content } = await readNote(f);
      const { data, body } = parseFrontmatter(content);

      const heatScore = typeof data.heat_score === 'number' ? data.heat_score : undefined;
      if (heatScore === undefined || heatScore <= 0) continue;

      let accessedDate: number;
      const lastAccessed = data.last_accessed || data.last_updated || data.updated;
      if (lastAccessed) {
        accessedDate = new Date(lastAccessed).getTime();
      } else {
        // Fall back to file modification time
        try {
          const resolved = await resolveSafePathForRead(f);
          const stats = await lstat(resolved);
          accessedDate = stats.mtimeMs;
        } catch {
          continue;
        }
      }
      if (isNaN(accessedDate)) continue;

      const daysSince = (now - accessedDate) / (1000 * 60 * 60 * 24);

      let baseDecay: number;
      if (daysSince > 30) {
        baseDecay = 2;
      } else if (daysSince > 7) {
        baseDecay = 1;
      } else {
        continue; // no decay needed
      }

      // Apply category-specific multiplier
      const noteCategory = typeof data.category === 'string' ? data.category : '';
      const categoryMult = CATEGORY_DECAY_MULTIPLIER[noteCategory] ?? DEFAULT_CATEGORY_DECAY_MULTIPLIER;

      // Apply importance-specific multiplier
      const noteImportance = typeof data.importance === 'string' ? data.importance : '';
      const importanceMult = IMPORTANCE_DECAY_MULTIPLIER[noteImportance] ?? DEFAULT_IMPORTANCE_DECAY_MULTIPLIER;

      const decayAmount = baseDecay * categoryMult * importanceMult;
      const newScore = Math.max(0, heatScore - decayAmount);

      if (newScore === heatScore) continue;

      const temperature: 'hot' | 'warm' | 'cold' =
        newScore >= 10 ? 'hot' : newScore >= 4 ? 'warm' : 'cold';

      data.heat_score = newScore;
      data.temperature = temperature;

      const updated = stringifyFrontmatter(data, body);
      await writeNote(f, updated);
      decayed++;
    } catch {
      // skip unreadable files
    }
  }

  return { decayed };
}

/**
 * Find groups of cold memories that share 2+ tags and could be consolidated.
 * Returns groups of 3+ notes as candidates.
 *
 * Uses docMeta from the search index to filter candidates without disk I/O.
 */
export async function findConsolidationCandidates(): Promise<
  Array<{ paths: string[]; commonTags: string[]; suggestedTitle: string }>
> {
  const coldNotes: Array<{ path: string; tags: string[] }> = [];

  // Use indexed metadata to filter candidates — no disk reads needed
  const dm = getDocMeta();
  for (const [filePath, meta] of dm) {
    if (meta.temperature !== 'cold') continue;
    if (meta.archived === true) continue;
    // Note: docMeta doesn't store 'status', so we skip that check here.
    // The consolidation logic in the tool already checks this on the actual file.
    if (meta.tags.length < 2) continue;

    coldNotes.push({ path: filePath, tags: meta.tags });
  }

  // Group by overlapping tags (notes sharing 2+ tags form a cluster)
  // Use a union-find approach: for each pair sharing 2+ tags, merge them
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Initialize all notes
  for (const note of coldNotes) {
    find(note.path);
  }

  // Merge notes that share 2+ tags
  for (let i = 0; i < coldNotes.length; i++) {
    for (let j = i + 1; j < coldNotes.length; j++) {
      const shared = coldNotes[i].tags.filter((t) => coldNotes[j].tags.includes(t));
      if (shared.length >= 2) {
        union(coldNotes[i].path, coldNotes[j].path);
      }
    }
  }

  // Collect clusters
  const clusters = new Map<string, string[]>();
  for (const note of coldNotes) {
    const root = find(note.path);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(note.path);
  }

  // Build results for clusters of 3+
  const results: Array<{ paths: string[]; commonTags: string[]; suggestedTitle: string }> = [];
  for (const [, paths] of clusters) {
    if (paths.length < 3) continue;

    // Find tags common to all notes in the cluster
    const notesInCluster = coldNotes.filter((n) => paths.includes(n.path));
    const tagSets = notesInCluster.map((n) => new Set(n.tags));

    // Find tags present in at least 2 notes
    const tagCounts = new Map<string, number>();
    for (const note of notesInCluster) {
      for (const tag of note.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const commonTags = [...tagCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([tag]) => tag)
      .sort();

    if (commonTags.length < 2) continue;

    results.push({
      paths,
      commonTags,
      suggestedTitle: commonTags.join(' + '),
    });
  }

  return results;
}

/**
 * Auto-apply a single high-confidence consolidation group: write a summary
 * note under Memories/consolidated/, then delete the originals. Returns
 * the consolidated path plus the list of deleted originals.
 *
 * Caller is expected to only call this for groups meeting the
 * AUTO_CONSOLIDATE_MIN_* thresholds — this helper does not re-check them.
 */
export async function applyAutoConsolidation(group: {
  paths: string[];
  commonTags: string[];
  suggestedTitle: string;
}): Promise<{ consolidatedPath: string; deleted: string[]; errors: string[] }> {
  const errors: string[] = [];
  const todayStr = new Date().toISOString().slice(0, 10);

  // Read all sources
  type Src = { path: string; title: string; data: Record<string, any>; body: string };
  const sources: Src[] = [];
  for (const p of group.paths) {
    try {
      const { content } = await readNote(p);
      const { data, body } = parseFrontmatter(content);
      const title = data.title || p.replace(/\.md$/, '').split('/').pop() || p;
      sources.push({ path: p, title, data, body });
    } catch (err) {
      errors.push(`read ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (sources.length === 0) {
    return { consolidatedPath: '', deleted: [], errors };
  }

  // Slug + target path under Memories/consolidated/
  const slug = group.suggestedTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'auto';
  const consolidatedPath = `Memories/consolidated/${todayStr}-${slug}.md`;

  // Merge tags / related / sources
  const allTags = new Set<string>(group.commonTags);
  allTags.add('consolidated-auto');
  const allRelated = new Set<string>();
  const allSources = new Set<string>();
  let maxImportance: string | number = 0;
  for (const src of sources) {
    if (Array.isArray(src.data.tags)) for (const t of src.data.tags) allTags.add(t);
    if (Array.isArray(src.data.related)) for (const r of src.data.related) allRelated.add(r);
    if (Array.isArray(src.data.sources)) for (const s of src.data.sources) allSources.add(s);
    if (typeof src.data.importance === 'number' && src.data.importance > (typeof maxImportance === 'number' ? maxImportance : 0)) {
      maxImportance = src.data.importance;
    }
  }

  const data: Record<string, any> = {
    title: group.suggestedTitle,
    category: 'insight',
    tags: [...allTags].sort(),
    consolidated_from: group.paths,
    auto_consolidated: true,
    importance: typeof maxImportance === 'number' && maxImportance > 0 ? maxImportance : 1,
    temperature: 'warm',
    heat_score: 6,
    created: todayStr,
    last_updated: todayStr,
    last_accessed: todayStr,
  };
  if (allRelated.size > 0) data.related = [...allRelated];
  if (allSources.size > 0) data.sources = [...allSources];

  // Body: summary + per-source digest (first ~200 chars of body)
  const digest = sources
    .map((s) => {
      const snippet = s.body.trim().slice(0, 200).replace(/\s+/g, ' ');
      return `- [[${s.path}]] — ${s.title}${snippet ? `\n  > ${snippet}${s.body.length > 200 ? '…' : ''}` : ''}`;
    })
    .join('\n');

  const body =
    `\n# ${group.suggestedTitle}\n\n` +
    `_Auto-consolidated on ${todayStr} from ${sources.length} notes sharing tags: ${group.commonTags.join(', ')}._\n\n` +
    `## Source Memories\n${digest}\n`;

  try {
    await writeNote(consolidatedPath, stringifyFrontmatter(data, body));
    await indexNote(consolidatedPath);
  } catch (err) {
    errors.push(`write ${consolidatedPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { consolidatedPath, deleted: [], errors };
  }

  // Delete originals only after the summary has been written successfully
  const deleted: string[] = [];
  for (const src of sources) {
    try {
      await deleteNote(src.path);
      removeFromIndex(src.path);
      deleted.push(src.path);
    } catch (err) {
      errors.push(`delete ${src.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  recordConsolidation(deleted.length);
  logger.info('Auto-consolidation applied', {
    consolidatedPath,
    deleted: deleted.length,
    errors: errors.length,
  });

  return { consolidatedPath, deleted, errors };
}

// ─────────────────────── ROI demotion + auto-promotion ───────────────────────
//
// Token-savior parity (Slice 8). Each memory is scored as
//
//   ROI = tokens_saved_per_hit × P(hit) × horizon × category_mult − tokens_stored
//   P(hit) = exp(−0.05 × days_since_access) × (1 + 0.1 × access_count)
//
// Negative ROI flags the memory for demotion (archival is gated by the same
// "unique content" check as autoArchiveColdMemories — we never delete unique
// memories silently). Positive ROI past a threshold + frequent recent access
// flags an `observation` for promotion to `fact` (timeless).

const ROI_TOKENS_SAVED_PER_HIT = 600;     // a recall replaces ~600 tokens of re-derivation
const ROI_HORIZON_DAYS = 90;              // amortize over a quarter
const ROI_CATEGORY_MULT: Record<string, number> = {
  fact: 2.0,
  preference: 1.8,
  decision: 1.5,
  insight: 1.2,
  observation: 1.0,
  reflection: 0.8,
  plan: 0.5,
  conversation: 0.3,
  reasoning: 1.3,
};

export function computeROI(data: Record<string, any>, body: string = ''): {
  roi: number;
  pHit: number;
  tokensStored: number;
  category: string;
} {
  const category = typeof data.category === 'string' ? data.category : 'observation';
  const accessCount = typeof data.access_count === 'number' ? data.access_count : 0;
  const tokensStored = Math.ceil(((body?.length ?? 0) || (typeof data.title === 'string' ? data.title.length : 0)) / 4) + 50; // body-bytes / 4 + frontmatter overhead

  let daysSinceAccess = 365;
  const lastAccessed = data.last_accessed || data.last_updated;
  if (typeof lastAccessed === 'string') {
    const t = new Date(lastAccessed).getTime();
    if (!Number.isNaN(t)) daysSinceAccess = Math.max(0, (Date.now() - t) / (1000 * 60 * 60 * 24));
  }

  const pHit = Math.exp(-0.05 * daysSinceAccess) * (1 + 0.1 * Math.min(accessCount, 50));
  const horizon = ROI_HORIZON_DAYS;
  const categoryMult = ROI_CATEGORY_MULT[category] ?? 1.0;
  const expectedSavings = ROI_TOKENS_SAVED_PER_HIT * pHit * (horizon / 30) * categoryMult;
  const roi = expectedSavings - tokensStored;

  return { roi: Math.round(roi * 100) / 100, pHit: Math.round(pHit * 1000) / 1000, tokensStored, category };
}

export interface ROIDemotionCandidate {
  path: string;
  roi: number;
  category: string;
  daysSinceAccess: number;
  accessCount: number;
}

/**
 * Walk indexed memories and flag those with negative ROI. Eligibility for
 * actual demotion (archival) is gated by the same uniqueness rule as
 * autoArchiveColdMemories — we never silently archive unique cold notes.
 */
export async function findROIDemotionCandidates(opts: {
  minDaysSinceAccess?: number;
} = {}): Promise<ROIDemotionCandidate[]> {
  const minDays = opts.minDaysSinceAccess ?? 30;
  const out: ROIDemotionCandidate[] = [];
  const dm = getDocMeta();

  for (const [filePath, meta] of dm) {
    if (meta.type !== 'memory') continue;
    if (meta.archived === true) continue;
    if (!meta.last_accessed) continue;
    // Quick pre-filter: skip recently-accessed
    const t = new Date(meta.last_accessed).getTime();
    if (Number.isNaN(t)) continue;
    const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
    if (days < minDays) continue;

    try {
      const { content } = await readNote(filePath);
      const { data, body } = parseFrontmatter(content);
      const r = computeROI(data, body);
      if (r.roi < 0) {
        out.push({
          path: filePath,
          roi: r.roi,
          category: r.category,
          daysSinceAccess: Math.round(days),
          accessCount: typeof data.access_count === 'number' ? data.access_count : 0,
        });
      }
    } catch { /* skip unreadable */ }
  }

  out.sort((a, b) => a.roi - b.roi); // most-negative first
  return out;
}

export interface PromotionCandidate {
  path: string;
  fromCategory: string;
  toCategory: string;
  accessCount: number;
  daysSinceCreated: number;
  reason: string;
}

const PROMOTE_MIN_ACCESS = 5;
const PROMOTE_WINDOW_DAYS = 30;

/**
 * Find observations that have been recalled ≥5 times in 30 days. Token-savior
 * promotes these to canonical facts (timeless category). Caller decides
 * whether to apply (this just flags; promotion is destructive-with-recovery).
 */
export async function findAutoPromoteCandidates(): Promise<PromotionCandidate[]> {
  const out: PromotionCandidate[] = [];
  const dm = getDocMeta();

  for (const [filePath, meta] of dm) {
    if (meta.type !== 'memory') continue;
    if (meta.archived === true) continue;
    if (meta.category !== 'observation') continue;
    if (!meta.last_accessed) continue;

    try {
      const { content } = await readNote(filePath);
      const { data } = parseFrontmatter(content);
      const accessCount = typeof data.access_count === 'number' ? data.access_count : 0;
      if (accessCount < PROMOTE_MIN_ACCESS) continue;

      const created = data.created || data.last_updated;
      if (!created) continue;
      const tCreated = new Date(created).getTime();
      if (Number.isNaN(tCreated)) continue;
      const daysSinceCreated = (Date.now() - tCreated) / (1000 * 60 * 60 * 24);

      // Only promote if the access is concentrated in the last 30 days
      // (heuristic: last_accessed within window, sufficient access_count)
      const lastAccessedT = new Date(meta.last_accessed).getTime();
      if (Number.isNaN(lastAccessedT)) continue;
      const daysSinceAccess = (Date.now() - lastAccessedT) / (1000 * 60 * 60 * 24);
      if (daysSinceAccess > PROMOTE_WINDOW_DAYS) continue;

      out.push({
        path: filePath,
        fromCategory: 'observation',
        toCategory: 'fact',
        accessCount,
        daysSinceCreated: Math.round(daysSinceCreated),
        reason: `Recalled ${accessCount}× — promoting to canonical fact`,
      });
    } catch { /* skip */ }
  }

  return out;
}

/**
 * Apply a single promotion: rewrite frontmatter category. Doesn't move the
 * file (timeless category is just a hint to the search ranker). Returns true
 * on success, false on any failure.
 */
export async function applyPromotion(p: PromotionCandidate): Promise<boolean> {
  try {
    const { content } = await readNote(p.path);
    const { data, body } = parseFrontmatter(content);
    if (data.category === p.toCategory) return true; // already done
    data.category = p.toCategory;
    data.promoted_at = new Date().toISOString().slice(0, 10);
    data.promoted_from = p.fromCategory;
    const updated = stringifyFrontmatter(data, body);
    await writeNote(p.path, updated);
    return true;
  } catch (err) {
    logger.warn('applyPromotion failed', {
      path: p.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Tags that identify templated, low-signal cron/auto-generated content
 * that is safe to auto-archive without unique content loss. Fold these
 * via memory_consolidate_series first to keep a rolling summary.
 */
export const TEMPLATED_ARCHIVE_SAFE_TAGS = new Set([
  'temperature-refresh',
  'email-recap',
  'cron-run',
  'auto-save',
  'hook',
  'dream-cycle',
]);

/**
 * Auto-archive cold memories.
 *
 * Archival policy: never archive a memory that may contain unique
 * information. Eligibility requires ONE of:
 *   (a) `consolidated_into` frontmatter pointing at a summary note
 *       (the content has already been folded somewhere)
 *   (b) any tag in TEMPLATED_ARCHIVE_SAFE_TAGS (templated cron/auto
 *       exhaust — structurally duplicative by nature)
 * Unique cold notes are left in place. They can be surfaced via
 * graph_orphans for manual review.
 */
export async function autoArchiveColdMemories(
  coldDaysThreshold = 90,
): Promise<{ archived: string[]; skippedUnique: number }> {
  const now = Date.now();
  const thresholdDate = new Date(now - coldDaysThreshold * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const archived: string[] = [];
  let skippedUnique = 0;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Pre-filter using indexed metadata
  const dm = getDocMeta();
  const candidates: string[] = [];
  for (const [filePath, meta] of dm) {
    if (meta.temperature !== 'cold') continue;
    if (meta.archived === true) continue;
    if (!meta.last_accessed) continue;
    if (meta.last_accessed > thresholdDate) continue;
    candidates.push(filePath);
  }

  for (const f of candidates) {
    try {
      const { content } = await readNote(f);
      const { data, body } = parseFrontmatter(content);

      if (data.temperature !== 'cold') continue;
      if (data.archived === true) continue;

      const lastAccessed = data.last_accessed || data.last_updated || data.updated;
      if (!lastAccessed) continue;

      const accessedDate = new Date(lastAccessed).getTime();
      if (isNaN(accessedDate)) continue;

      const daysSince = (now - accessedDate) / (1000 * 60 * 60 * 24);
      if (daysSince <= coldDaysThreshold) continue;

      // Archival eligibility gate — see function doc.
      const hasConsolidationTarget =
        typeof data.consolidated_into === 'string' && data.consolidated_into.length > 0;
      const noteTags: string[] = Array.isArray(data.tags) ? data.tags : [];
      const isTemplatedSafe = noteTags.some((t) => TEMPLATED_ARCHIVE_SAFE_TAGS.has(t));
      if (!hasConsolidationTarget && !isTemplatedSafe) {
        skippedUnique++;
        continue;
      }

      data.archived = true;
      data.archived_at = todayStr;

      const updated = stringifyFrontmatter(data, body);
      await writeNote(f, updated);
      archived.push(f);
    } catch {
      // skip
    }
  }

  if (skippedUnique > 0) {
    logger.info('Auto-archive skipped unique cold notes (no consolidated_into, not templated)', {
      skipped: skippedUnique,
      archived: archived.length,
    });
  }

  return { archived, skippedUnique };
}
