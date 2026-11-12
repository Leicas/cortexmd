import { config, DEFAULT_EMBEDDING_MODEL } from '../config.js';
import { logger } from './logger.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chunkNote, leadText, rollupChunkHits, type ChunkHit, type ChunkRollup } from './chunking.js';

// Dynamic imports to avoid hard failures if deps are missing
let HierarchicalNSW: any = null;

// ── Model ────────────────────────────────────────────────────────────────
// `runModel` embeds a batch of already-prefixed texts → L2-normalised vectors.
// Set by initEmbeddings (transformers.js) or the test seam.
let runModel: ((texts: string[]) => Promise<number[][]>) | null = null;
// Model id + dimension the live index was built with. Normally config's; the
// dimension is corrected from the model's first output if they disagree, so a
// wrong EMBEDDING_DIMENSION can never corrupt an index.
let activeModel: string = config.embeddingModel;
let activeDim: number = config.embeddingDimension;

// ── Index state ──────────────────────────────────────────────────────────
// A note owns 1..n vectors (chunks): the lead (title + first 1,024 chars —
// the legacy one-vector-per-note text) plus, for long notes, ~200-token
// section chunks (lib/chunking.ts). Each chunk has its own HNSW label and its
// own content hash, so an edit re-embeds only the chunks whose text changed.
interface ChunkRec {
  /** HNSW label. */
  id: number;
  /** sha1 of the chunk's embed text ('' = legacy vector with no hash). */
  hash: string;
  /** Offsets into the note body (end 0 = unknown: legacy lead vector). */
  start: number;
  end: number;
}
let index: any = null;
const noteChunks = new Map<string, ChunkRec[]>();
const labelToRef = new Map<number, { path: string; i: number }>();
let nextId = 0;
let ready = false;
// True when initEmbeddings successfully loaded a persisted index from disk.
// Boot uses this to choose an incremental sync over a full rebuild.
let loadedPersistedIndex = false;
// Bumped whenever `index` is replaced (full build / compaction). A deferred
// native markDelete scheduled against an older index must not run against the
// new one (labels are renumbered).
let indexGeneration = 0;

// Stats
let totalEmbedTime = 0;
let totalEmbedCount = 0;
let lastPersist = 0;
let compactions = 0;
let lastCompaction: { at: string; live: number; dropped: number; ms: number } | null = null;

// ── Native-index lock ────────────────────────────────────────────────────
// Every native mutation (addPoint / markDelete / resize / swap) and every
// async persist runs through this FIFO chain. `writeIndex` serialises the
// index on a libuv worker thread; a concurrent addPoint (or worse, a
// resizeIndex realloc) on the main thread would race it. Embedding inference —
// the slow part — happens OUTSIDE the lock; only the cheap native ops queue.
let lockChain: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => undefined);
  return run;
}

// Debounced, non-blocking persist (async writeIndex on the libuv pool).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistIndexAsync();
  }, 5_000);
  persistTimer.unref?.();
}

export function isEmbeddingsReady(): boolean {
  return ready;
}

/**
 * True when a persisted HNSW index was loaded from disk at init. Boot reads
 * this to decide between an incremental sync (cheap — only the delta) and a
 * full rebuild (cold start / corrupt index / embedding model changed).
 */
export function wasPersistedIndexLoaded(): boolean {
  return loadedPersistedIndex;
}

/**
 * The lead embed text of a doc: title + first 1024 chars of the body — the
 * whole-note vector of the one-vector-per-note index, and still chunk 0 of
 * every note. Single source of truth for EVERY path — boot full build, boot
 * incremental sync, the runtime write path (search.indexNote → embedAndIndex)
 * and the background rescan sync — and for the change hash. Deliberately
 * unchanged so hashes persisted before chunking stay valid: migrating to
 * chunk-level vectors only ADDS section vectors for long notes.
 */
export function embedTextFor(doc: { title: string; content: string }): string {
  return leadText(doc);
}

/** Stable content hash of an embed text — used to detect changed chunks. */
export function docHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

interface PlannedChunk {
  hash: string;
  start: number;
  end: number;
  /** Text fed to the model (before the document prefix). */
  text: string;
}

/**
 * The vectors a note should have: one lead chunk, plus section chunks for
 * long notes when chunking is on. Chunks with identical embed text collapse
 * to the first occurrence (a second identical vector adds nothing).
 */
export function planChunks(doc: { title: string; content: string }): PlannedChunk[] {
  if (!config.embeddingChunking) {
    const text = embedTextFor(doc);
    return text ? [{ hash: docHash(text), start: 0, end: Math.min(doc.content.length, 1024), text }] : [];
  }
  const maxChars = Math.round(config.embeddingChunkChars * 1.15);
  const chunks = chunkNote(doc, {
    targetChars: config.embeddingChunkChars,
    maxChars,
    overlapChars: config.embeddingChunkOverlap,
    maxChunks: config.embeddingMaxChunks,
  });
  const seen = new Set<string>();
  const out: PlannedChunk[] = [];
  for (const c of chunks) {
    const hash = docHash(c.embedText);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ hash, start: c.start, end: c.end, text: c.embedText });
  }
  return out;
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
  dimension: number;
  /** Notes with at least one vector. */
  indexSize: number;
  /** Live vectors (chunks) in the HNSW index. */
  vectors: number;
  chunking: boolean;
  avgEmbedTimeMs: number;
  lastPersist: number;
  deletedSlots: number;
  pendingSync: number;
  compactions: number;
  lastCompaction: { at: string; live: number; dropped: number; ms: number } | null;
} {
  return {
    enabled: config.enableEmbeddings,
    ready,
    model: activeModel,
    dimension: activeDim,
    indexSize: noteChunks.size,
    vectors: labelToRef.size,
    chunking: config.embeddingChunking,
    avgEmbedTimeMs: totalEmbedCount > 0 ? Math.round(totalEmbedTime / totalEmbedCount) : 0,
    lastPersist,
    deletedSlots: deletedSlotCount(),
    pendingSync: pendingEmbeds.size,
    compactions,
    lastCompaction,
  };
}

