import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listTeams } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'teams_list',
    `List team definitions declared under Ops/Teams/ in the vault. Each entry reports name, coordination mode, tags, and member count.

Optionally filter by tag.`,
    {
      tag: z.string().optional().describe('Filter teams whose tags include this value'),
    },
    wrapToolHandler('teams_list', async (params) => {
      const tag = params.tag as string | undefined;
      const teams = await listTeams(tag ? { tag } : undefined);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ teams, total: teams.length }, null, 2),
          },
        ],
      };
    }),
  );
}
