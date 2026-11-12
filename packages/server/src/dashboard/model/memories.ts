/**
 * Memories tab model — inbox listing + detail + write actions.
 *
 * Listing reads the in-memory search index (`getDocMeta`) and only touches disk
 * for the (bounded) candidate set when a provenance filter (agent / machine /
 * project / source) needs frontmatter the index does not carry.
 *
 * Write actions reuse the same vault primitives, in the same order, as the
 * corresponding MCP tools — the tools keep their logic inline, so these are
 * thin mirrors (noted in the report):
 *   archive    ≙ notes_archive  (frontmatter archived/cold, journal, reindex)
 *   delete     ≙ notes_delete   (relink inbound links, delete, de-index, journal)
 *   update     ≙ notes_upsert   (etag-checked write, journal, reindex, graph)
 *   markNoise  = archive + `noise: true` + `noise` tag (reversible: it is an archive)
 */
import { readNote, writeNote, deleteNote } from '../../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../../lib/frontmatter.js';
import { getDocMeta, indexNote, removeFromIndex } from '../../lib/search.js';
import { updateGraphForNote, getNeighbors } from '../../lib/graph.js';
import { appendJournalEntry } from '../../lib/journal.js';
import { rewriteInboundLinks } from '../../lib/link-rewrite.js';
import { extractWikilinks } from '../../lib/markdown.js';
import { sanitizePath } from '../../lib/sanitize.js';
import { recordArchive } from '../../lib/metrics.js';

export interface MemoryFilters {
  q?: string;
  /** ISO day (inclusive). Default: last 24 h. */
  since?: string;
  until?: string;
  category?: string;
  temperature?: string;
  agent?: string;
  machine?: string;
  project?: string;
  source?: string;
  includeArchived?: boolean;
  /** Include every indexed note, not just `type: memory`. */
  allNotes?: boolean;
  limit?: number;
}

export interface MemoryListItem {
  path: string; title: string; date?: string; category?: string; temperature?: string;
  heat?: number; importance?: string; archived: boolean; lastAccessed?: string;
  collection: string; agent?: string; machine?: string; project?: string; source?: string;
  snippet: string;
}

const PROVENANCE_READ_CAP = 400;

function fmStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return undefined;
}

