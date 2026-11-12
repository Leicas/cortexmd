/**
 * Hook-facing memory capture (POST /api/store-memory). Fast path for the
 * PostToolUse hook and the n8n email triage — no preference extraction, no
 * entity detection, no contradiction probe — but with the same hygiene as the
 * memory_store tool, which the old inline handler lacked:
 *
 *   - capture-noise filter (shell stubs, automated emails, calendar invites)
 *   - `matrimail` captures routed to EmailLog/ (+ per-month index link) so
 *     they neither flood Memories/ nor the graph
 *   - title dedup (Levenshtein on the slug, same category) and semantic dedup
 *     when embeddings are ready — the old route wrote blindly
 *   - incremental graph update so the note is not an orphan until next rebuild
 *   - born-cold ingest: a MACHINE source (n8n / email / hooks — see
 *     config.machineCaptureSourcePatterns) is stored `temperature: cold`,
 *     `importance: low` (unless the caller passed one), `heat_score: 0`;
 *     any other (deliberate) source keeps `warm` / `heat_score: 6`
 *   - recurring machine captures (same title stem + source within
 *     config.recurringCaptureWindowDays) supersede the previous note
 *     (`supersedes` on the new note; `valid_to` / `superseded_by` + archived
 *     on the old one) instead of piling up a near-duplicate per day
 *
 * The handler in index.ts validates nothing but transport, calls
 * storeMemoryFromApi and `res.json`s the result; `markActivity()` stays there.
 */
import { v4 as uuidv4 } from 'uuid';
import { createNote, readNote, writeNote } from './vault.js';
import { stringifyFrontmatter, parseFrontmatter } from './frontmatter.js';
import { indexNote, searchNotes, getDocMeta } from './search.js';
import { updateGraphForNote } from './graph.js';
import { isEmbeddingsReady, checkSemanticDuplicate } from './embeddings.js';
import { matchCaptureNoise, isSlugTitle, isMachineCaptureSource } from './capture-filter.js';
import { titleStem, isUsableStem } from './vault-hygiene/patterns.js';
import { config } from '../config.js';
import { linkFromIndex } from './index-notes.js';
import { sanitizeContent } from './sanitize.js';
import { repairWikilinks } from './auto-link.js';
import { MEMORY_CATEGORIES } from './categorize.js';
import { logger } from './logger.js';
import { projectSlug } from './journal.js';
import { memoryKindOf } from './memory-kind.js';

export type StoreMemoryImportance = 'low' | 'medium' | 'high';

export interface StoreMemoryBody {
  content?: string;
  category?: string;
  title?: string;
  tags?: string[];
  source?: string;
  /** Default `low` — hook exhaust stays low until something promotes it. */
  importance?: StoreMemoryImportance;
  /** Skip title + semantic dedup (e.g. a caller that already deduped). */
  skipDedupe?: boolean;
  /** Provenance for the dashboard Memories filters (all optional). */
  agent?: string;
  machine?: string;
  project?: string;
}

export interface CaptureProvenance {
  agent?: string;
  machine?: string;
  project?: string;
  client?: string;
}

/** One-line, bounded frontmatter value; undefined for non-strings/blank. */
function provenanceValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return s || undefined;
}

/**
 * Normalise optional provenance (`agent`, `machine`, `project`, `client`) into
 * the frontmatter keys the dashboard Memories filters read
 * (dashboard/model/memories.ts provenanceOf). `project` is stored as the
 * Projects/<slug> slug. Absent / blank values produce no key, so callers that
 * pass nothing write exactly the frontmatter they always did.
 */
export function provenanceFrontmatter(raw: Record<string, unknown>): CaptureProvenance {
  const out: CaptureProvenance = {};
  const agent = provenanceValue(raw.agent);
  const machine = provenanceValue(raw.machine);
  const projectRaw = provenanceValue(raw.project);
  const project = projectRaw ? projectSlug(projectRaw) : undefined;
  const client = provenanceValue(raw.client);
  if (agent) out.agent = agent;
  if (machine) out.machine = machine;
  if (project) out.project = project;
  if (client) out.client = client;
  return out;
}

