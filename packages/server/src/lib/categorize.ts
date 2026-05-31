/**
 * Category detection for notes and memories.
 *
 * Provides a shared category classifier used by memory_store (for new memories),
 * notes_upsert (to auto-assign when omitted), and notes_categorize (for the
 * batch backfill tool).
 *
 * The classifier looks at three signals in priority order:
 *   1. An explicit frontmatter category / type hint (already known).
 *   2. The note's path (Memories/... → memory, 00 Inbox/... → inbox, etc.).
 *   3. Content keyword heuristics (decision / observation / insight / ...).
 */

import { classifyPath } from './collections.js';

export type MemoryCategory =
  | 'observation'
  | 'decision'
  | 'insight'
  | 'conversation'
  | 'fact'
  | 'preference'
  | 'plan'
  | 'reflection';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'observation',
  'decision',
  'insight',
  'conversation',
  'fact',
  'preference',
  'plan',
  'reflection',
] as const;

/**
 * Generic note categories — a superset of memory categories plus a handful of
 * broad buckets that cover the rest of the vault. The set here is intentionally
 * short; specific sub-categorization happens through path classification and
 * tags.
 */
export type NoteCategory =
  | MemoryCategory
  | 'memory'
  | 'task'
  | 'project'
  | 'journal'
  | 'meeting'
  | 'crm'
  | 'entity'
  | 'knowledge'
  | 'reference'
  | 'inbox'
  | 'report'
  | 'template'
  | 'archive'
  | 'general';

// Keyword patterns in priority order. First match wins.
const KEYWORD_MAP: Array<[RegExp, MemoryCategory]> = [
  [/\b(decided|chose|choose|decision|ruling|choosing)\b/i, 'decision'],
  [/\b(noticed|observed|saw|spotted|observation|seeing)\b/i, 'observation'],
  [/\b(I think|pattern|insight|realize|realise|realized|realised|correlat)/i, 'insight'],
  [/\b(talked|discussed|conversation|meeting|chat|call)\b/i, 'conversation'],
  [/\b(fact|definition|always|never|is a|are a)\b/i, 'fact'],
  [/\b(prefer|like|dislike|love|hate|preference|favorite|favourite)\b/i, 'preference'],
  [/\b(plan|todo|goal|milestone|roadmap|next step|will|going to|intend)/i, 'plan'],
  [/\b(reflect|looking back|lesson|takeaway|retrospect|hindsight)/i, 'reflection'],
];

/**
 * Infer a memory category from free-form content via keyword heuristics.
 * Falls back to 'observation' if nothing matches — the same default
 * memory_store has always used.
 */
export function detectCategory(content: string): MemoryCategory {
  for (const [pattern, category] of KEYWORD_MAP) {
    if (pattern.test(content)) return category;
  }
  return 'observation';
}

/**
 * Backwards-compatible alias used by existing code paths (memory-store, etc.).
 * An explicit hint overrides heuristics.
 */
export function categorizeMemory(
  content: string,
  hints?: { category?: MemoryCategory; tags?: string[] },
): MemoryCategory {
  if (hints?.category) return hints.category;
  return detectCategory(content);
}

/**
 * Map a collection name (produced by classifyPath) to the general note
 * category bucket appropriate for notes living in that collection.
 *
 * Keeps the bucket set small — specific tagging/metadata should carry finer
 * meaning when needed.
 */
export function categoryFromCollection(collection: string): NoteCategory | undefined {
  switch (collection) {
    case 'memories':   return 'memory';
    case 'journal':    return 'journal';
    case 'projects':   return 'project';
    case 'crm':        return 'crm';
    case 'knowledge':  return 'knowledge';
    case 'tasks':      return 'task';
    case 'products':   return 'reference';
    case 'areas':      return 'reference';
    case 'ops':        return 'report';
    case 'inbox':      return 'inbox';
    case 'daily-notes':return 'journal';
    case 'archive':    return 'archive';
    case 'personal':   return 'reference';
    case 'general':
    default:
      return undefined;
  }
}

