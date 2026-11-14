import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSkill } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getPackSkill, PACK_SKILL_PREFIX } from '../lib/guidance-packs/skills-bridge.js';

export function register(server: McpServer): void {
  server.tool(
    'skills_get',
    `Fetch the full definition of a single skill by name: display_name, description, trigger, tags, and the raw markdown body that will be injected into agent/team prompts.

A pack:<pack>/<skill> name returns a guidance-pack skill (third-party text, with a note mapping its CLI commands to guidance_search / guidance_get).

Returns { error: "not_found" } if no skill file matches.`,
    {
      name: z.string().describe('Skill name (kebab-case, matches Ops/Skills/<name>.md filename and frontmatter name), or pack:<pack>/<skill>'),
    },
    wrapToolHandler('skills_get', async (params) => {
      const name = (params.name as string).trim();
      const skill = name.startsWith(PACK_SKILL_PREFIX) ? await getPackSkill(name) : await getSkill(name);

      if (!skill) {
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
            text: JSON.stringify(skill),
          },
        ],
      };
    }),
  );
}
