import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, deleteNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { removeFromIndex } from '../lib/search.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    'notes_delete',
    `Permanently delete a note from the vault. This is IRREVERSIBLE — the file is removed from disk and all indexes.

Use notes_archive instead if you want to keep the note but mark it cold/inactive. Only use notes_delete for:
- Duplicate notes that should not exist
- Test/scratch notes
- Cleanup after memory_consolidate (originals already merged)

Requires confirmation via the confirm parameter to prevent accidental deletion.`,
    {
      path: z.string().describe('Vault-relative path to the note to delete'),
      reason: z.string().describe('Why this note is being deleted — logged to journal for audit trail'),
      confirm: z
        .boolean()
        .describe('Must be true to confirm deletion. Safety guard against accidental calls.'),
    },
    wrapToolHandler('notes_delete', async (params) => {
      const notePath = sanitizePath(params.path as string);
      const reason = params.reason as string;
      const confirm = params.confirm as boolean;

      if (!confirm) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Deletion not confirmed. Set confirm: true to proceed.',
                path: notePath,
              }),
            },
          ],
          isError: true,
        };
      }

      // Read note metadata before deletion for the audit log
      let title = notePath;
      let category: string | undefined;
      try {
        const { content } = await readNote(notePath);
        const { data } = parseFrontmatter(content);
        title = data.title ?? notePath;
        category = data.category;
      } catch {
        // File might not parse — still allow deletion
      }

      // Delete the file
      await deleteNote(notePath);

      // Remove from all indexes (lexical, semantic, docMeta)
      removeFromIndex(notePath);

      // Audit trail in journal
      await appendJournalEntry(
        `Deleted note: [[${notePath}]] (${title})${category ? ` [${category}]` : ''} — reason: ${reason}`,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              deleted: true,
              path: notePath,
              title,
              reason,
            }),
          },
        ],
      };
    }),
  );
}
