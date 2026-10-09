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
 *   - `importance` honoured from the body (default `low`; auto-capture is
 *     exhaust until promoted), `temperature: 'warm'`, `heat_score: 6` kept
 *
 * The handler in index.ts validates nothing but transport, calls
 * storeMemoryFromApi and `res.json`s the result; `markActivity()` stays there.
 */
import { v4 as uuidv4 } from 'uuid';
import { createNote } from './vault.js';
import { stringifyFrontmatter } from './frontmatter.js';
import { indexNote, searchNotes } from './search.js';
import { updateGraphForNote } from './graph.js';
import { isEmbeddingsReady, checkSemanticDuplicate } from './embeddings.js';
import { matchCaptureNoise, isSlugTitle } from './capture-filter.js';
import { linkFromIndex } from './index-notes.js';
import { sanitizeContent } from './sanitize.js';
import { repairWikilinks } from './auto-link.js';
import { MEMORY_CATEGORIES } from './categorize.js';
import { logger } from './logger.js';

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
}

export interface StoreMemoryResult {
  stored: boolean;
  path?: string;
  category?: string;
  reason?: 'capture_noise' | 'duplicate' | 'semantic_duplicate';
  existingPath?: string;
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
  skipDedupe: boolean;
} {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw bad('content required');

  const category = typeof body.category === 'string' && body.category ? body.category : 'observation';
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw bad(`invalid category: ${category}`);
  }

  let importance: StoreMemoryImportance = 'low';
  if (body.importance !== undefined && body.importance !== null) {
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

  return { content, category, title, tags, source, importance, skipDedupe };
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

  // Shell-command stubs and automated emails never become memories.
  const noise = matchCaptureNoise(title);
  if (noise) {
    return { stored: false, reason: 'capture_noise', title, pattern: noise.source };
  }

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

  // Title dedup: an existing note in the same collection/category whose slug
  // is within 2 edits of ours is the same memory.
  if (!v.skipDedupe) {
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
  if (!v.skipDedupe && isEmbeddingsReady()) {
    try {
      const semantic = await checkSemanticDuplicate(content);
      if (semantic.isDuplicate && semantic.matchPath) {
        return { stored: false, reason: 'semantic_duplicate', existingPath: semantic.matchPath, title };
      }
    } catch {
      // Embeddings may not be ready — skip semantic dedup
    }
  }

  const tags = Array.from(new Set([...v.tags, 'auto-capture', `source:${v.source}`]));
  const frontmatter: Record<string, unknown> = {
    id: memoryId,
    type: 'memory',
    category,
    title,
    importance: v.importance,
    temperature: 'warm',
    heat_score: 6,
    access_count: 1,
    last_accessed: today,
    created: today,
    last_updated: today,
    tags,
    source: v.source,
  };
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

  return { stored: true, path: notePath, category, title };
}
