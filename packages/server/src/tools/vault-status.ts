import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getIndexedNoteCount, getDocMeta, getVaultHealth } from '../lib/search.js';
import { getGraphStats } from '../lib/graph.js';
import { isKgInitialized, kgStats } from '../lib/knowledge-graph.js';
import { isEmbeddingsReady, getEmbeddingStats } from '../lib/embeddings.js';
import { getCollectionNames, classifyPath } from '../lib/collections.js';
import { config } from '../config.js';
import { listAgents } from '../lib/journal.js';

const MAX_AGENTS = 10;

export function register(server: McpServer): void {
  server.tool(
    'vault_status',
    `Compact vault overview in one call — use this first to orient yourself. Returns:
- Note counts by collection (memories, projects, crm, ops, etc.) and temperature (hot/warm/cold)
- Graph connectivity summary (links, orphans), knowledge-graph and embeddings readiness
- The ${MAX_AGENTS} most recently active agents with diary entries
- Vault configuration (enabled features, multi-vault setup)
verbose=true adds the category/importance histograms, the collection catalogue, top predicates/entities and most-linked notes.

For deeper wing/room/drawer breakdown, use vault_taxonomy. For graph details, use graph_stats. For KG details, use kg_stats.`,
    {
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include histograms (categories, importance), the collection catalogue and top-N lists. Default false (compact).'),
    },
    wrapToolHandler('vault_status', async (params) => {
      const verbose = (params.verbose as boolean | undefined) ?? false;
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

        if (verbose) {
          const cat = meta.category ?? 'uncategorized';
          categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
          if (meta.importance) {
            importanceCounts[meta.importance] = (importanceCounts[meta.importance] ?? 0) + 1;
          }
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
          ...(verbose ? {
            topPredicates: kg.topPredicates?.slice(0, 5),
            topEntities: kg.topEntities?.slice(0, 5),
          } : {}),
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
      const totalAgents = agents.length;
      agents = [...agents]
        .sort((a, b) => String(b.lastActive ?? '').localeCompare(String(a.lastActive ?? '')))
        .slice(0, MAX_AGENTS);

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
        ...(verbose ? { availableCollections: getCollectionNames() } : {}),
        temperature: temperatureCounts,
        ...(verbose ? { categories: categoryCounts, importance: importanceCounts } : {}),
        health: {
          archived: health.archivedNotes,
          stale: health.staleNotes,
        },
        graph: graphStats ? {
          totalLinks: graphStats.totalLinks,
          avgLinksPerNote: graphStats.avgLinksPerNote,
          orphanNotes: graphStats.orphanNotes,
          ...(verbose ? { mostLinked: graphStats.mostLinked?.slice(0, 5) } : {}),
        } : null,
        knowledgeGraph: kgInfo,
        embeddings: {
          ready: embeddingInfo.ready,
          model: embeddingInfo.model,
          indexedVectors: embeddingInfo.indexSize,
        },
        agents,
        ...(totalAgents > agents.length ? { agentsTotal: totalAgents } : {}),
        config: configSummary,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    }),
  );
}
