import matter from 'gray-matter';
import { v4 as uuidv4 } from 'uuid';

/**
 * Disable gray-matter's process-global parse cache. `matter(str)` (no options)
 * memoizes every input in `matter.cache[str]` FOREVER — the full raw note as
 * the key, plus a `file` object holding a Buffer copy of it (`orig`), the body
 * and the parsed data. Every index rebuild, rescan and note edit adds an entry
 * and nothing ever evicts one, so a 10k-note vault carried a second (and third)
 * copy of every note version it had ever parsed. Parsing frontmatter is cheap;
 * the cache only ever hit for byte-identical re-parses. Installed here because
 * this module is imported by everything that indexes notes; it applies to
 * every `matter()` caller in the process (the module is a singleton).
 */
export function disableGrayMatterCache(): void {
  const m = matter as unknown as { cache: Record<string, unknown> };
  m.cache = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: () => undefined,
    set: () => true,
    has: () => false,
  });
}
disableGrayMatterCache();

/**
 * Parse YAML front-matter from markdown content.
 */
export function parseFrontmatter(content: string): {
  data: Record<string, any>;
  body: string;
} {
  const { data, content: body } = matter(content);
  return { data, body };
}

/**
 * Serialize front-matter data and body back into a markdown string.
 */
export function stringifyFrontmatter(
  data: Record<string, any>,
  body: string,
): string {
  return matter.stringify(body, data);
}

/**
 * Ensure the front-matter data object has an `id` field; add a UUID v4 if missing.
 */
export function ensureId(data: Record<string, any>): Record<string, any> {
  if (!data.id) {
    return { ...data, id: uuidv4() };
  }
  return data;
}
