/**
 * Token-savings tracking for code-navigation tools.
 *
 * Each code-nav tool replaces a more expensive Read/Grep workflow. We
 * estimate how many tokens would have been spent in the baseline workflow
 * and subtract the actual response size to get a per-call "tokens saved"
 * figure. Aggregated and surfaced via the dashboard + `code_nav_stats`.
 *
 * Persistence is best-effort — never throw from these helpers.
 */

/**
 * Baseline tokens that a Read/Grep equivalent of each code-nav tool would
 * cost. Conservative estimates from typical Claude Code workflows.
 */
export const BASELINE_TOKENS_BY_TOOL: Record<string, number> = {
  code_symbol_search: 800,    // Grep + 1-2 Read snippets
  code_file_outline: 4000,    // Read of average file
  code_symbol_get: 4000,      // Read of average file
  code_symbol_callers: 8000,  // Grep + multiple Read
  code_symbol_callees: 8000,
  code_change_impact: 15000,  // Multi-step manual trace
  code_full_context: 16000,   // 4-call chain: get + callers + callees + outline
  code_audit_file: 12000,     // file Read + per-symbol probes for caller/callee counts
};

/** Cap the chart history. ~33 hours at 10-min intervals. */
const MAX_HISTORY = 200;

export interface ToolSavings {
  calls: number;
  tokensSaved: number;
  avgSaved: number;
}

export interface CodeNavSavingsSnapshot {
  totalSaved: number;
  totalCalls: number;
  savedByTool: Record<string, ToolSavings>;
  savedByRepo: Record<string, ToolSavings>;
  /** Last N samples for the dashboard chart. */
  history: Array<{ ts: number; cumulativeSaved: number }>;
}

interface PerToolCounters {
  calls: number;
  tokensSaved: number;
}

const perTool: Record<string, PerToolCounters> = {};
const perRepo: Record<string, PerToolCounters> = {};
let totalSaved = 0;
let totalCalls = 0;
const history: Array<{ ts: number; cumulativeSaved: number }> = [];

/** Approximate token count for a string. ~4 chars per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Record token savings for a code-nav tool call.
 * Called from the tool wrapper after a successful response.
 *
 * `actualResponseTokens` should be `JSON.stringify(response).length / 4`.
 * If `toolName` is not in BASELINE_TOKENS_BY_TOOL, this is a no-op.
 */
export function recordCodeNavSavings(
  toolName: string,
  actualResponseTokens: number,
  repoSlug?: string | null,
): void {
  try {
    const baseline = BASELINE_TOKENS_BY_TOOL[toolName];
    if (baseline === undefined) return; // not a tracked tool
    const saved = Math.max(0, baseline - actualResponseTokens);

    if (!perTool[toolName]) {
      perTool[toolName] = { calls: 0, tokensSaved: 0 };
    }
    perTool[toolName].calls++;
    perTool[toolName].tokensSaved += saved;
    totalSaved += saved;
    totalCalls++;

    if (repoSlug && typeof repoSlug === 'string') {
      const slug = repoSlug.trim();
      if (slug) {
        if (!perRepo[slug]) perRepo[slug] = { calls: 0, tokensSaved: 0 };
        perRepo[slug].calls++;
        perRepo[slug].tokensSaved += saved;
      }
    }

    history.push({ ts: Date.now(), cumulativeSaved: totalSaved });
    if (history.length > MAX_HISTORY) history.shift();
  } catch {
    /* swallow — never let metrics tracking crash a tool */
  }
}

/**
 * Bulk-record savings from a client-side indexer that served a code-nav
 * lookup against its local DB. Same counters as `recordCodeNavSavings`, but
 * accepts pre-aggregated deltas instead of a single call. Used by the
 * `code_savings_push` MCP tool.
 */
export function recordExternalCodeNavSavings(
  toolName: string,
  calls: number,
  tokensSaved: number,
  repoSlug?: string | null,
): void {
  try {
    if (!Number.isFinite(calls) || calls <= 0) return;
    if (!Number.isFinite(tokensSaved) || tokensSaved < 0) return;
    if (!perTool[toolName]) perTool[toolName] = { calls: 0, tokensSaved: 0 };
    perTool[toolName].calls += calls;
    perTool[toolName].tokensSaved += tokensSaved;
    totalSaved += tokensSaved;
    totalCalls += calls;

    if (repoSlug && typeof repoSlug === 'string') {
      const slug = repoSlug.trim();
      if (slug) {
        if (!perRepo[slug]) perRepo[slug] = { calls: 0, tokensSaved: 0 };
        perRepo[slug].calls += calls;
        perRepo[slug].tokensSaved += tokensSaved;
      }
    }

    history.push({ ts: Date.now(), cumulativeSaved: totalSaved });
    if (history.length > MAX_HISTORY) history.shift();
  } catch {
    /* swallow */
  }
}

