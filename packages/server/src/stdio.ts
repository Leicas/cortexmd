/**
 * stdio transport: `node dist/index.js --stdio`.
 *
 * Same McpServer (tools, resources, prompts, profile) as the HTTP transport,
 * but no HTTP listener, no API-key/OAuth auth (the parent process owns the
 * pipe), no dashboard and no session bookkeeping. stdout carries only
 * JSON-RPC frames: lib/stdio-guard.ts (imported first by index.ts) reroutes
 * every other stdout write to stderr, and the transport writes to the real
 * stdout through `jsonRpcStdout`.
 *
 * Startup mirrors main() in index.ts: KG init, a blocking lexical index build,
 * then embeddings + link graph in the background, and the periodic index
 * rebuild. stdin closing (the client went away) shuts the process down.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from './config.js';
import { jsonRpcStdout } from './lib/stdio-guard.js';
import { logger } from './lib/logger.js';
import { rebuildIndex, getIndexedNoteCount, getDocMeta } from './lib/search.js';
import {
  initEmbeddings,
  persistIndex as persistEmbeddingIndex,
  isEmbeddingsReady,
  buildFullIndex,
  syncIndexIncremental,
  wasPersistedIndexLoaded,
} from './lib/embeddings.js';
import { initKnowledgeGraph, shutdownKG } from './lib/knowledge-graph.js';
import { buildAndCacheGraph } from './lib/graph.js';
import { buildToolEmbeddings } from './lib/tool-meta.js';
import { flushCoRecall } from './lib/co-recall.js';
import { loadVaultRegistryIntoDb, getCodeDb } from './lib/code-nav/db.js';
import { readVaultRegistry } from './lib/code-nav/registry.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runStdio(createServer: () => McpServer): Promise<void> {
  logger.info('cortexmd starting (stdio transport)', { vaults: config.allVaults });

  const embeddingsInit = config.enableEmbeddings ? initEmbeddings() : null;
  if (config.kgEnabled) initKnowledgeGraph();

  await rebuildIndex();
  logger.info('Index built', { notes: getIndexedNoteCount() });

  // Code-nav: make the local DB know the vault-registered repos (non-fatal).
  try {
    getCodeDb();
    const reg = await readVaultRegistry();
    if (reg && reg.repos.length > 0) loadVaultRegistryIntoDb(reg.repos);
  } catch (err) {
    logger.warn('Code-nav bootstrap failed (stdio)', { error: errMsg(err) });
  }

  const server = createServer();
  const transport = new StdioServerTransport(process.stdin, jsonRpcStdout);
  await server.connect(transport);
  logger.info('cortexmd stdio transport ready');

  const rebuildTimer = setInterval(() => {
    rebuildIndex().catch((err) => logger.error('Background index rebuild failed', { error: errMsg(err) }));
  }, config.indexRebuildIntervalMs);
  rebuildTimer.unref();

  buildAndCacheGraph().catch((err) => logger.error('Link graph build failed', { error: errMsg(err) }));

  if (embeddingsInit) {
    embeddingsInit
      .then(async () => {
        const docTexts = new Map<string, { title: string; content: string }>();
        for (const [p, meta] of getDocMeta()) docTexts.set(p, { title: meta.title, content: meta.content });
        if (wasPersistedIndexLoaded()) await syncIndexIncremental(docTexts);
        else await buildFullIndex(docTexts);
        await buildToolEmbeddings();
      })
      .catch((err) => logger.error('Embeddings init failed', { error: errMsg(err) }));
  }

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('cortexmd stdio shutting down', { reason });
    clearInterval(rebuildTimer);
    try { if (isEmbeddingsReady()) persistEmbeddingIndex(); } catch { /* best-effort */ }
    try { flushCoRecall(); } catch { /* best-effort */ }
    try { if (config.kgEnabled) shutdownKG(); } catch { /* best-effort */ }
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