/**
 * Labels occupying a slot in the native index without a live chunk (markDeleted
 * updates/removals). hnswlib never reclaims them; compaction does.
 */
function deletedSlotCount(): number {
  if (!index) return 0;
  try {
    if (typeof index.getCurrentCount === 'function') {
      return Math.max(0, index.getCurrentCount() - labelToRef.size);
    }
  } catch { /* fall through */ }
  return Math.max(0, nextId - labelToRef.size);
}

function newNativeIndex(capacity: number): any {
  const fresh = new HierarchicalNSW('cosine', activeDim);
  fresh.initIndex(capacity, config.hnswM, config.hnswEfConstruction);
  fresh.setEf(config.hnswEfSearch);
  return fresh;
}

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (!(n > 0)) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Tensor [n, d] → n plain arrays (hnswlib-node needs number[], not Float32Array). */
function tensorRows(t: any, n: number): number[][] {
  const data = t.data as Float32Array;
  const d = Math.round(data.length / n);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push(Array.from(data.subarray(i * d, (i + 1) * d)));
  return rows;
}

/** Load the configured model into `runModel` (transformers.js, CPU/ONNX). */
async function loadModel(transformers: any): Promise<void> {
  const model = config.embeddingModel;
  // v3 of @huggingface/transformers replaced the v2 `quantized: true` flag
  // with an explicit `dtype` option and changed the default dtype to full
  // precision (fp32). The default 'q8' (8-bit quantized) matches v2's default
  // quantized weights — and the vectors existing HNSW indexes were built with.
  const dtype = config.embeddingDtype;
  const modelOpts: Record<string, unknown> = { dtype };
  if (config.embeddingThreads > 0) modelOpts.session_options = { intraOpNumThreads: config.embeddingThreads };
  if (config.embeddingPooling === 'sentence_embedding') {
    // Sentence-transformers exports with a pooling+dense head baked into the
    // graph (e.g. EmbeddingGemma): read the `sentence_embedding` output.
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(model);
    const net = await transformers.AutoModel.from_pretrained(model, modelOpts);
    runModel = async (texts) => {
      const inputs = await tokenizer(texts, { padding: true, truncation: true });
      const out = await net(inputs);
      const t = out.sentence_embedding ?? out.pooler_output;
      if (!t) throw new Error(`model ${model} has no sentence_embedding output — set EMBEDDING_POOLING=mean|cls|last_token`);
      return tensorRows(t, texts.length).map(l2normalize);
    };
  } else {
    const pipe = await transformers.pipeline('feature-extraction', model, modelOpts);
    const pooling = config.embeddingPooling;
    runModel = async (texts) => {
      const out = await pipe(texts, { pooling, normalize: true });
      return tensorRows(out, texts.length);
    };
  }
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
    logger.info('Loading embedding model...', {
      model: config.embeddingModel, dtype: config.embeddingDtype, pooling: config.embeddingPooling,
    });
    await loadModel(transformers);
    activeModel = config.embeddingModel;
    activeDim = config.embeddingDimension;
    logger.info('Embedding model loaded');

    // Warm the inference path now (at boot) rather than on the first user
    // recall. The initial forward pass JIT-compiles/allocates and can take
    // seconds — a prime suspect for slow first-recall latency. The warm-up
    // vector also tells us the model's real output dimension: trust it over
    // the configured one so the index is never created with a wrong size.
    try {
      const warmStart = Date.now();
      const warm = await embedText('warmup');
      logger.info('Embedding model warmed', { ms: Date.now() - warmStart });
      if (warm.length > 0 && warm.length !== activeDim) {
        logger.warn('Embedding dimension differs from config — using the model output size', {
          model: activeModel, configured: activeDim, actual: warm.length,
        });
        activeDim = warm.length;
      }
    } catch (warmErr) {
      logger.debug('Embedding warmup failed (non-fatal)', {
        error: warmErr instanceof Error ? warmErr.message : String(warmErr),
      });
    }

    // Ensure data directory exists
    mkdirSync(config.embeddingsDataDir, { recursive: true });

    // Try to load the persisted index of THIS model + dimension.
    if (loadPersistedIndex()) return;

    // No usable persisted index (cold start, corrupt files, or the embedding
    // model/dimension changed) — create empty; the caller populates it in the
    // background with buildFullIndex().
    index = newNativeIndex(config.hnswMaxElements);
    ready = true;
    logger.info('Created empty embedding index (will populate on first full build)', {
      model: activeModel, dimension: activeDim,
    });

  } catch (err) {
    logger.warn('Embeddings init failed — semantic search disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    ready = false;
  }
}

/**
 * Load the persisted index for the active model + dimension. Returns false
 * (leaving state untouched) when there is none, it is unreadable, or it was
 * written by a different model/dimension — never throws, never mixes vectors.
 *
 * Two on-disk map formats:
 *   v2  { version: 2, model, dimension, nextId, notes: { path: [[label, hash, start, end], …] } }
 *   v1  { pathToId, pathToHash, nextId } — one vector per note (pre-chunking).
 *       Loaded as a lead chunk per note; the next incremental sync keeps those
 *       vectors (same hash) and only ADDS the missing section chunks.
 */
