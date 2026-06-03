/**
 * Project reconciliation (Phase C) — the dream's "tidy cold memories into
 * projects" pass.
 *
 * Where findConsolidationCandidates clusters cold notes by SHARED TAGS only and
 * applyAutoConsolidation merges them into a generic Memories/consolidated/
 * "insight" note, this module clusters cold notes by SHARED ENTITIES (+ tags)
 * and consolidates each cluster into a PROJECT note (Projects/<slug>.md),
 * folding each source's full body in and then DELETING the originals — the
 * project note becomes their durable home. It runs alongside the existing
 * tag-consolidation path.
 *
 * Clustering signal: two cold notes join the same cluster when they share ≥1
 * high-confidence entity (person/org/project) OR ≥2 tags. Entity overlap is the
 * key generalization — notes about the same thing that were tagged
 * inconsistently (or not at all) still cluster.
 */
import { getDocMeta, indexNote, removeFromIndex } from './search.js';
import { readNote, writeNote, deleteNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { detectEntities } from './entity-detector.js';
import { updateGraphForNote } from './graph.js';
import { recordConsolidation } from './metrics.js';
import { logger } from './logger.js';

export interface ColdCluster {
  paths: string[];
  sharedTags: string[];
  /** Canonical entity names shared across the cluster (the tie). */
  sharedEntities: string[];
  /** 'entity:<name>' | 'tags:<a+b>' — what tied the cluster together. */
  basis: string;
  suggestedTitle: string;
}

export interface ReconcileOptions {
  /** Also consider warm notes, not just cold (default false). */
  includeWarm?: boolean;
  /** Minimum notes in a cluster before it reconciles (default 2). */
  minClusterSize?: number;
  /**
   * Entity-detection confidence gate for clustering (default 0.6 — lower than
   * the 0.7 auto-LINK gate on purpose: reconciliation produces a single durable
   * project note from the cluster, so a single solid person/org mention is
   * enough to group notes the tag-only path would miss).
   */
  minEntityConfidence?: number;
  /** Cap how many notes we scan bodies for (perf guard; default 1500). */
  maxScan?: number;
}

export interface ProjectReconciliation {
  projectPath: string;
  /** True when a new project note was created (vs an existing one updated). */
  created: boolean;
  /** Source notes folded into the project (and deleted, unless dryRun). */
  sourcePaths: string[];
  /** Originals actually deleted this run (empty in dryRun). */
  deleted: string[];
  title: string;
  basis: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * Cluster cold (optionally warm) notes by shared entities / tags. Reads note
 * bodies from the in-memory index (DocMeta.content) — no extra disk I/O.
 * Project notes themselves are excluded so the dream never consolidates its
 * own output.
 */
export function clusterColdNotes(opts: ReconcileOptions = {}): ColdCluster[] {
  const minSize = opts.minClusterSize ?? 2;
  const minConf = opts.minEntityConfidence ?? 0.6;
  const maxScan = opts.maxScan ?? 1500;

  type Cand = { path: string; tags: string[]; entities: Set<string> };
  const cands: Cand[] = [];
  const dm = getDocMeta();
  let scanned = 0;
  for (const [path, meta] of dm) {
    if (meta.archived === true) continue;
    // Never re-consolidate project notes (or anything under Projects/).
    if (meta.collection === 'projects' || meta.type === 'project' || /^Projects\//i.test(path)) continue;
    const temp = meta.temperature;
    const eligible = opts.includeWarm ? (temp === 'cold' || temp === 'warm') : temp === 'cold';
    if (!eligible) continue;
    if (scanned >= maxScan) break;
    scanned++;

    const entities = new Set<string>();
    try {
      for (const e of detectEntities(meta.content || '')) {
        if (e.confidence >= minConf) entities.add(e.name);
      }
    } catch {
      // Entity detection is best-effort.
    }
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    // A note with neither tags nor entities can't cluster — skip it.
    if (tags.length === 0 && entities.size === 0) continue;
    cands.push({ path, tags, entities });
  }

  // Union-find over candidates.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of cands) find(c.path);

  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i], b = cands[j];
      let sharedEnt = 0;
      for (const e of a.entities) { if (b.entities.has(e)) { sharedEnt++; break; } }
      const sharedTags = a.tags.filter((t) => b.tags.includes(t));
      if (sharedEnt >= 1 || sharedTags.length >= 2) union(a.path, b.path);
    }
  }

  // Collect clusters.
  const byRoot = new Map<string, Cand[]>();
  for (const c of cands) {
    const r = find(c.path);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(c);
  }

  const clusters: ColdCluster[] = [];
  for (const [, members] of byRoot) {
    if (members.length < minSize) continue;

    // Most common entity across the cluster (the tie); fall back to tags.
    const entCount = new Map<string, number>();
    const tagCount = new Map<string, number>();
    for (const m of members) {
      for (const e of m.entities) entCount.set(e, (entCount.get(e) ?? 0) + 1);
      for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
    const sharedEntities = [...entCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([e]) => e);
    const sharedTags = [...tagCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);

    let basis: string;
    let suggestedTitle: string;
    if (sharedEntities.length > 0) {
      basis = `entity:${sharedEntities[0]}`;
      suggestedTitle = sharedEntities[0];
    } else if (sharedTags.length > 0) {
      basis = `tags:${sharedTags.slice(0, 2).join('+')}`;
      suggestedTitle = sharedTags.slice(0, 2).join(' + ');
    } else {
      continue; // No durable tie — don't reconcile.
    }

    clusters.push({
      paths: members.map((m) => m.path),
      sharedTags,
      sharedEntities,
      basis,
      suggestedTitle,
    });
  }

  return clusters;
}

/** Strip a leading `# Title` line + surrounding blank lines from a note body. */
function stripLeadingTitle(body: string): string {
  return body.replace(/^\s*#\s+.*(?:\r?\n)+/, '').trim();
}

/**
 * Consolidate one cold cluster into a project note, then DELETE the originals.
 * Create/update Projects/<slug>.md (type:'project'), fold each source's FULL
 * body into a "## Consolidated memories" section (so deletion is lossless),
 * record `consolidated_from`, then remove the source notes from disk + index.
 * Returns null on hard failure or when there is nothing new to fold. Respects
 * dryRun (computes the plan, writes/deletes nothing).
 */
export async function reconcileClusterIntoProject(
  cluster: ColdCluster,
  dryRun = false,
): Promise<ProjectReconciliation | null> {
  const slug = slugify(cluster.suggestedTitle) || 'project';
  const projectPath = `Projects/${slug}.md`;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Read sources (skip the project note itself if a path collides).
  type Src = { path: string; title: string; data: Record<string, any>; body: string };
  const sources: Src[] = [];
  for (const p of cluster.paths) {
    if (p === projectPath) continue;
    try {
      const { content } = await readNote(p);
      const { data, body } = parseFrontmatter(content);
      const title = data.title || p.replace(/\.md$/, '').split('/').pop() || p;
      sources.push({ path: p, title, data, body });
    } catch {
      // Skip unreadable source.
    }
  }
  if (sources.length === 0) return null;

  // Load or initialize the project note.
  let projData: Record<string, any>;
  let projBody: string;
  let created: boolean;
  try {
    const { content } = await readNote(projectPath);
    const parsed = parseFrontmatter(content);
    projData = parsed.data;
    projBody = parsed.body;
    created = false;
  } catch {
    projData = {
      type: 'project',
      title: cluster.suggestedTitle,
      status: 'active',
      created: todayStr,
      auto_reconciled: true,
    };
    projBody = `# ${cluster.suggestedTitle}\n\n` +
      `_Project note auto-assembled by the dream from related cold memories._\n`;
    created = true;
  }

  // Merge metadata.
  projData.type = 'project';
  projData.last_updated = todayStr;
  const mergedTags = new Set<string>(Array.isArray(projData.tags) ? projData.tags : []);
  cluster.sharedTags.forEach((t) => mergedTags.add(t));
  mergedTags.add('reconciled');
  if (mergedTags.size > 0) projData.tags = [...mergedTags].sort();
  if (cluster.sharedEntities.length > 0) {
    const ent = new Set<string>(Array.isArray(projData.entities) ? projData.entities : []);
    cluster.sharedEntities.forEach((e) => ent.add(e));
    projData.entities = [...ent];
  }
  const consolidatedFrom = new Set<string>(Array.isArray(projData.consolidated_from) ? projData.consolidated_from : []);
  // Merge any related/sources frontmatter the originals carried.
  const mergedRelated = new Set<string>(Array.isArray(projData.related) ? projData.related : []);
  for (const s of sources) {
    consolidatedFrom.add(s.path);
    if (Array.isArray(s.data.related)) for (const r of s.data.related) mergedRelated.add(r);
  }
  projData.consolidated_from = [...consolidatedFrom];
  if (mergedRelated.size > 0) projData.related = [...mergedRelated];

  // Fold each source's FULL body in (lossless), under a dated subsection.
  // Skip sources already folded in (idempotent on the project body).
  const newEntries = sources.filter((s) => !projBody.includes(`<!-- src:${s.path} -->`));
  if (newEntries.length === 0 && !created) return null;

  if (newEntries.length > 0) {
    const blocks = newEntries.map((s) => {
      const content = stripLeadingTitle(s.body);
      return `<!-- src:${s.path} -->\n### ${s.title}\n_was ${s.path}_\n\n${content || '(no body)'}\n`;
    });
    const header = '## Consolidated memories';
    if (projBody.includes(header)) {
      projBody = projBody.replace(header, `${header}\n\n${blocks.join('\n')}`);
    } else {
      projBody = `${projBody.replace(/\s*$/, '')}\n\n${header}\n\n${blocks.join('\n')}`;
    }
  }

  if (dryRun) {
    return {
      projectPath, created,
      sourcePaths: sources.map((s) => s.path),
      deleted: [],
      title: cluster.suggestedTitle, basis: cluster.basis,
    };
  }

  // Write the project note BEFORE deleting any source.
  try {
    const projContent = stringifyFrontmatter(projData, projBody);
    await writeNote(projectPath, projContent);
    await indexNote(projectPath);
    updateGraphForNote(projectPath, projContent);
  } catch (err) {
    logger.warn('reconcileClusterIntoProject: project write failed', {
      projectPath, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Delete the originals only after the project note is safely written.
  const deleted: string[] = [];
  for (const s of newEntries) {
    try {
      await deleteNote(s.path);
      removeFromIndex(s.path);
      deleted.push(s.path);
    } catch (err) {
      logger.warn('reconcileClusterIntoProject: source delete failed', {
        path: s.path, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  recordConsolidation(deleted.length);
  logger.info('Project reconciliation applied', { projectPath, created, deleted: deleted.length });
  return {
    projectPath, created,
    sourcePaths: sources.map((s) => s.path),
    deleted,
    title: cluster.suggestedTitle, basis: cluster.basis,
  };
}
