import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listSkills } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'skills_list',
    `List skill definitions declared under Ops/Skills/ in the vault. Each entry summarises name, description, trigger, and tags so a coordinator can pick relevant skills to inject into an agent or team prompt.

Optionally filter by tag, or by a case-insensitive substring match against the trigger field.`,
    {
      tag: z.string().optional().describe('Filter skills whose tags include this value'),
      trigger: z
        .string()
        .optional()
        .describe('Case-insensitive substring match against the skill trigger field'),
    },
    wrapToolHandler('skills_list', async (params) => {
      const tag = params.tag as string | undefined;
      const trigger = (params.trigger as string | undefined)?.trim().toLowerCase();

      const all = await listSkills(tag ? { tag } : undefined);
      const skills = trigger
        ? all.filter((s) => s.trigger.toLowerCase().includes(trigger))
        : all;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ skills, total: skills.length }, null, 2),
          },
        ],
      };
    }),
  );
}
