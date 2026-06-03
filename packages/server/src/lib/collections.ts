export interface CollectionRule {
  name: string;
  pathPattern: RegExp;
  weight: number; // boost multiplier for RRF scoring
}

/**
 * Minimal, generic collection set. Rules are evaluated top-to-bottom and the
 * first matching `pathPattern` wins, so the catch-all `general` MUST stay last.
 * Path patterns here are intentionally vault-layout-agnostic (no personal
 * folder names) so the defaults are safe for any vault.
 *
 * To tune retrieval for a specific vault layout, override these patterns with
 * your own folder structure. Example operator config (commented out — DO NOT
 * bake personal folder names into the shipped defaults):
 *
 *   export const DEFAULT_COLLECTIONS: CollectionRule[] = [
 *     { name: 'memories',    pathPattern: /^Memories\//i,              weight: 1.2 },
 *     { name: 'journal',     pathPattern: /^(Journal|Logs and Meetings notes)\//i, weight: 0.9 },
 *     { name: 'projects',    pathPattern: /^(Projects|01 Projects|03 Projects|Project Management)\//i, weight: 1.0 },
 *     { name: 'crm',         pathPattern: /^(CRM|05 CRM|Organisations|Teams)\//i, weight: 1.0 },
 *     { name: 'personal',    pathPattern: /^Perso\//i,                 weight: 1.0 },
 *     { name: 'knowledge',   pathPattern: /^(Knowledge|10 Knowledge Base|06 Intelligence|Documentation|08 Syntheses|03 Resources|Markets)\//i, weight: 1.0 },
 *     { name: 'tasks',       pathPattern: /^(Tasks|Task lists)\//i,    weight: 1.0 },
 *     { name: 'products',    pathPattern: /^Products\//i,              weight: 1.0 },
 *     { name: 'areas',       pathPattern: /^02 Areas\//i,              weight: 1.0 },
 *     { name: 'agents',      pathPattern: /^Ops\/(Agents|Teams|Skills)\//i,    weight: 0.7 },
 *     { name: 'ops',         pathPattern: /^(Ops|99 Ops|Office setup|Templates|Assets)\//i, weight: 0.9 },
 *     { name: 'inbox',       pathPattern: /^00 Inbox\//i,             weight: 0.9 },
 *     { name: 'daily-notes', pathPattern: /^(DailyNotes|Unorganized daily notes)\//i, weight: 0.8 },
 *     { name: 'archive',     pathPattern: /^(Archive|04 Archive)\//i,   weight: 0.5 },
 *     { name: 'code',        pathPattern: /^Code\//i,                   weight: 0.8 },
 *     { name: 'general',     pathPattern: /./,                          weight: 1.0 },
 *   ];
 */
export const DEFAULT_COLLECTIONS: CollectionRule[] = [
  // Memories — boosted for recall relevance
  { name: 'memories', pathPattern: /^Memories\//i, weight: 1.2 },

  // Journal — daily logs / meeting notes
  { name: 'journal',  pathPattern: /^Journal\//i,  weight: 0.9 },

  // Code projections — symbol notes mirrored from code-nav
  { name: 'code',     pathPattern: /^Code\//i,     weight: 0.8 },

  // Projects — synthesis notes the dream reconciles cold memories into
  { name: 'projects', pathPattern: /^Projects\//i, weight: 1.0 },

  // Archive — heavily deprioritized
  { name: 'archive',  pathPattern: /^Archive\//i,  weight: 0.5 },

  // catch-all must be last
  { name: 'general',  pathPattern: /./,            weight: 1.0 },
];

export function classifyPath(path: string): string {
  for (const rule of DEFAULT_COLLECTIONS) {
    if (rule.pathPattern.test(path)) return rule.name;
  }
  return 'general';
}

/**
 * Try to infer a collection from frontmatter hints (additive — never fails,
 * returns undefined when nothing matches so callers can fall back to path
 * classification). Intended as an override for notes where `classifyPath`
 * returned the catch-all `general`, e.g. notes filed outside the known
 * vault-root patterns but still carrying a `type: memory` / `collection: crm`
 * hint in their frontmatter.
 */
export function classifyByFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!frontmatter) return undefined;

  // Explicit collection hint wins.
  const explicit = frontmatter.collection;
  if (typeof explicit === 'string' && explicit.trim()) {
    const name = explicit.trim().toLowerCase();
    if (DEFAULT_COLLECTIONS.some((r) => r.name === name)) return name;
  }

  // Type-based mapping onto the generic collection set. Types that have no
  // dedicated generic collection fall through to `general` (returned below).
  const type = typeof frontmatter.type === 'string' ? frontmatter.type.trim().toLowerCase() : '';
  switch (type) {
    case 'memory':    return 'memories';
    case 'journal':   return 'journal';
    case 'meeting':   return 'journal';
    case 'project':   return 'projects';
  }

  // Category hint for memory sub-categories (observation, decision, ...)
  const cat = typeof frontmatter.category === 'string' ? frontmatter.category.trim().toLowerCase() : '';
  if (cat && ['observation','decision','insight','conversation','fact','preference','plan','reflection'].includes(cat)) {
    return 'memories';
  }

  return undefined;
}

/**
 * Classify a note combining path + frontmatter hints. Preserves existing
 * behaviour for every path that already matches a non-`general` rule; the
 * frontmatter override only kicks in when the path alone would land in the
 * catch-all.
 */
export function classifyNote(
  path: string,
  frontmatter?: Record<string, unknown> | null,
): string {
  const byPath = classifyPath(path);
  if (byPath !== 'general') return byPath;
  const byFm = classifyByFrontmatter(frontmatter);
  return byFm ?? 'general';
}

export function getCollectionWeight(collection: string): number {
  return DEFAULT_COLLECTIONS.find(r => r.name === collection)?.weight ?? 1.0;
}

export function getCollectionNames(): string[] {
  return DEFAULT_COLLECTIONS.map(r => r.name);
}
