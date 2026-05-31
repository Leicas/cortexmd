import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDocMeta, getIndexedNoteCount } from './search.js';
import { logger } from './logger.js';

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

let essentialCache: { content: string; expires: number } | null = null;
const ESSENTIAL_TTL_MS = 60 * 1000; // 60 seconds

// ── Helpers ───────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
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

/**
 * Build the essential narrative layer: top notes by heat score, grouped
 * by collection. Cached for 60 seconds.
 */
async function buildEssentialNarrative(focusCollection?: string): Promise<string> {
  const now = Date.now();
  // Only use cache when there's no collection focus
  if (!focusCollection && essentialCache && essentialCache.expires > now) {
    return essentialCache.content;
  }

  const docMeta = getDocMeta();

  // Collect all notes with their metadata
  const entries: Array<{
    path: string;
    title: string;
    collection: string;
    category: string;
    temperature: string;
    heat_score: number;
  }> = [];

  for (const [notePath, meta] of docMeta) {
    entries.push({
      path: notePath,
      title: meta.title,
      collection: meta.collection ?? 'general',
      category: meta.category ?? 'uncategorized',
      temperature: meta.temperature ?? 'unknown',
      heat_score: meta.heat_score ?? 0,
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

  // Build markdown narrative
  const lines: string[] = [];
  for (const [collection, notes] of byCollection) {
    const topNotes = notes.slice(0, 5);
    if (topNotes.length === 0) continue;
    lines.push(`### ${collection}`);
    for (const note of topNotes) {
      const title = note.title.replace(/\.md$/, '');
      lines.push(`- [[${title}]] -- ${note.category}, ${note.temperature} (${note.heat_score})`);
    }
    lines.push('');
  }

  // Truncate to ~800 tokens (3200 chars) to stay within budget
  const content = truncateToTokens(lines.join('\n').trim(), 800);

  // Cache only the unfocused version
  if (!focusCollection) {
    essentialCache = { content, expires: now + ESSENTIAL_TTL_MS };
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
    const title = note.title.replace(/\.md$/, '');
    lines.push(`- [[${title}]] -- ${note.category}, ${note.temperature} (${note.heat_score})`);
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

/**
 * Wake-up call: returns L0 (Identity) + L1 (Essential Narrative) layers.
 * Optionally focus on a specific collection.
 */
export async function wakeUp(collection?: string): Promise<MemoryLayer[]> {
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
    const narrativeContent = await buildEssentialNarrative(collection);
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
