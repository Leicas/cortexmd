/**
 * Dream phase: orphan triage. Every note with zero inbound wiki-links is
 * classified and handled conservatively (when unsure, skip):
 *
 *   EMPTY    — no body once frontmatter, headings, template boilerplate and
 *              whitespace are stripped, no record data in its frontmatter, not
 *              a record type → deleted via the shared delete path (inbound
 *              links rewritten, journaled).
 *   NOISE    — title matches a capture-filter pattern, low importance, little
 *              prose → archived in place with a reason (reversible).
 *   VALUABLE — everything else → linked from the best project hub's managed
 *              "## Related memories" section (frontmatter project, tags,
 *              outbound links, then title mention + similarity), or, for a
 *              memory with no hub, from a monthly per-type index note.
 *
 * Protected paths, notes younger than the min age and anything already
 * archived are never touched. Every action has its own switch and per-run cap,
 * and dryRun reports what would happen without writing.
 */
import { stat } from 'node:fs/promises';
import { readNote, resolveSafePathForRead } from './vault.js';
import { parseFrontmatter } from './frontmatter.js';
import { getDocMeta } from './search.js';
import { getInboundLinkCounts, buildAndCacheGraph } from './graph.js';
import { extractWikilinks } from './markdown.js';
import { buildLinkLookup, resolveWikilink } from './link-resolver.js';
import { matchCaptureNoise } from './capture-filter.js';
import { linkFromIndex } from './index-notes.js';
import { findSimilarNotes } from './similar-notes.js';
import { projectSlug } from './journal.js';
import { deleteNoteWithRelink, archiveNoteInPlace } from './note-actions.js';
import { syncHub, listProjectHubs, listVaultPaths, isProjectHubPath } from './hub-links.js';
import { config } from '../config.js';
import { logger } from './logger.js';

/** Paths the triage never touches (case-insensitive prefixes). */
export const BUILTIN_PROTECTED_PREFIXES: readonly string[] = [
  'Indexes/',
  'Templates/',
  'Perso/templates/',
  'Projects/',
  'Ops/Agent Diaries/',
  'Archive/',
  'Journal/',
  'Code/',
];

/** Frontmatter `type` values that are durable records, never deleted. */
export const RECORD_TYPES: ReadonlySet<string> = new Set([
  'person', 'people', 'contact', 'org', 'organization', 'organisation', 'company',
  'project', 'entity', 'task', 'index',
]);

/**
 * Frontmatter keys the system writes on every note. Any OTHER key with a
 * non-empty value is treated as record data (an email, a URL, aliases, a
 * related list …) and blocks deletion.
 */
const SYSTEM_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'title', 'category', 'tags', 'created', 'date', 'updated', 'modified',
  'last_updated', 'last_accessed', 'temperature', 'heat_score', 'importance',
  'access_count', 'source', 'agent', 'auto_linked', 'cssclass', 'cssclasses',
  'publish', 'template', 'validity_alpha', 'validity_beta', 'status',
]);

export function isProtectedPath(p: string, extra: readonly string[] = []): boolean {
  const lower = p.toLowerCase();
  for (const prefix of [...BUILTIN_PROTECTED_PREFIXES, ...extra]) {
    if (lower.startsWith(prefix.toLowerCase())) return true;
  }
  const segments = p.split('/');
  // Any templates folder, anywhere
  if (segments.slice(0, -1).some((s) => /^_?templates?$/i.test(s))) return true;
  // Index / hub notes ("Journal Index", "EmailLog Index")
  if (/\bindex$/i.test(segments[segments.length - 1].replace(/\.md$/i, ''))) return true;
  return false;
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.every(isEmptyValue);
  if (v instanceof Date) return false;
  if (typeof v === 'object') return Object.values(v as object).every(isEmptyValue);
  return false;
}

/** True when the frontmatter carries data beyond what the system writes itself. */
export function hasRecordData(data: Record<string, any>): boolean {
  if (typeof data.type === 'string' && RECORD_TYPES.has(data.type.toLowerCase())) return true;
  for (const [k, v] of Object.entries(data)) {
    if (SYSTEM_KEYS.has(k)) continue;
    if (!isEmptyValue(v)) return true;
  }
  return false;
}

