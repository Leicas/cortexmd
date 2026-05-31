import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    'diary_write',
    `Write to YOUR personal agent diary (Ops/Agent Diaries/{agentName}/YYYY-MM-DD.md). Use this for session recaps, decisions made, observations, and self-reflection — anything that future sessions of this agent should remember.

This is separate from journal_append (vault-wide ops log) and memory_store (structured knowledge). Diary entries are per-agent, timestamped, and read back via diary_read or memory_wakeup.

Always write a diary entry at the end of a meaningful session.`,
    {
      agentName: z
        .string()
        .describe('Name of the agent (used as filename and diary heading)'),
      entry: z
        .string()
        .describe('The diary entry text — include [[wiki-links]] to reference notes'),
      topic: z
        .string()
        .optional()
        .describe('Optional topic prefix shown in bold before the entry text'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags to append as hashtags to the entry'),
    },
    wrapToolHandler('diary_write', async (params) => {
      const agentName = (params.agentName as string).trim();
      if (!agentName) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'agentName is required' }),
            },
          ],
          isError: true,
        };
      }

      let entryText = sanitizeContent(params.entry as string, 5000);
      const topic = params.topic as string | undefined;
      const tags = params.tags as string[] | undefined;

      // Prepend topic as bold prefix
      if (topic) {
        entryText = `**[${topic}]** ${entryText}`;
      }

      // Append tags as hashtags
      if (tags && tags.length > 0) {
        const hashtags = tags
          .map((t) => (t.startsWith('#') ? t : `#${t}`))
          .join(' ');
        entryText = `${entryText} ${hashtags}`;
      }

      const result = await appendJournalEntry(entryText, undefined, agentName);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: result.path,
              lineRef: result.lineRef,
              agentName,
            }),
          },
        ],
      };
    }),
  );
}
