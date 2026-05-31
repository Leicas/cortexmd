import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAgents } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'agents_list',
    `List agent definitions declared under Ops/Agents/ in the vault. Each entry summarises name, role, model, and tags so a coordinator can pick the right agent for a task.

Optionally filter by tag; pass limit to cap the number returned.`,
    {
      tag: z.string().optional().describe('Filter agents whose tags include this value'),
      limit: z.number().optional().default(50).describe('Maximum number of agents to return'),
    },
    wrapToolHandler('agents_list', async (params) => {
      const tag = params.tag as string | undefined;
      const limit = (params.limit as number | undefined) ?? 50;

      const all = await listAgents(tag ? { tag } : undefined);
      const agents = all.slice(0, Math.max(0, limit));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { agents, total: all.length, returned: agents.length },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}