/** Return a fresh snapshot. */
export function getCodeNavSavings(): CodeNavSavingsSnapshot {
  const savedByTool: Record<string, ToolSavings> = {};
  for (const [name, c] of Object.entries(perTool)) {
    savedByTool[name] = {
      calls: c.calls,
      tokensSaved: c.tokensSaved,
      avgSaved: c.calls > 0 ? Math.round(c.tokensSaved / c.calls) : 0,
    };
  }
  const savedByRepo: Record<string, ToolSavings> = {};
  for (const [slug, c] of Object.entries(perRepo)) {
    savedByRepo[slug] = {
      calls: c.calls,
      tokensSaved: c.tokensSaved,
      avgSaved: c.calls > 0 ? Math.round(c.tokensSaved / c.calls) : 0,
    };
  }
  return {
    totalSaved,
    totalCalls,
    savedByTool,
    savedByRepo,
    history: history.slice(),
  };
}

/** Persisted shape (subset, history capped). */
interface PersistedSavings {
  totalSaved?: number;
  totalCalls?: number;
  perTool?: Record<string, PerToolCounters>;
  perRepo?: Record<string, PerToolCounters>;
  history?: Array<{ ts: number; cumulativeSaved: number }>;
}

/** Restore counters from a previously-persisted blob. */
export function restoreCodeNavSavings(data: unknown): void {
  try {
    if (!data || typeof data !== 'object') return;
    const p = data as PersistedSavings;
    if (typeof p.totalSaved === 'number') totalSaved = p.totalSaved;
    if (typeof p.totalCalls === 'number') totalCalls = p.totalCalls;
    if (p.perTool && typeof p.perTool === 'object') {
      for (const [name, c] of Object.entries(p.perTool)) {
        if (c && typeof c.calls === 'number' && typeof c.tokensSaved === 'number') {
          perTool[name] = { calls: c.calls, tokensSaved: c.tokensSaved };
        }
      }
    }
    if (p.perRepo && typeof p.perRepo === 'object') {
      for (const [slug, c] of Object.entries(p.perRepo)) {
        if (c && typeof c.calls === 'number' && typeof c.tokensSaved === 'number') {
          perRepo[slug] = { calls: c.calls, tokensSaved: c.tokensSaved };
        }
      }
    }
    if (Array.isArray(p.history)) {
      history.length = 0;
      for (const h of p.history.slice(-MAX_HISTORY)) {
        if (h && typeof h.ts === 'number' && typeof h.cumulativeSaved === 'number') {
          history.push({ ts: h.ts, cumulativeSaved: h.cumulativeSaved });
        }
      }
    }
  } catch {
    /* ignore corrupt persisted data */
  }
}

/** Return the persistable shape. */
export function getCodeNavSavingsForPersistence(): object {
  return {
    totalSaved,
    totalCalls,
    perTool: { ...perTool },
    perRepo: { ...perRepo },
    history: history.slice(),
  };
}

/**
 * Best-effort extraction of the repo slug a code-nav tool call touched,
 * by looking at the input args first (e.g. `args.repo`) and then sniffing
 * common shapes in the JSON response (top-level `repo`, `root.repo`,
 * dominant `results[].repo`, or `symbols[0].repo`).
 *
 * Returns null when the call spans multiple repos with no clear winner or
 * the response isn't JSON-parseable. Per-repo tracking is best-effort
 * and falls back to per-tool only.
 */
export function extractRepoSlug(
  args: Record<string, unknown> | undefined,
  content: Array<{ type?: string; text?: string }> | undefined,
): string | null {
  try {
    if (args && typeof args.repo === 'string') {
      const t = args.repo.trim();
      if (t) return t;
    }
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return null;
    const parsed = JSON.parse(first.text);
    if (parsed && typeof parsed === 'object') {
      if (typeof (parsed as any).repo === 'string') return (parsed as any).repo;
      const root = (parsed as any).root;
      if (root && typeof root.repo === 'string') return root.repo;
      const results = (parsed as any).results;
      if (Array.isArray(results) && results.length > 0) {
        const counts: Record<string, number> = {};
        for (const r of results) {
          if (r && typeof r.repo === 'string') counts[r.repo] = (counts[r.repo] ?? 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) return sorted[0][0];
      }
      const symbols = (parsed as any).symbols;
      if (Array.isArray(symbols) && symbols.length > 0) {
        const r = symbols[0]?.repo;
        if (typeof r === 'string') return r;
      }
    }
  } catch {
    /* not JSON or unexpected shape — give up silently */
  }
  return null;
}
