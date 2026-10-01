/**
 * Shared hub-linking for the dream: project hubs (Projects/<slug>.md) carry a
 * MANAGED "## Related memories" block that the dream regenerates, so hubs stay
 * small and never accumulate duplicate or dangling links.
 *
 *   ## Related memories
 *   <any user text here is preserved>
 *   <!-- cortexmd:related-memories:start -->
 *   ### Decisions
 *   - [[Memories/decision/x|Title]] <!-- link:Memories/decision/x.md -->
 *   ...
 *   ### Older memories
 *   - [[Indexes/Projects/<slug>/2026-08|2026-08]] — 12 memories <!-- index:Indexes/Projects/<slug>/2026-08.md -->
 *   <!-- cortexmd:related-memories:end -->
 *
 * The full membership of a hub is the managed entries PLUS the entries of its
 * generated monthly overflow index notes, so a re-run re-derives the same
 * hub (idempotent) and a memory moved to an index is never re-added inline.
 * Legacy unmarked sections (the old project-reconcile list) are absorbed: its
 * bare link lines become entries, every other line is kept as user text.
 *
 * Used by the orphan triage (link a valuable orphan to its hub), by
 * project-reconcile (non-destructive cluster linking) and by the project
 * rebuild phase.
 */
import { readNote, writeNote, deleteNote, listFiles } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { getDocMeta, indexNote, removeFromIndex } from './search.js';
import { updateGraphForNote, invalidateGraphCache } from './graph.js';
import { extractWikilinks, replaceWikilinks } from './markdown.js';
import { buildLinkLookup, resolveWikilink, type LinkLookup } from './link-resolver.js';
import { projectSlug } from './journal.js';
import { config } from '../config.js';
import { logger } from './logger.js';

export const RELATED_HEADING = 'Related memories';
export const MANAGED_START = '<!-- cortexmd:related-memories:start -->';
export const MANAGED_END = '<!-- cortexmd:related-memories:end -->';
/** Frontmatter marker on generated overflow index notes (safe to rewrite/delete). */
export const GENERATED_INDEX_MARKER = 'dream-project-index';

const LINK_MARKER_RE = /<!-- link:(.+?) -->/;
const INDEX_MARKER_RE = /<!-- index:(.+?) -->/;
const FOLD_ARCHIVE_MARKER_RE = /<!-- fold-archive:(.+?) -->/;
const HEADING_RE = new RegExp(`^##\\s+${RELATED_HEADING}\\s*$`, 'i');
/** Section boundary: an h1/h2 (h3+ are the managed block's own group headings). */
const SECTION_BOUNDARY_RE = /^#{1,2}\s/;
/** A list item that is nothing but a wiki-link (+ optional marker/suffix). */
const BARE_LINK_LINE_RE = /^\s*[-*+]\s+\[\[[^\]]+\]\]\s*(?:—.*)?(?:<!--.*-->)?\s*$/;

export const PROJECTS_DIR = 'Projects';

export interface HubGroup { key: string; label: string; categories: string[] }

/** Display order of the managed block's groups. */
export const HUB_GROUPS: HubGroup[] = [
  { key: 'decisions', label: 'Decisions', categories: ['decision'] },
  { key: 'preferences', label: 'Preferences', categories: ['preference'] },
  { key: 'insights', label: 'Insights', categories: ['insight', 'fact', 'reflection'] },
  { key: 'plans', label: 'Plans', categories: ['plan', 'task'] },
  { key: 'observations', label: 'Recent observations', categories: [] },
];

function groupFor(category: string | undefined): HubGroup {
  const c = (category ?? '').toLowerCase();
  return HUB_GROUPS.find((g) => g.categories.includes(c)) ?? HUB_GROUPS[HUB_GROUPS.length - 1];
}

const IMPORTANCE_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1 };

/** True for a top-level project hub path: Projects/<name>.md. */
export function isProjectHubPath(p: string): boolean {
  return new RegExp(`^${PROJECTS_DIR}/[^/]+\\.md$`, 'i').test(p);
}

