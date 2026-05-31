import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { acquireOperation, releaseOperation } from '../lib/operation-mutex.js';

export function register(server: McpServer): void {
  server.tool(
    'index_repair',
    `Force-rebuild one or all search indexes. Targets:
- "lexical": full-text MiniSearch rebuild
- "semantic": HNSW embedding vectors rebuild
- "graph": wiki-link graph rebuild
- "kg": knowledge graph integrity check + repair
- "kg_bootstrap": populate KG from existing vault notes (wiki-links, tags, detected entities, collection membership). Run this if KG is empty. Safe to re-run — idempotent.
- "all": lexical + semantic + graph + kg sequentially`,
    {
      target: z
        .enum(['all', 'lexical', 'semantic', 'graph', 'kg', 'kg_bootstrap'])
        .describe('Which index to rebuild or bootstrap'),
    },
    wrapToolHandler('index_repair', async (params) => {
      const target = params.target as 'all' | 'lexical' | 'semantic' | 'graph' | 'kg' | 'kg_bootstrap';

      if (!acquireOperation('repair')) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'A repair operation is already in progress', operation: 'repair' }) }],
          isError: true,
        };
      }

      try {
      const results: Array<{
        target: string;
        success: boolean;
        duration_ms: number;
        details: string;
      }> = [];

      const targets =
        target === 'all'
          ? (['lexical', 'semantic', 'graph', 'kg'] as const)
          : ([target] as const);

      for (const t of targets) {
        const start = Date.now();
        try {
          switch (t) {
            case 'lexical': {
              const { forceFullRebuild, rebuildIndex, getIndexedNoteCount } =
                await import('../lib/search.js');
              forceFullRebuild();
              await rebuildIndex();
              const count = getIndexedNoteCount();
              results.push({
                target: t,
                success: true,
                duration_ms: Date.now() - start,
                details: `Full lexical index rebuilt with ${count} notes`,
              });
              break;
            }
            case 'semantic': {
              const { isEmbeddingsReady, buildFullIndex } = await import(
                '../lib/embeddings.js'
              );
              if (!isEmbeddingsReady()) {
                results.push({
                  target: t,
                  success: false,
                  duration_ms: Date.now() - start,
                  details:
                    'Embeddings not enabled or not initialized — cannot rebuild semantic index',
                });
                break;
              }
              const { getDocMeta } = await import('../lib/search.js');
              const dm = getDocMeta();
              const docTexts = new Map<
                string,
                { title: string; content: string }
              >();
              for (const [p, meta] of dm) {
                docTexts.set(p, { title: meta.title, content: meta.content });
              }
              await buildFullIndex(docTexts);
              results.push({
                target: t,
                success: true,
                duration_ms: Date.now() - start,
                details: `Semantic index rebuilt with ${docTexts.size} documents`,
              });
              break;
            }
            case 'graph': {
              const { buildAndCacheGraph } = await import('../lib/graph.js');
              await buildAndCacheGraph();
              results.push({
                target: t,
                success: true,
                duration_ms: Date.now() - start,
                details: 'Graph rebuilt from vault wiki-links',
              });
              break;
            }
            case 'kg': {
              const { kgRepair } = await import('../lib/knowledge-graph.js');
              const kgResult = kgRepair();
              results.push({
                target: t,
                success: kgResult.status !== 'error',
                duration_ms: Date.now() - start,
                details: kgResult.detail,
              });
              break;
            }
            case 'kg_bootstrap': {
              const { isKgInitialized, kgBootstrap } = await import('../lib/knowledge-graph.js');
              if (!isKgInitialized()) {
                results.push({
                  target: t,
                  success: false,
                  duration_ms: Date.now() - start,
                  details: 'Knowledge graph not initialized (set ENABLE_KG=true)',
                });
                break;
              }
              const { getDocMeta } = await import('../lib/search.js');
              const dm = getDocMeta();
              const bootstrapResult = kgBootstrap(dm);
              results.push({
                target: t,
                success: true,
                duration_ms: bootstrapResult.duration_ms,
                details: `KG bootstrapped: ${bootstrapResult.entities} entities, ${bootstrapResult.triples} triples`,
              });
              break;
            }
          }
        } catch (err) {
          results.push({
            target: t,
            success: false,
            duration_ms: Date.now() - start,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const allSuccess = results.every((r) => r.success);
      const totalDuration = results.reduce((s, r) => s + r.duration_ms, 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              target,
              success: allSuccess,
              duration_ms: totalDuration,
              results,
            }),
          },
        ],
        _detail: `target=${target} success=${allSuccess} ${totalDuration}ms`,
      };
      } finally {
        releaseOperation('repair');
      }
    }),
  );
}
