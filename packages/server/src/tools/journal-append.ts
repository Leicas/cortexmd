import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { findSimilarNotes } from '../lib/similar-notes.js';

export function register(server: McpServer): void {
  server.tool(
    "journal_append",
    `Append an entry to today's shared journal (Journal/YYYY/MM/YYYY-MM-DD.md). This is the vault-wide operations log — use it to record external events, tool actions, and cross-cutting observations that don't belong to any single agent.

NOT for agent self-reflection or session recaps — use diary_write for that.

Include [[wiki-links]] to connect entries to the knowledge graph. Example: "Synced with [[CRM/People/Alice.md]] about [[Projects/Beta.md]]".`,
    {
      entry: z.string().describe("The journal entry text — include [[wiki-links]] to reference people, projects, and notes mentioned in the entry"),
      source: z
        .object({
          kind: z.string().describe("Source kind (e.g. 'slack', 'email', 'manual')"),
          id: z.string().optional().describe("Optional source identifier"),
        })
        .optional()
        .describe("Source metadata for the entry"),
      tags: z.array(z.string()).optional().describe("Tags to append as hashtags to the entry"),
    },
    wrapToolHandler("journal_append", async (params) => {
      let entryText = sanitizeContent(params.entry as string, 5000);
      const tags = params.tags as string[] | undefined;
      const source = params.source as { kind: string; id?: string } | undefined;

      // Append tags as hashtags
      if (tags && tags.length > 0) {
        const hashtags = tags
          .map((t) => (t.startsWith("#") ? t : `#${t}`))
          .join(" ");
        entryText = `${entryText} ${hashtags}`;
      }

      const result = await appendJournalEntry(entryText, source);

      // Find similar notes based on the journal entry content
      const { similarNotes, suggestion } = await findSimilarNotes(entryText, result.path);

      const responseData: Record<string, unknown> = {
        path: result.path,
        lineRef: result.lineRef,
      };
      if (similarNotes.length > 0) {
        responseData.similarNotes = similarNotes;
        responseData.suggestion = suggestion;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(responseData),
          },
        ],
      };
    })
  );
}
