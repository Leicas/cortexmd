import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDocMeta, getIndexedNoteCount } from './search.js';
import { logger } from './logger.js';
import { projectSlug } from './journal.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryLayer {
  level: 0 | 1 | 2 | 3;
  tokens: number;       // approximate token count (chars / 4)
  content: string;       // markdown
  source: string;        // e.g. 'identity.txt', 'top-memories', 'filtered', 'search'
}

// ── Caches (simple closures) ──────────────────────────────────────────────────

let identityCache: { content: string; expires: number } | null = null;
const IDENTITY_TTL_MS = 5 * 60 * 1000; // 5 minutes

// L1 narrative cache, keyed by project slug ('' = global). Bounded so a
// hook cycling through many repos cannot grow it without limit.
const essentialCache = new Map<string, { content: string; expires: number }>();
const ESSENTIAL_TTL_MS = 60 * 1000; // 60 seconds
const ESSENTIAL_CACHE_MAX = 32;

// ── Helpers ───────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}

/**
 * Path-qualified link with the title as display text. Titles rarely match
 * filenames (e.g. "Email - <subject>" vs a slugged path), so a bare
 * `[[title]]` dangles — and agents copy these lines into new notes.
 */
export function noteLink(notePath: string, title: string): string {
  const display = (title || notePath).replace(/\.md$/, '').replace(/[[\]|]/g, '');
  return `[[${notePath.replace(/\.md$/, '')}|${display}]]`;
}

// ── L0: Identity ──────────────────────────────────────────────────────────────

/**
 * Read the identity layer. Returns the content of `{dataDir}/identity.txt`
 * if it exists, otherwise generates a stub from vault stats.
 * Cached for 5 minutes.
 */
