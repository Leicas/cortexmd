/**
 * Hook-facing recall (POST /api/recall). One round-trip, no MCP session, but
 * the SAME ranker as the memory_recall tool: hybridSearch → rescoreRecall
 * (heat, importance, half-life recency, relatedTo, validity, centrality,
 * co-recall, MMR). Before this lived here, the route returned raw hybridSearch
 * hits, so a low-importance auto-capture (or a spam SMS note) could outrank a
 * curated decision and get injected into every prompt.
 *
 * Extras for hooks:
 *   - `project`  → relatedTo `Projects/<slug>` (×2 for memories linked to the
 *                  project the session is working in)
 *   - `seen`     → paths already injected this session are dropped BEFORE
 *                  selection, so repeats never crowd out fresh context
 *   - `minImportance` → lets a hook skip `low` exhaust entirely
 *
 * The handler in index.ts only validates transport concerns, calls
 * recallForHook and `res.json`s the result; `markActivity()` stays there.
 */
import { hybridSearch, getDocMeta } from './search.js';
import { projectSlug } from './journal.js';
import { rescoreRecall, touchRecalledMemories, IMPORTANCE_ORDER } from './memory.js';
import { config } from '../config.js';

export type RecallKinds = 'memory' | 'notes' | 'both';
export type RecallImportance = typeof IMPORTANCE_ORDER[number];

export interface RecallBody {
  query: string;
  /** 1..10, default 5. */
  limit?: number;
  kinds?: RecallKinds;
  /** Default true. */
  excludeArchived?: boolean;
  /** Project slug or name; boosts memories linked to `Projects/<slug>`. */
  project?: string;
  minImportance?: RecallImportance;
  /** Vault paths already shown this session — excluded from both lists. */
  seen?: string[];
}

export interface RecallMemoryHit {
  path: string;
  title: string;
  snippet: string;
  category?: string;
  temperature?: string;
  importance?: string;
  score: number;
}

export interface RecallNoteHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface RecallResponse {
  query: string;
  memories: RecallMemoryHit[];
  notes: RecallNoteHit[];
}

export interface ApiValidationError {
  status: 400;
  message: string;
}

/**
 * Prefixes never injected by a hook: EmailLog/ captures are exhaust by design
 * (routed out of Memories/ for that reason) and diary days are already the
 * wakeup's own section.
 */
const HOOK_EXCLUDE_PREFIXES = ['EmailLog/', 'Ops/Agent Diaries/'];

function isHookExcluded(p: string): boolean {
  return HOOK_EXCLUDE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

const KINDS = new Set<RecallKinds>(['memory', 'notes', 'both']);

function bad(message: string): ApiValidationError {
  return { status: 400, message };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Validate a raw request body into a normalised RecallBody. Throws `{ status: 400, message }`. */
export function validateRecallBody(raw: unknown): Required<Pick<RecallBody, 'query' | 'limit' | 'kinds' | 'excludeArchived' | 'seen'>> & Pick<RecallBody, 'project' | 'minImportance'> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) throw bad('query required');

  const rawLimit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 5;
  const limit = Math.max(1, Math.min(10, Math.floor(rawLimit)));

  const kinds = (body.kinds ?? 'both') as RecallKinds;
  if (!KINDS.has(kinds)) throw bad(`invalid kinds: ${String(body.kinds)}`);

  const excludeArchived = typeof body.excludeArchived === 'boolean' ? body.excludeArchived : true;

  let minImportance: RecallImportance | undefined;
  if (body.minImportance !== undefined && body.minImportance !== null) {
    if (typeof body.minImportance !== 'string' || !(IMPORTANCE_ORDER as readonly string[]).includes(body.minImportance)) {
      throw bad(`invalid minImportance: ${String(body.minImportance)}`);
    }
    minImportance = body.minImportance as RecallImportance;
  }

  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : undefined;

  const seen = Array.isArray(body.seen)
    ? body.seen.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 500)
    : [];

  return { query, limit, kinds, excludeArchived, project, minImportance, seen };
}

export async function recallForHook(body: RecallBody): Promise<RecallResponse> {
  const { query, limit, kinds, excludeArchived, project, minImportance, seen } = validateRecallBody(body);
  const seenSet = new Set(seen);
  // Over-fetch enough that the seen-set and post-filters still leave `limit`.
  const overFetch = limit * 3 + seenSet.size;

  const memories: RecallMemoryHit[] = [];
  const notes: RecallNoteHit[] = [];

  if (kinds !== 'notes') {
    const relatedTo = project ? [`Projects/${projectSlug(project)}`] : undefined;
    const hits = await hybridSearch(query, {
      type: 'memory',
      limit: overFetch,
      excludeArchived,
      // With temporal memory enabled, hook recall asks for what is true now.
      asOf: config.bitemporalKg ? new Date().toISOString() : undefined,
    });
    const ranked = rescoreRecall(hits.filter((h) => !isHookExcluded(h.path)), {
      limit,
      minImportance,
      relatedTo,
      exclude: seenSet,
    });
    for (const r of ranked) {
      memories.push({
        path: r.path,
        title: r.title,
        snippet: r.snippet.slice(0, 200),
        category: r.category,
        temperature: r.temperature,
        importance: r.importance,
        score: round4(r.score),
      });
    }
    // Same salience bump as memory_recall (top 3, once per day per note).
    // Fire-and-forget; validity is never touched by recall.
    touchRecalledMemories(memories.slice(0, 3).map((m) => m.path));
  }

  if (kinds !== 'memory') {
    const dm = getDocMeta();
    const hits = await hybridSearch(query, { limit: overFetch, excludeArchived });
    for (const r of hits) {
      if (notes.length >= limit) break;
      if (seenSet.has(r.path)) continue;
      const meta = dm.get(r.path);
      if (meta?.type === 'memory') continue;
      if (isHookExcluded(r.path)) continue;
      notes.push({
        path: r.path,
        title: r.title,
        snippet: r.snippet.slice(0, 200),
        score: round4(r.score),
      });
    }
  }

  return { query, memories, notes };
}
