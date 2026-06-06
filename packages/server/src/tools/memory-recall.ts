import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hybridSearch, getDocMeta } from '../lib/search.js';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeQuery, validateDateString } from '../lib/sanitize.js';
import { recordSearchQuery, recordSearchScoreBreakdown, recordSearchTypeBreakdown } from '../lib/metrics.js';
import { config } from '../config.js';
import { projectCodeRefsFromBody } from '../lib/code-nav/projection.js';
import {
  computeValidity,
  updateValidity,
  VALIDITY_STALE_RANK_PENALTY,
} from '../lib/memory.js';

const CATEGORIES = [
  'observation',
  'decision',
  'insight',
  'conversation',
  'fact',
  'preference',
  'plan',
  'reflection',
] as const;

const CATEGORY_HALF_LIFE_DAYS: Record<string, number> = {
  observation: 14,
  decision: 30,
  insight: 30,
  conversation: 7,
  fact: 90,
  preference: 60,
  plan: 7,
  reflection: 30,
};

const DEFAULT_HALF_LIFE_DAYS = 30;

const TEMPERATURE_BOOST: Record<string, number> = {
  hot: 1.5,
  warm: 1.0,
  cold: 0.5,
};

const IMPORTANCE_BOOST: Record<string, number> = {
  critical: 2.0,
  high: 1.5,
  medium: 1.0,
  low: 0.7,
};

const IMPORTANCE_ORDER = ['low', 'medium', 'high', 'critical'];

// ── MMR diversity (avoid near-duplicate recalls) ──────────────────────────
// Cheap lexical similarity on title+snippet tokens — no embedding round-trip.
// The vault accumulates near-identical memories (e.g. repeated "X failed
// pipeline" / "down payment overdue" observations); MMR keeps the most
// relevant of each cluster instead of spending the result budget on dupes.
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Maximal Marginal Relevance selection. `items` must be pre-sorted by score
 * descending. Picks `limit` results balancing relevance (λ) against novelty
 * vs. already-selected items (1−λ). λ=0.7 keeps relevance dominant.
 */
function mmrSelect<T extends { title: string; snippet: string; score: number }>(
  items: T[],
  limit: number,
  lambda = 0.7,
): T[] {
  if (items.length <= limit) return items;
  const maxScore = items[0].score || 1;
  const toks = new Map<T, Set<string>>();
  const tokensFor = (r: T): Set<string> => {
    let t = toks.get(r);
    if (!t) { t = tokenSet(`${r.title} ${r.snippet}`); toks.set(r, t); }
    return t;
  };

  const selected: T[] = [];
  const remaining = [...items];
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(tokensFor(cand), tokensFor(s));
        if (sim > maxSim) maxSim = sim;
      }
      const relNorm = cand.score / maxScore;
      const mmr = lambda * relNorm - (1 - lambda) * maxSim;
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}

