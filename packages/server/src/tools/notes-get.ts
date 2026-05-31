import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { extractWikilinks } from '../lib/markdown.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { promoteOnAccess } from '../lib/memory.js';

export function register(server: McpServer): void {
  server.tool(
    "notes_get",
    "Read a note from the vault, returning its content, parsed frontmatter, outgoing [[wiki-links]], and etag. The linksOut array lists all wiki-links found in the note — use these to traverse related notes or identify missing links that should be added",
    {
      path: z.string().describe("Vault-relative path to the note"),
    },
    wrapToolHandler("notes_get", async (params) => {
      const notePath = sanitizePath(params.path as string);
      const { content, etag } = await readNote(notePath);
      const { data: frontmatter, body } = parseFrontmatter(content);
      const linksOut = extractWikilinks(content);

      // Fire-and-forget temperature promotion (with daily cap & diminishing returns)
      // Only promote structured notes that already have temperature tracking
      if (typeof frontmatter.heat_score === 'number' || frontmatter.temperature) {
        promoteOnAccess(notePath).catch(() => {
          // fire-and-forget — don't block the response
        });
      }

      const title = (frontmatter.title as string) || notePath.split('/').pop()?.replace(/\.md$/, '') || notePath;
      const detailStr = `${notePath} ("${title}")` + (linksOut.length ? ` [${linksOut.length} links]` : '');

      return {
        _detail: detailStr,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: notePath,
              content,
              frontmatter,
              linksOut,
              etag,
            }),
          },
        ],
      };
    })
  );
}
