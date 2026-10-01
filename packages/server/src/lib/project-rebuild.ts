/**
 * Dream phase: project reconstruction. Keeps every Projects/<slug>.md hub
 * small and current:
 *
 *  - the managed "## Related memories" block (lib/hub-links.ts) is rebuilt
 *    from the memories that name the project (frontmatter `project`, a tag
 *    equal to the slug or `project/<slug>`) plus everything already listed,
 *    grouped by type and capped; the rest go to monthly index notes;
 *  - duplicate, archived and dangling entries are dropped, and dangling
 *    `related:` frontmatter entries pruned;
 *  - a "## Consolidated memories" section (bodies folded in by the legacy
 *    destructive reconcile) keeps only its newest `foldCap` blocks; older
 *    blocks move, with dangling links flattened, to a dated archive note
 *    linked from the managed block.
 *
 * All user text outside the managed block is preserved verbatim. Writes only
 * when the rendered result differs, so re-runs are no-ops.
 */
import { readNote, writeNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { getDocMeta, indexNote } from './search.js';
import { projectSlug } from './journal.js';
import {
  syncHub,
  listProjectHubs,
  listVaultPaths,
  isProjectHubPath,
  flattenDanglingLinks,
} from './hub-links.js';
import { config } from '../config.js';
import { logger } from './logger.js';

export const FOLD_SECTION_HEADING = 'Consolidated memories';
const FOLD_HEADING_RE = new RegExp(`^##\\s+${FOLD_SECTION_HEADING}\\s*$`, 'i');
const FOLD_MARKER_RE = /^<!-- src:.+ -->\s*$/;
export const GENERATED_FOLD_ARCHIVE_MARKER = 'dream-fold-archive';

export interface FoldCapResult {
  body: string;
  /** Blocks moved out (oldest first as they appeared). */
  moved: string[];
}

/**
 * Split the folded section into blocks and keep the first `cap` (reconcile
 * inserts new blocks at the top, so these are the newest). Pure.
 */
export function capFoldedBlocks(body: string, cap: number): FoldCapResult {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => FOLD_HEADING_RE.test(l));
  if (start === -1) return { body, moved: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start + 1, end);
  const head: string[] = [];
  const blocks: string[][] = [];
  for (const line of section) {
    if (FOLD_MARKER_RE.test(line.trim())) blocks.push([line]);
    else if (blocks.length === 0) head.push(line);
    else blocks[blocks.length - 1].push(line);
  }
  if (blocks.length <= cap) return { body, moved: [] };
  const kept = blocks.slice(0, cap);
  const moved = blocks.slice(cap).map((b) => b.join('\n').trimEnd());
  const newSection = [...head, ...kept.flat()];
  const out = [...lines.slice(0, start + 1), ...newSection, ...lines.slice(end)];
  return { body: out.join('\n'), moved };
}

function foldArchivePath(hubPath: string, day: string): string {
  const slug = projectSlug(hubPath.replace(/\.md$/i, '').split('/').pop()!) || 'project';
  return `Projects/Archive/${slug}-folded-${day}.md`;
}

/**
 * Move folded blocks beyond `cap` to Projects/Archive/<slug>-folded-<day>.md
 * (appending when that note exists). The archive is written BEFORE the hub is
 * trimmed so the move is lossless. Returns the trimmed body + archive path.
 */
export async function moveFoldOverflow(
  hubPath: string,
  hubTitle: string,
  body: string,
  cap: number,
  files: Set<string>,
  dryRun: boolean,
  day = new Date().toISOString().slice(0, 10),
): Promise<{ body: string; archivePath?: string; moved: number }> {
  const { body: trimmed, moved } = capFoldedBlocks(body, cap);
  if (moved.length === 0) return { body, moved: 0 };
  const archivePath = foldArchivePath(hubPath, day);
  if (!dryRun) {
    let existing: string | undefined;
    try { existing = (await readNote(archivePath)).content; } catch { /* new */ }
    // A retry after a failed hub write must not append the same blocks twice
    const fresh = existing === undefined
      ? moved
      : moved.filter((b) => !existing!.includes(b.split('\n')[0].trim()));
    const { content: blocks } = flattenDanglingLinks(fresh.join('\n\n'), files, archivePath);
    let next: string;
    if (existing !== undefined && fresh.length === 0) {
      next = existing;
    } else if (existing !== undefined) {
      const { data, body: prev } = parseFrontmatter(existing);
      next = stringifyFrontmatter(data, `${prev.trimEnd()}\n\n${blocks}\n`);
    } else {
      next = stringifyFrontmatter(
        { type: 'archive', generated: GENERATED_FOLD_ARCHIVE_MARKER, hub: hubPath, created: day },
        `# ${hubTitle} — folded memories (archived ${day})\n\n` +
        `Moved out of [[${hubPath.replace(/\.md$/i, '')}|${hubTitle.replace(/[\[\]|]/g, ' ')}]] to keep the project note small.\n\n` +
        `${blocks}\n`,
      );
    }
    if (next !== existing) {
      await writeNote(archivePath, next);
      await indexNote(archivePath);
    }
    files.add(archivePath);
  }
  return { body: trimmed, archivePath, moved: moved.length };
}

