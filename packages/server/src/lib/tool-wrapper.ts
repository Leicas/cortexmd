import { recordToolCall, recordToolCallDetailed } from './metrics.js';
import { logger } from './logger.js';
import { markActivity } from './activity.js';
import { recordCodeNavSavings, BASELINE_TOKENS_BY_TOOL, extractRepoSlug } from './code-nav/savings.js';

interface TextContent {
  type: 'text';
  text: string;
}

interface McpToolResult {
  content: TextContent[];
  isError?: boolean;
  _detail?: string;
  [key: string]: unknown;
}

type ToolHandler = (params: Record<string, unknown>) => Promise<McpToolResult>;

// Optional hook for session-level tool tracking (set from index.ts to avoid circular deps)
let sessionToolHook: ((sessionId: string, toolName: string) => void) | null = null;

export function setSessionToolHook(hook: (sessionId: string, toolName: string) => void): void {
  sessionToolHook = hook;
}

/**
 * Build a short human-readable summary from tool args for dashboard display.
 */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.query === 'string') parts.push(`q="${args.query}"`);
  if (typeof args.path === 'string') parts.push(args.path as string);
  if (typeof args.title === 'string') parts.push(`"${args.title}"`);
  if (Array.isArray(args.categories) && args.categories.length) parts.push(`cat=${args.categories.join(',')}`);
  if (typeof args.temperature === 'string' && args.temperature !== 'any') parts.push(`temp=${args.temperature}`);
  if (typeof args.limit === 'number') parts.push(`limit=${args.limit}`);
  if (Array.isArray(args.collections) && args.collections.length) parts.push(`col=${args.collections.join(',')}`);
  return parts.join(' ') || toolName;
}

interface ZodLikeIssue {
  path?: Array<string | number>;
  message?: string;
}

/**
 * Per-pattern recovery hint appended to a tool error so the agent can act on
 * it instead of retrying blindly. Returns undefined when no pattern matches.
 */
export function errorHint(err: Error & { code?: string; issues?: unknown }): string | undefined {
  const msg = err.message ?? '';
  const code = typeof err.code === 'string' ? err.code : '';

  // zod validation (tools that parse inside the handler): name the bad fields.
  if (Array.isArray(err.issues) && err.issues.length > 0) {
    const fields = (err.issues as ZodLikeIssue[])
      .slice(0, 5)
      .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
      .join('; ');
    return `invalid input — ${fields}`;
  }

  if (code === 'ENOENT' || /\bENOENT\b/.test(msg) || /note (?:not found|does not exist)/i.test(msg)) {
    return 'note path not found; use notes_search to get the exact vault path';
  }
  if (/graph has not been built/i.test(msg)) {
    return 'call graph_stats after startup finishes (it builds the link graph on demand)';
  }
  if (code === 'EACCES' || code === 'EPERM' || /\bE(?:ACCES|PERM)\b/.test(msg)) {
    return 'permission denied on the vault path; check the vault mount and file permissions';
  }
  if (/etag|modified concurrently|conflict/i.test(msg)) {
    return 'the note changed since it was read; call notes_get again and retry';
  }
  if (/is not a function|is not iterable|Cannot read propert/i.test(msg)) {
    return 'an argument had an unexpected type; pass arrays for list params (tags, categories, relatedTo) and strings for text';
  }
  if (/embeddings? (?:not|aren't|are not) (?:ready|enabled|available)/i.test(msg)) {
    return 'semantic search is still warming up; retry in a minute or use notes_search (lexical)';
  }
  if (/(?:unknown|no such|not (?:a )?registered) repo|repo .* not found/i.test(msg)) {
    return 'use code_repo_list for the registered repo slugs';
  }
  if (/invalid date|expected yyyy-mm-dd|not a valid iso/i.test(msg)) {
    return 'dates must be YYYY-MM-DD (or an ISO instant for asOf)';
  }
  if (/agentName is required|agent name/i.test(msg)) {
    return 'pass agentName="<client> (<hostname>)" — the same value used for memory_wakeup';
  }
  if (/rate limit|too many requests|429/i.test(msg)) {
    return 'rate limited; wait a few seconds before retrying';
  }
  if (/timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(msg)) {
    return 'a backend call timed out; retry once, then report it if it persists';
  }
  return undefined;
}

/**
 * Wrap a tool handler with metrics recording and error safety.
 * On error, returns a proper MCP error response with isError: true
 * and a sanitized message (no stack traces).
 *
 * The returned function accepts (args, extra) to match the MCP SDK signature,
 * but only passes args to the inner handler.
 */
export function wrapToolHandler(
  toolName: string,
  handler: ToolHandler,
): (args: Record<string, unknown>, extra: unknown) => Promise<McpToolResult> {
  return async (args: Record<string, unknown>, extra: unknown): Promise<McpToolResult> => {
    const start = Date.now();
    const argsSummary = summarizeArgs(toolName, args);
    // Mark activity so the idle-edge dream waits for real quiet (see activity.ts).
    markActivity(start);
    // Track tool usage per session
    const sessionId = (extra as any)?.sessionId as string | undefined;
    if (sessionId && sessionToolHook) sessionToolHook(sessionId, toolName);
    try {
      const result = await handler(args);
      const durationMs = Date.now() - start;
      // Tools can set _detail on the result for richer dashboard display
      const detail = result._detail ?? argsSummary;
      delete result._detail;
      recordToolCall(toolName, durationMs);
      recordToolCallDetailed(toolName, durationMs, undefined, detail);

      // Record code-nav token savings for tracked tools.
      // Compute response token estimate from the JSON-serialized content.
      // Attribute to a repo slug when we can sniff one from args/response.
      if (toolName in BASELINE_TOKENS_BY_TOOL) {
        try {
          const responseJson = JSON.stringify(result.content ?? []);
          const actualTokens = Math.ceil(responseJson.length / 4);
          const repoSlug = extractRepoSlug(args, result.content as any);
          recordCodeNavSavings(toolName, actualTokens, repoSlug);
        } catch {
          /* never let tracking fail the request */
        }
      }

      logger.debug(`Tool ${toolName} completed`, { durationMs });
      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err : new Error(String(err));
      recordToolCall(toolName, durationMs, error.message);
      recordToolCallDetailed(toolName, durationMs, error.message, argsSummary);

      logger.error(`Tool ${toolName} failed`, {
        error: error.message,
        durationMs,
      });

      // Return a sanitized MCP error response — no stack traces, but an
      // actionable "<tool> failed: <message>. Hint: <recovery>" line so the
      // agent knows what to do next instead of seeing a raw "x is not a function".
      const hint = errorHint(error as Error & { code?: string; issues?: unknown });
      const text = `${toolName} failed: ${error.message}` + (hint ? `. Hint: ${hint}` : '');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: text,
              tool: toolName,
              ...(hint ? { hint } : {}),
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
