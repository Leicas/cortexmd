import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { searchNotes } from '../lib/search.js';

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

      const responseData: Record<string, unknown> = {
        path: result.path,
        lineRef: result.lineRef,
      };

      // Best-effort similar-notes hint. Use lexical-only search (synchronous,
      // no query embedding or LLM rerank) so the append returns immediately
      // rather than blocking on an embed+rerank round-trip just for a hint.
      // The `similarNotes`/`suggestion` fields stay present when there are hits
      // so consumers see the same response shape.
      try {
        const query = entryText.slice(0, 500).replace(/^---[\s\S]*?---\s*/, '');
        if (query.trim().length >= 10) {
          const hits = searchNotes(query, { limit: 10 })
            .filter((r) => r.path !== result.path && r.score >= 0.005)
            .slice(0, 5);
          if (hits.length > 0) {
            responseData.similarNotes = hits.map((r) => ({
              path: r.path,
              title: r.title,
              score: Math.round(r.score * 1000) / 1000,
              snippet: r.snippet.slice(0, 150),
            }));
            responseData.suggestion = `Found ${hits.length} similar note${hits.length > 1 ? 's' : ''} -- consider consolidating or linking related content.`;
          }
        }
      } catch {
        // Non-critical: journal append must not fail on a missing/empty search index.
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