export function overflowIndexPath(hubPath: string, month: string): string {
  const slug = hubPath.replace(/\.md$/i, '').split('/').pop()!;
  return `Indexes/Projects/${projectSlug(slug) || 'project'}/${month}.md`;
}

function noExt(p: string): string {
  return p.replace(/\.md$/i, '');
}

function escapeAlias(title: string): string {
  return title.replace(/[\[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

function linkLine(path: string, title: string): string {
  return `- [[${noExt(path)}|${escapeAlias(title) || noExt(path).split('/').pop()}]] <!-- link:${path} -->`;
}

/** All note paths of the RW vault (the existence check for dangling links). */
export async function listVaultPaths(): Promise<Set<string>> {
  try {
    return new Set(await listFiles(config.brainVault));
  } catch {
    return new Set();
  }
}

/** Map project slug (from basename and from title) → hub path. */
export function listProjectHubs(files: Iterable<string>): Map<string, string> {
  const dm = getDocMeta();
  const hubs = new Map<string, string>();
  for (const p of [...files].sort()) {
    if (!isProjectHubPath(p)) continue;
    const base = projectSlug(noExt(p).split('/').pop()!);
    if (base && !hubs.has(base)) hubs.set(base, p);
  }
  for (const p of [...files].sort()) {
    if (!isProjectHubPath(p)) continue;
    const title = dm.get(p)?.title;
    const t = title ? projectSlug(title) : '';
    if (t && !hubs.has(t)) hubs.set(t, p);
  }
  return hubs;
}

// ── Section parsing ────────────────────────────────────────────────────

export interface ParsedHubBody {
  /** Body before the section heading. */
  before: string;
  /** User lines kept inside the section (outside the managed block). */
  preserved: string[];
  /** Body after the section (next h1/h2 onward). */
  after: string;
  /** Raw entry references found in the section (paths or wiki-link targets). */
  entryRefs: Array<{ ref: string; isPath: boolean; title?: string }>;
  indexPaths: string[];
  foldArchives: string[];
  hasSection: boolean;
}

export function parseHubBody(body: string): ParsedHubBody {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => HEADING_RE.test(l));
  const empty: ParsedHubBody = {
    before: body, preserved: [], after: '', entryRefs: [], indexPaths: [], foldArchives: [], hasSection: false,
  };
  if (start === -1) return empty;

  let end = lines.length;
  let inManaged = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === MANAGED_START) inManaged = true;
    else if (lines[i].trim() === MANAGED_END) inManaged = false;
    else if (!inManaged && SECTION_BOUNDARY_RE.test(lines[i])) { end = i; break; }
  }

  const out: ParsedHubBody = {
    before: lines.slice(0, start).join('\n'),
    preserved: [],
    after: lines.slice(end).join('\n'),
    entryRefs: [],
    indexPaths: [],
    foldArchives: [],
    hasSection: true,
  };

  inManaged = false;
  for (const line of lines.slice(start + 1, end)) {
    const t = line.trim();
    if (t === MANAGED_START) { inManaged = true; continue; }
    if (t === MANAGED_END) { inManaged = false; continue; }
    const idx = INDEX_MARKER_RE.exec(line);
    if (idx) { out.indexPaths.push(idx[1]); continue; }
    const fold = FOLD_ARCHIVE_MARKER_RE.exec(line);
    if (fold) { out.foldArchives.push(fold[1]); continue; }
    const marker = LINK_MARKER_RE.exec(line);
    if (marker) {
      const alias = /\[\[[^\]|]+\|([^\]]*)\]\]/.exec(line)?.[1];
      out.entryRefs.push({ ref: marker[1], isPath: true, title: alias });
      continue;
    }
    if (inManaged) continue; // our own group headings / blurb are regenerated
    if (BARE_LINK_LINE_RE.test(line)) {
      // Legacy list line: absorb the link as an entry
      for (const target of extractWikilinks(line)) out.entryRefs.push({ ref: target, isPath: false });
      continue;
    }
    out.preserved.push(line);
  }
  // Trim blank edges of the preserved user text
  while (out.preserved.length && !out.preserved[0].trim()) out.preserved.shift();
  while (out.preserved.length && !out.preserved[out.preserved.length - 1].trim()) out.preserved.pop();
  return out;
}