// ── Phase runner ───────────────────────────────────────────────────────

export interface ProjectRebuildOptions {
  dryRun?: boolean;
  maxLinks?: number;
  maxRebuilds?: number;
  foldCap?: number;
}

export interface ProjectRebuildReport {
  dryRun: boolean;
  hubs: number;
  projects_rebuilt: Array<{
    path: string;
    listed: number;
    overflow: number;
    added: number;
    dropped: number;
    foldArchive?: string;
  }>;
  /** Hubs left unchanged or skipped (cap / error). */
  skipped: number;
  errors: string[];
}

/** hub path → memories that name the project (frontmatter project or tag). */
export function collectProjectMembers(hubs: Map<string, string>, files: Set<string>): Map<string, string[]> {
  const members = new Map<string, string[]>();
  const add = (hub: string, p: string): void => {
    if (!members.has(hub)) members.set(hub, []);
    const list = members.get(hub)!;
    if (!list.includes(p)) list.push(p);
  };
  for (const [p, meta] of getDocMeta()) {
    if (!files.has(p) || meta.archived === true) continue;
    if (/^(Projects|Indexes)\//i.test(p)) continue;
    if (meta.collection !== 'memories' && !meta.category) continue;
    for (const v of meta.project ?? []) {
      const slug = projectSlug(v.replace(/^\[\[|\]\]$/g, '').split('|')[0].replace(/\.md$/i, '').replace(/^Projects\//i, ''));
      const hub = hubs.get(slug);
      if (hub) add(hub, p);
    }
    for (const t of meta.tags) {
      const slug = projectSlug(t.replace(/^#/, '').replace(/^projects?\//i, ''));
      if (slug.length < 3) continue;
      const hub = hubs.get(slug);
      if (hub) add(hub, p);
    }
  }
  for (const list of members.values()) list.sort();
  return members;
}

export async function runProjectRebuild(options: ProjectRebuildOptions = {}): Promise<ProjectRebuildReport> {
  const {
    dryRun = false,
    maxLinks = config.dreamProjectMaxLinks,
    maxRebuilds = config.dreamProjectMaxRebuilds,
    foldCap = config.dreamProjectFoldCap,
  } = options;
  const report: ProjectRebuildReport = { dryRun, hubs: 0, projects_rebuilt: [], skipped: 0, errors: [] };

  const files = await listVaultPaths();
  const hubs = listProjectHubs(files);
  const hubPaths = [...new Set(hubs.values())].filter(isProjectHubPath).sort();
  report.hubs = hubPaths.length;
  const members = collectProjectMembers(hubs, files);

  for (const hub of hubPaths) {
    if (report.projects_rebuilt.length >= maxRebuilds) { report.skipped++; continue; }
    try {
      let foldArchive: string | undefined;
      const res = await syncHub(hub, members.get(hub) ?? [], {
        dryRun,
        files,
        maxLinks,
        transform: async (data, body) => {
          const title = typeof data.title === 'string' && data.title ? data.title : hub.replace(/\.md$/i, '').split('/').pop()!;
          const moved = await moveFoldOverflow(hub, title, body, foldCap, files, dryRun);
          foldArchive = moved.archivePath;
          return { data, body: moved.body, foldArchives: moved.archivePath ? [moved.archivePath] : [] };
        },
      });
      if (!res || !res.changed) { report.skipped++; continue; }
      report.projects_rebuilt.push({
        path: hub, listed: res.listed, overflow: res.overflow,
        added: res.added.length, dropped: res.dropped.length, foldArchive,
      });
    } catch (err) {
      report.skipped++;
      report.errors.push(`${hub}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info('Dream project rebuild', {
    dryRun, hubs: report.hubs, rebuilt: report.projects_rebuilt.length, errors: report.errors.length,
  });
  return report;
}