/**
 * True when `body` (frontmatter already stripped) holds nothing but headings,
 * template boilerplate and whitespace. Any link, embed, URL, list item with
 * text, sentence or table cell counts as content.
 */
export function isBoilerplateOnly(body: string): boolean {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')       // HTML comments
    .replace(/<%[\s\S]*?%>/g, '')           // Templater commands
    .replace(/\{\{[^{}]*\}\}/g, '');        // {{date}}-style placeholders
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/\[\[|\]\(|https?:\/\/|!\[/.test(t)) return false;           // any link/embed/URL is content
    if (/^#{1,6}(\s|$)/.test(t)) continue;                           // heading
    if (/^([-*+]|\d+[.)])(\s+\[[ xX]?\])?\s*$/.test(t)) continue;    // empty bullet / checkbox
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;                  // horizontal rule
    if (/^\|?[\s:|-]+\|?$/.test(t) && t.includes('-')) continue;    // table separator row
    if (/^>\s*$/.test(t)) continue;                                  // empty quote
    if (/^(\*\*|__)?[\p{L}\p{N} _/-]{1,40}(\*\*|__)?\s*:{1,2}\s*(\*\*|__)?\s*$/u.test(t)) continue; // "Label:" / "**Label:**" / "Field::" with no value
    return false;
  }
  return true;
}

/** Words of prose: fenced/inline code, headings, URLs and link syntax excluded. */
export function proseWordCount(body: string): number {
  const text = body
    .replace(/(^|\n)\s*(`{3,}|~{3,})[\s\S]*?(\n\s*\2|$)/g, '\n')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function toTime(v: unknown): number | undefined {
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.getTime();
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v).getTime();
    return isNaN(t) ? undefined : t;
  }
  return undefined;
}

async function noteTime(p: string, data: Record<string, any>, metaDate: unknown): Promise<number | undefined> {
  const t = toTime(data.created) ?? toTime(data.date) ?? toTime(metaDate);
  if (t !== undefined) return t;
  try {
    return (await stat(await resolveSafePathForRead(p))).mtimeMs;
  } catch {
    return undefined;
  }
}

function monthKey(t: number | undefined): string {
  return t === undefined ? 'undated' : new Date(t).toISOString().slice(0, 7);
}

// ── Options / report ───────────────────────────────────────────────────

export interface OrphanTriageOptions {
  dryRun?: boolean;
  deleteEmpty?: boolean;
  archiveNoise?: boolean;
  link?: boolean;
  minAgeDays?: number;
  maxDelete?: number;
  maxArchive?: number;
  maxLink?: number;
  maxScan?: number;
  noiseMaxWords?: number;
  protectedPrefixes?: string[];
  /** Use hybrid search to break ties between several mentioned hubs (default true). */
  similarity?: boolean;
  /** Clock override for tests. */
  now?: number;
}

export interface OrphanTriageReport {
  dryRun: boolean;
  /** Orphans found (zero inbound links) in the RW vault. */
  orphans: number;
  /** Orphans examined this run (≤ maxScan). */
  scanned: number;
  deleted_empty: string[];
  archived_noise: string[];
  linked: Array<{ path: string; hub: string; basis: string }>;
  /** Reason → count for orphans left alone. */
  skipped: Record<string, number>;
  errors: string[];
}

export type OrphanClass =
  | { kind: 'empty' }
  | { kind: 'noise'; pattern: string }
  | { kind: 'valuable' }
  | { kind: 'skip'; reason: string };

/**
 * Classify one orphan from its frontmatter/body. Pure (no I/O) so it is easy
 * to test; age and path protection are checked by the caller.
 */
export function classifyOrphan(
  p: string,
  data: Record<string, any>,
  body: string,
  opts: { noiseMaxWords?: number } = {},
): OrphanClass {
  const importance = typeof data.importance === 'string' ? data.importance.toLowerCase() : '';
  const recordish = hasRecordData(data)
    || importance === 'high' || importance === 'critical'
    || /(?:^|\/)\d*\s*CRM\//i.test(p) || /(?:^|\/)Entities\//i.test(p);
  if (isBoilerplateOnly(body)) {
    return recordish ? { kind: 'skip', reason: 'record-data' } : { kind: 'empty' };
  }
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title
    : p.replace(/\.md$/i, '').split('/').pop()!;
  const noise = matchCaptureNoise(title);
  if (noise && !recordish && importance !== 'medium'
    && !['fact', 'preference', 'decision', 'entity'].includes(String(data.category ?? ''))
    && proseWordCount(body) <= (opts.noiseMaxWords ?? config.dreamTriageNoiseMaxWords)) {
    return { kind: 'noise', pattern: noise.source };
  }
  return { kind: 'valuable' };
}

// ── Hub finding ────────────────────────────────────────────────────────

function cleanRef(v: string): string {
  return v.replace(/^\[\[|\]\]$/g, '').split('|')[0].replace(/\.md$/i, '').replace(/^Projects\//i, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface HubCandidate { title: string; path: string }

/**
 * Best project hub for a note, or undefined. Strong signals first
 * (frontmatter project, tags, outbound links to the hub); then a hub whose
 * title the note mentions as a whole word, using similarity search only to
 * pick between several mentioned hubs.
 */
export async function findHubForNote(
  p: string,
  data: Record<string, any>,
  body: string,
  hubs: Map<string, string>,
  files: Set<string>,
  useSimilarity = true,
): Promise<{ hub: string; basis: string } | undefined> {
  for (const v of [data.project, data.projects].flat()) {
    if (typeof v !== 'string') continue;
    const hub = hubs.get(projectSlug(cleanRef(v)));
    if (hub) return { hub, basis: 'frontmatter-project' };
  }
  const tags: string[] = (Array.isArray(data.tags) ? data.tags : []).map(String);
  for (const t of tags) {
    const slug = projectSlug(t.replace(/^#/, '').replace(/^projects?\//i, ''));
    if (slug.length < 3) continue;
    const hub = hubs.get(slug);
    if (hub) return { hub, basis: `tag:${t}` };
  }
  const lookup = buildLinkLookup(files);
  for (const target of extractWikilinks(body)) {
    const resolved = resolveWikilink(target, lookup, p);
    if (resolved && isProjectHubPath(resolved) && resolved !== p) return { hub: resolved, basis: 'outbound-link' };
  }

  const title = typeof data.title === 'string' ? data.title : '';
  const haystack = `${title}\n${body}`;
  const dm = getDocMeta();
  const mentioned = new Set<string>();
  for (const hub of new Set(hubs.values())) {
    const names = new Set([
      hub.replace(/\.md$/i, '').split('/').pop()!,
      dm.get(hub)?.title ?? '',
    ]);
    for (const name of names) {
      const n = name.trim();
      if (n.length < 4) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, 'iu');
      if (re.test(haystack)) { mentioned.add(hub); break; }
    }
  }
  if (mentioned.size === 1) return { hub: [...mentioned][0], basis: 'title-mention' };
  if (mentioned.size > 1 && useSimilarity) {
    const { similarNotes } = await findSimilarNotes(haystack, p, 10);
    const best = similarNotes.find((s) => mentioned.has(s.path));
    if (best) return { hub: best.path, basis: `similarity:${best.score}` };
  }
  return undefined;
}

// ── Phase runner ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export async function runOrphanTriage(options: OrphanTriageOptions = {}): Promise<OrphanTriageReport> {
  const {
    dryRun = false,
    deleteEmpty = config.dreamTriageDeleteEmpty,
    archiveNoise = config.dreamTriageArchiveNoise,
    link = config.dreamTriageLink,
    minAgeDays = config.dreamTriageMinAgeDays,
    maxDelete = config.dreamTriageMaxDelete,
    maxArchive = config.dreamTriageMaxArchive,
    maxLink = config.dreamTriageMaxLink,
    maxScan = config.dreamTriageMaxScan,
    noiseMaxWords = config.dreamTriageNoiseMaxWords,
    protectedPrefixes = config.dreamTriageProtectedPrefixes,
    similarity = true,
    now = Date.now(),
  } = options;

  const report: OrphanTriageReport = {
    dryRun, orphans: 0, scanned: 0,
    deleted_empty: [], archived_noise: [], linked: [], skipped: {}, errors: [],
  };
  const skip = (reason: string): void => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };

  let inbound = getInboundLinkCounts();
  if (!inbound) {
    await buildAndCacheGraph();
    inbound = getInboundLinkCounts();
  }
  if (!inbound) {
    report.errors.push('graph unavailable');
    return report;
  }

  const files = await listVaultPaths();
  const hubs = listProjectHubs(files);
  const dm = getDocMeta();
  const orphanPaths = [...files]
    .filter((p) => dm.has(p) && (inbound!.get(p) ?? 0) === 0)
    .sort();
  report.orphans = orphanPaths.length;

  const hubAdds = new Map<string, Array<{ path: string; basis: string }>>();
  let linkCount = 0;

  for (const p of orphanPaths) {
    if (report.scanned >= maxScan) { skip('scan-cap'); continue; }
    report.scanned++;
    const meta = dm.get(p)!;
    if (isProtectedPath(p, protectedPrefixes)) { skip('protected'); continue; }
    if (meta.archived === true) { skip('archived'); continue; }

    let data: Record<string, any>;
    let body: string;
    try {
      ({ data, body } = parseFrontmatter((await readNote(p)).content));
    } catch (err) {
      skip('unreadable');
      continue;
    }

    const t = await noteTime(p, data, meta.date);
    if (t === undefined) { skip('unknown-age'); continue; }
    if (now - t < minAgeDays * DAY_MS) { skip('too-young'); continue; }

    const cls = classifyOrphan(p, data, body, { noiseMaxWords });
    try {
      if (cls.kind === 'skip') { skip(cls.reason); continue; }

      if (cls.kind === 'empty') {
        if (!deleteEmpty) { skip('delete-disabled'); continue; }
        if (report.deleted_empty.length >= maxDelete) { skip('delete-cap'); continue; }
        if (!dryRun) await deleteNoteWithRelink(p, 'dream orphan triage: empty note (frontmatter/headings only)');
        report.deleted_empty.push(p);
        continue;
      }

      if (cls.kind === 'noise') {
        if (!archiveNoise) { skip('archive-disabled'); continue; }
        if (report.archived_noise.length >= maxArchive) { skip('archive-cap'); continue; }
        if (!dryRun) await archiveNoteInPlace(p, `dream orphan triage: capture noise (${cls.pattern})`);
        report.archived_noise.push(p);
        continue;
      }

      // Valuable
      if (!link) { skip('link-disabled'); continue; }
      if (linkCount >= maxLink) { skip('link-cap'); continue; }
      const found = await findHubForNote(p, data, body, hubs, files, similarity);
      if (found) {
        if (!hubAdds.has(found.hub)) hubAdds.set(found.hub, []);
        hubAdds.get(found.hub)!.push({ path: p, basis: found.basis });
        linkCount++;
        continue;
      }
      const category = typeof data.category === 'string' ? projectSlug(data.category) : '';
      if (meta.collection === 'memories' && category) {
        const month = monthKey(t);
        const label = category.charAt(0).toUpperCase() + category.slice(1);
        const index = { path: `Indexes/Memories/${label}/${month}.md`, title: `Memories — ${category} — ${month}` };
        if (!dryRun) {
          await linkFromIndex(index, p, [
            { path: `Indexes/Memories/${label}.md`, title: `Memories — ${category}` },
            { path: 'Indexes/Memories.md', title: 'Memories' },
          ]);
        }
        report.linked.push({ path: p, hub: index.path, basis: 'type-index' });
        linkCount++;
        continue;
      }
      skip('no-hub');
    } catch (err) {
      report.errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [hub, adds] of [...hubAdds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      const res = await syncHub(hub, adds.map((a) => a.path), { dryRun, files });
      const added = new Set(res?.added ?? []);
      for (const a of adds) {
        if (added.has(a.path)) report.linked.push({ path: a.path, hub, basis: a.basis });
        else skip('hub-unchanged');
      }
    } catch (err) {
      report.errors.push(`${hub}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info('Dream orphan triage', {
    dryRun, orphans: report.orphans, scanned: report.scanned,
    deleted: report.deleted_empty.length, archived: report.archived_noise.length,
    linked: report.linked.length, errors: report.errors.length,
  });
  return report;
}