function loadPersistedIndex(): boolean {
  const { indexPath, mapPath } = indexFilePaths();
  if (!existsSync(indexPath) || !existsSync(mapPath)) return false;
  try {
    const mapData = JSON.parse(readFileSync(mapPath, 'utf-8'));
    const fileModel = typeof mapData.model === 'string' ? mapData.model : DEFAULT_EMBEDDING_MODEL;
    const fileDim = typeof mapData.dimension === 'number' ? mapData.dimension : 384;
    if (fileModel !== activeModel || fileDim !== activeDim) {
      logger.warn('Persisted embedding index belongs to another model — ignoring it, will rebuild', {
        file: { model: fileModel, dimension: fileDim }, active: { model: activeModel, dimension: activeDim },
      });
      return false;
    }

    const loaded = new HierarchicalNSW('cosine', activeDim);
    loaded.readIndexSync(indexPath);
    loaded.setEf(config.hnswEfSearch);

    const notes = new Map<string, ChunkRec[]>();
    if (mapData.version === 2 && mapData.notes && typeof mapData.notes === 'object') {
      for (const [p, recs] of Object.entries(mapData.notes as Record<string, unknown>)) {
        if (!Array.isArray(recs)) continue;
        const list: ChunkRec[] = [];
        for (const r of recs) {
          if (Array.isArray(r) && typeof r[0] === 'number') {
            list.push({ id: r[0], hash: String(r[1] ?? ''), start: Number(r[2]) || 0, end: Number(r[3]) || 0 });
          }
        }
        if (list.length) notes.set(p, list);
      }
    } else if (mapData.pathToId && typeof mapData.pathToId === 'object') {
      // Content hashes are absent in indexes persisted before they existed —
      // '' just means those notes re-embed once on the next sync.
      const hashes = (mapData.pathToHash ?? {}) as Record<string, string>;
      for (const [p, id] of Object.entries(mapData.pathToId as Record<string, number>)) {
        notes.set(p, [{ id, hash: hashes[p] ?? '', start: 0, end: 0 }]);
      }
    } else {
      throw new Error('unrecognised id-map format');
    }

    index = loaded;
    indexGeneration++;
    noteChunks.clear();
    labelToRef.clear();
    let maxLabel = -1;
    for (const [p, list] of notes) {
      noteChunks.set(p, list);
      list.forEach((r, i) => {
        labelToRef.set(r.id, { path: p, i });
        if (r.id > maxLabel) maxLabel = r.id;
      });
    }
    nextId = Math.max(Number(mapData.nextId) || 0, maxLabel + 1);
    ready = true;
    loadedPersistedIndex = true;
    logger.info('Loaded persisted embedding index', {
      notes: noteChunks.size,
      vectors: labelToRef.size,
      format: mapData.version === 2 ? 'v2' : 'v1 (one vector per note)',
    });
    return true;
  } catch (err) {
    logger.warn('Failed to load persisted embedding index, will rebuild', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Replace a note's chunk records. MUST run under withIndexLock. */
function setNoteUnlocked(docPath: string, next: ChunkRec[]): void {
  if (next.length === 0) noteChunks.delete(docPath);
  else noteChunks.set(docPath, next);
  next.forEach((r, i) => labelToRef.set(r.id, { path: docPath, i }));
}

/**
 * Reconcile one note's vectors with its planned chunks. MUST run under
 * withIndexLock. Chunks whose hash already has a vector keep their label (no
 * native work); new chunks are inserted from `vecs`; vectors of chunks that no
 * longer exist are markDeleted. A planned chunk with neither an existing
 * vector nor an embedding (a concurrent writer replaced it between planning
 * and applying) is skipped and the note re-queued.
 */
function applyNoteUnlocked(docPath: string, plan: PlannedChunk[], vecs: ReadonlyMap<string, number[]>): void {
  const cur = noteChunks.get(docPath) ?? [];
  const curByHash = new Map<string, ChunkRec>();
  for (const r of cur) if (r.hash && !curByHash.has(r.hash)) curByHash.set(r.hash, r);
  const kept = new Set<number>();
  const next: ChunkRec[] = [];
  let incomplete = false;
  for (const c of plan) {
    const reuse = curByHash.get(c.hash);
    if (reuse && !kept.has(reuse.id)) {
      kept.add(reuse.id);
      next.push({ id: reuse.id, hash: c.hash, start: c.start, end: c.end });
      continue;
    }
    const v = vecs.get(c.hash);
    if (!v) { incomplete = true; continue; }
    const id = nextId++;
    ensureCapacity(nextId);
    index.addPoint(v, id);
    next.push({ id, hash: c.hash, start: c.start, end: c.end });
  }
  for (const r of cur) {
    if (kept.has(r.id)) continue;
    try { index.markDelete(r.id); } catch { /* already gone */ }
    labelToRef.delete(r.id);
  }
  setNoteUnlocked(docPath, next);
  if (incomplete) {
    pendingEmbeds.add(docPath);
    kickDrain(0);
  }
}

/** Hashes a note still needs embedded, or null when its vectors are current. */
function missingChunks(docPath: string, plan: PlannedChunk[]): PlannedChunk[] | null {
  const cur = noteChunks.get(docPath);
  if (!cur) return plan;
  let same = cur.length === plan.length;
  if (same) {
    for (let i = 0; i < plan.length; i++) {
      if (cur[i].hash !== plan[i].hash) { same = false; break; }
    }
  }
  if (same) {
    // Same chunk texts — offsets may still be unknown (legacy lead) or shifted.
    for (let i = 0; i < plan.length; i++) { cur[i].start = plan[i].start; cur[i].end = plan[i].end; }
    return null;
  }
  const have = new Set(cur.map((r) => r.hash).filter(Boolean));
  return plan.filter((c) => !have.has(c.hash));
}

interface UpsertCounters { added: number; updated: number; unchanged: number; failed: number; vectors: number }

/**
 * Embed + upsert many notes. Chunk texts from consecutive notes are pooled,
 * length-sorted and run through the model in batches (inference OUTSIDE the
 * index lock); each window is then applied under the lock. Yields to the
 * event loop between windows and persists every `persistEveryMs` so a restart
 * mid-migration resumes instead of starting over.
 */
async function upsertNotes(
  docs: Iterable<[string, { title: string; content: string }]>,
  opts: { persistEveryMs?: number; onProgress?: (c: UpsertCounters) => void } = {},
): Promise<UpsertCounters> {
  const c: UpsertCounters = { added: 0, updated: 0, unchanged: 0, failed: 0, vectors: 0 };
  const windowTexts = Math.max(8, config.embeddingBatchSize * 8);
  let pending: Array<{ path: string; plan: PlannedChunk[]; missing: PlannedChunk[]; existed: boolean }> = [];
  let pendingTexts = 0;
  let lastPersistAt = Date.now();
  const gen = indexGeneration;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingTexts = 0;
    const need = new Map<string, string>();
    for (const n of batch) for (const m of n.missing) need.set(m.hash, m.text);
    const vecs = new Map<string, number[]>();
    try {
      const hashes = [...need.keys()];
      const out = await embedDocuments(hashes.map((h) => need.get(h)!));
      hashes.forEach((h, i) => vecs.set(h, out[i]));
    } catch (err) {
      // One bad text must not sink the window: retry note by note.
      for (const n of batch) {
        try {
          const out = await embedDocuments(n.missing.map((m) => m.text));
          n.missing.forEach((m, i) => vecs.set(m.hash, out[i]));
        } catch (e) {
          c.failed++;
          if (c.failed <= 3) logger.warn('Failed to embed document', { path: n.path, error: String(e) });
          n.missing = [];
          n.plan = [];
        }
      }
    }
    await withIndexLock(() => {
      // The index was rebuilt under us (full build / compaction renumbered
      // labels): applying is still correct — it works from the live maps.
      for (const n of batch) {
        if (n.plan.length === 0) continue;
        try {
          applyNoteUnlocked(n.path, n.plan, vecs);
          c.vectors += n.missing.length;
          if (n.existed) c.updated++; else c.added++;
        } catch (e) {
          c.failed++;
          if (c.failed <= 3) logger.warn('Failed to index document', { path: n.path, error: String(e) });
        }
      }
    });
    opts.onProgress?.(c);
    if (opts.persistEveryMs && Date.now() - lastPersistAt > opts.persistEveryMs && gen === indexGeneration) {
      await persistIndexAsync();
      lastPersistAt = Date.now();
    }
    // Yield so request handling never starves behind a bulk embed.
    await new Promise((resolve) => setImmediate(resolve));
  };

  let i = 0;
  for (const [docPath, doc] of docs) {
    const plan = planChunks(doc);
    if (plan.length > 0) {
      const missing = missingChunks(docPath, plan);
      if (missing === null) {
        c.unchanged++;
      } else {
        pending.push({ path: docPath, plan, missing, existed: noteChunks.has(docPath) });
        pendingTexts += missing.length;
        if (pendingTexts >= windowTexts) await flush();
      }
    }
    if (++i % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  await flush();
  return c;
}

/**
 * Build the full embedding index from a map of paths to text content.
 * Called after rebuildIndex() populates docMeta. The swap to a fresh index is
 * atomic under the native-index lock; the build then embeds in windows
 * (inference outside the lock, yielding between windows so requests keep
 * flowing) and persists periodically so an interrupted build resumes as an
 * incremental sync.
 */
export async function buildFullIndex(
  docs: ReadonlyMap<string, { title: string; content: string }>
): Promise<void> {
  if (!ready || !runModel || !index) return;
  const t0 = Date.now();
  logger.info('Building full embedding index...', { docCount: docs.size, model: activeModel, chunking: config.embeddingChunking });

  const swapped = await withIndexLock(() => {
    // Recreate index with appropriate capacity
    const capacity = Math.max(docs.size * 2, config.hnswMaxElements);
    let fresh: any;
    try {
      fresh = newNativeIndex(capacity);
    } catch (err) {
      logger.error('Failed to recreate HNSW index in buildFullIndex', {
        error: err instanceof Error ? err.message : String(err),
        capacity,
        dimension: activeDim,
      });
      return false;
    }
    // Reset state
    index = fresh;
    indexGeneration++;
    noteChunks.clear();
    labelToRef.clear();
    nextId = 0;
    return true;
  });
  if (!swapped) return;

  let lastLog = Date.now();
  const c = await upsertNotes(docs.entries(), {
    persistEveryMs: 120_000,
    onProgress: (p) => {
      if (Date.now() - lastLog > 15_000) {
        lastLog = Date.now();
        logger.info('Embedding progress', { notes: p.added + p.updated, vectors: p.vectors, errors: p.failed, total: docs.size });
      }
    },
  });

  await persistIndexAsync();
  logger.info('Full embedding index built', {
    processed: c.added + c.updated, errors: c.failed, total: docs.size, vectors: labelToRef.size, ms: Date.now() - t0,
  });
}

/**
 * Incrementally reconcile the loaded (persisted) index against the current
 * doc set — the cheap boot path. Only chunks that are new or whose content
 * hash changed get embedded; notes that vanished from the vault are dropped.
 * Unchanged notes (the overwhelming majority on a normal restart) cost nothing.
 *
 * This is also the migration path from a one-vector-per-note index: every
 * existing vector is the note's lead chunk and is kept; only the section
 * chunks of long notes are embedded, in the background, while the old vectors
 * keep serving searches.
 *
 * Falls back to a full build only when there is no usable persisted index
 * (handled by the caller via wasPersistedIndexLoaded()).
 */
export async function syncIndexIncremental(
  docs: ReadonlyMap<string, { title: string; content: string }>,
): Promise<{ added: number; updated: number; removed: number; unchanged: number }> {
  if (!ready || !runModel || !index) {
    return { added: 0, updated: 0, removed: 0, unchanged: 0 };
  }

  const t0 = Date.now();
  let removed = 0;

  // 1. Drop vectors for notes that no longer exist in the vault.
  await withIndexLock(() => {
    for (const p of [...noteChunks.keys()]) {
      if (!docs.has(p)) {
        for (const r of noteChunks.get(p) ?? []) {
          try { index.markDelete(r.id); } catch { /* already gone */ }
          labelToRef.delete(r.id);
        }
        noteChunks.delete(p);
        removed++;
      }
    }
  });

  // 2. Add new notes and (re-)embed changed chunks; skip unchanged. Inference
  //    runs outside the lock; only the native insert takes it.
  const c = await upsertNotes(docs.entries(), { persistEveryMs: 120_000 });

  if (c.added > 0 || c.updated > 0 || removed > 0) {
    await persistIndexAsync();
  }
  logger.info('Embedding index synced incrementally', {
    added: c.added, updated: c.updated, removed, unchanged: c.unchanged,
    embedded: c.vectors, vectors: labelToRef.size, ms: Date.now() - t0,
  });
  maybeScheduleCompaction();
  return { added: c.added, updated: c.updated, removed, unchanged: c.unchanged };
}

// Small LRU cache for QUERY embeddings (opt-in via opts.cache). Recall/wakeup
// re-embed the same or similar short queries repeatedly; a cache hit removes a
// full local transformer forward pass (~100-600ms) from the hot path. Document
// embedding (buildFullIndex) stays uncached — every doc is unique, so caching
// there would only thrash. Bounded so memory stays flat.
const QUERY_EMBED_CACHE_MAX = 256;
const queryEmbedCache = new Map<string, number[]>();

/**
 * Embed one text. `kind: 'query'` applies the model's query prefix (e.g.
 * `query: ` for E5), anything else the document prefix — symmetric uses
 * (duplicate checks, clustering) embed both sides as documents.
 */
export async function embedText(
  text: string,
  opts?: { cache?: boolean; kind?: 'query' | 'document' },
): Promise<number[]> {
  if (!runModel) throw new Error('Embedding pipeline not initialized');

  // Truncate to ~256 tokens (~1024 chars)
  const truncated = text.slice(0, config.embeddingMaxChars);
  const kind = opts?.kind ?? 'document';
  const prefix = kind === 'query' ? config.embeddingQueryPrefix : config.embeddingDocPrefix;

  // Normalize the cache key (not the embedded text) to raise hit rate:
  // case/whitespace variants of the same query share one cached vector.
  const cacheKey = kind + '\u0000' + truncated.toLowerCase().trim().replace(/\s+/g, ' ');

  if (opts?.cache) {
    const hit = queryEmbedCache.get(cacheKey);
    if (hit) {
      // Refresh recency: re-insert moves the key to the end of the Map.
      queryEmbedCache.delete(cacheKey);
      queryEmbedCache.set(cacheKey, hit);
      return hit;
    }
  }

  const start = Date.now();
  const [vec] = await runModel([prefix + truncated]);
  const elapsed = Date.now() - start;

  totalEmbedTime += elapsed;
  totalEmbedCount++;

  if (opts?.cache) {
    queryEmbedCache.set(cacheKey, vec);
    if (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
      // Evict least-recently-used (oldest insertion order).
      const oldest = queryEmbedCache.keys().next().value;
      if (oldest !== undefined) queryEmbedCache.delete(oldest);
    }
  }

  return vec;
}

/**
 * Embed document texts in batches (document prefix applied). Texts are sorted
 * by length before batching so padding waste stays small; output order
 * matches input order.
 */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (!runModel) throw new Error('Embedding pipeline not initialized');
  if (texts.length === 0) return [];
  const prepared = texts.map((t) => config.embeddingDocPrefix + t.slice(0, config.embeddingMaxChars));
  const order = prepared.map((_, i) => i).sort((a, b) => prepared[a].length - prepared[b].length);
  const out: number[][] = new Array(texts.length);
  const bs = Math.max(1, config.embeddingBatchSize);
  for (let i = 0; i < order.length; i += bs) {
    const idxs = order.slice(i, i + bs);
    const start = Date.now();
    const vecs = await runModel(idxs.map((j) => prepared[j]));
    totalEmbedTime += Date.now() - start;
    totalEmbedCount += idxs.length;
    idxs.forEach((j, k) => { out[j] = vecs[k]; });
  }
  return out;
}

/**
 * Embed one note and upsert its vectors. `doc` is title + body — the SAME
 * chunk plan and hashes as the boot and rescan paths. Only chunks whose embed
 * text changed are run through the model; when nothing changed (a
 * frontmatter-only edit: heat score, last_accessed, tags…) the forward pass is
 * skipped entirely.
 */
export async function embedAndIndex(
  docPath: string,
  doc: { title: string; content: string },
): Promise<'embedded' | 'unchanged' | 'skipped'> {
  if (!ready || !index) return 'skipped';
  const plan = planChunks(doc);
  if (plan.length === 0) return 'skipped';
  const missing = missingChunks(docPath, plan);
  if (missing === null) return 'unchanged';

  const vecs = new Map<string, number[]>();
  if (missing.length > 0) {
    const out = await embedDocuments(missing.map((m) => m.text));
    missing.forEach((m, i) => vecs.set(m.hash, out[i]));
  }
  await withIndexLock(() => applyNoteUnlocked(docPath, plan, vecs));
  schedulePersist();
  maybeScheduleCompaction();
  return 'embedded';
}

export function removeFromVectorIndex(docPath: string): void {
  if (!ready || !index) return;

  const recs = noteChunks.get(docPath);
  if (recs) {
    // Maps update synchronously (search results drop the path at once); the
    // native markDelete queues behind any in-flight persist/compaction, and is
    // skipped if the index was rebuilt meanwhile (labels renumbered — the
    // rebuild already excluded this path).
    noteChunks.delete(docPath);
    const ids = recs.map((r) => r.id);
    for (const id of ids) labelToRef.delete(id);
    const gen = indexGeneration;
    void withIndexLock(() => {
      if (gen !== indexGeneration) return;
      for (const id of ids) {
        try { index.markDelete(id); } catch { /* ignore */ }
      }
    });
    schedulePersist();
    maybeScheduleCompaction();
  }
}

/** A note-level semantic hit. `path` + `score` are the stable contract. */
export interface SemanticHit {
  path: string;
  /** Note-level cosine (best chunk, or mean of the two best — see rollup). */
  score: number;
  /**
   * The note's best-matching chunk: offsets into the note body and, when the
   * body is available, its text — for a query-aware snippet or as the passage
   * handed to a reranker. Absent for vectors not yet migrated to chunk offsets.
   */
  chunk?: { index: number; start: number; end: number; text?: string };
  /** Number of the note's chunks among the retrieved neighbours. */
  matchedChunks?: number;
}

/** Chunk-level kNN: up to `k` live vectors nearest to the query vector. */
function knnChunks(queryEmbedding: number[], k: number): ChunkHit[] {
  const n = Math.min(k, labelToRef.size);
  if (n <= 0) return [];
  // hnswlib only explores `ef` candidates: a k above ef returns short lists.
  try { index.setEf(Math.max(config.hnswEfSearch, n)); } catch { /* keep current ef */ }
  const result = index.searchKnn(queryEmbedding, n);
  const hits: ChunkHit[] = [];
  for (let i = 0; i < result.neighbors.length; i++) {
    const ref = labelToRef.get(result.neighbors[i]);
    if (!ref) continue;
    const rec = noteChunks.get(ref.path)?.[ref.i];
    // hnswlib returns distances; for cosine space, similarity = 1 - distance
    hits.push({ path: ref.path, index: ref.i, score: 1 - result.distances[i], start: rec?.start ?? 0, end: rec?.end ?? 0 });
  }
  return hits;
}

/**
 * Semantic search at NOTE level: kNN over chunk vectors, rolled up per note
 * (best chunk by default). Returns at most `limit` notes, best first, each
 * with its best-matching chunk. `{ path, score }` is unchanged from the
 * one-vector-per-note days; `chunk` / `matchedChunks` are additive.
 */
export async function searchSemantic(
  query: string,
  limit: number,
  opts: { rollup?: ChunkRollup; withText?: boolean } = {},
): Promise<SemanticHit[]> {
  if (!ready || !index || labelToRef.size === 0) return [];

  const queryEmbedding = await embedText(query, { cache: true, kind: 'query' });

  // Several chunks of one note can crowd the neighbour list, so over-fetch by
  // the index's vectors-per-note ratio (+50%) to still surface `limit` notes.
  const ratio = labelToRef.size / Math.max(1, noteChunks.size);
  const k = ratio > 1.001 ? Math.ceil(limit * ratio * 1.5) : limit;
  const notes = rollupChunkHits(knnChunks(queryEmbedding, k), opts.rollup ?? config.embeddingChunkRollup).slice(0, limit);

  let docMeta: ReadonlyMap<string, { content: string }> | null = null;
  if (opts.withText !== false) {
    try {
      // Lazy import to avoid a circular dep with search.ts
      docMeta = (await import('./search.js')).getDocMeta();
    } catch { docMeta = null; }
  }

  return notes.map((n) => {
    const hit: SemanticHit = { path: n.path, score: n.score, matchedChunks: n.matched };
    if (n.best.end > n.best.start) {
      hit.chunk = { index: n.best.index, start: n.best.start, end: n.best.end };
      const content = docMeta?.get(n.path)?.content;
      if (typeof content === 'string' && content.length >= n.best.start) {
        hit.chunk.text = content.slice(n.best.start, n.best.end);
      }
    }
    return hit;
  });
}

/**
 * Best-matching chunk of each given note for a query — exact cosine against
 * the note's stored chunk vectors (no kNN, no extra model pass beyond the
 * cached query embedding). Works for ANY candidate, including notes only the
 * lexical or graph arm surfaced; use it for query-aware snippets and as the
 * passage handed to a reranker. Notes without vectors/offsets are omitted.
 */
export async function bestChunksFor(
  query: string,
  paths: Iterable<string>,
  opts: { withText?: boolean } = {},
): Promise<Map<string, { index: number; start: number; end: number; score: number; text?: string }>> {
  const out = new Map<string, { index: number; start: number; end: number; score: number; text?: string }>();
  if (!ready || !index || labelToRef.size === 0) return out;
  const q = await embedText(query, { cache: true, kind: 'query' });
  let docMeta: ReadonlyMap<string, { content: string }> | null = null;
  if (opts.withText !== false) {
    try { docMeta = (await import('./search.js')).getDocMeta(); } catch { docMeta = null; }
  }
  for (const p of paths) {
    const recs = noteChunks.get(p);
    if (!recs) continue;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < recs.length; i++) {
      let v: number[];
      try { v = index.getPoint(recs[i].id); } catch { continue; }
      let dot = 0;
      let nv = 0;
      for (let d = 0; d < v.length; d++) { dot += v[d] * q[d]; nv += v[d] * v[d]; }
      const score = nv > 0 ? dot / Math.sqrt(nv) : 0;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) continue;
    const r = recs[best];
    if (!(r.end > r.start)) continue;
    const hit: { index: number; start: number; end: number; score: number; text?: string } =
      { index: best, start: r.start, end: r.end, score: bestScore };
    const content = docMeta?.get(p)?.content;
    if (typeof content === 'string' && content.length >= r.start) hit.text = content.slice(r.start, r.end);
    out.set(p, hit);
  }
  return out;
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

  if (!ready || !index || !runModel || labelToRef.size === 0) {
    return { isDuplicate: false, mode: 'semantic' };
  }

  try {
    const text = content.slice(0, 1024).trim();
    if (!text) return { isDuplicate: false, mode: 'semantic' };

    const embedding = await embedText(text);
    // A duplicate is a near-copy of a whole NOTE: compare against lead vectors
    // only (chunk 0 = title + opening — what the one-vector-per-note index
    // held), so a paragraph buried in a long digest never blocks a new memory.
    const top = knnChunks(embedding, 16).find((h) => h.index === 0);
    if (!top) {
      return { isDuplicate: false, mode: 'semantic' };
    }
    const similarity = top.score;
    const matchPath: string | undefined = top.path;

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
    if (ready && index && runModel && labelToRef.size > 0) {
      try {
        const embedding = await embedText(queryText);
        const k = Math.min(20, labelToRef.size);
        const result = index.searchKnn(embedding, k);
        for (const id of result.neighbors ?? []) {
          const p = labelToRef.get(id)?.path;
          if (p && !candidatePaths.includes(p)) candidatePaths.push(p);
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

/**
 * Index files of the active model + dimension. The default model keeps the
 * historical names (index.hnsw / id-map.json); every other (model, dimension)
 * pair gets its own pair of files, so switching EMBEDDING_MODEL never loads —
 * or overwrites — vectors of another model. Switching back reuses the old
 * files as-is.
 */
export function embeddingIndexTag(model: string, dimension: number): string {
  if (model === DEFAULT_EMBEDDING_MODEL && dimension === 384) return '';
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `-${slug}-${dimension}`;
}

function indexFilePaths(): { indexPath: string; mapPath: string } {
  const tag = embeddingIndexTag(activeModel, activeDim);
  return {
    indexPath: path.join(config.embeddingsDataDir, `index${tag}.hnsw`),
    mapPath: path.join(config.embeddingsDataDir, `id-map${tag}.json`),
  };
}

function serializeMaps(): string {
  const notes: Record<string, Array<[number, string, number, number]>> = {};
  for (const [p, recs] of noteChunks) notes[p] = recs.map((r) => [r.id, r.hash, r.start, r.end]);
  return JSON.stringify({ version: 2, model: activeModel, dimension: activeDim, nextId, notes });
}

let tmpSeq = 0;
function tmpSuffix(): string {
  return `.tmp-${process.pid}-${++tmpSeq}`;
}

// Set by the synchronous shutdown persist: an async persist still in flight
// must not rename an older snapshot over the final one.
let finalPersistDone = false;

/**
 * Async persist body. MUST run under withIndexLock: the index is serialised on
 * a libuv worker (`writeIndex`) while the main thread keeps serving searches;
 * no native mutation can interleave because they all queue on the same lock.
 * tmp + rename keeps each file atomic; the id-map is snapshotted BEFORE the
 * index write so it never names a label the index file lacks.
 */
async function persistUnlocked(): Promise<void> {
  if (!ready || !index) return;
  const { indexPath, mapPath } = indexFilePaths();
  const suffix = tmpSuffix();
  const tmpIndex = indexPath + suffix;
  const tmpMap = mapPath + suffix;
  const t0 = Date.now();
  try {
    await mkdir(config.embeddingsDataDir, { recursive: true });
    const mapJson = serializeMaps();
    const size = labelToRef.size;
    if (typeof index.writeIndex === 'function') {
      await index.writeIndex(tmpIndex);
    } else {
      index.writeIndexSync(tmpIndex);
    }
    await writeFile(tmpMap, mapJson);
    if (finalPersistDone) {
      await unlink(tmpIndex).catch(() => undefined);
      await unlink(tmpMap).catch(() => undefined);
      return;
    }
    await rename(tmpIndex, indexPath);
    await rename(tmpMap, mapPath);
    lastPersist = Date.now();
    logger.info('Persisted embedding index', { size, ms: lastPersist - t0 });
  } catch (err) {
    await unlink(tmpIndex).catch(() => undefined);
    await unlink(tmpMap).catch(() => undefined);
    logger.error('Failed to persist embedding index', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Non-blocking persist (queued on the index lock). */
export function persistIndexAsync(): Promise<void> {
  return withIndexLock(() => persistUnlocked());
}

/**
 * Synchronous persist — ONLY for shutdown paths that exit right after (the
 * event loop may not get another turn). Normal writes use the debounced async
 * persist. Unique tmp names so it can never collide with an async persist.
 */
export function persistIndex(): void {
  if (!ready || !index) return;

  const { indexPath, mapPath } = indexFilePaths();
  const suffix = tmpSuffix();
  const tmpIndex = indexPath + suffix;
  const tmpMap = mapPath + suffix;
  try {
    mkdirSync(config.embeddingsDataDir, { recursive: true });
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    index.writeIndexSync(tmpIndex);
    writeFileSync(tmpMap, serializeMaps());

    renameSync(tmpIndex, indexPath);
    renameSync(tmpMap, mapPath);
    finalPersistDone = true;

    lastPersist = Date.now();
    logger.info('Persisted embedding index', { size: labelToRef.size });
  } catch (err) {
    try { unlinkSync(tmpIndex); } catch { /* ignore */ }
    try { unlinkSync(tmpMap); } catch { /* ignore */ }
    logger.error('Failed to persist embedding index', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Compaction ───────────────────────────────────────────────────────────

let compactTimer: ReturnType<typeof setTimeout> | null = null;
let compacting = false;

/** True when dead slots exceed the configured ratio of live vectors. */
export function needsCompaction(): boolean {
  if (!ready || !index) return false;
  const dead = deletedSlotCount();
  const live = Math.max(1, labelToRef.size);
  return dead >= config.hnswCompactMinDeleted && dead > config.hnswCompactRatio * live;
}

function maybeScheduleCompaction(): void {
  if (compacting || compactTimer || !needsCompaction()) return;
  compactTimer = setTimeout(() => {
    compactTimer = null;
    void compactIndex().catch((err) => {
      logger.warn('HNSW compaction failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, 1_000);
  compactTimer.unref?.();
}

/**
 * Rebuild the HNSW graph from the live STORED vectors (getPoint — no model
 * inference; every chunk vector of every note), dropping markDeleted slots and
 * renumbering labels 0..n-1. Runs
 * under the index lock in chunks with event-loop yields; searches keep using
 * the old index until the synchronous swap at the end. Removals that land
 * mid-compaction only touch the maps (their native markDelete is deferred and
 * generation-checked), so the swap simply skips paths no longer mapped.
 */
export async function compactIndex(opts: { chunk?: number } = {}): Promise<{ live: number; dropped: number } | null> {
  if (!ready || !index || !HierarchicalNSW || compacting) return null;
  compacting = true;
  try {
    return await withIndexLock(async () => {
      const t0 = Date.now();
      const old = index;
      const deadBefore = deletedSlotCount();
      const labels = [...labelToRef.keys()];
      const capacity = Math.max(labels.length * 2, config.hnswMaxElements);
      const fresh = newNativeIndex(capacity);

      const chunk = Math.max(1, opts.chunk ?? 64); // ~60 ms of addPoint per slice at 10k × 384-d
      const newIds = new Map<number, number>();
      let nid = 0;
      for (let i = 0; i < labels.length; i++) {
        const oldId = labels[i];
        try {
          fresh.addPoint(old.getPoint(oldId), nid);
          newIds.set(oldId, nid++);
        } catch (err) {
          logger.warn('HNSW compaction: could not copy vector', { path: labelToRef.get(oldId)?.path, error: String(err) });
        }
        if ((i + 1) % chunk === 0) await new Promise((r) => setImmediate(r));
      }

      // Synchronous swap. Chunks removed during the copy are no longer in
      // labelToRef — mark their copied slot deleted in the fresh index.
      for (const [oldId, id] of newIds) {
        if (!labelToRef.has(oldId)) {
          try { fresh.markDelete(id); } catch { /* ignore */ }
        }
      }
      index = fresh;
      indexGeneration++;
      labelToRef.clear();
      for (const [p, recs] of [...noteChunks]) {
        const next: ChunkRec[] = [];
        for (const r of recs) {
          const id = newIds.get(r.id);
          if (id !== undefined) next.push({ ...r, id });
        }
        setNoteUnlocked(p, next);
      }
      nextId = nid;
      compactions++;
      const ms = Date.now() - t0;
      lastCompaction = { at: new Date().toISOString(), live: labelToRef.size, dropped: deadBefore, ms };
      logger.info('Compacted HNSW index', lastCompaction);
      await persistUnlocked();
      return { live: labelToRef.size, dropped: deadBefore };
    });
  } finally {
    compacting = false;
  }
}

// ── Background re-embed queue (rescan path) ──────────────────────────────

const pendingEmbeds = new Set<string>();
let draining = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue notes the periodic rescan found changed/added (edits made outside the
 * server: Syncthing, Obsidian, source vaults) for re-embedding. Drained in the
 * background in batches of EMBED_SYNC_BATCH with an event-loop yield per note
 * and EMBED_SYNC_PAUSE_MS between batches; unchanged embed text is skipped by
 * hash, and a path no longer indexed has its vector removed.
 */
export function enqueueEmbedSync(paths: Iterable<string>): void {
  if (!ready || !index) return;
  for (const p of paths) pendingEmbeds.add(p);
  kickDrain(0);
}

function kickDrain(delayMs: number): void {
  if (draining || drainTimer || pendingEmbeds.size === 0) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainEmbedQueueOnce().finally(() => {
      if (pendingEmbeds.size > 0) kickDrain(config.embedSyncPauseMs);
    });
  }, delayMs);
  drainTimer.unref?.();
}

/**
 * Process ONE batch of the re-embed queue. Exported for tests; production
 * drives it through enqueueEmbedSync.
 */
export async function drainEmbedQueueOnce(
  batchSize = config.embedSyncBatch,
): Promise<{ embedded: number; unchanged: number; removed: number; failed: number }> {
  const out = { embedded: 0, unchanged: 0, removed: 0, failed: 0 };
  if (draining || pendingEmbeds.size === 0) return out;
  draining = true;
  try {
    const { getDocMeta } = await import('./search.js');
    const dm = getDocMeta();
    const batch: string[] = [];
    for (const p of pendingEmbeds) {
      batch.push(p);
      if (batch.length >= Math.max(1, batchSize)) break;
    }
    for (const p of batch) {
      pendingEmbeds.delete(p);
      const meta = dm.get(p);
      try {
        if (!meta) {
          if (noteChunks.has(p)) { removeFromVectorIndex(p); out.removed++; }
        } else {
          const r = await embedAndIndex(p, { title: meta.title, content: meta.content });
          if (r === 'embedded') out.embedded++; else out.unchanged++;
        }
      } catch (err) {
        out.failed++;
        logger.warn('Background re-embed failed', { path: p, error: String(err) });
      }
      await new Promise((r) => setImmediate(r));
    }
    if (out.embedded > 0 || out.removed > 0 || out.failed > 0) {
      logger.info('Re-embedded changed notes', { ...out, pending: pendingEmbeds.size });
    }
  } finally {
    draining = false;
  }
  return out;
}

/** Test seam: reset module state and inject a fake model / HNSW class. */
export const __embeddingsTestHooks = {
  install(opts: {
    embed: (text: string) => Promise<number[]> | number[];
    hnsw: any;
    capacity?: number;
    /** Pretend this model id / dimension is configured (model-change tests). */
    model?: string;
    dimension?: number;
  }): void {
    runModel = async (texts: string[]) => {
      const out: number[][] = [];
      for (const t of texts) out.push(Array.from(await opts.embed(t)));
      return out;
    };
    HierarchicalNSW = opts.hnsw;
    activeModel = opts.model ?? config.embeddingModel;
    activeDim = opts.dimension ?? config.embeddingDimension;
    index = newNativeIndex(opts.capacity ?? 1000);
    noteChunks.clear(); labelToRef.clear(); pendingEmbeds.clear(); queryEmbedCache.clear();
    nextId = 0; indexGeneration++; ready = true; loadedPersistedIndex = false;
    finalPersistDone = false; compactions = 0; lastCompaction = null;
  },
  reset(): void {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    runModel = null; index = null; ready = false;
    noteChunks.clear(); labelToRef.clear(); pendingEmbeds.clear(); queryEmbedCache.clear();
    nextId = 0; loadedPersistedIndex = false;
    activeModel = config.embeddingModel; activeDim = config.embeddingDimension;
  },
  /** Run the boot-time "load the persisted index of the active model" step. */
  loadPersisted: (): boolean => loadPersistedIndex(),
  indexFiles: (): { indexPath: string; mapPath: string } => indexFilePaths(),
  /** Label / hash of a note's lead (first) chunk. */
  labelOf: (p: string): number | undefined => noteChunks.get(p)?.[0]?.id,
  hashOf: (p: string): string | undefined => noteChunks.get(p)?.[0]?.hash,
  chunksOf: (p: string): Array<{ id: number; hash: string; start: number; end: number }> =>
    (noteChunks.get(p) ?? []).map((r) => ({ ...r })),
  nativeIndex: (): any => index,
  pending: (): number => pendingEmbeds.size,
  idle: (): Promise<unknown> => withIndexLock(() => undefined),
};