export async function getIdentity(): Promise<string> {
  const now = Date.now();
  if (identityCache && identityCache.expires > now) {
    return identityCache.content;
  }

  let content: string;
  try {
    const identityPath = config.identityFile || path.join(config.dataDir, 'identity.txt');
    content = await readFile(identityPath, 'utf-8');
    content = content.trim();
  } catch {
    // File doesn't exist — generate stub from vault stats
    const noteCount = getIndexedNoteCount();
    const docMeta = getDocMeta();
    const collectionCounts = new Map<string, number>();
    for (const [, meta] of docMeta) {
      const col = meta.collection ?? 'general';
      collectionCounts.set(col, (collectionCounts.get(col) ?? 0) + 1);
    }

    const topCollections = [...collectionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    content = `Vault with ${noteCount} notes across ${collectionCounts.size} collections. Top collections: ${topCollections || 'none indexed yet'}.`;
  }

  identityCache = { content, expires: now + IDENTITY_TTL_MS };
  return content;
}

// ── L1: Essential Narrative ───────────────────────────────────────────────────

interface NarrativeEntry {
  path: string;
  title: string;
  collection: string;
  category: string;
  temperature: string;
  heat_score: number;
  last_accessed: string;
}

/** Paths never listed under "this project" (the diary is its own wakeup section). */
const PROJECT_SECTION_EXCLUDE_PREFIXES = ['Ops/Agent Diaries/'];

/** `[[Projects/x|alias]]`, `Projects/x.md`, `projects/X` all normalise to `projects/x`. */
function normalizeLinkTarget(raw: string): string {
  return raw
    .replace(/^\[\[/, '').replace(/\]\]$/, '')
    .split('|')[0].split('#')[0]
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Does this note link the project? Frontmatter `related`, tags, or a body
 * `[[Projects/<slug>]]` wiki-link (the form every diary line and most
 * memories use) all count.
 */
function linksProject(meta: { related?: string[]; tags?: string[]; content?: string }, target: string): boolean {
  if (Array.isArray(meta.related) && meta.related.some((r) => normalizeLinkTarget(String(r)) === target)) return true;
  if (Array.isArray(meta.tags) && meta.tags.some((t) => normalizeLinkTarget(String(t)) === target)) return true;
  const body = (meta.content ?? '').toLowerCase();
  if (!body) return false;
  return body.includes(`[[${target}]]`) || body.includes(`[[${target}|`) || body.includes(`[[${target}.md]]`);
}

/**
 * "### this project" section: the project note itself (when it exists) plus
 * the top notes linking `Projects/<slug>`, hottest first. Placed BEFORE the
 * global collections so a new session reads about the repo it is in first,
 * and so it survives the 800-token truncation.
 */
function buildProjectSection(project: string): string[] {
  const slug = projectSlug(project);
  if (!slug) return [];
  const target = `projects/${slug}`;
  const docMeta = getDocMeta();

  const projectNotePath = [...docMeta.keys()].find((p) => p.toLowerCase() === `${target}.md`);
  const linked: NarrativeEntry[] = [];
  for (const [notePath, meta] of docMeta) {
    if (notePath === projectNotePath) continue;
    if (PROJECT_SECTION_EXCLUDE_PREFIXES.some((p) => notePath.startsWith(p))) continue;
    if (meta.archived) continue;
    if (!linksProject(meta, target)) continue;
    linked.push({
      path: notePath,
      title: meta.title,
      collection: meta.collection ?? 'general',
      category: meta.category ?? 'uncategorized',
      temperature: meta.temperature ?? 'unknown',
      heat_score: meta.heat_score ?? 0,
      last_accessed: meta.last_accessed ?? '',
    });
  }
  linked.sort((a, b) => (b.heat_score - a.heat_score) || b.last_accessed.localeCompare(a.last_accessed));

  const lines: string[] = [`### this project — [[Projects/${slug}]]`];
  if (projectNotePath) {
    const meta = docMeta.get(projectNotePath)!;
    lines.push(`- ${noteLink(projectNotePath, meta.title)} -- project note, ${meta.temperature ?? 'unknown'} (${meta.heat_score ?? 0})`);
  }
  for (const note of linked.slice(0, 5)) {
    lines.push(`- ${noteLink(note.path, note.title)} -- ${note.category}, ${note.temperature} (${note.heat_score})`);
  }
  if (!projectNotePath && linked.length === 0) {
    lines.push(`_No notes link [[Projects/${slug}]] yet._`);
  }
  lines.push('');
  return lines;
}

/**
 * Build the essential narrative layer: top notes by heat score, grouped
 * by collection, with a "this project" section first when a project is
 * given. Cached for 60 seconds per project (unfocused only).
 */
async function buildEssentialNarrative(focusCollection?: string, project?: string): Promise<string> {
  const now = Date.now();
  const cacheKey = project ? projectSlug(project) : '';
  // Only use cache when there's no collection focus
  if (!focusCollection) {
    const cached = essentialCache.get(cacheKey);
    if (cached && cached.expires > now) return cached.content;
  }

  const docMeta = getDocMeta();

  // Collect all notes with their metadata
  const entries: NarrativeEntry[] = [];

  for (const [notePath, meta] of docMeta) {
    entries.push({
      path: notePath,
      title: meta.title,
      collection: meta.collection ?? 'general',
      category: meta.category ?? 'uncategorized',
      temperature: meta.temperature ?? 'unknown',
      heat_score: meta.heat_score ?? 0,
      last_accessed: meta.last_accessed ?? '',
    });
  }

  // Sort by heat_score descending
  entries.sort((a, b) => b.heat_score - a.heat_score);

  // Group by collection
  const byCollection = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (focusCollection && entry.collection !== focusCollection) continue;
    const list = byCollection.get(entry.collection) ?? [];
    list.push(entry);
    byCollection.set(entry.collection, list);
  }

  // Build markdown narrative — project section first.
  const lines: string[] = project ? buildProjectSection(project) : [];
  for (const [collection, notes] of byCollection) {
    const topNotes = notes.slice(0, 5);
    if (topNotes.length === 0) continue;
    lines.push(`### ${collection}`);
    for (const note of topNotes) {
      lines.push(`- ${noteLink(note.path, note.title)} -- ${note.category}, ${note.temperature} (${note.heat_score})`);
    }
    lines.push('');
  }

  // Truncate to ~800 tokens (3200 chars) to stay within budget
  const content = truncateToTokens(lines.join('\n').trim(), 800);

  // Cache only the unfocused version (per project key, bounded)
  if (!focusCollection) {
    if (essentialCache.size >= ESSENTIAL_CACHE_MAX && !essentialCache.has(cacheKey)) {
      const oldest = essentialCache.keys().next().value;
      if (oldest !== undefined) essentialCache.delete(oldest);
    }
    essentialCache.set(cacheKey, { content, expires: now + ESSENTIAL_TTL_MS });
  }

  return content;
}

// ── L2: Filtered Recall ───────────────────────────────────────────────────────

/**
 * Filtered recall layer: return top notes matching collection and/or category.
 * Never cached (always fresh).
 */
export async function filteredRecall(
  collection: string,
  category?: string,
): Promise<MemoryLayer> {
  const docMeta = getDocMeta();

  const entries: Array<{
    path: string;
    title: string;
    collection: string;
    category: string;
    temperature: string;
    heat_score: number;
  }> = [];

  for (const [notePath, meta] of docMeta) {
    const noteCollection = meta.collection ?? 'general';
    const noteCategory = meta.category ?? 'uncategorized';

    if (noteCollection !== collection) continue;
    if (category && noteCategory !== category) continue;

    entries.push({
      path: notePath,
      title: meta.title,
      collection: noteCollection,
      category: noteCategory,
      temperature: meta.temperature ?? 'unknown',
      heat_score: meta.heat_score ?? 0,
    });
  }

  // Sort by heat_score descending
  entries.sort((a, b) => b.heat_score - a.heat_score);

  // Take top items, format like L1
  const topEntries = entries.slice(0, 15);
  const lines: string[] = [];
  lines.push(`### ${collection}${category ? ` / ${category}` : ''}`);
  lines.push(`*${entries.length} notes total, showing top ${topEntries.length}*`);
  lines.push('');
  for (const note of topEntries) {
    lines.push(`- ${noteLink(note.path, note.title)} -- ${note.category}, ${note.temperature} (${note.heat_score})`);
  }

  const content = truncateToTokens(lines.join('\n'), 500);

  return {
    level: 2,
    tokens: countTokens(content),
    content,
    source: 'filtered',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WakeUpOptions {
  /** Project slug or name: prepends a "### this project" section to L1. */
  project?: string;
}

/**
 * Wake-up call: returns L0 (Identity) + L1 (Essential Narrative) layers.
 * Optionally focus on a specific collection and/or project.
 */
export async function wakeUp(collection?: string, opts: WakeUpOptions = {}): Promise<MemoryLayer[]> {
  const layers: MemoryLayer[] = [];

  try {
    // L0: Identity
    const identityContent = await getIdentity();
    layers.push({
      level: 0,
      tokens: countTokens(identityContent),
      content: identityContent,
      source: 'identity.txt',
    });

    // L1: Essential Narrative
    const narrativeContent = await buildEssentialNarrative(collection, opts.project);
    layers.push({
      level: 1,
      tokens: countTokens(narrativeContent),
      content: narrativeContent,
      source: 'top-memories',
    });
  } catch (err) {
    logger.error('memory-stack wakeUp failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return layers;
}
