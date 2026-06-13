import { config } from '../config.js';
import { logger } from './logger.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Dynamic imports to avoid hard failures if deps are missing
let pipeline: any = null;
let HierarchicalNSW: any = null;

// State
let embeddingPipeline: any = null;
let index: any = null;
const pathToId = new Map<string, number>();
const idToPath = new Map<number, string>();
// Content hash per indexed path — lets boot detect which notes actually
// changed so we only re-embed the delta instead of the whole vault. Persisted
// alongside the id-map. Hash is over the exact text we feed the model (see
// embedTextFor) so a change past the embed-truncation point never re-embeds.
const pathToHash = new Map<string, string>();
let nextId = 0;
let ready = false;
// True when initEmbeddings successfully loaded a persisted index from disk.
// Boot uses this to choose an incremental sync over a full rebuild.
let loadedPersistedIndex = false;

// Stats
let totalEmbedTime = 0;
let totalEmbedCount = 0;
let lastPersist = 0;

// Debounced persist
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistIndex();
    persistTimer = null;
  }, 5_000);
}

export function isEmbeddingsReady(): boolean {
  return ready;
}

/**
 * True when a persisted HNSW index was loaded from disk at init. Boot reads
 * this to decide between an incremental sync (cheap — only the delta) and a
 * full rebuild (cold start / corrupt index).
 */
export function wasPersistedIndexLoaded(): boolean {
  return loadedPersistedIndex;
}

/**
 * The exact text we embed for a doc. Single source of truth so buildFullIndex,
 * the incremental sync, and the change-hash never drift apart. Mirrors the
 * truncation embedText applies (~256 tokens / 1024 chars).
 */
function embedTextFor(doc: { title: string; content: string }): string {
  return (doc.title + ' ' + doc.content.slice(0, 1024)).trim();
}

/** Stable content hash of the embed text — used to detect changed notes. */
function docHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Ensure the HNSW index can hold at least `target` points. hnswlib allocates a
 * fixed capacity up front and throws on addPoint once full; markDeleted points
 * still occupy slots, so an index that has seen many updates can fill well
 * before the logical size warrants it. Grow with headroom when needed.
 */
