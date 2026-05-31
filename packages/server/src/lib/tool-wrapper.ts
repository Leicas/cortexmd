import { recordToolCall, recordToolCallDetailed } from './metrics.js';
import { logger } from './logger.js';
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

      // Return a sanitized MCP error response - no stack traces
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: error.message,
              tool: toolName,
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
