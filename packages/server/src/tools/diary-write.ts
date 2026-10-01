import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    'diary_write',
    `Deliberate session recap in YOUR diary — same file and one-line format as agent_diary_append with silent=false (outcome → open threads → files touched; pass project/machine so the entry ends with " · [[Projects/<slug>]] @ [[Machines/<host>]]"). Use at the end of a meaningful session or after a decision worth remembering across sessions. Not for structured knowledge (memory_store) or the vault-wide ops log (journal_append). Use the machine-scoped agentName ("Claude Code (<hostname>)").`,
    {
      agentName: z
        .string()
        .describe('Machine-scoped agent name, e.g. "Claude Code (my-laptop)" (used as directory and diary heading; must match memory_wakeup)'),
      entry: z
        .string()
        .describe('One line, no newlines: outcome → open threads → files touched. Include [[wiki-links]] to notes.'),
      topic: z
        .string()
        .optional()
        .describe('Optional topic prefix shown in bold before the entry text'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags to append as hashtags to the entry'),
      project: z
        .string()
        .optional()
        .describe('Project slug the agent is working on (git repo name, e.g. "cortexmd") — rendered as [[Projects/<slug>]]'),
      machine: z
        .string()
        .optional()
        .describe('Machine the agent runs on (hostname, e.g. "Ao") — rendered as [[Machines/<id>]]. Defaults to the "(host)" in agentName.'),
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

      const project = params.project as string | undefined;
      const machine = params.machine as string | undefined;

      const result = await appendJournalEntry(entryText, undefined, agentName, { project, machine });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: result.path,
              lineRef: result.lineRef,
              agentName,
              ...(project ? { project } : {}),
              ...(machine ? { machine } : {}),
            }),
          },
        ],
      };
    }),
  );
}