/** Best-effort provenance from frontmatter — memory_store does not stamp all of these. */
export function provenanceOf(fm: Record<string, unknown>): { agent?: string; machine?: string; project?: string; source?: string } {
  const ctx = (fm.context && typeof fm.context === 'object' ? fm.context : {}) as Record<string, unknown>;
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
  const related = Array.isArray(fm.related) ? fm.related.map(String) : [];
  const projLink = related.map((r) => /\[\[Projects\/([^\]|#]+)/i.exec(r)?.[1]).find(Boolean)
    ?? tags.map((t) => /^project[:/](.+)$/i.exec(t)?.[1]).find(Boolean);
  return {
    agent: fmStr(fm.agent) ?? fmStr(fm.agentName) ?? fmStr(fm.agent_name) ?? fmStr(fm.author) ?? fmStr(ctx.agent),
    machine: fmStr(fm.machine) ?? fmStr(fm.host) ?? fmStr(fm.hostname) ?? fmStr(ctx.machine),
    project: fmStr(fm.project) ?? fmStr(ctx.project) ?? projLink?.replace(/\.md$/, ''),
    source: fmStr(fm.source) ?? fmStr(fm.capture_source) ?? fmStr(fm.origin) ?? fmStr(fm.client) ?? fmStr(ctx.source)
      ?? (typeof fm.context === 'string' ? fm.context.slice(0, 60) : undefined),
  };
}

function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const lc = (s: string | undefined): string => (s ?? '').toLowerCase();

/** One-line preview: drop a leading `# heading` (it repeats the title) and flatten [[links]]. */
export function snippetOf(body: string): string {
  return body.replace(/^\s*#{1,6}\s+[^\n]*\n/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => t.replace(/\.md$/, '').split('/').pop() ?? t)
    .replace(/\s+/g, ' ').trim().slice(0, 180);
}

export async function listMemories(f: MemoryFilters): Promise<{ items: MemoryListItem[]; total: number; truncated: boolean; since: string }> {
  const since = f.since ?? dayAgo(1);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const q = lc(f.q).trim();
  const needsFm = !!(f.agent || f.machine || f.project || f.source);

  const base: MemoryListItem[] = [];
  for (const [path, m] of getDocMeta()) {
    if (!f.allNotes && m.type !== 'memory') continue;
    if (!f.includeArchived && m.archived) continue;
    const day = (m.date ?? '').slice(0, 10);
    if (since && (!day || day < since)) continue;
    if (f.until && day && day > f.until) continue;
    if (f.category && m.category !== f.category) continue;
    if (f.temperature && (m.temperature ?? 'unset') !== f.temperature) continue;
    if (q && !lc(m.title).includes(q) && !lc(path).includes(q) && !lc(m.content).includes(q)) continue;
    base.push({
      path, title: m.title, date: m.date, category: m.category, temperature: m.temperature,
      heat: m.heat_score, importance: m.importance, archived: !!m.archived, lastAccessed: m.last_accessed,
      collection: m.collection, snippet: snippetOf(m.content ?? ''),
    });
  }
  base.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.path.localeCompare(b.path));

  // Provenance needs frontmatter: read the newest candidates (bounded).
  const withFm = base.slice(0, needsFm ? PROVENANCE_READ_CAP : limit);
  await Promise.all(withFm.map(async (it) => {
    try {
      const { content } = await readNote(it.path);
      Object.assign(it, provenanceOf(parseFrontmatter(content).data));
    } catch { /* unreadable: leave provenance blank */ }
  }));
  let items = withFm;
  if (needsFm) {
    const match = (v: string | undefined, want?: string): boolean => !want || lc(v).includes(lc(want));
    items = items.filter((it) => match(it.agent, f.agent) && match(it.machine, f.machine)
      && match(it.project, f.project) && match(it.source, f.source));
  }
  const total = needsFm ? items.length : base.length;
  return {
    items: items.slice(0, limit), total,
    truncated: (needsFm && base.length > PROVENANCE_READ_CAP) || total > limit,
    since,
  };
}

/** Distinct values for the filter selects (index-only, cheap). */
export function memoryFacets(): { categories: string[]; temperatures: string[] } {
  const cats = new Set<string>();
  const temps = new Set<string>();
  for (const [, m] of getDocMeta()) {
    if (m.type !== 'memory') continue;
    if (m.category) cats.add(m.category);
    temps.add(m.temperature ?? 'unset');
  }
  return { categories: [...cats].sort(), temperatures: [...temps].sort() };
}

export async function getMemoryDetail(rawPath: string): Promise<Record<string, unknown>> {
  const path = sanitizePath(rawPath);
  const { content, etag } = await readNote(path);
  const { data, body } = parseFrontmatter(content);
  const meta = getDocMeta().get(path);
  const linksOut = [...new Set(extractWikilinks(body))];
  let linksIn: string[] = [];
  try {
    const { edges } = await getNeighbors(path, 1);
    linksIn = [...new Set(edges.filter((e) => e.to === path && e.from !== path).map((e) => e.from))];
  } catch { /* graph not built */ }
  const supersededBy = fmStr(data.superseded_by) ?? meta?.superseded_by;
  const consolidatedInto = fmStr(data.consolidated_into) ?? meta?.consolidated_into;
  return {
    path, etag, body, frontmatter: data,
    title: fmStr(data.title) ?? meta?.title ?? path,
    provenance: provenanceOf(data),
    heat: {
      temperature: fmStr(data.temperature) ?? meta?.temperature ?? null,
      heatScore: typeof data.heat_score === 'number' ? data.heat_score : meta?.heat_score ?? null,
      accessCount: typeof data.access_count === 'number' ? data.access_count : null,
      lastAccessed: fmStr(data.last_accessed) ?? meta?.last_accessed ?? null,
      importance: fmStr(data.importance) ?? meta?.importance ?? null,
    },
    supersession: {
      supersededBy: supersededBy ?? null,
      supersedes: data.supersedes ?? null,
      consolidatedInto: consolidatedInto ?? null,
      contradicts: data.contradicts ?? null,
      validFrom: fmStr(data.valid_from) ?? meta?.valid_from ?? null,
      validTo: fmStr(data.valid_to) ?? meta?.valid_to ?? null,
    },
    archived: data.archived === true,
    linksOut, linksIn,
  };
}

/** Frontmatter keys the editor may change. Everything else is preserved verbatim. */
export const EDITABLE_FIELDS = ['title', 'category', 'importance', 'temperature', 'tags'] as const;

export async function updateMemory(rawPath: string, input: {
  etag?: string; body?: string; fields?: Record<string, unknown>;
}): Promise<{ etag: string }> {
  const path = sanitizePath(rawPath);
  const { content, etag: current } = await readNote(path);
  if (input.etag && input.etag !== current) {
    throw Object.assign(new Error('This note changed since you opened it — reload and re-apply your edit.'), { status: 409 });
  }
  const { data, body } = parseFrontmatter(content);
  for (const k of EDITABLE_FIELDS) {
    if (!input.fields || !(k in input.fields)) continue;
    const v = input.fields[k];
    if (k === 'tags') {
      const tags = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean);
      if (tags.length) data.tags = tags; else delete data.tags;
    } else if (v == null || String(v).trim() === '') {
      if (k !== 'title') delete data[k];
    } else {
      data[k] = String(v).trim();
    }
  }
  data.last_updated = new Date().toISOString().slice(0, 10);
  const next = stringifyFrontmatter(data, input.body != null ? input.body : body);
  const res = await writeNote(path, next, current);
  await appendJournalEntry(`Updated note from dashboard: [[${path}]]`);
  await indexNote(path);
  updateGraphForNote(path, next);
  return res;
}

export async function archiveMemory(rawPath: string, reason?: string, opts: { noise?: boolean } = {}): Promise<{ path: string }> {
  const path = sanitizePath(rawPath);
  const { content } = await readNote(path);
  const { data, body } = parseFrontmatter(content);
  data.archived = true;
  data.archived_at = new Date().toISOString().slice(0, 10);
  if (reason) data.archive_reason = reason;
  data.temperature = 'cold';
  data.heat_score = 0;
  if (opts.noise) {
    data.noise = true;
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    if (!tags.includes('noise')) data.tags = [...tags, 'noise'];
  }
  await writeNote(path, stringifyFrontmatter(data, body));
  recordArchive(path);
  await appendJournalEntry(
    `${opts.noise ? 'Marked as noise' : 'Archived note'} from dashboard: [[${path}]]${reason ? ` — reason: ${reason}` : ''}`,
  );
  await indexNote(path);
  return { path };
}

export async function deleteMemory(rawPath: string, reason: string): Promise<{ path: string; relinked: string[] }> {
  const path = sanitizePath(rawPath);
  let title = path;
  let consolidatedInto: string | undefined;
  try {
    const { data } = parseFrontmatter((await readNote(path)).content);
    title = fmStr(data.title) ?? path;
    consolidatedInto = fmStr(data.consolidated_into);
  } catch { /* still allow */ }
  const relinked = await rewriteInboundLinks(path, consolidatedInto);
  await deleteNote(path);
  removeFromIndex(path);
  await appendJournalEntry(`Deleted note from dashboard: \`${path}\` (${title}) — reason: ${reason}`);
  return { path, relinked };
}
