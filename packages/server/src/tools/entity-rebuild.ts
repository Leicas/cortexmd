import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rebuildEntityRegistry } from '../lib/entity-backfill.js';
import { acquireOperation, releaseOperation } from '../lib/operation-mutex.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'entity_rebuild',
    `Scan the whole indexed vault corpus, run heuristic entity detection, and (re)populate the persistent entity registry (+ optional knowledge-graph mentions_* triples).

Backfills the entity registry that otherwise only fills incrementally on writes (memory_store/notes_upsert), so an existing vault that predates those write hooks surfaces its entities in the dashboard "Entity Intelligence" panel. Idempotent and safe to re-run: dedupes by normalized name, only bumps occurrences/lastSeen, and never downgrades a confirmed entity. Returns a summary of notes scanned, entities upserted, distinct names touched, KG triples created, and duration.`,
    {
      limit: z.number().int().min(0).optional().describe('Max notes to scan this run (default: all).'),
      minConfidence: z.number().min(0).max(1).optional().describe('Min detector confidence to register (default 0.7, matches write hooks).'),
      seedKg: z.boolean().optional().describe('Also seed KG mentions_* triples while scanning (default true if KG initialized).'),
    },
    wrapToolHandler('entity_rebuild', async (params) => {
      if (!acquireOperation('entity-rebuild')) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Entity rebuild already running' }),
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await rebuildEntityRegistry({
          limit: params.limit as number | undefined,
          minConfidence: params.minConfidence as number | undefined,
          seedKg: params.seedKg as boolean | undefined,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
          _detail: `scanned=${result.scanned} entities=${result.uniqueEntities} triples=${result.kgTriples}`,
        };
      } finally {
        releaseOperation('entity-rebuild');
      }
    }),
  );
}