function ensureCapacity(target: number): void {
  if (!index || typeof index.getMaxElements !== 'function') return;
  try {
    const max = index.getMaxElements();
    if (target > max) {
      const grown = Math.max(target, Math.ceil(max * 1.5));
      index.resizeIndex(grown);
      logger.info('Resized HNSW index', { from: max, to: grown });
    }
  } catch (err) {
    logger.warn('HNSW resize failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function getEmbeddingStats(): {
  enabled: boolean;
  ready: boolean;
  model: string;
  indexSize: number;
  avgEmbedTimeMs: number;
  lastPersist: number;
} {
  return {
    enabled: config.enableEmbeddings,
    ready,
    model: config.embeddingModel,
    indexSize: pathToId.size,
    avgEmbedTimeMs: totalEmbedCount > 0 ? Math.round(totalEmbedTime / totalEmbedCount) : 0,
    lastPersist,
  };
}

export async function initEmbeddings(): Promise<void> {
  if (!config.enableEmbeddings) {
    logger.info('Embeddings disabled via ENABLE_EMBEDDINGS=false');
    return;
  }

  try {
    // Dynamic imports
    logger.info('Embeddings: importing @huggingface/transformers...');
    let transformers: any;
    try {
      transformers = await import('@huggingface/transformers');
    } catch (importErr) {
      logger.error('Failed to import @huggingface/transformers', {
        error: importErr instanceof Error ? importErr.message : String(importErr),
        stack: importErr instanceof Error ? importErr.stack : undefined,
      });
      ready = false;
      return;
    }
    pipeline = transformers.pipeline;
    logger.info('Embeddings: @huggingface/transformers loaded');

    // Set cache dir to persistent volume
    if (transformers.env) {
      transformers.env.cacheDir = path.join(config.embeddingsDataDir, 'models');
      // Disable local model check to allow download
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = true;
    }

    logger.info('Embeddings: importing hnswlib-node...');
    let hnswlib: any;
    try {
      hnswlib = await import('hnswlib-node');
    } catch (importErr) {
      logger.error('Failed to import hnswlib-node', {
        error: importErr instanceof Error ? importErr.message : String(importErr),
        stack: importErr instanceof Error ? importErr.stack : undefined,
      });
      ready = false;
      return;
    }
    // ESM dynamic import wraps CJS modules under .default
    const hnswExports = hnswlib.default ?? hnswlib;
    HierarchicalNSW = hnswExports.HierarchicalNSW;
    logger.info('Embeddings: hnswlib-node loaded');

    // Load embedding model
    logger.info('Loading embedding model...', { model: config.embeddingModel });
    // v3 of @huggingface/transformers replaced the v2 `quantized: true` flag
    // with an explicit `dtype` option and changed the default dtype to full
    // precision (fp32). To preserve v2's quantized embedding behavior (and the
    // resulting vector values the HNSW index was built against), pin dtype to
    // 'q8' (8-bit quantized), which matches v2's default quantized weights.
    embeddingPipeline = await pipeline('feature-extraction', config.embeddingModel, {
      dtype: 'q8',
    });
    logger.info('Embedding model loaded');

    // Warm the inference path now (at boot) rather than on the first user
    // recall. The initial forward pass JIT-compiles/allocates and can take
    // seconds — a prime suspect for slow first-recall latency. Best-effort.
    try {
      const warmStart = Date.now();
      await embedText('warmup');
      logger.info('Embedding model warmed', { ms: Date.now() - warmStart });
    } catch (warmErr) {
      logger.debug('Embedding warmup failed (non-fatal)', {
        error: warmErr instanceof Error ? warmErr.message : String(warmErr),
      });
    }

    // Ensure data directory exists
    mkdirSync(config.embeddingsDataDir, { recursive: true });

    // Try to load persisted index
    const indexPath = path.join(config.embeddingsDataDir, 'index.hnsw');
    const mapPath = path.join(config.embeddingsDataDir, 'id-map.json');

    if (existsSync(indexPath) && existsSync(mapPath)) {
      try {
        const mapData = JSON.parse(readFileSync(mapPath, 'utf-8'));

        index = new HierarchicalNSW('cosine', config.embeddingDimension);
        index.readIndexSync(indexPath);
        index.setEf(config.hnswEfSearch);

        // Restore maps
        for (const [p, id] of Object.entries(mapData.pathToId)) {
          pathToId.set(p, id as number);
          idToPath.set(id as number, p);
        }
        // Restore content hashes (absent in indexes persisted before this
        // existed — leaving them empty just means those notes re-embed once on
        // the next boot, then the hashes are written back).
        if (mapData.pathToHash) {
          for (const [p, h] of Object.entries(mapData.pathToHash)) {
            pathToHash.set(p, h as string);
          }
        }
        nextId = mapData.nextId || 0;

        ready = true;
        loadedPersistedIndex = true;
        logger.info('Loaded persisted embedding index', {
          size: pathToId.size,
          hashed: pathToHash.size,
        });
        return;
      } catch (err) {
        logger.warn('Failed to load persisted embedding index, will rebuild', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // No persisted index — create empty, will be populated by buildFullIndex()
    index = new HierarchicalNSW('cosine', config.embeddingDimension);
    index.initIndex(config.hnswMaxElements, config.hnswM, config.hnswEfConstruction);
    index.setEf(config.hnswEfSearch);
    ready = true;
    logger.info('Created empty embedding index (will populate on first full build)');

  } catch (err) {
    logger.warn('Embeddings init failed — semantic search disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    ready = false;
  }
}

/**
 * Build the full embedding index from a map of paths to text content.
 * Called after rebuildIndex() populates docMeta.
 */
export async function buildFullIndex(
  docs: ReadonlyMap<string, { title: string; content: string }>
): Promise<void> {
  if (!ready || !embeddingPipeline || !index) return;

  logger.info('Building full embedding index...', { docCount: docs.size });

  // Reset state
  pathToId.clear();
  idToPath.clear();
  pathToHash.clear();
  nextId = 0;

  // Recreate index with appropriate capacity
  const capacity = Math.max(docs.size * 2, config.hnswMaxElements);
  try {
    index = new HierarchicalNSW('cosine', config.embeddingDimension);
    index.initIndex(capacity, config.hnswM, config.hnswEfConstruction);
    index.setEf(config.hnswEfSearch);
  } catch (err) {
    logger.error('Failed to recreate HNSW index in buildFullIndex', {
      error: err instanceof Error ? err.message : String(err),
      capacity,
      dimension: config.embeddingDimension,
    });
    return;
  }

  let processed = 0;
  let errors = 0;
  const batchSize = 50;
  const entries = [...docs.entries()];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);

    for (const [docPath, doc] of batch) {
      try {
        const text = embedTextFor(doc);
        if (!text) continue;

        const embedding = await embedText(text);
        const id = nextId++;

        index.addPoint(embedding, id);
        pathToId.set(docPath, id);
        idToPath.set(id, docPath);
        pathToHash.set(docPath, docHash(text));
        processed++;
      } catch (err) {
        errors++;
        if (errors <= 3) {
          logger.warn('Failed to embed document', { path: docPath, error: String(err) });
        }
      }
    }

    if (i % 200 === 0 && i > 0) {
      logger.info('Embedding progress', { processed, errors, total: entries.length });
    }

    // Yield to event loop between batches
    if (i + batchSize < entries.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  persistIndex();
  logger.info('Full embedding index built', { processed, errors, total: docs.size });
}

/**
 * Incrementally reconcile the loaded (persisted) index against the current
 * doc set — the cheap boot path. Only notes that are new or whose content hash
 * changed get re-embedded; notes that vanished from the vault are dropped.
 * Unchanged notes (the overwhelming majority on a normal restart) cost nothing.
 *
 * This is what makes a restart fast: instead of ~4k transformer forward passes,
 * we run as many as the vault actually changed since the last persist.
 *
 * Falls back to a full build only when there is no usable persisted index
 * (handled by the caller via wasPersistedIndexLoaded()).
 */
export async function syncIndexIncremental(
  docs: ReadonlyMap<string, { title: string; content: string }>,
): Promise<{ added: number; updated: number; removed: number; unchanged: number }> {
  if (!ready || !embeddingPipeline || !index) {
    return { added: 0, updated: 0, removed: 0, unchanged: 0 };
  }

  const t0 = Date.now();
  let added = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;

  // 1. Drop vectors for notes that no longer exist in the vault.
  for (const p of [...pathToId.keys()]) {
    if (!docs.has(p)) {
      const id = pathToId.get(p);
      if (id !== undefined) {
        try { index.markDelete(id); } catch { /* already gone */ }
        idToPath.delete(id);
      }
      pathToId.delete(p);
      pathToHash.delete(p);
      removed++;
    }
  }

  // 2. Add new notes and re-embed changed ones; skip unchanged.
  let i = 0;
  for (const [docPath, doc] of docs) {
    const text = embedTextFor(doc);
    if (!text) continue;

    const h = docHash(text);
    const existingId = pathToId.get(docPath);
    if (existingId !== undefined && pathToHash.get(docPath) === h) {
      unchanged++;
    } else {
      try {
        const embedding = await embedText(text);
        if (existingId !== undefined) {
          try { index.markDelete(existingId); } catch { /* ignore */ }
          idToPath.delete(existingId);
        }
        const id = nextId++;
        ensureCapacity(nextId);
        index.addPoint(embedding, id);
        pathToId.set(docPath, id);
        idToPath.set(id, docPath);
        pathToHash.set(docPath, h);
        if (existingId !== undefined) updated++; else added++;
      } catch (err) {
        logger.warn('Incremental embed failed', { path: docPath, error: String(err) });
      }
    }

    // Yield to the event loop periodically so the sync never blocks request
    // handling (the whole point of not doing a full rebuild).
    if (++i % 50 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (added > 0 || updated > 0 || removed > 0) {
    persistIndex();
  }
  logger.info('Embedding index synced incrementally', {
    added, updated, removed, unchanged, ms: Date.now() - t0,
  });
  return { added, updated, removed, unchanged };
}

// Small LRU cache for QUERY embeddings (opt-in via opts.cache). Recall/wakeup
// re-embed the same or similar short queries repeatedly; a cache hit removes a
// full local transformer forward pass (~100-600ms) from the hot path. Document
// embedding (buildFullIndex) stays uncached — every doc is unique, so caching
// there would only thrash. Bounded so memory stays flat.
const QUERY_EMBED_CACHE_MAX = 256;
const queryEmbedCache = new Map<string, number[]>();

export async function embedText(
  text: string,
  opts?: { cache?: boolean },
): Promise<number[]> {
  if (!embeddingPipeline) throw new Error('Embedding pipeline not initialized');

  // Truncate to ~256 tokens (~1024 chars)
  const truncated = text.slice(0, 1024);

  if (opts?.cache) {
    const hit = queryEmbedCache.get(truncated);
    if (hit) {
      // Refresh recency: re-insert moves the key to the end of the Map.
      queryEmbedCache.delete(truncated);
      queryEmbedCache.set(truncated, hit);
      return hit;
    }
  }

  const start = Date.now();
  const output = await embeddingPipeline(truncated, {
    pooling: 'mean',
    normalize: true,
  });
  const elapsed = Date.now() - start;

  totalEmbedTime += elapsed;
  totalEmbedCount++;

  // hnswlib-node requires a plain number[], not Float32Array
  const vec = Array.from(output.data as Float32Array);

  if (opts?.cache) {
    queryEmbedCache.set(truncated, vec);
    if (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
      // Evict least-recently-used (oldest insertion order).
      const oldest = queryEmbedCache.keys().next().value;
      if (oldest !== undefined) queryEmbedCache.delete(oldest);
    }
  }

  return vec;
}

export async function embedAndIndex(docPath: string, text: string): Promise<void> {
  if (!ready || !index) return;

  const embedding = await embedText(text);

  // Remove old entry if exists
  const existingId = pathToId.get(docPath);
  if (existingId !== undefined) {
    try {
      index.markDelete(existingId);
    } catch {
      // may not exist
    }
    idToPath.delete(existingId);
    pathToId.delete(docPath);
  }

  const id = nextId++;
  ensureCapacity(nextId);
  index.addPoint(embedding, id);
  pathToId.set(docPath, id);
  idToPath.set(id, docPath);
  pathToHash.set(docPath, docHash(text.slice(0, 1024)));

  schedulePersist();
}

export function removeFromVectorIndex(docPath: string): void {
  if (!ready || !index) return;

  const id = pathToId.get(docPath);
  if (id !== undefined) {
    try {
      index.markDelete(id);
    } catch {
      // ignore
    }
    pathToId.delete(docPath);
    idToPath.delete(id);
    pathToHash.delete(docPath);
    schedulePersist();
  }
}

export async function searchSemantic(
  query: string,
  limit: number
): Promise<Array<{ path: string; score: number }>> {
  if (!ready || !index || pathToId.size === 0) return [];

  const queryEmbedding = await embedText(query, { cache: true });

  const numNeighbors = Math.min(limit, pathToId.size);
  const result = index.searchKnn(queryEmbedding, numNeighbors);

  const results: Array<{ path: string; score: number }> = [];
  for (let i = 0; i < result.neighbors.length; i++) {
    const id = result.neighbors[i];
    const docPath = idToPath.get(id);
    if (docPath) {
      // hnswlib returns distances; for cosine space, similarity = 1 - distance
      results.push({
        path: docPath,
        score: 1 - result.distances[i],
      });
    }
  }

  return results;
}

/**
 * Normalize text for structural-duplicate comparison: strip dates, times,
 * numbers, and common templated filler so we can detect near-duplicate
 * cron-log / auto-save noise that semantic embeddings miss because the
 * embedding picks up the changing numeric content.
 */
export function normalizeStructural(text: string): string {
  let s = text.toLowerCase();
  // ISO dates (YYYY-MM-DD)
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' <DATE> ');
  // Times (HH:MM, HH:MM:SS)
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' <TIME> ');
  // ISO timestamps with T or Z
  s = s.replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, ' <TS> ');
  // Standalone numbers (incl. floats) — replace with NUM sentinel
  s = s.replace(/\b\d+(?:[.,]\d+)?\b/g, ' <NUM> ');
  // Common templated filler that produces noise
  s = s.replace(/\b(run|cron|tick|cycle|heartbeat|auto-save|autosave|refresh|invocation|job|scheduled)\b/g, ' <EVT> ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Jaccard-based structural similarity on token shingles. Gives a normalized
 * [0,1] score without needing a vector model — robust to date/number noise.
 */
function structuralSimilarity(a: string, b: string): number {
  const tokensA = normalizeStructural(a).split(' ').filter(Boolean);
  const tokensB = normalizeStructural(b).split(' ').filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Use word-bigrams for a bit more signal than pure unigrams
  const shinglesA = new Set<string>();
  const shinglesB = new Set<string>();
  for (let i = 0; i < tokensA.length - 1; i++) shinglesA.add(tokensA[i] + ' ' + tokensA[i + 1]);
  for (let i = 0; i < tokensB.length - 1; i++) shinglesB.add(tokensB[i] + ' ' + tokensB[i + 1]);
  // Fallback to unigrams if either is a 1-token string
  if (shinglesA.size === 0) for (const t of tokensA) shinglesA.add(t);
  if (shinglesB.size === 0) for (const t of tokensB) shinglesB.add(t);

  let intersection = 0;
  for (const s of shinglesA) if (shinglesB.has(s)) intersection++;
  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export type DuplicateCheckMode = 'semantic' | 'structural';

/**
 * Check whether the given content is similar to an existing note in the
 * vault. Two modes:
 *   - "semantic"   (default): cosine similarity on sentence embeddings,
 *                  default threshold 0.92.
 *   - "structural": normalize-and-compare (dates, times, numbers, templated
 *                  filler replaced with sentinels, then token-bigram Jaccard).
 *                  Catches cron-log / auto-save near-duplicates at ~0.77
 *                  semantic similarity that the semantic path misses.
 *                  Default threshold 0.85.
 *
 * Structural mode scans candidate docs via docMeta (no vector index needed)
 * but keeps it bounded by first shortlisting with the HNSW index when
 * available; if the index is not ready we fall back to a full scan of
 * structurally-normalized cached content.
 *
 * @param content   Text to check for duplicates
 * @param threshold Similarity threshold. Defaults depend on mode.
 * @param mode      "semantic" | "structural"
 */
export async function checkSemanticDuplicate(
  content: string,
  threshold?: number,
  mode: DuplicateCheckMode = 'semantic',
): Promise<{
  isDuplicate: boolean;
  matchPath?: string;
  similarity?: number;
  mode: DuplicateCheckMode;
}> {
  if (mode === 'structural') {
    return checkStructuralDuplicate(content, threshold ?? 0.85);
  }

  const effThreshold = threshold ?? 0.92;

  if (!ready || !index || !embeddingPipeline || pathToId.size === 0) {
    return { isDuplicate: false, mode: 'semantic' };
  }

  try {
    const text = content.slice(0, 1024).trim();
    if (!text) return { isDuplicate: false, mode: 'semantic' };

    const embedding = await embedText(text);
    const numNeighbors = Math.min(1, pathToId.size);
    const result = index.searchKnn(embedding, numNeighbors);

    if (!result.neighbors || result.neighbors.length === 0) {
      return { isDuplicate: false, mode: 'semantic' };
    }

    const topId = result.neighbors[0];
    const distance = result.distances[0];
    // cosine similarity = 1 - distance for hnswlib cosine space
    const similarity = 1 - distance;
    const matchPath = idToPath.get(topId);

    if (matchPath && similarity >= effThreshold) {
      return {
        isDuplicate: true,
        matchPath,
        similarity: Math.round(similarity * 10000) / 10000,
        mode: 'semantic',
      };
    }

    return {
      isDuplicate: false,
      matchPath,
      similarity: Math.round(similarity * 10000) / 10000,
      mode: 'semantic',
    };
  } catch (err) {
    logger.warn('checkSemanticDuplicate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { isDuplicate: false, mode: 'semantic' };
  }
}

/**
 * Structural-duplicate implementation. Uses the search-index docMeta for
 * candidate text (title + content) and computes bigram-Jaccard similarity
 * on date/number/filler-normalized strings.
 *
 * Picks the top-K semantic neighbors first when the HNSW index is available
 * — this keeps it O(K) rather than O(N) for typical use. If the HNSW index
 * isn't ready, falls back to a bounded full scan (first ~500 docs).
 */
async function checkStructuralDuplicate(
  content: string,
  threshold: number,
): Promise<{
  isDuplicate: boolean;
  matchPath?: string;
  similarity?: number;
  mode: DuplicateCheckMode;
}> {
  try {
    const queryText = content.slice(0, 4096).trim();
    if (!queryText) return { isDuplicate: false, mode: 'structural' };

    // Lazy import to avoid a circular dep with search.ts
    const { getDocMeta } = await import('./search.js');
    const dm = getDocMeta();
    if (dm.size === 0) return { isDuplicate: false, mode: 'structural' };

    // Build a shortlist of candidate paths. Prefer semantic top-K when
    // embeddings are ready to keep cost bounded on large vaults.
    let candidatePaths: string[] = [];
    if (ready && index && embeddingPipeline && pathToId.size > 0) {
      try {
        const embedding = await embedText(queryText);
        const k = Math.min(20, pathToId.size);
        const result = index.searchKnn(embedding, k);
        for (const id of result.neighbors ?? []) {
          const p = idToPath.get(id);
          if (p) candidatePaths.push(p);
        }
      } catch {
        candidatePaths = [];
      }
    }
    if (candidatePaths.length === 0) {
      // Bounded full scan fallback
      const max = Math.min(500, dm.size);
      let count = 0;
      for (const p of dm.keys()) {
        if (count++ >= max) break;
        candidatePaths.push(p);
      }
    }

    let bestPath: string | undefined;
    let bestScore = 0;
    for (const p of candidatePaths) {
      const meta = dm.get(p);
      if (!meta) continue;
      const candText = (meta.title + ' ' + meta.content).slice(0, 4096);
      if (!candText.trim()) continue;
      const sim = structuralSimilarity(queryText, candText);
      if (sim > bestScore) {
        bestScore = sim;
        bestPath = p;
      }
    }

    const rounded = Math.round(bestScore * 10000) / 10000;
    if (bestPath && bestScore >= threshold) {
      return { isDuplicate: true, matchPath: bestPath, similarity: rounded, mode: 'structural' };
    }
    return { isDuplicate: false, matchPath: bestPath, similarity: rounded, mode: 'structural' };
  } catch (err) {
    logger.warn('checkStructuralDuplicate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { isDuplicate: false, mode: 'structural' };
  }
}

export function persistIndex(): void {
  if (!ready || !index) return;

  try {
    mkdirSync(config.embeddingsDataDir, { recursive: true });

    const indexPath = path.join(config.embeddingsDataDir, 'index.hnsw');
    const mapPath = path.join(config.embeddingsDataDir, 'id-map.json');
    const tmpIndex = indexPath + '.tmp';
    const tmpMap = mapPath + '.tmp';

    index.writeIndexSync(tmpIndex);
    writeFileSync(tmpMap, JSON.stringify({
      pathToId: Object.fromEntries(pathToId),
      pathToHash: Object.fromEntries(pathToHash),
      nextId,
    }));

    renameSync(tmpIndex, indexPath);
    renameSync(tmpMap, mapPath);

    lastPersist = Date.now();
    logger.info('Persisted embedding index', { size: pathToId.size });
  } catch (err) {
    logger.error('Failed to persist embedding index', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
