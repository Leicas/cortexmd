import path from 'node:path';

/** A basename maps to null when multiple notes share it. */
export interface LinkLookup {
  paths: Set<string>;
  basenames: Map<string, string | null>;
}

export function buildLinkLookup(paths: Iterable<string>): LinkLookup {
  const all = new Set(paths);
  const basenames = new Map<string, string | null>();
  for (const notePath of all) {
    const basename = notePath.replace(/\.md$/i, '').split('/').pop()!;
    if (basenames.has(basename) && basenames.get(basename) !== notePath) {
      basenames.set(basename, null);
    } else if (!basenames.has(basename)) {
      basenames.set(basename, notePath);
    }
  }
  return { paths: all, basenames };
}

/** Resolve only a unique target. A missing explicit path never falls back by basename. */
export function resolveWikilink(target: string, lookup: LinkLookup, sourcePath?: string): string | undefined {
  const raw = target.split('#')[0].trim().replace(/\\/g, '/');
  if (!raw) return undefined;
  const withMd = raw.endsWith('.md') ? raw : `${raw}.md`;
  const candidate = raw.startsWith('./') || raw.startsWith('../')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath ?? ''), withMd))
    : path.posix.normalize(withMd);
  if (candidate.startsWith('../') || candidate === '..') return undefined;
  if (lookup.paths.has(candidate)) return candidate;
  // A slash is an intentional path; resolving its basename could select a
  // different note and quietly fabricate a graph edge.
  if (raw.includes('/')) return undefined;
  const basename = raw.replace(/\.md$/i, '');
  return lookup.basenames.get(basename) ?? undefined;
}
