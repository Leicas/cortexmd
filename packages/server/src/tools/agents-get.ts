import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAgent } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'agents_get',
    `Fetch the full definition of a single agent by name: role, model, allowed_tools, diary_subdir, tags, the extracted System Prompt section, and the raw markdown body.

Returns { error: "not_found" } if no agent file matches.`,
    {
      name: z.string().describe('Agent name (kebab-case, matches the Ops/Agents/<name>.md filename and frontmatter name)'),
    },
    wrapToolHandler('agents_get', async (params) => {
      const name = (params.name as string).trim();
      const agent = await getAgent(name);

      if (!agent) {
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
            text: JSON.stringify(agent, null, 2),
          },
        ],
      };
    }),
  );
}
