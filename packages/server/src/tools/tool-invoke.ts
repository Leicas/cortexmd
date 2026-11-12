import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * `tool_invoke(name, arguments)` — generic dispatcher for tools the active
 * profile does not advertise in `tools/list` (see lib/tool-profile.ts).
 *
 * Clients such as Claude Code, Codex and ChatGPT only call tools they saw in
 * `tools/list`, so hiding a tool would otherwise make it unreachable. This tool
 * re-enters the SDK's own `tools/call` handler with the target name, so the
 * call gets exactly the same treatment as a direct call: the hidden tool's real
 * zod input schema validates `arguments`, its handler (metrics, session
 * tracking, error hints) runs, and its output schema is checked.
 */

type RawHandler = (request: unknown, extra: unknown) => Promise<unknown>;

const SELF = 'tool_invoke';

function errorResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export function register(server: McpServer): void {
  server.tool(
    SELF,
    'Call any cortexmd tool by name, including ones not in your tool list. Find the name and inputSchema with tool_search first; arguments are validated against that schema.',
    {
      name: z.string().describe('Exact tool name, e.g. "kg_query"'),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe('Arguments object for that tool (per its inputSchema)'),
    },
    async (params, extra) => {
      const name = String(params.name ?? '').trim();
      if (!name) return errorResult('tool_invoke: name is required');
      if (name === SELF) return errorResult('tool_invoke: cannot invoke itself');

      const mcp = server as unknown as {
        _registeredTools?: Record<string, unknown>;
        server?: { _requestHandlers?: Map<string, RawHandler> };
      };
      if (!mcp._registeredTools?.[name]) {
        return errorResult(`tool_invoke: unknown tool "${name}". Use tool_search to find the exact name.`);
      }
      const callTool = mcp.server?._requestHandlers?.get('tools/call');
      if (typeof callTool !== 'function') {
        return errorResult('tool_invoke: dispatcher unavailable (MCP SDK internals changed)');
      }
      const result = await callTool(
        { method: 'tools/call', params: { name, arguments: params.arguments ?? {} } },
        extra,
      );
      return result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    },
  );
}
