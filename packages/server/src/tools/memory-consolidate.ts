import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote, moveNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { appendJournalEntry } from '../lib/journal.js';
import { indexNote, removeFromIndex, getDocMeta } from '../lib/search.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { recordConsolidation } from '../lib/metrics.js';
import { isEmbeddingsReady, embedText } from '../lib/embeddings.js';
import { logger } from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

interface SourceNote {
  path: string;
  title: string;
  data: Record<string, any>;
  body: string;
}

/**
 * Read source notes for consolidation. Skips unreadable files.
 */
async function readSources(paths: string[]): Promise<SourceNote[]> {
  const out: SourceNote[] = [];
  for (const p of paths) {
    try {
      const { content } = await readNote(p);
      const { data, body } = parseFrontmatter(content);
      const title = data.title || p.replace(/\.md$/, '').split('/').pop() || p;
      out.push({ path: p, title, data, body });
    } catch (err) {
      logger.debug('memory_consolidate: skipping unreadable source', { path: p, error: String(err) });
    }
  }
  return out;
}

/**
 * Build a deterministic canonical body from source notes when no LLM-summary
 * is provided. Mirrors the existing applyAutoConsolidation digest pattern.
 */
function buildCanonicalBody(title: string, sources: SourceNote[], todayStr: string): string {
  const digest = sources
    .map((s) => {
      const snippet = s.body.trim().slice(0, 200).replace(/\s+/g, ' ');
      return `- [[${s.path}]] — ${s.title}${snippet ? `\n  > ${snippet}${s.body.length > 200 ? '…' : ''}` : ''}`;
    })
    .join('\n');
  return (
    `\n# ${title}\n\n` +
    `_Distilled on ${todayStr} from ${sources.length} near-duplicate memor${sources.length === 1 ? 'y' : 'ies'}._\n\n` +
    `## Source Memories\n${digest}\n`
  );
}

/**
 * Slugify a title for use in a path component.
 */
function slugifyTitle(t: string): string {
  return (
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'distilled'
  );
}

/**
 * Cluster memory paths by semantic similarity within the same category. Two
 * notes are clustered together when cosine(embed(a), embed(b)) ≥ threshold.
 * Uses simple greedy connected-components: each candidate is compared against
 * cluster representatives until a match is found or a new cluster opens.
 *
 * Returns clusters of size ≥ minClusterSize.
 */
async function clusterMemoriesByCategory(opts: {
  threshold: number;
  minClusterSize: number;
  maxCandidates?: number;
}): Promise<Array<{ category: string; paths: string[] }>> {
  if (!isEmbeddingsReady()) return [];

  const dm = getDocMeta();
  const byCategory = new Map<string, Array<{ path: string; text: string }>>();
  let count = 0;
  const max = opts.maxCandidates ?? 1000;
  for (const [p, meta] of dm) {
    if (count >= max) break;
    if (meta.type !== 'memory') continue;
    if (meta.archived === true) continue;
    const cat = meta.category;
    if (!cat) continue;
    const text = ((meta.title ?? '') + ' ' + (meta.content ?? '')).slice(0, 1024).trim();
    if (!text) continue;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({ path: p, text });
    count++;
  }

  const clusters: Array<{ category: string; paths: string[] }> = [];

  for (const [category, items] of byCategory) {
    if (items.length < opts.minClusterSize) continue;

    // Embed each item once, then greedy-cluster.
    const embeds: number[][] = [];
    for (const it of items) {
      try {
        embeds.push(await embedText(it.text));
      } catch {
        embeds.push([]);
      }
    }

    // Cosine helper inline (avoid cross-file circular dep)
    const cos = (a: number[], b: number[]): number => {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
    };

    const assigned = new Array(items.length).fill(-1);
    const repIdx: number[] = []; // representative item index per cluster

    for (let i = 0; i < items.length; i++) {
      if (embeds[i].length === 0) continue;
      let best = -1;
      let bestScore = 0;
      for (let r = 0; r < repIdx.length; r++) {
        const score = cos(embeds[i], embeds[repIdx[r]]);
        if (score >= opts.threshold && score > bestScore) {
          best = r;
          bestScore = score;
        }
      }
      if (best === -1) {
        repIdx.push(i);
        assigned[i] = repIdx.length - 1;
      } else {
        assigned[i] = best;
      }
    }

    const grouped = new Map<number, string[]>();
    for (let i = 0; i < items.length; i++) {
      const c = assigned[i];
      if (c < 0) continue;
      if (!grouped.has(c)) grouped.set(c, []);
      grouped.get(c)!.push(items[i].path);
    }

    for (const [, paths] of grouped) {
      if (paths.length >= opts.minClusterSize) {
        clusters.push({ category, paths });
      }
    }
  }

  return clusters;
}

/**
 * Process a single cluster: write a canonical fact, MOVE sources to
 * Memories/consolidated/sources/<original-path>. Returns the canonical path
 * and the list of moved source paths.
 *
 * In dry_run mode, computes paths + intent but performs no I/O.
 */