export interface StoreMemoryResult {
  stored: boolean;
  path?: string;
  category?: string;
  reason?: 'capture_noise' | 'duplicate' | 'semantic_duplicate';
  existingPath?: string;
  /** Previous version of a recurring capture that this one superseded. */
  supersededPath?: string;
  title?: string;
  pattern?: string;
}

export interface ApiValidationError {
  status: 400;
  message: string;
}

const IMPORTANCE_VALUES = new Set<StoreMemoryImportance>(['low', 'medium', 'high']);
const TIMELESS_CATEGORIES = new Set(['fact', 'preference']);
/** Tag the n8n email triage puts on full-body captures. */
export const EMAIL_CAPTURE_TAG = 'matrimail';

function bad(message: string): ApiValidationError {
  return { status: 400, message };
}

/** Same slug rule as memory-store.ts. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Levenshtein edit distance (parity with memory-store.ts title dedup). */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Title from the first prose line (skipping code fences and a leading `$ `
 * shell prompt), max 80 chars — parity with memory-store.ts generateTitle.
 */
export function deriveTitle(content: string): string {
  let firstProse = '';
  let inFence = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    firstProse = line.startsWith('#') ? line.replace(/^#+\s*/, '') : line;
    break;
  }
  firstProse = firstProse.replace(/^\$\s+/, '');
  let title = (firstProse || content.trim()).split(/[.!?\n]/)[0].trim();
  if (title.length > 80) title = title.slice(0, 77) + '...';
  return title || 'Auto-captured';
}

/** Validate a raw request body. Throws `{ status: 400, message }`. */
export function validateStoreMemoryBody(raw: unknown): {
  content: string;
  category: string;
  title?: string;
  tags: string[];
  source: string;
  importance: StoreMemoryImportance;
  /** True when the caller set `importance` (machine captures honour it). */
  importanceExplicit: boolean;
  skipDedupe: boolean;
  provenance: CaptureProvenance;
} {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw bad('content required');

  const category = typeof body.category === 'string' && body.category ? body.category : 'observation';
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw bad(`invalid category: ${category}`);
  }

  let importance: StoreMemoryImportance = 'low';
  const importanceExplicit = body.importance !== undefined && body.importance !== null;
  if (importanceExplicit) {
    if (typeof body.importance !== 'string' || !IMPORTANCE_VALUES.has(body.importance as StoreMemoryImportance)) {
      throw bad(`invalid importance: ${String(body.importance)}`);
    }
    importance = body.importance as StoreMemoryImportance;
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : [];
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'hook';
  const skipDedupe = body.skipDedupe === true;

  // `client` is server-derived (MCP session) — not accepted from the REST body.
  const provenance = provenanceFrontmatter({ agent: body.agent, machine: body.machine, project: body.project });

  return { content, category, title, tags, source, importance, importanceExplicit, skipDedupe, provenance };
}

