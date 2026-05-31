import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAgentDiary, listAgents } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'diary_read',
    `Read an agent's diary entries, or list all agents that have diaries.

Use this to review what a specific agent did in prior sessions — decisions made, observations logged, session recaps. Diary entries are timestamped and sorted newest-first.

Pass agentName to read that agent's recent entries. Pass empty string to list all known agents with their last-active date and entry count.`,
    {
      agentName: z
        .string()
        .describe(
          'Name of the agent whose diary to read. Pass empty string to list all agents.',
        ),
      lastN: z
        .number()
        .optional()
        .describe('Number of recent entries to return (default: 10)'),
    },
    wrapToolHandler('diary_read', async (params) => {
      const agentName = (params.agentName as string).trim();
      const lastN = (params.lastN as number | undefined) ?? 10;

      // List mode
      if (!agentName) {
        const agents = await listAgents();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ agents, count: agents.length }, null, 2),
            },
          ],
        };
      }

      // Read mode
      const { entries, total } = await readAgentDiary(agentName, lastN);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                agentName,
                total,
                returned: entries.length,
                entries,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}
