import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeam } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'teams_get',
    `Fetch a team definition by name. With resolveMembers=true (default), each member is returned as a full AgentDef; with false, members come back as just { agent, role } name refs.

Returns { error: "not_found" } if no team file matches.`,
    {
      name: z.string().describe('Team name (kebab-case, matches Ops/Teams/<name>.md)'),
      resolveMembers: z
        .boolean()
        .optional()
        .default(true)
        .describe('When true, replace each member string with its full AgentDef'),
    },
    wrapToolHandler('teams_get', async (params) => {
      const name = (params.name as string).trim();
      const resolveMembers = (params.resolveMembers as boolean | undefined) ?? true;

      const team = await getTeam(name, resolveMembers);
      if (!team) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'not_found', name }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(team, null, 2),
          },
        ],
      };
    }),
  );
}
