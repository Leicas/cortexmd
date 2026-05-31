import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { appendJournalEntry } from '../lib/journal.js';
import { indexNote } from '../lib/search.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { recordArchive } from '../lib/metrics.js';

export function register(server: McpServer): void {
  server.tool(
    "notes_archive",
    "Archive a note by updating its frontmatter and optionally copying to an Archive folder",
    {
      path: z.string().describe("Vault-relative path to the note"),
      reason: z.string().optional().describe("Reason for archiving"),
      moveToArchive: z.boolean().optional().default(false).describe("Whether to also write a copy to Archive/"),
    },
    wrapToolHandler("notes_archive", async (params) => {
      const notePath = sanitizePath(params.path as string);
      const reason = params.reason as string | undefined;
      const moveToArchive = params.moveToArchive as boolean ?? false;

      const todayStr = new Date().toISOString().slice(0, 10);

      // 1. Read the note
      const { content } = await readNote(notePath);
      const { data, body } = parseFrontmatter(content);

      // 2. Update frontmatter
      data.archived = true;
      data.archived_at = todayStr;
      if (reason) {
        data.archive_reason = reason;
      }
      data.temperature = 'cold';
      data.heat_score = 0;

      // 3. Write back in place
      const updated = stringifyFrontmatter(data, body);
      await writeNote(notePath, updated);

      // 4. Optionally write a copy to Archive/
      let archiveCopyPath: string | undefined;
      if (moveToArchive) {
        archiveCopyPath = `Archive/${notePath}`;
        await writeNote(archiveCopyPath, updated);
      }

      recordArchive(notePath);
      await appendJournalEntry(
        `Archived note: [[${notePath}]]${reason ? ` — reason: ${reason}` : ''}`,
      );
      // Incrementally update just this note instead of full index rebuild
      await indexNote(notePath);
      if (archiveCopyPath) await indexNote(archiveCopyPath);

      const result: Record<string, unknown> = {
        path: notePath,
        archived: true,
      };
      if (archiveCopyPath) {
        result.archiveCopyPath = archiveCopyPath;
      }

      const summary = `Archived "${notePath}"` +
        (reason ? ` (reason: ${reason})` : '') +
        (archiveCopyPath ? `\nCopy written to ${archiveCopyPath}` : '');

      return {
        content: [{
          type: "text",
          text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    })
  );
}