export interface NoteCategoryInputs {
  /** Vault-relative path of the note (used for path-based classification). */
  path?: string;
  /** Parsed frontmatter (category / type / tags / collection hints). */
  frontmatter?: Record<string, unknown> | null | undefined;
  /** Raw note body (used for keyword heuristics). */
  content?: string;
}

export interface NoteCategoryResult {
  category: NoteCategory;
  /** Which signal produced the category ('frontmatter' | 'path' | 'content' | 'default'). */
  source: 'frontmatter' | 'path' | 'content' | 'default';
  /** Human-readable one-liner for logs / dry-run reports. */
  reason: string;
}

const MEMORY_CATEGORY_SET: ReadonlySet<string> = new Set<string>(MEMORY_CATEGORIES);

/**
 * Infer a note category from any combination of path, frontmatter and content.
 *
 * Signal priority:
 *   1. Explicit frontmatter.category (kept as-is if recognisable).
 *   2. Frontmatter.type / collection hints (type=task → 'task', etc.).
 *   3. Path-based classification via DEFAULT_COLLECTIONS.
 *   4. Content keyword heuristics (memory categories).
 *   5. 'general' fallback.
 */
export function inferNoteCategory(input: NoteCategoryInputs): NoteCategoryResult {
  const fm = input.frontmatter ?? undefined;

  // (1) explicit category in frontmatter
  if (fm && typeof fm.category === 'string' && fm.category.trim()) {
    const explicit = fm.category.trim();
    return {
      category: explicit as NoteCategory,
      source: 'frontmatter',
      reason: `frontmatter.category=${explicit}`,
    };
  }

  // (2) type-based hint (task, memory, report, ...)
  if (fm && typeof fm.type === 'string' && fm.type.trim()) {
    const type = fm.type.trim().toLowerCase();
    if (type === 'memory') {
      // Memories without a category fall through to content-based detection
      // so they land on observation/insight/... instead of a generic 'memory'.
      const memCat = detectCategory(input.content ?? '');
      return {
        category: memCat,
        source: 'content',
        reason: `frontmatter.type=memory + keyword (${memCat})`,
      };
    }
    if (type === 'task' || type === 'project' || type === 'meeting' || type === 'journal'
        || type === 'report' || type === 'template' || type === 'entity') {
      return {
        category: type as NoteCategory,
        source: 'frontmatter',
        reason: `frontmatter.type=${type}`,
      };
    }
  }

  // (3) path-based classification
  if (input.path) {
    const collection = classifyPath(input.path);
    const pathCat = categoryFromCollection(collection);
    if (pathCat) {
      // For the memories collection, still refine via keyword detection so we
      // end up with observation/decision/etc. instead of the generic 'memory'.
      if (pathCat === 'memory' && input.content) {
        const memCat = detectCategory(input.content);
        return {
          category: memCat,
          source: 'content',
          reason: `path=${collection} + keyword (${memCat})`,
        };
      }
      return {
        category: pathCat,
        source: 'path',
        reason: `path classified as ${collection}`,
      };
    }
  }

  // (4) content keyword heuristics
  if (input.content && input.content.trim().length > 0) {
    const memCat = detectCategory(input.content);
    // detectCategory always returns something — but only promote it to the
    // final answer when we actually matched a real keyword. Otherwise we
    // prefer the 'general' fallback over a default 'observation' guess for
    // non-memory notes.
    if (memCat !== 'observation' || hasMemoryKeyword(input.content)) {
      return {
        category: memCat,
        source: 'content',
        reason: `keyword match (${memCat})`,
      };
    }
  }

  return {
    category: 'general',
    source: 'default',
    reason: 'no path/frontmatter/keyword signal',
  };
}

function hasMemoryKeyword(content: string): boolean {
  for (const [pattern] of KEYWORD_MAP) {
    if (pattern.test(content)) return true;
  }
  return false;
}

/** True if the category is one of the memory-specific sub-categories. */
export function isMemoryCategory(category: string): category is MemoryCategory {
  return MEMORY_CATEGORY_SET.has(category);
}
