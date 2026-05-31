import { getCodeDb } from './db.js';

export interface CodeRef {
  ref: string;          // "slug:relpath:name"
  id: string | null;    // resolved symbol id, or null when unresolved
  hash: string | null;  // resolved content_hash, or null when unresolved
}

const CODE_LINK_RE = /\[\[code:([^:\]]+):([^:\]]+):([^\]]+)\]\]/g;

/**
 * Scan a note body for `[[code:slug:relpath:name]]` wiki-links and resolve
 * each to a symbol id + content_hash. Unresolved refs are still returned
 * (id/hash null) so the caller can persist the broken link if desired.
 */
export function captureCodeRefs(body: string): CodeRef[] {
  const refs = new Map<string, CodeRef>();
  if (typeof body !== 'string' || body.length === 0) return [];

  // Reset RE state across calls.
  CODE_LINK_RE.lastIndex = 0;

  const candidates: Array<{ slug: string; relpath: string; name: string; key: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = CODE_LINK_RE.exec(body)) !== null) {
    const slug = m[1];
    const relpath = m[2];
    const name = m[3];
    const key = `${slug}:${relpath}:${name}`;
    if (refs.has(key)) continue;
    refs.set(key, { ref: key, id: null, hash: null });
    candidates.push({ slug, relpath, name, key });
  }
  if (candidates.length === 0) return [];

  let db: ReturnType<typeof getCodeDb>;
  try {
    db = getCodeDb();
  } catch {
    // DB unavailable — return unresolved refs
    return Array.from(refs.values());
  }

  const lookup = db.prepare(
    `SELECT s.id, s.content_hash FROM symbols s
     JOIN repos r ON r.id = s.repo_id
     WHERE r.slug = ? AND s.relative_path = ? AND s.name = ?
     LIMIT 1`,
  );

  for (const c of candidates) {
    try {
      const row = lookup.get(c.slug, c.relpath, c.name) as
        | { id: string; content_hash: string }
        | undefined;
      if (row) {
        refs.set(c.key, { ref: c.key, id: row.id, hash: row.content_hash });
      }
    } catch {
      // ignore individual lookup failures
    }
  }

  return Array.from(refs.values());
}
