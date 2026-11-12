/**
 * Markdown → NoteRecord. Mirrors lib/search.ts `metadataForNote` for the fields
 * the lexical index filters on. When the SQLite backend is wired in, search.ts
 * should export its `metadataForNote` and pass a `toRecord` built on it so there
 * is exactly one metadata contract (see docs/ARCHITECTURE.md §6).
 */
import { parseFrontmatter } from '../frontmatter.js';
import { classifyPath } from '../collections.js';
import type { NoteRecord } from './types.js';

function toIsoDay(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length > 0 ? s : undefined;
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function noteRecordFromMarkdown(relPath: string, content: string): NoteRecord {
  const { data, body } = parseFrontmatter(content);
  const title = data.title ?? relPath.replace(/\.md$/, '').split('/').pop() ?? relPath;
  return {
    path: relPath,
    title: String(title),
    body,
    tags: (Array.isArray(data.tags) ? data.tags : []).map(String),
    date: toIsoDay(data.date ?? data.created),
    type: str(data.type),
    category: str(data.category),
    temperature: str(data.temperature),
    heat_score: typeof data.heat_score === 'number' ? data.heat_score : undefined,
    importance: str(data.importance),
    archived: typeof data.archived === 'boolean' ? data.archived : undefined,
    collection: classifyPath(relPath),
  };
}
