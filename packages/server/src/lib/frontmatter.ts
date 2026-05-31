import matter from 'gray-matter';
import { v4 as uuidv4 } from 'uuid';

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
