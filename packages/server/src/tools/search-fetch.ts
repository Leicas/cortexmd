import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { recallForHook } from '../lib/recall-api.js';
import { readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { sanitizePath } from '../lib/sanitize.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

/**
 * ChatGPT connector / deep-research tool pair. ChatGPT expects exactly:
 *   search(query) → one text item holding JSON {results:[{id,title,url}]}
 *   fetch(id)     → one text item holding JSON {id,title,text,url,metadata}
 * Thin wrappers: `search` is the hook recall ranker (same ranking as
 * memory_recall, memories + notes), `fetch` is notes_get by vault path.
 *
 * Registered only under TOOL_PROFILE=chatgpt or CHATGPT_SEARCH_FETCH=true
 * (see mcp-server.ts), so other clients never see two extra generic names.
 */
export const SEARCH_FETCH_TOOL_NAMES: ReadonlyArray<string> = ['search', 'fetch'];

const SEARCH_LIMIT = 10;

/** Citation URL for a vault path: opens the note in Obsidian. */
export function noteUrl(notePath: string): string {
  const vault = path.basename(config.brainVault);
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(notePath.replace(/\.md$/, ''))}`;
}

function text(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function register(server: McpServer): void {
  server.tool(
    'search',
    "Search the user's cortexmd second brain (memories + notes). Returns result ids (vault paths) to pass to fetch.",
    { query: z.string().describe('Search query') },
    { readOnlyHint: true },
    wrapToolHandler('search', async (params) => {
      const query = String(params.query ?? '').trim();
      if (!query) return text({ results: [] });
      const recall = await recallForHook({ query, limit: SEARCH_LIMIT, kinds: 'both' });
      const merged = [...recall.memories, ...recall.notes].sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      const results: Array<{ id: string; title: string; url: string }> = [];
      for (const hit of merged) {
        if (seen.has(hit.path)) continue;
        seen.add(hit.path);
        results.push({ id: hit.path, title: hit.title, url: noteUrl(hit.path) });
        if (results.length >= SEARCH_LIMIT) break;
      }
      return { _detail: `q="${query}" → ${results.length}`, ...text({ results }) };
    }),
  );

  server.tool(
    'fetch',
    'Fetch the full text of a cortexmd note by the id (vault path) returned by search.',
    { id: z.string().describe('Result id from search (a vault-relative note path)') },
    { readOnlyHint: true },
    wrapToolHandler('fetch', async (params) => {
      const notePath = sanitizePath(String(params.id ?? ''));
      const { content } = await readNote(notePath);
      const { data } = parseFrontmatter(content);
      const title =
        (typeof data.title === 'string' && data.title) ||
        notePath.split('/').pop()?.replace(/\.md$/, '') ||
        notePath;
      const metadata: Record<string, unknown> = {};
      for (const key of ['type', 'category', 'tags', 'created', 'updated', 'importance']) {
        if (data[key] !== undefined) metadata[key] = data[key];
      }
      return {
        _detail: notePath,
        ...text({ id: notePath, title, text: content, url: noteUrl(notePath), metadata }),
      };
    }),
  );
}
