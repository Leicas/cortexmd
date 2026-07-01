import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getIndexedNoteCount, getDocMeta, getVaultHealth } from '../lib/search.js';
import { getGraphStats } from '../lib/graph.js';
import { isKgInitialized, kgStats } from '../lib/knowledge-graph.js';
import { isEmbeddingsReady, getEmbeddingStats } from '../lib/embeddings.js';
import { getCollectionNames, classifyPath } from '../lib/collections.js';
import { config } from '../config.js';
import { listAgents } from '../lib/journal.js';

export function register(server: McpServer): void {
  server.tool(
    'vault_status',
    `Full vault overview in one call — use this first to orient yourself. Returns:
- Note counts by collection (memories, projects, crm, ops, etc.)
- Temperature distribution (hot/warm/cold) and category breakdown
- Graph connectivity summary (links, orphans, bridges)
- Knowledge graph status (entities, triples, top predicates)
- Embeddings/semantic search readiness
- Active agents with diary entries
- Vault configuration (enabled features, multi-vault setup)

For deeper wing/room/drawer breakdown, use vault_taxonomy. For graph details, use graph_stats. For KG details, use kg_stats.`,
    {},
    wrapToolHandler('vault_status', async () => {
      const noteCount = getIndexedNoteCount();
      const docMeta = getDocMeta();
      const health = getVaultHealth();

      // Collection breakdown
      const collectionCounts: Record<string, number> = {};
      const temperatureCounts: Record<string, number> = { hot: 0, warm: 0, cold: 0, unknown: 0 };
      const categoryCounts: Record<string, number> = {};
      const importanceCounts: Record<string, number> = {};

      for (const [notePath, meta] of docMeta) {
        const col = meta.collection ?? classifyPath(notePath);
        collectionCounts[col] = (collectionCounts[col] ?? 0) + 1;

        const temp = meta.temperature ?? 'unknown';
        temperatureCounts[temp] = (temperatureCounts[temp] ?? 0) + 1;

        const cat = meta.category ?? 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;

        if (meta.importance) {
          importanceCounts[meta.importance] = (importanceCounts[meta.importance] ?? 0) + 1;
        }
      }

      // Graph stats (lightweight — no BFS)
      const graphStats = getGraphStats();

      // Knowledge graph
      let kgInfo: Record<string, unknown> | null = null;
      if (isKgInitialized()) {
        const kg = kgStats();
        kgInfo = {
          entities: kg.entityCount,
          triples: kg.tripleCount,
          active: kg.activeTriples,
          expired: kg.expiredTriples,
          topPredicates: kg.topPredicates?.slice(0, 5),
          topEntities: kg.topEntities?.slice(0, 5),
        };
      }

      // Embeddings
      const embeddingInfo = getEmbeddingStats();

      // Active agents. This is auxiliary awareness data, not core status, so it
      // must never block the overview: listAgents fans its diary reads out in
      // parallel (and short-TTL caches), but we still cap the wait so a slow
      // vault filesystem can't stall the whole call — on timeout we return an
      // empty roster rather than hanging.
      let agents: Array<{ name: string; lastActive: string; entryCount: number }> = [];
      try {
        const AGENTS_TIMEOUT_MS = 750;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<typeof agents>((resolve) => {
          timer = setTimeout(() => resolve([]), AGENTS_TIMEOUT_MS);
        });
        agents = await Promise.race([listAgents(), timeout]);
        if (timer) clearTimeout(timer);
      } catch {
        // diary listing is optional
      }

      // Config summary
      const configSummary = {
        brainVault: config.brainVault,
        sourceVaults: config.sourceVaults.length,
        allVaults: config.allVaults.length,
        embeddingsEnabled: config.enableEmbeddings,
        kgEnabled: config.kgEnabled,
        rerankerEnabled: config.enableReranker,
      };

      const result = {
        totalNotes: noteCount,
        collections: collectionCounts,
        availableCollections: getCollectionNames(),
        temperature: temperatureCounts,
        categories: categoryCounts,
        importance: importanceCounts,
        health: {
          archived: health.archivedNotes,
          stale: health.staleNotes,
        },
        graph: graphStats ? {
          totalLinks: graphStats.totalLinks,
          avgLinksPerNote: graphStats.avgLinksPerNote,
          orphanNotes: graphStats.orphanNotes,
          mostLinked: graphStats.mostLinked?.slice(0, 5),
        } : null,
        knowledgeGraph: kgInfo,
        embeddings: {
          ready: embeddingInfo.ready,
          model: embeddingInfo.model,
          indexedVectors: embeddingInfo.indexSize,
        },
        agents,
        config: configSummary,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }),
  );
}
