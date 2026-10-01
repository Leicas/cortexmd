import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { deleteNoteWithRelink } from '../lib/note-actions.js';

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

      const { title, relinked } = await deleteNoteWithRelink(notePath, reason);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              deleted: true,
              path: notePath,
              title,
              reason,
              relinked,
            }),
          },
        ],
      };
    }),
  );
}