/** Entry refs found in a generated overflow index note. */
function parseIndexEntries(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = LINK_MARKER_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── Rendering ──────────────────────────────────────────────────────────

export interface HubEntry {
  path: string;
  title: string;
  category?: string;
  date?: string;
  importance?: string;
}

function entryFor(path: string, fallbackTitle?: string): HubEntry {
  const meta = getDocMeta().get(path);
  return {
    path,
    title: meta?.title || fallbackTitle || noExt(path).split('/').pop()!,
    category: meta?.category,
    date: meta?.date ? String(meta.date).slice(0, 10) : undefined,
    importance: meta?.importance,
  };
}

/** Most important first, then newest first, then path (stable). */
function rankEntries(entries: HubEntry[]): HubEntry[] {
  return [...entries].sort((a, b) =>
    (IMPORTANCE_RANK[b.importance ?? ''] ?? 0) - (IMPORTANCE_RANK[a.importance ?? ''] ?? 0)
    || (b.date ?? '').localeCompare(a.date ?? '')
    || a.path.localeCompare(b.path));
}

function monthOf(e: HubEntry): string {
  return /^\d{4}-\d{2}/.test(e.date ?? '') ? e.date!.slice(0, 7) : 'undated';
}

function renderManaged(
  listed: HubEntry[],
  total: number,
  overflow: Map<string, HubEntry[]>,
  hubPath: string,
  foldArchives: string[],
): string[] {
  const lines: string[] = [MANAGED_START];
  lines.push(total > listed.length
    ? `_Maintained by the dream: the ${listed.length} most relevant of ${total} related memories. Edit outside this block._`
    : `_Maintained by the dream (${total} related ${total === 1 ? 'memory' : 'memories'}). Edit outside this block._`);
  for (const g of HUB_GROUPS) {
    const items = listed.filter((e) => groupFor(e.category).key === g.key);
    if (items.length === 0) continue;
    lines.push('', `### ${g.label}`);
    for (const e of items) lines.push(linkLine(e.path, e.title));
  }
  if (overflow.size > 0) {
    lines.push('', '### Older memories');
    for (const month of [...overflow.keys()].sort().reverse()) {
      const idx = overflowIndexPath(hubPath, month);
      const n = overflow.get(month)!.length;
      lines.push(`- [[${noExt(idx)}|${month}]] — ${n} ${n === 1 ? 'memory' : 'memories'} <!-- index:${idx} -->`);
    }
  }
  if (foldArchives.length > 0) {
    lines.push('', '### Archived folded memories');
    for (const a of foldArchives) {
      lines.push(`- [[${noExt(a)}|${noExt(a).split('/').pop()}]] <!-- fold-archive:${a} -->`);
    }
  }
  lines.push(MANAGED_END);
  return lines;
}

function renderIndexNote(hubPath: string, hubTitle: string, month: string, entries: HubEntry[]): string {
  const data = { type: 'index', generated: GENERATED_INDEX_MARKER, hub: hubPath, month };
  const body = `# ${hubTitle} — ${month}\n\n` +
    `Older memories related to [[${noExt(hubPath)}|${escapeAlias(hubTitle)}]], kept here so the project note stays small.\n\n` +
    entries.map((e) => linkLine(e.path, e.title)).join('\n') + '\n';
  return stringifyFrontmatter(data, body);
}

// ── Sync ───────────────────────────────────────────────────────────────

export interface HubSyncOptions {
  /** Plan only; nothing is written. */
  dryRun?: boolean;
  /** Max entries listed inline (default config.dreamProjectMaxLinks). */
  maxLinks?: number;
  /** Existence set for dangling-link checks (default: list the vault). */
  files?: Set<string>;
  /** Initial note when the hub does not exist yet (else the hub must exist). */
  initial?: { data: Record<string, any>; body: string };
  /** Extra frontmatter/body transform applied before rendering (project rebuild). */
  transform?: (data: Record<string, any>, body: string) => Promise<{ data: Record<string, any>; body: string; foldArchives?: string[] }>;
}

export interface HubSyncResult {
  hubPath: string;
  /** Paths newly added this call. */
  added: string[];
  /** Entries dropped as dangling, archived or duplicate. */
  dropped: string[];
  /** Entries listed inline after the sync. */
  listed: number;
  /** Entries moved to monthly overflow index notes. */
  overflow: number;
  /** True when the hub (or one of its indexes) was (or, in dryRun, would be) written. */
  changed: boolean;
  created: boolean;
  foldArchives: string[];
}

function lookupFor(files: Set<string>): LinkLookup {
  return buildLinkLookup(files);
}

/**
 * Add `addPaths` to the hub's managed section and re-render it: dedupe, drop
 * dangling/archived entries, group by type, cap inline entries and move the
 * rest to monthly overflow index notes. Writes only when something changed.
 */
export async function syncHub(
  hubPath: string,
  addPaths: string[],
  opts: HubSyncOptions = {},
): Promise<HubSyncResult | null> {
  const maxLinks = Math.max(1, opts.maxLinks ?? config.dreamProjectMaxLinks);
  const files = opts.files ?? await listVaultPaths();
  const lookup = lookupFor(files);
  const dm = getDocMeta();

  let content: string | undefined;
  let etag: string | undefined;
  let created = false;
  try {
    ({ content, etag } = await readNote(hubPath));
  } catch (err: any) {
    if (err?.code !== 'ENOENT' || !opts.initial) return null;
  }
  let data: Record<string, any>;
  let body: string;
  if (content !== undefined) {
    ({ data, body } = parseFrontmatter(content));
  } else {
    data = { ...opts.initial!.data };
    body = opts.initial!.body;
    created = true;
  }

  let foldArchivesNew: string[] = [];
  if (opts.transform) {
    const t = await opts.transform(data, body);
    data = t.data;
    body = t.body;
    foldArchivesNew = t.foldArchives ?? [];
  }

  const parsed = parseHubBody(body);

  // Current membership: managed/legacy entries + overflow index entries
  const refs: Array<{ path?: string; raw: string; title?: string }> = [];
  for (const r of parsed.entryRefs) {
    const path = r.isPath ? (files.has(r.ref) ? r.ref : undefined) : resolveWikilink(r.ref, lookup, hubPath);
    refs.push({ path, raw: r.ref, title: r.title });
  }
  const oldIndexContents = new Map<string, string>();
  for (const idx of parsed.indexPaths) {
    try {
      const { content: ic } = await readNote(idx);
      oldIndexContents.set(idx, ic);
      for (const p of parseIndexEntries(ic)) refs.push({ path: files.has(p) ? p : undefined, raw: p });
    } catch {
      // Missing index: its entries are gone; re-derived from other signals.
    }
  }

  const existing = new Set<string>();
  const dropped: string[] = [];
  const entries: HubEntry[] = [];
  const accept = (path: string | undefined, raw: string, title?: string): boolean => {
    if (!path) { dropped.push(raw); return false; }
    if (path === hubPath || existing.has(path)) {
      if (existing.has(path)) dropped.push(raw);
      return false;
    }
    if (dm.get(path)?.archived === true) { dropped.push(raw); return false; }
    existing.add(path);
    entries.push(entryFor(path, title));
    return true;
  };
  for (const r of refs) accept(r.path, r.raw, r.title);
  const added: string[] = [];
  for (const p of addPaths) {
    if (existing.has(p) || p === hubPath) continue;
    if (!files.has(p)) continue;
    if (accept(p, p)) added.push(p);
  }

  // Cap: top-ranked inline, the rest into monthly indexes
  const ranked = rankEntries(entries);
  const listed = ranked.slice(0, maxLinks);
  const overflow = new Map<string, HubEntry[]>();
  for (const e of ranked.slice(maxLinks)) {
    const m = monthOf(e);
    if (!overflow.has(m)) overflow.set(m, []);
    overflow.get(m)!.push(e);
  }

  const foldArchives = [...new Set([...parsed.foldArchives, ...foldArchivesNew])].filter((a) => files.has(a) || foldArchivesNew.includes(a));
  if (entries.length === 0 && foldArchives.length === 0 && !parsed.hasSection && !created) {
    // Nothing to list and no section to maintain: leave the hub untouched.
    return { hubPath, added, dropped, listed: 0, overflow: 0, changed: false, created, foldArchives };
  }

  const hubTitle = typeof data.title === 'string' && data.title ? data.title : noExt(hubPath).split('/').pop()!;
  const sectionLines = [`## ${RELATED_HEADING}`];
  if (parsed.preserved.length > 0) sectionLines.push(...parsed.preserved, '');
  sectionLines.push(...renderManaged(listed, entries.length, overflow, hubPath, foldArchives));
  const beforeText = parsed.before.replace(/\s*$/, '');
  const afterText = parsed.after.trim() ? `\n\n${parsed.after.replace(/^\s*/, '')}` : '';
  const newBody = `${beforeText}${beforeText ? '\n\n' : ''}${sectionLines.join('\n')}${afterText.replace(/\s*$/, '')}\n`;

  // Prune frontmatter `related` of dangling links (keeps hubs from carrying
  // thousands of dead references).
  if (Array.isArray(data.related)) {
    const kept = data.related.filter((r: unknown) => {
      if (typeof r !== 'string') return false;
      const target = r.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
      return resolveWikilink(target, lookup, hubPath) !== undefined;
    });
    const uniq = [...new Set(kept)];
    if (uniq.length !== data.related.length) data.related = uniq;
  }

  // Overflow index notes (generated; never overwrite a user note at that path)
  const indexWrites = new Map<string, string>();
  for (const [month, list] of overflow) {
    const idx = overflowIndexPath(hubPath, month);
    const next = renderIndexNote(hubPath, hubTitle, month, list);
    let prev = oldIndexContents.get(idx);
    if (prev === undefined && files.has(idx)) {
      try { prev = (await readNote(idx)).content; } catch { /* ignore */ }
    }
    if (prev !== undefined && parseFrontmatter(prev).data.generated !== GENERATED_INDEX_MARKER) {
      logger.warn('syncHub: index path holds a user note; overflow kept inline', { idx });
      return null;
    }
    if (prev !== next) indexWrites.set(idx, next);
  }
  const staleIndexes = [...oldIndexContents.keys()].filter((idx) =>
    ![...overflow.keys()].some((m) => overflowIndexPath(hubPath, m) === idx)
    && parseFrontmatter(oldIndexContents.get(idx)!).data.generated === GENERATED_INDEX_MARKER);

  const newContent = stringifyFrontmatter(data, newBody);
  const changed = created || newContent !== content || indexWrites.size > 0 || staleIndexes.length > 0;
  const result: HubSyncResult = {
    hubPath, added, dropped, listed: listed.length,
    overflow: entries.length - listed.length, changed, created, foldArchives,
  };
  if (opts.dryRun || !changed) return result;

  for (const [idx, ic] of indexWrites) {
    await writeNote(idx, ic);
    await indexNote(idx);
  }
  if (newContent !== content || created) {
    await writeNote(hubPath, newContent, created ? undefined : etag);
    await indexNote(hubPath);
    updateGraphForNote(hubPath, newContent);
  }
  for (const idx of staleIndexes) {
    try {
      await deleteNote(idx);
      removeFromIndex(idx);
    } catch (err) {
      logger.warn('syncHub: stale index delete failed', { idx, error: String(err) });
    }
  }
  if (indexWrites.size > 0 || staleIndexes.length > 0) invalidateGraphCache();
  return result;
}

/**
 * Flatten wiki-links that resolve to nothing into their display text. Used on
 * dream-generated content (archived folds) only — user text is never touched.
 */
export function flattenDanglingLinks(content: string, files: Set<string>, fromPath: string): { content: string; flattened: number } {
  const lookup = lookupFor(files);
  let flattened = 0;
  const out = replaceWikilinks(content, (target, alias) => {
    if (resolveWikilink(target, lookup, fromPath) !== undefined) return undefined;
    flattened++;
    return alias?.trim() || target.split('#')[0].replace(/\.md$/i, '').split('/').pop()!;
  });
  return { content: out, flattened };
}