export function register(server: McpServer): void {
  server.tool(
    "memory_recall",
    "Search and recall memories from the vault with filtering by category, temperature, importance, and related notes. Use relatedTo to boost memories linked via [[wiki-links]] to specific notes. Recalled memories often reveal linking opportunities — if a memory mentions entities that lack [[wiki-links]], consider updating it with notes_upsert to add them",
    {
      query: z.string().describe("Search query string"),
      categories: z
        .array(z.enum(CATEGORIES))
        .optional()
        .describe("Filter by memory categories"),
      temperature: z
        .enum(['hot', 'warm', 'cold', 'any'])
        .optional()
        .default('any')
        .describe("Filter by temperature level"),
      minImportance: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe("Minimum importance level"),
      relatedTo: z
        .array(z.string())
        .optional()
        .describe("Boost results linked to these vault paths"),
      tags: z.array(z.string()).optional().describe("Filter results by tags"),
      dateFrom: z.string().optional().describe("Filter results from this date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("Filter results up to this date (YYYY-MM-DD)"),
      limit: z.number().optional().default(10).describe("Maximum number of results"),
      includeContent: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include full note content in results"),
      contextSnippet: z
        .string()
        .optional()
        .describe("Current context to improve relevance — entities and topics are auto-extracted and used to boost matching memories"),
      maxTokens: z
        .number()
        .optional()
        .describe("Maximum approximate token budget for returned content (1 token ≈ 4 chars). Results are truncated to fit within budget."),
    },
    wrapToolHandler("memory_recall", async (params) => {
      const query = sanitizeQuery(params.query as string);
      const categories = params.categories as string[] | undefined;
      const temperature = (params.temperature as string | undefined) ?? 'any';
      const minImportance = params.minImportance as string | undefined;
      const relatedTo = params.relatedTo as string[] | undefined;
      const tags = params.tags as string[] | undefined;
      const dateFrom = params.dateFrom as string | undefined;
      const dateTo = params.dateTo as string | undefined;
      const limit = (params.limit as number | undefined) ?? 10;
      const includeContent = (params.includeContent as boolean | undefined) ?? false;
      const contextSnippet = params.contextSnippet as string | undefined;
      const maxTokens = params.maxTokens as number | undefined;

      // Extract context keywords for boosting
      const STOPWORDS = new Set([
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been',
        'are', 'was', 'were', 'will', 'can', 'could', 'would', 'should',
        'not', 'but', 'they', 'their', 'them', 'what', 'which', 'when',
        'where', 'how', 'who', 'all', 'each', 'every', 'both', 'few',
        'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
        'just', 'about', 'above', 'after', 'again', 'also', 'because',
        'before', 'between', 'does', 'done', 'down', 'during', 'into',
        'its', 'only', 'our', 'out', 'over', 'own', 'same', 'then',
        'there', 'these', 'those', 'through', 'under', 'until', 'upon',
        'your', 'you', 'she', 'her', 'his', 'him',
      ]);
      const contextKeywords: string[] = [];
      if (contextSnippet) {
        const words = contextSnippet.toLowerCase().split(/\s+/);
        const seen = new Set<string>();
        for (const w of words) {
          const clean = w.replace(/[^a-z0-9]/g, '');
          if (clean.length > 3 && !STOPWORDS.has(clean) && !seen.has(clean)) {
            seen.add(clean);
            contextKeywords.push(clean);
          }
        }
      }

      if (dateFrom && !validateDateString(dateFrom)) {
        throw new Error(`Invalid dateFrom format: ${dateFrom}. Expected YYYY-MM-DD.`);
      }
      if (dateTo && !validateDateString(dateTo)) {
        throw new Error(`Invalid dateTo format: ${dateTo}. Expected YYYY-MM-DD.`);
      }

      // Over-fetch to allow for post-filtering
      const overFetchLimit = limit * 3;
      const searchStart = Date.now();
      const searchResults = await hybridSearch(query, {
        tags,
        dateFrom,
        dateTo,
        limit: overFetchLimit,
      });

      // Post-filter and re-score
      const relatedSet = relatedTo ? new Set(relatedTo) : undefined;
      const minImportanceIdx = minImportance ? IMPORTANCE_ORDER.indexOf(minImportance) : -1;

      interface ScoredResult {
        path: string;
        title: string;
        category: string;
        temperature: string;
        importance: string;
        score: number;
        lexicalScore: number;
        semanticScore: number;
        fusedScore: number;
        snippet: string;
        content?: string;
      }

      const scored: ScoredResult[] = [];

      // Score/filter entirely from the in-memory docMeta index. The fields
      // recall needs (type, category, temperature, heat_score, importance,
      // last_accessed, related, validity counters, body) are all cached at
      // index time — so the common path does ZERO disk reads. Full content is
      // fetched from disk only for the final survivors when includeContent.
      const docMeta = getDocMeta();

      for (const result of searchResults) {
        const meta = docMeta.get(result.path);
        if (!meta) continue;

        // Filter: must be a memory type
        if (meta.type !== 'memory') continue;

        const noteCategory = meta.category || 'observation';
        const noteTemperature = meta.temperature || 'warm';
        const noteImportance = meta.importance || 'medium';

        // Filter by categories
        if (categories && categories.length > 0 && !categories.includes(noteCategory)) {
          continue;
        }

        // Filter by temperature
        if (temperature !== 'any' && noteTemperature !== temperature) {
          continue;
        }

        // Filter by minImportance
        if (minImportanceIdx >= 0) {
          const noteImportanceIdx = IMPORTANCE_ORDER.indexOf(noteImportance);
          if (noteImportanceIdx < minImportanceIdx) continue;
        }

        // Bayesian validity: filter quarantined, penalize stale.
        let validityPenalty = 1.0;
        if (config.memoryValidity) {
          const v = computeValidity({
            validity_alpha: meta.validity_alpha,
            validity_beta: meta.validity_beta,
          });
          if (v.quarantined) continue;
          if (v.stale) validityPenalty = VALIDITY_STALE_RANK_PENALTY;
        }

        // Heat boost: use the granular numeric heat_score (0-16) when present,
        // mapped onto the same 0.5..1.5 band the coarse temperature bucket used
        // (0 → 0.5, 16 → 1.5); fall back to the bucket label when absent.
        const heatScore = typeof meta.heat_score === 'number' ? meta.heat_score : undefined;
        const tempBoost = heatScore !== undefined
          ? 0.5 + Math.min(Math.max(heatScore, 0), 16) / 16
          : (TEMPERATURE_BOOST[noteTemperature] ?? 1.0);
        const impBoost = IMPORTANCE_BOOST[noteImportance] ?? 1.0;

        // Temporal decay: smooth recency boost based on category half-life
        let recencyBoost = 1.0;
        const lastAccessedStr = meta.last_accessed;
        if (lastAccessedStr) {
          const lastAccessedTime = new Date(lastAccessedStr).getTime();
          if (!isNaN(lastAccessedTime)) {
            const daysSinceLastAccess = (Date.now() - lastAccessedTime) / (1000 * 60 * 60 * 24);
            const halfLifeDays = CATEGORY_HALF_LIFE_DAYS[noteCategory] ?? DEFAULT_HALF_LIFE_DAYS;
            recencyBoost = 1 / (1 + daysSinceLastAccess / halfLifeDays);
          }
        }

        let relBoost = 1.0;
        if (relatedSet) {
          const noteRelated = Array.isArray(meta.related) ? meta.related : [];
          // Check if any related wikilink references a path in relatedTo
          const hasRelation = noteRelated.some((r: string) => {
            // related stored as "[[path]]", strip brackets
            const stripped = r.replace(/^\[\[/, '').replace(/\]\]$/, '');
            return relatedSet.has(stripped);
          });
          if (hasRelation) relBoost = 2.0;
        }

        // Context boost: reward notes containing keywords from contextSnippet
        const body = meta.content ?? '';
        let contextBoost = 1.0;
        if (contextKeywords.length > 0) {
          const bodyLower = body.toLowerCase();
          let matchCount = 0;
          for (const kw of contextKeywords) {
            if (bodyLower.includes(kw)) matchCount++;
          }
          if (matchCount > 0) {
            contextBoost = Math.min(1.0 + 0.1 * matchCount, 1.5);
          }
        }

        const finalScore = result.score * tempBoost * impBoost * relBoost * recencyBoost * contextBoost * validityPenalty;

        scored.push({
          path: result.path,
          title: meta.title || result.title,
          category: noteCategory,
          temperature: noteTemperature,
          importance: noteImportance,
          score: finalScore,
          lexicalScore: result.lexicalScore,
          semanticScore: result.semanticScore,
          fusedScore: result.fusedScore,
          snippet: body.slice(0, 200),
        });
      }

      // Sort by score descending, then MMR-select the top `limit` for diversity
      scored.sort((a, b) => b.score - a.score);
      let results = mmrSelect(scored, limit);

      // Fetch full content from disk only for the final survivors, in parallel,
      // and only when the caller asked for it (the expensive path).
      if (includeContent && results.length > 0) {
        await Promise.all(results.map(async (r) => {
          try {
            const { content } = await readNote(r.path);
            r.content = content;
          } catch {
            // leave content undefined for unreadable notes
          }
        }));
      }

      const searchDurationMs = Date.now() - searchStart;
      recordSearchQuery(query, results.length, searchDurationMs);
      recordSearchScoreBreakdown(query, results);
      recordSearchTypeBreakdown(results);

      // Best-effort auto-projection of any [[code:...]] refs in result bodies.
      // Capped (3 per recall) and gated by env config; failures swallowed.
      if (config.codeAutoProjectOnRecall && results.length > 0) {
        const combined = results.map((r) => r.snippet ?? '').join('\n');
        // Fire-and-forget — never block the recall response.
        projectCodeRefsFromBody(combined, 3).catch(() => undefined);
      }

      // Apply maxTokens budget when includeContent is true
      if (maxTokens && includeContent) {
        const charBudget = maxTokens * 4;
        let charCount = 0;
        const budgetResults: ScoredResult[] = [];
        for (const r of results) {
          const entryChars = (r.content ?? '').length;
          if (charCount + entryChars <= charBudget) {
            charCount += entryChars;
            budgetResults.push(r);
          } else {
            // Truncate this result's content to fit remaining budget
            const remaining = charBudget - charCount;
            if (remaining > 0 && r.content) {
              r.content = r.content.slice(0, remaining) + '\n... [truncated to fit token budget]';
              budgetResults.push(r);
            }
            break;
          }
        }
        results = budgetResults;
      }

      // Task 2: Fire-and-forget access tracking for top results.
      // Also bumps Bayesian validity α (memory was useful) when enabled.
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < results.length; i++) {
        if (includeContent || i < 3) {
          const resultPath = results[i].path;
          // Fire-and-forget — do not await
          (async () => {
            try {
              const { content: noteContent } = await readNote(resultPath);
              const { data, body } = parseFrontmatter(noteContent);
              const currentCount = typeof data.access_count === 'number' ? data.access_count : 0;
              const currentAccessed = data.last_accessed as string | undefined;
              if (currentAccessed === today && currentCount > 0) return; // already tracked today
              data.access_count = currentCount + 1;
              data.last_accessed = today;
              const updated = stringifyFrontmatter(data, body);
              await writeNote(resultPath, updated);
            } catch {
              // ignore — best-effort tracking
            }
          })();
          if (config.memoryValidity) {
            updateValidity(resultPath, 'success').catch(() => undefined);
          }
        }
      }

      // Human-readable summary first, then structured JSON
      const summary = `Found ${results.length} memories:\n` +
        results.map((r, i) => `${i + 1}. [${r.temperature}] ${r.title} (${r.category}, score: ${r.score.toFixed(1)})`).join('\n');

      const recalledPaths = results.map(r => r.path);
      const detailStr = `q="${query}" → ${results.length} memories` +
        (results.length > 0 ? `: ${recalledPaths.slice(0, 3).map(p => p.split('/').pop()?.replace(/\.md$/, '')).join(', ')}` : '') +
        (results.length > 3 ? ` +${results.length - 3} more` : '');

      return {
        _detail: detailStr,
        content: [
          {
            type: "text",
            text: `${summary}\n\n${JSON.stringify({ results }, null, 2)}`,
          },
        ],
      };
    })
  );
}