export async function storeMemoryFromApi(body: StoreMemoryBody): Promise<StoreMemoryResult> {
  const v = validateStoreMemoryBody(body);
  const category = v.category;
  // Title/registry-named links ([[Email - <subject>]]) → real paths; strip
  // <private> blocks exactly like memory_store does.
  const content = repairWikilinks(sanitizeContent(v.content));

  // A filename-slug title is a stub: derive one from the content instead.
  const rawTitle = v.title && !isSlugTitle(v.title) ? v.title : deriveTitle(content);
  const title = rawTitle.slice(0, 80) || 'Auto-captured';

  // Shell-command stubs, tool-result fragments, commit echoes, prompt
  // fragments and automated emails never become memories.
  const noise = matchCaptureNoise(title, { content, source: v.source, tags: v.tags });
  if (noise) {
    return { stored: false, reason: 'capture_noise', title, pattern: noise.source };
  }

  // Machine exhaust (n8n, email, hooks) is born cold; deliberate API captures
  // keep the historical warm/6 start.
  const machine = isMachineCaptureSource(v.source);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const subdir = TIMELESS_CATEGORIES.has(category) ? '' : `${year}/${month}/`;
  const slug = slugify(title);

  // n8n's email triage tags full-body captures `matrimail` → EmailLog/.
  const isEmailCapture = v.tags.includes(EMAIL_CAPTURE_TAG);
  const baseDir = isEmailCapture ? 'EmailLog' : 'Memories';
  const memoryId = uuidv4();
  const notePath = `${baseDir}/${category}/${subdir}${today}-${slug}${isEmailCapture ? '' : `-${memoryId.slice(0, 8)}`}.md`;

  // Recurring machine captures (daily briefings, weekly summaries): same
  // normalised title stem + same source within the window → the new capture
  // SUPERSEDES the previous one instead of piling up a near-duplicate.
  let supersedes: RecurringMatch | undefined;
  if (!v.skipDedupe && machine) {
    try {
      supersedes = await findRecurringPredecessor({ baseDir, category, title, source: v.source, today: now });
    } catch {
      supersedes = undefined;
    }
    // The exact same title is the same memory, not a new version of a
    // series: leave it to the title dedup below (historical contract).
    if (supersedes && slugify(String(supersedes.data.title ?? '')) === slug) supersedes = undefined;
    if (supersedes && supersedes.body.trim() === `# ${title}\n\n${content}`.trim()) {
      // A retry of the identical capture is a duplicate, not a new version.
      return { stored: false, reason: 'duplicate', existingPath: supersedes.path, title };
    }
  }

  // Title dedup: an existing note in the same collection/category whose slug
  // is within 2 edits of ours is the same memory.
  if (!v.skipDedupe && !supersedes) {
    try {
      const dedupResults = searchNotes(`${title} ${content.slice(0, 50)}`, {
        scopePaths: [`${baseDir}/${category}/`],
        limit: 10,
      });
      for (const result of dedupResults) {
        if (levenshteinDistance(slug, slugify(result.title)) < 3) {
          return { stored: false, reason: 'duplicate', existingPath: result.path, title: result.title };
        }
      }
    } catch {
      // Index may not be ready — skip title dedup
    }
  }

  // Semantic dedup via embeddings (only when the vector index is ready).
  if (!v.skipDedupe && !supersedes && isEmbeddingsReady()) {
    try {
      const semantic = await checkSemanticDuplicate(content);
      if (semantic.isDuplicate && semantic.matchPath) {
        return { stored: false, reason: 'semantic_duplicate', existingPath: semantic.matchPath, title };
      }
    } catch {
      // Embeddings may not be ready — skip semantic dedup
    }
  }

  // `source` lives in its own frontmatter field — no duplicate `source:*` tag.
  const tags = Array.from(new Set([...v.tags, 'auto-capture']));
  const frontmatter: Record<string, unknown> = {
    id: memoryId,
    type: 'memory',
    category,
    title,
    // Machine captures start low/cold with no heat: they earn heat only by
    // being recalled. An explicit importance from the caller is honoured.
    importance: machine && !v.importanceExplicit ? 'low' : v.importance,
    temperature: machine ? 'cold' : 'warm',
    heat_score: machine ? 0 : 6,
    access_count: machine ? 0 : 1,
    last_accessed: today,
    created: today,
    last_updated: today,
    tags,
    source: v.source,
    ...v.provenance,
  };
  if (supersedes) {
    frontmatter.supersedes = supersedes.path;
    frontmatter.valid_from = today;
  }
  // Episodic / semantic / procedural, so recall can scope without re-deriving.
  frontmatter.memory_kind = memoryKindOf(frontmatter, notePath, {
    machineSourcePatterns: config.machineCaptureSourcePatterns,
  });
  const noteBody = `# ${title}\n\n${content}\n`;
  const noteContent = stringifyFrontmatter(frontmatter, noteBody);

  try {
    await createNote(notePath, noteContent);
  } catch (err: any) {
    // Email captures carry no uuid suffix (idempotent per subject/day): a
    // retry of the same capture is a duplicate, not an error.
    if (err?.code === 'EEXIST') {
      return { stored: false, reason: 'duplicate', existingPath: notePath, title };
    }
    throw err;
  }

  try { await indexNote(notePath); } catch { /* best-effort */ }
  try { updateGraphForNote(notePath, noteContent); } catch { /* graph may not be built yet */ }

  if (supersedes) {
    await closeSupersededCapture(supersedes, notePath, today);
  }

  if (isEmailCapture) {
    // Email captures get no entity/related links; a per-month index keeps
    // them from landing as orphans (parity with memory-store.ts).
    try {
      await linkFromIndex(
        { path: `EmailLog/EmailLog ${year}-${month}.md`, title: `EmailLog — ${year}-${month}` },
        notePath,
        [{ path: 'EmailLog/EmailLog Index.md', title: 'EmailLog' }],
      );
    } catch (err) {
      logger.warn('store-memory-api: EmailLog index link failed', {
        path: notePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    stored: true, path: notePath, category, title,
    ...(supersedes ? { supersededPath: supersedes.path } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recurring-capture supersession
// ---------------------------------------------------------------------------

export interface RecurringMatch {
  path: string;
  etag: string;
  data: Record<string, any>;
  body: string;
}

function dayOf(path: string, metaDate: string | undefined): string | undefined {
  if (metaDate && /^\d{4}-\d{2}-\d{2}/.test(metaDate)) return metaDate.slice(0, 10);
  return /(?:^|\/)(\d{4}-\d{2}-\d{2})-[^/]*$/.exec(path)?.[1];
}

/**
 * The newest live note in `<baseDir>/<category>/` created within the window
 * whose title has the same normalised stem and whose frontmatter `source`
 * equals ours. Undefined when the stem is too generic, the window is 0, or
 * nothing matches. Candidates are pre-filtered from the index; only stem hits
 * are read from disk to confirm `source`.
 */
export async function findRecurringPredecessor(opts: {
  baseDir: string;
  category: string;
  title: string;
  source: string;
  today: Date;
}): Promise<RecurringMatch | undefined> {
  const windowDays = config.recurringCaptureWindowDays;
  if (!(windowDays > 0)) return undefined;
  const stem = titleStem(opts.title);
  if (!isUsableStem(stem)) return undefined;
  const cutoff = new Date(opts.today.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const prefix = `${opts.baseDir}/${opts.category}/`;

  const hits: Array<{ path: string; day: string }> = [];
  for (const [p, meta] of getDocMeta()) {
    if (!p.startsWith(prefix)) continue;
    if (meta.archived === true || meta.valid_to || meta.superseded_by) continue;
    const day = dayOf(p, meta.date);
    if (!day || day < cutoff) continue;
    if (titleStem(meta.title ?? '') !== stem) continue;
    hits.push({ path: p, day });
  }
  hits.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  for (const hit of hits) {
    try {
      const { content, etag } = await readNote(hit.path);
      const { data, body } = parseFrontmatter(content);
      if (String(data.source ?? '') !== opts.source) continue;
      if (data.valid_to || data.superseded_by || data.archived === true) continue;
      return { path: hit.path, etag, data: { ...data }, body };
    } catch {
      // Unreadable candidate — try the next one.
    }
  }
  return undefined;
}

/**
 * Close the previous version of a recurring capture, bitemporal-style
 * (`valid_to` / `superseded_by`, same fields bitemporal.ts stamps), and
 * archive it so it drops out of active recall. Never deletes. Best-effort:
 * an ETag conflict leaves the old note live (the new one is already written).
 */
async function closeSupersededCapture(prev: RecurringMatch, newPath: string, today: string): Promise<void> {
  try {
    const data = { ...prev.data };
    if (!data.valid_to) data.valid_to = today;
    data.superseded_by = newPath;
    data.archived = true;
    data.archived_at = today;
    data.archive_reason = 'superseded by a newer recurring capture';
    data.temperature = 'cold';
    data.heat_score = 0;
    await writeNote(prev.path, stringifyFrontmatter(data, prev.body), prev.etag);
    try { await indexNote(prev.path); } catch { /* best-effort */ }
  } catch (err) {
    logger.warn('store-memory-api: could not close superseded capture', {
      path: prev.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