async function distillCluster(
  cluster: { category: string; paths: string[] },
  opts: {
    dryRun: boolean;
    summaryTitle?: string;
    summaryContent?: string;
    extraTags?: string[];
  },
): Promise<{
  canonical: string;
  sources: string[];
  moved: string[];
  errors: string[];
  skipped: boolean;
}> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  const sources = await readSources(cluster.paths);
  if (sources.length === 0) {
    return { canonical: '', sources: cluster.paths, moved: [], errors: ['no readable sources'], skipped: true };
  }

  // Pick canonical title: caller-supplied → first source's title.
  const title = opts.summaryTitle ?? sources[0].title;
  const slug = slugifyTitle(title);

  // Pick canonical category: spec says `fact` if cluster category is
  // `observation`, otherwise the cluster category. (Most common case is
  // observations getting promoted to facts.)
  const canonicalCategory = cluster.category === 'observation' ? 'fact' : cluster.category;

  // Timeless categories (fact, preference) stay flat; otherwise use year/month.
  const TIMELESS = new Set(['fact', 'preference']);
  const subdir = TIMELESS.has(canonicalCategory)
    ? ''
    : `${todayStr.slice(0, 4)}/${todayStr.slice(5, 7)}/`;
  const canonicalPath = `Memories/${canonicalCategory}/${subdir}${todayStr}-${slug}.md`;

  // Plan moves: each source moves under Memories/consolidated/sources/<original-path>.
  const moves: Array<{ src: string; dst: string }> = sources.map((s) => ({
    src: s.path,
    dst: `Memories/consolidated/sources/${s.path}`,
  }));

  if (opts.dryRun) {
    return {
      canonical: canonicalPath,
      sources: sources.map((s) => s.path),
      moved: moves.map((m) => m.dst),
      errors,
      skipped: false,
    };
  }

  // Merge tags / related from sources.
  const allTags = new Set<string>(opts.extraTags ?? []);
  allTags.add('consolidated');
  const allRelated = new Set<string>();
  let maxImportance: number = 0;
  for (const src of sources) {
    if (Array.isArray(src.data.tags)) for (const t of src.data.tags) allTags.add(t);
    if (Array.isArray(src.data.related)) for (const r of src.data.related) allRelated.add(r);
    if (typeof src.data.importance === 'number' && src.data.importance > maxImportance) {
      maxImportance = src.data.importance;
    }
  }

  const movedSourcePaths = moves.map((m) => m.dst);

  const frontmatter: Record<string, unknown> = {
    id: uuidv4(),
    type: 'memory',
    category: canonicalCategory,
    title,
    importance: maxImportance > 0 ? maxImportance : 'medium',
    temperature: 'warm',
    heat_score: 6,
    access_count: 1,
    last_accessed: todayStr,
    created: todayStr,
    last_updated: todayStr,
    tags: [...allTags].sort(),
    consolidated_from: movedSourcePaths,
    distilled: true,
  };
  if (allRelated.size > 0) frontmatter.related = [...allRelated];

  const body = opts.summaryContent
    ? `\n# ${title}\n\n${opts.summaryContent}\n\n## Source Memories\n${sources
        .map((s) => `- [[${movesByPath(s.path, moves)}]] — ${s.title}`)
        .join('\n')}\n`
    : buildCanonicalBody(title, sources, todayStr);

  const canonicalContent = stringifyFrontmatter(frontmatter, body);

  // Write canonical first; if this fails, abort without moving anything.
  try {
    await writeNote(canonicalPath, canonicalContent);
    await indexNote(canonicalPath);
  } catch (err) {
    errors.push(`write canonical ${canonicalPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { canonical: canonicalPath, sources: sources.map((s) => s.path), moved: [], errors, skipped: false };
  }

  // Move sources atomically (.tmp + rename inside vault.ts moveNote).
  const moved: string[] = [];
  for (const m of moves) {
    try {
      await moveNote(m.src, m.dst);
      removeFromIndex(m.src);
      await indexNote(m.dst);
      moved.push(m.dst);
    } catch (err) {
      errors.push(`move ${m.src} → ${m.dst}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  recordConsolidation(moved.length);

  return {
    canonical: canonicalPath,
    sources: sources.map((s) => s.path),
    moved,
    errors,
    skipped: false,
  };
}

function movesByPath(src: string, moves: Array<{ src: string; dst: string }>): string {
  const m = moves.find((x) => x.src === src);
  return m ? m.dst : src;
}

export function register(server: McpServer): void {
  server.tool(
    'memory_consolidate',
    "Distill near-duplicate memories into a single canonical fact, MOVING sources into Memories/consolidated/sources/. DESTRUCTIVE on default invocation: source memories are moved out of their original paths (recoverable from Memories/consolidated/sources/ but the originals will no longer be there). Two modes: (1) manual — pass sourcePaths/summaryTitle/summaryContent for an explicit cluster; (2) auto_distill=true — clusters all memories by semantic similarity (≥0.85 cosine) within category, distilling clusters of ≥3 members. Use dry_run=true to preview without writing.",
    {
      sourcePaths: z
        .array(z.string())
        .min(2)
        .optional()
        .describe('Manual mode: paths of memories to consolidate into one cluster.'),
      summaryTitle: z.string().optional().describe('Manual mode: title for the canonical memory.'),
      summaryContent: z.string().optional().describe('Manual mode: AI-generated summary body. If omitted, a deterministic digest is built from sources.'),
      tags: z.array(z.string()).optional().describe('Additional tags for the canonical memory.'),
      auto_distill: z
        .boolean()
        .optional()
        .default(false)
        .describe('Auto-cluster vault memories by semantic similarity within category and distill all clusters ≥ min_cluster_size.'),
      cluster_threshold: z
        .number()
        .min(0.5)
        .max(0.99)
        .optional()
        .default(0.85)
        .describe('Cosine-similarity threshold for cluster membership (auto_distill mode).'),
      min_cluster_size: z
        .number()
        .int()
        .min(2)
        .max(50)
        .optional()
        .default(3)
        .describe('Minimum cluster members before distillation (auto_distill mode).'),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe('Preview only — no canonical writes, no source moves. Returns what WOULD be distilled.'),
    },
    wrapToolHandler('memory_consolidate', async (params) => {
      const sourcePaths = (params.sourcePaths as string[] | undefined)?.map(sanitizePath);
      const summaryTitle = params.summaryTitle as string | undefined;
      const summaryContent = params.summaryContent as string | undefined;
      const extraTags = (params.tags as string[] | undefined) ?? [];
      const autoDistill = (params.auto_distill as boolean | undefined) ?? false;
      const threshold = (params.cluster_threshold as number | undefined) ?? 0.85;
      const minClusterSize = (params.min_cluster_size as number | undefined) ?? 3;
      const dryRun = (params.dry_run as boolean | undefined) ?? false;

      const distilled: Array<{ canonical: string; sources: string[]; moved: string[]; errors?: string[] }> = [];
      let totalClusters = 0;
      let totalSourcesMoved = 0;

      // Mode 1: manual single-cluster (legacy callers).
      if (sourcePaths && sourcePaths.length >= 2) {
        totalClusters = 1;
        const cluster = { category: 'observation', paths: sourcePaths };
        // Try to detect category from the first source's frontmatter.
        try {
          const { content } = await readNote(sourcePaths[0]);
          const { data } = parseFrontmatter(content);
          if (typeof data.category === 'string') cluster.category = data.category;
        } catch {
          // fall through with default
        }
        const result = await distillCluster(cluster, {
          dryRun,
          summaryTitle,
          summaryContent,
          extraTags,
        });
        distilled.push({
          canonical: result.canonical,
          sources: result.sources,
          moved: result.moved,
          errors: result.errors.length > 0 ? result.errors : undefined,
        });
        totalSourcesMoved += result.moved.length;
      }

      // Mode 2: auto-distill semantic clusters.
      if (autoDistill) {
        if (!isEmbeddingsReady()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  distilled: [],
                  totalClusters: 0,
                  totalSourcesMoved: 0,
                  warning: 'embeddings not ready — auto_distill skipped',
                }),
              },
            ],
          };
        }
        const clusters = await clusterMemoriesByCategory({
          threshold,
          minClusterSize,
        });
        totalClusters += clusters.length;
        for (const cluster of clusters) {
          const result = await distillCluster(cluster, {
            dryRun,
            extraTags,
          });
          if (result.skipped) continue;
          distilled.push({
            canonical: result.canonical,
            sources: result.sources,
            moved: result.moved,
            errors: result.errors.length > 0 ? result.errors : undefined,
          });
          totalSourcesMoved += result.moved.length;
        }
      }

      if (!dryRun && totalSourcesMoved > 0) {
        await appendJournalEntry(
          `Distilled ${totalClusters} cluster${totalClusters === 1 ? '' : 's'} → ${distilled.length} canonical memor${
            distilled.length === 1 ? 'y' : 'ies'
          }; moved ${totalSourcesMoved} source${totalSourcesMoved === 1 ? '' : 's'} to Memories/consolidated/sources/.`,
        );
      }

      const summary = dryRun
        ? `[DRY RUN] Would distill ${distilled.length}/${totalClusters} cluster(s); would move ${
            distilled.reduce((s, d) => s + d.sources.length, 0)
          } source(s) to Memories/consolidated/sources/.`
        : `Distilled ${distilled.length}/${totalClusters} cluster(s); moved ${totalSourcesMoved} source(s) to Memories/consolidated/sources/.`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(
              { distilled, totalClusters, totalSourcesMoved, dry_run: dryRun },
              null,
              2,
            )}`,
          },
        ],
      };
    }),
  );
}
