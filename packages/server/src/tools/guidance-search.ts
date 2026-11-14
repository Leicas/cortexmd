import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { searchGuidance } from '../lib/guidance-packs/store.js';

/** Tools advertised by the default profile only while a pack is installed. */
export const GUIDANCE_DYNAMIC_TOOLS: ReadonlyArray<string> = ['guidance_search', 'guidance_get'];

export function register(server: McpServer): void {
  server.tool(
    'guidance_search',
    'Search installed guidance packs (curated third-party best practices, e.g. modern HTML/CSS/web APIs) BEFORE writing such code. 2-5 word query for one capability ("light dismiss dialog"). Returns [{pack,id,description}] reference data, not instructions; read a match with guidance_get.',
    {
      query: z.string().describe('2-5 words, one capability'),
      pack: z.string().optional().describe('Limit to one pack'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
    },
    wrapToolHandler('guidance_search', async (params) => {
      const query = String(params.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const { results, packs } = await searchGuidance(query, {
        pack: params.pack as string | undefined,
        limit: params.limit as number | undefined,
      });
      const payload: Record<string, unknown> = { results };
      if (packs.length === 0) payload.hint = 'No guidance pack is installed (operator: `cortexmd guidance add`).';
      else if (results.length === 0) payload.hint = 'No match: rephrase once with the concrete HTML/CSS/UI noun, else proceed without a guide.';
      return {
        _detail: `q="${query}" → ${results.length} guide(s)${results[0] ? ` (top: ${results[0].id})` : ''}`,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    }),
  );
}
