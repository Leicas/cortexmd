import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    'agent_diary_append',
    `Append an entry to an agent's diary with hook-friendly "silent save" semantics.

Like diary_write, but supports a silent mode for unattended writes triggered by Claude Code hooks (Stop, PreCompact, etc). Silent entries are visually distinct in Obsidian (prefixed with _(silent)_) and carry a source annotation so you can trace which hook produced them.

Use silent=true when the write is not a deliberate user-authored session recap — e.g. automatic snapshots from Stop/PreCompact hooks. Use silent=false (default) for the same semantics as diary_write.`,
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
      silent: z
        .boolean()
        .optional()
        .describe('When true, render with a _(silent)_ marker and inject #hook tag. Default false.'),
      source: z
        .string()
        .optional()
        .describe('Source annotation, e.g. "hook:Stop" — appended as _via {source}_'),
    },
    wrapToolHandler('agent_diary_append', async (params) => {
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

      const rawEntry = sanitizeContent(params.entry as string, 5000);
      const topic = params.topic as string | undefined;
      const userTags = (params.tags as string[] | undefined) ?? [];
      const silent = (params.silent as boolean | undefined) ?? false;
      const source = params.source as string | undefined;

      const normalizeTag = (t: string): string => (t.startsWith('#') ? t : `#${t}`);

      let text: string;
      if (silent) {
        const tagSet = new Set<string>(['#hook', ...userTags.map(normalizeTag)]);
        const hashtags = Array.from(tagSet).join(' ');
        const body = topic ? `**${topic}** — ${rawEntry}` : rawEntry;
        text = `_(silent)_ ${body} ${hashtags}`.trimEnd();
        if (source) {
          text = `${text} _via ${source}_`;
        }
      } else {
        const body = topic ? `**[${topic}]** ${rawEntry}` : rawEntry;
        if (userTags.length > 0) {
          const hashtags = userTags.map(normalizeTag).join(' ');
          text = `${body} ${hashtags}`;
        } else {
          text = body;
        }
      }

      const result = await appendJournalEntry(text, undefined, agentName);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: result.path,
              lineRef: result.lineRef,
              agentName,
              silent,
            }),
          },
        ],
      };
    }),
  );
}
