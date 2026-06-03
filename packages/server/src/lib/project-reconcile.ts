/**
 * Project reconciliation (Phase C) — the dream's "tidy cold memories into
 * projects" pass.
 *
 * Where findConsolidationCandidates clusters cold notes by SHARED TAGS only and
 * applyAutoConsolidation MERGES + DELETES them, this module clusters cold notes
 * by SHARED ENTITIES (+ tags) and reconciles each cluster into a project note
 * by LINKING — originals are never deleted. It is additive and runs alongside
 * the existing destructive tag-consolidation path.
 *
 * Clustering signal: two cold notes join the same cluster when they share ≥1
 * high-confidence entity (person/org/project) OR ≥2 tags. Entity overlap is the
 * key generalization — notes about the same thing that were tagged
 * inconsistently (or not at all) still cluster.
 */
import { getDocMeta, indexNote } from './search.js';
import { readNote, writeNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { detectEntities } from './entity-detector.js';
import { updateGraphForNote } from './graph.js';
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
   * the 0.7 auto-LINK gate on purpose: reconciliation is non-destructive and
   * produces a clearly-marked, opt-out project note, so a single solid
   * person/org mention is enough to group notes the tag-only path would miss).
   */
  minEntityConfidence?: number;
  /** Cap how many notes we scan bodies for (perf guard; default 1500). */
  maxScan?: number;
}

export interface ProjectReconciliation {
  projectPath: string;
  /** True when a new project note was created (vs an existing one updated). */
  created: boolean;
  /** Source notes linked into the project this run. */
  linkedPaths: string[];
  title: string;
  basis: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * Cluster cold (optionally warm) notes by shared entities / tags. Reads note
 * bodies from the in-memory index (DocMeta.content) — no extra disk I/O.
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

/**
 * Reconcile one cold cluster into a project note by LINKING (never deleting):
 * create/update Projects/<slug>.md (type:'project'), append a "## Related
 * memories" section of [[wikilinks]] + digests, and add a non-destructive
 * `reconciled_into` marker + project back-link to each source note. Idempotent:
 * already-linked sources are skipped. Returns null on hard failure or when
 * there is nothing new to link. Respects dryRun (computes, writes nothing).
 */
export async function reconcileClusterIntoProject(
  cluster: ColdCluster,
  dryRun = false,
): Promise<ProjectReconciliation | null> {
  const slug = slugify(cluster.suggestedTitle) || 'project';
  const projectPath = `Projects/${slug}.md`;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Read sources (skip ones already reconciled into THIS project).
  type Src = { path: string; title: string; data: Record<string, any>; body: string; snippet: string };
  const sources: Src[] = [];
  for (const p of cluster.paths) {
    try {
      const { content } = await readNote(p);
      const { data, body } = parseFrontmatter(content);
      if (data.reconciled_into === projectPath) continue; // already linked
      const title = data.title || p.replace(/\.md$/, '').split('/').pop() || p;
      sources.push({
        path: p, title, data, body,
        snippet: body.trim().replace(/^#.*$/m, '').trim().slice(0, 160).replace(/\s+/g, ' '),
      });
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

  // Append a "Related memories" section (dedup against links already present).
  const newLines = sources
    .filter((s) => !projBody.includes(`[[${s.path}]]`))
    .map((s) => `- [[${s.path}]] — ${s.title}${s.snippet ? `\n  > ${s.snippet}…` : ''}`);
  if (newLines.length === 0 && !created) return null;

  if (newLines.length > 0) {
    const header = '## Related memories';
    if (projBody.includes(header)) {
      projBody = projBody.replace(header, `${header}\n${newLines.join('\n')}`);
    } else {
      projBody = `${projBody.replace(/\s*$/, '')}\n\n${header}\n${newLines.join('\n')}\n`;
    }
  }

  if (dryRun) {
    return { projectPath, created, linkedPaths: sources.map((s) => s.path), title: cluster.suggestedTitle, basis: cluster.basis };
  }

  // Write the project note.
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

  // Link each source back to the project — non-destructively. We use
  // `reconciled_into` (NOT `consolidated_into`) on purpose: it records the tie
  // without making the note eligible for auto-archive.
  const linkedPaths: string[] = [];
  for (const s of sources) {
    try {
      s.data.reconciled_into = projectPath;
      const related = new Set<string>(Array.isArray(s.data.related) ? s.data.related : []);
      related.add(`[[${projectPath}]]`);
      s.data.related = [...related];
      let body = s.body;
      const backlink = `[[${projectPath}]]`;
      if (!body.includes(backlink)) {
        body = `${body.replace(/\s*$/, '')}\n\n## Project\nReconciled into ${backlink}.\n`;
      }
      const updated = stringifyFrontmatter(s.data, body);
      await writeNote(s.path, updated);
      await indexNote(s.path);
      updateGraphForNote(s.path, updated);
      linkedPaths.push(s.path);
    } catch (err) {
      logger.warn('reconcileClusterIntoProject: source link failed', {
        path: s.path, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Project reconciliation applied', { projectPath, created, linked: linkedPaths.length });
  return { projectPath, created, linkedPaths, title: cluster.suggestedTitle, basis: cluster.basis };
}
