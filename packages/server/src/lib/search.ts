import MiniSearch from 'minisearch';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listFiles, readNote } from './vault.js';
import { parseFrontmatter } from './frontmatter.js';
import { setIndexedNotes, recordIndexRebuild } from './metrics.js';
import { logger } from './logger.js';
import { isEmbeddingsReady, searchSemantic, embedAndIndex, removeFromVectorIndex, enqueueEmbedSync } from './embeddings.js';
import { classifyPath, getCollectionWeight } from './collections.js';
import { isRerankerEnabled, rerankResults } from './reranker.js';
import { isPathIndexable, sourceNameForVault } from './index-allowlist.js';
import { getVault, pruneStaleVaultTransports } from './vault/registry.js';
import { listSourceVaultPaths } from './source-vaults.js';
import { withinWindow, toIso } from './bitemporal.js';
import { extractWikilinks } from './markdown.js';
import {
  docLinks,
  forEachOrderedConcurrent,
  getIndexState,
  setIndexProgress,
  setIndexState,
} from './index-state.js';
import { buildLinkLookup, resolveWikilink } from './link-resolver.js';
import { detectEntities } from './entity-detector.js';
import { analyzeTerm, analyzeText, foldText, fuzzyForTerm, prefixForTerm } from './text-analyzer.js';
import { kgAllMentionTriples } from './knowledge-graph.js';
import { memoryKindOf, type MemoryKind } from './memory-kind.js';
import {
  buildRecallGraph,
  runPPR,
  extractSeeds,
  pprRrfContribution,
  type RecallGraph,
} from './graph-recall.js';

export interface SearchOptions {
  scopePaths?: string[];
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  /** Frontmatter `type` to keep; an array keeps any of the listed types. */
  type?: string | string[];
  category?: string;
  temperature?: 'hot' | 'warm' | 'cold';
  minHeatScore?: number;
  importance?: string;
  excludeArchived?: boolean;
  collections?: string[];
  /**
   * Memory kinds to keep (episodic / semantic / procedural, see
   * lib/memory-kind.ts). Omitted or empty: every kind. Applied with the other
   * scope filters, BEFORE ranking, so an out-of-scope kind never takes a
   * candidate slot.
   */
  kinds?: readonly MemoryKind[];
  /**
   * Extra scope predicate, applied with the other filters BEFORE ranking. Use
   * it when a caller would otherwise drop results afterwards: a note that can
   * never be returned must not take a candidate slot nor set the scale the
   * lexical arm is normalised by.
   */
  filter?: (path: string, meta: Readonly<DocMeta>) => boolean;
  /**
   * Bitemporal as-of instant (ISO). When set, notes whose validity window
   * `[valid_from, valid_to)` excludes `asOf` are suppressed from results. When
   * UNSET (the normal production path) no bitemporal filtering happens and
   * results are byte-identical to today.
   */
  asOf?: string;
  /**
   * Enable the Personalized-PageRank graph-recall arm for THIS call. The arm is
   * active when `config.pprRecall` OR `opts.graph === true`; with neither set
   * (the normal production path) the arm block is skipped entirely and results
   * are byte-identical to today. The eval flips this per-call so it can measure
   * the arm without mutating env. Additive-only: enabling it can re-rank or
   * introduce results but never drop an existing lexical/semantic hit.
   */
  graph?: boolean;
  /**
   * Whether to apply the LLM reranking pass. When omitted (undefined), the
   * global reranker setting (isRerankerEnabled) decides — preserving existing
   * behavior. Set to `false` to force-skip reranking on this call even when the
   * reranker is globally enabled (e.g. internal similarity lookups).
   */
  rerank?: boolean;
  /**
   * Build the query-aware snippet for each result (default true). Callers that
   * re-rank and keep only a few results (memory_recall) pass false and build
   * snippets for the survivors themselves — `snippet` is then ''.
   */
  snippets?: boolean;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;           // keep for backward compat (= fusedScore)
  lexicalScore: number;    // RRF contribution from lexical search
  semanticScore: number;   // RRF contribution from semantic search
  graphScore: number;      // contribution from the PPR graph arm (0 when the arm is off)
  fusedScore: number;      // (lexicalScore + semanticScore + graphScore) × collectionBoost
  /** Raw BM25 score from the lexical arm (undefined when the note was not a lexical hit). */
  lexicalRaw?: number;
  /** Cosine similarity from the semantic arm (undefined when not a kNN hit). */
  semanticSim?: number;
  /**
   * IDF-weighted share (0..1) of the analysed query terms this note matches.
   * Absolute lexical evidence: unlike rank-relative scores it does not saturate
   * at 1 for the best hit of a query that nothing really answers.
   */
  coverage?: number;
  /**
   * Raw BM25 ÷ the query's total IDF mass: lexical match strength per unit of
   * query information, comparable across queries of different lengths (used by
   * recall's minimum-evidence floor). Undefined when not a lexical hit.
   */
  lexicalEvidence?: number;
  /**
   * The note's best-matching embedding chunk (semantic arm): offsets into the
   * note body and its text. Present only for kNN hits with chunk vectors.
   */
  chunk?: { index: number; start: number; end: number; text?: string };
}

export interface DocMeta {
  date?: string;
  tags: string[];
  content: string;
  title: string;
  type?: string;
  category?: string;
  temperature?: string;
  heat_score?: number;
  importance?: string;
  last_accessed?: string;
  archived?: boolean;
  consolidated_into?: string;
  collection: string;
  /** Frontmatter `source` (e.g. `hook:PostToolUse:Bash`, `n8n:…`) — marks machine captures. */
  source?: string;
  /**
   * Episodic / semantic / procedural (lib/memory-kind.ts): explicit
   * `memory_kind` frontmatter, else classified from path, type, category, tags,
   * source and title at index time. Drives recall's kind scope and tiers.
   */
  memory_kind: MemoryKind;
  // Carried so memory_recall can score/filter without re-reading the file:
  related?: string[];
  validity_alpha?: number;
  validity_beta?: number;
  // Bitemporal source-note validity window (populated only when a supersession
  // pass has stamped the note; otherwise all undefined and every asOf filter is
  // a no-op). Read from frontmatter exactly like the validity_* fields above.
  valid_from?: string;
  valid_to?: string;
  superseded_by?: string;
}

/**
 * Coerce a frontmatter date-ish value to a `YYYY-MM-DD` day string. js-yaml
 * parses unquoted timestamps (`created: 2026-05-30T00:00:00.000Z`) as `Date`
 * objects; `DocMeta.date` is compared lexicographically against `dateFrom` /
 * `dateTo` and fed to the as-of filter, so it must always be a string.
 * Strings are trimmed as-is (a note may legitimately carry a full instant);
 * anything else → `undefined`.
 */
function toIsoDay(v: unknown): string | undefined {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length > 0 ? s : undefined;
  }
  return undefined;
}

/** Keep full rebuild and single-note updates on the same metadata contract. */
function metadataForNote(filePath: string, data: Record<string, any>, body: string): DocMeta {
  const tags = (Array.isArray(data.tags) ? data.tags : []).map(String);
  const title = data.title ?? filePath.replace(/\.md$/, '').split('/').pop() ?? filePath;
  return {
    date: toIsoDay(data.date ?? data.created),
    tags,
    content: body,
    title,
    memory_kind: memoryKindOf(
      { ...data, tags, title: typeof title === 'string' ? title : String(title), content: body },
      filePath,
      { machineSourcePatterns: config.machineCaptureSourcePatterns },
    ),
    type: typeof data.type === 'string' ? data.type : undefined,
    category: typeof data.category === 'string' ? data.category : undefined,
    temperature: typeof data.temperature === 'string' ? data.temperature : undefined,
    heat_score: typeof data.heat_score === 'number' ? data.heat_score : undefined,
    importance: typeof data.importance === 'string' ? data.importance : undefined,
    last_accessed: toIso(data.last_accessed),
    archived: typeof data.archived === 'boolean' ? data.archived : undefined,
    consolidated_into: typeof data.consolidated_into === 'string' ? data.consolidated_into : undefined,
    collection: classifyPath(filePath),
    source: typeof data.source === 'string' ? data.source : undefined,
    related: Array.isArray(data.related) ? data.related as string[] : undefined,
    validity_alpha: typeof data.validity_alpha === 'number' ? data.validity_alpha : undefined,
    validity_beta: typeof data.validity_beta === 'number' ? data.validity_beta : undefined,
    valid_from: toIso(data.valid_from),
    valid_to: toIso(data.valid_to),
    superseded_by: typeof data.superseded_by === 'string' ? data.superseded_by : undefined,
  };
}

export interface IndexHealthEntry {
  vault: string;
  fileCount: number;
  indexed: number;
  enoent: number;
  enoentSamples: string[];
  permissionErrors: number;
  permissionSamples: string[];
  otherErrors: number;
}

let miniSearch: MiniSearch;

/**
 * docMeta with a mutation counter. Every index change (full rebuild, single-note
 * update, removal) goes through set/delete/clear, so `indexVersion` is an exact
 * invalidation key for caches derived from the index (the recall graph).
 */
let indexVersion = 0;
class VersionedDocMeta extends Map<string, DocMeta> {
  override set(key: string, value: DocMeta): this { indexVersion++; return super.set(key, value); }
  override delete(key: string): boolean { indexVersion++; return super.delete(key); }
  override clear(): void { indexVersion++; super.clear(); }
}
const docMeta: Map<string, DocMeta> = new VersionedDocMeta();

/** Monotonic counter bumped on every index mutation (cache invalidation key). */
export function getIndexVersion(): number {
  return indexVersion;
}

let archivedProbe: { version: number; any: boolean } | null = null;

/** Does the index hold at least one archived note? Cached per index version. */
export function hasArchivedNotes(): boolean {
  if (archivedProbe && archivedProbe.version === indexVersion) return archivedProbe.any;
  let any = false;
  for (const meta of docMeta.values()) {
    if (meta.archived === true) { any = true; break; }
  }
  archivedProbe = { version: indexVersion, any };
  return any;
}
let indexedNoteCount = 0;
let lastIndexHealth: IndexHealthEntry[] = [];

// Track file modification times for incremental rebuilds. Keyed by
// `${vault}\0${relPath}` (see `mtimeKey`) — NOT bare relPath — because the brain
// vault and source vaults share relative paths (e.g. `Daily/2026-01-01.md`), and
// a bare-relPath key made each rebuild see the "other" vault's mtime as a change
// and re-index the same ~1200 files every tick forever.
const fileMtimes = new Map<string, number>();
let isFirstBuild = true;

/** Composite key for per-vault file state (mtimes / seen-set). */
function mtimeKey(vault: string, relPath: string): string {
  return `${vault}\u0000${relPath}`;
}

/**
 * Summary of the most recent `rebuildIndex()` run (I-2 — consumed by /health).
 * `null` until the first rebuild completes. `collisions` counts relPaths that
 * exist in more than one vault; only the first vault (in `readVaults()` order)
 * is indexed for such a path.
 */
export interface LastIndexUpdate {
  /** ISO timestamp of when the rebuild finished. */
  at: string;
  updated: number;
  removed: number;
  /** Wall-clock duration of the rebuild in milliseconds. */
  ms: number;
  collisions: number;
}
let lastIndexUpdate: LastIndexUpdate | null = null;

/** Most recent rebuild summary, or `null` before the first rebuild. */
export function getLastIndexUpdate(): LastIndexUpdate | null {
  return lastIndexUpdate;
}

export function getIndexedNoteCount(): number {
  return indexedNoteCount;
}

/**
 * Force the next rebuildIndex() call to do a complete rebuild
 * (re-scan all files, not incremental). Used by index repair.
 */
export function forceFullRebuild(): void {
  isFirstBuild = true;
}

function createIndex(): MiniSearch {
  if (!config.lexicalAnalyzer) {
    // LEXICAL_ANALYZER=legacy: raw MiniSearch tokens, prefix + fuzzy everywhere.
    return new MiniSearch({
      fields: ['title', 'content', 'tags'],
      storeFields: ['title'],
      idField: 'id',
      searchOptions: {
        boost: { title: 3, tags: 2 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }
  return new MiniSearch({
    fields: ['title', 'content', 'tags'],
    storeFields: ['title'],
    idField: 'id',
    // Bilingual analyzer (lib/text-analyzer.ts), applied at index AND query
    // time: accent folding, EN+FR stopwords, light plural stemming.
    processTerm: (term) => analyzeTerm(term),
    searchOptions: {
      boost: { title: 3, tags: 2 },
      prefix: (term) => prefixForTerm(term),
      fuzzy: (term) => fuzzyForTerm(term),
    },
  });
}

/** One file read during a scan (stat + bytes), or a skip for an unchanged file. */
type ScanRead = { skip: true } | { skip: false; content: string; mtime: number | undefined };

let rebuildInFlight: Promise<void> | null = null;
let rebuildQueued: Promise<void> | null = null;

/**
 * Rebuild the full-text search index by scanning all vaults.
 * After the first full build, subsequent calls are incremental:
 * only files whose mtime has changed (or new/deleted files) are re-indexed.
 *
 * Overlap-guarded: the server now listens before the boot build finishes, so
 * the 60 s rescan (or a repair) can fire mid-build. A call made while a build
 * is running waits for it and then runs ONE coalesced follow-up rebuild.
 */
export function rebuildIndex(): Promise<void> {
  if (!rebuildInFlight) {
    rebuildInFlight = runRebuild().finally(() => { rebuildInFlight = null; });
    return rebuildInFlight;
  }
  if (!rebuildQueued) {
    rebuildQueued = rebuildInFlight
      .catch(() => undefined)
      .then(() => { rebuildQueued = null; return rebuildIndex(); });
  }
  return rebuildQueued;
}

async function runRebuild(): Promise<void> {
  const startedAt = Date.now();
  // A full build (boot, forced repair, source-vault change) scans into FRESH
  // structures and swaps them in at the end, so readers keep a complete index
  // for the whole scan instead of an empty-then-growing one.
  const full = isFirstBuild;
  // Cleared up-front so a forceFullRebuild() requested DURING this run is kept
  // for the coalesced follow-up run instead of being reset at the end.
  isFirstBuild = false;
  const isBootBuild = full && (getIndexState() === 'not_started' || getIndexState() === 'error');
  if (isBootBuild) setIndexState('indexing');
  const ms = full ? createIndex() : miniSearch;
  const meta: Map<string, DocMeta> = full ? new Map() : docMeta;
  const links: Map<string, string[]> = full ? new Map() : docLinks;
  const mtimes: Map<string, number> = full ? new Map() : fileMtimes;

  const healthThisScan: IndexHealthEntry[] = [];

  let fileCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  // Paths whose text changed this scan → re-embedded in the background (the
  // rescan used to update MiniSearch only, leaving stale vectors until restart).
  const changedPaths: string[] = [];

  // Track which (vault, relPath) pairs we see this scan (to prune `fileMtimes`).
  const seenFiles = new Set<string>();
  // relPath → vault that claimed it this scan. `docMeta` / MiniSearch stay keyed
  // by bare relPath (every consumer — readNote, graph, embeddings, co-recall —
  // depends on that, and `resolveSafePathForRead` resolves first-vault-wins in
  // the same vault order), so a relPath present in several vaults is indexed
  // ONCE, from the first vault that lists it. Later vaults' copies are counted
  // as collisions and skipped instead of ping-ponging the index every tick.
  const claimedBy = new Map<string, string>();
  let collisions = 0;
  const collisionSamples: string[] = [];

  // Dynamic vault set: the brain vault plus the runtime-merged source vaults
  // (env + persisted). Using this rather than the frozen `config.allVaults`
  // means a vault added/removed at runtime is picked up on the next rebuild.
  const vaults = [config.brainVault, ...listSourceVaultPaths()];
  let listedTotal = 0;
  let readDone = 0;

  try {
    for (const vault of vaults) {
      // Route source bytes through the IVault read-transport seam (Phase 3).
      // LocalVault preserves today's filesystem behavior; this is the single
      // place a future PR swaps a source to git-pull/WebDAV/S3. Refresh first so
      // a non-local transport sees the latest snapshot (no-op for LocalVault).
      const transport = getVault(vault);
      if (transport) {
        try {
          await transport.refresh();
        } catch (err) {
          logger.warn('Vault refresh failed', { vault, error: String(err) });
        }
      }

      let files: string[];
      try {
        if (transport) {
          files = [];
          for await (const entry of transport.list()) files.push(entry.relPath);
        } else {
          files = await listFiles(vault);
        }
        if (full) {
          logger.info('Listed vault files', { vault, count: files.length });
        }
      } catch (err) {
        logger.error('Failed to list vault files', { vault, error: String(err) });
        continue;
      }

      // Source-vault default-deny allowlist (privacy control). For a source vault
      // with a non-empty include-glob list, drop any path that isn't allowed
      // before it is walked/indexed. The brain vault has no source name, so its
      // files always pass through.
      const sourceName = sourceNameForVault(vault);
      if (sourceName) {
        const before = files.length;
        files = files.filter((relPath) => isPathIndexable(sourceName, relPath));
        if (full && files.length !== before) {
          logger.info('Applied source-vault index allowlist', {
            vault, kept: files.length, excluded: before - files.length,
          });
        }
      }

      // Claim paths first (cheap, synchronous) so collisions are decided in
      // vault order exactly as before; only owned paths are read.
      const owned: string[] = [];
      for (const relPath of files) {
        // Cross-vault collision: an earlier vault in this scan already owns this
        // relPath. Skip it entirely (no stat, no read) so it can neither churn the
        // index nor shadow the first vault's copy.
        const owner = claimedBy.get(relPath);
        if (owner !== undefined && owner !== vault) {
          collisions++;
          if (collisionSamples.length < 5) collisionSamples.push(`${relPath} (${sourceName ?? 'brain'} ← ${sourceNameForVault(owner) ?? 'brain'})`);
          continue;
        }
        claimedBy.set(relPath, vault);
        seenFiles.add(mtimeKey(vault, relPath));
        owned.push(relPath);
      }
      listedTotal += owned.length;
      if (isBootBuild) setIndexProgress(readDone, listedTotal);

      let skippedEnoent = 0;
      const enoentSamples: string[] = [];
      let permissionErrors = 0;
      const permissionSamples: string[] = [];
      const otherErrors: Array<{ path: string; error: string }> = [];

      // stat + read with bounded concurrency (the boot pass used to await each
      // file in turn); results are applied in listing order.
      const readOne = async (relPath: string): Promise<ScanRead> => {
        const key = mtimeKey(vault, relPath);
        const absPath = path.resolve(vault, relPath);
        let mtime: number | undefined;
        try {
          const fileStat = transport ? await transport.stat(relPath) : await stat(absPath);
          if (fileStat) mtime = fileStat.mtimeMs;
        } catch {
          // stat failed: (re-)index the file anyway
        }
        if (!full && mtime !== undefined && mtimes.get(key) === mtime) {
          return { skip: true }; // file unchanged, skip
        }
        const content = transport
          ? (await transport.read(relPath)).content.toString('utf-8')
          : await readFile(absPath, 'utf-8');
        return { skip: false, content, mtime };
      };

      await forEachOrderedConcurrent(owned, config.indexReadConcurrency, readOne, (relPath, res) => {
        readDone++;
        if (isBootBuild && (readDone & 255) === 0) setIndexProgress(readDone, listedTotal);
        try {
          if (res.status === 'rejected') throw res.reason;
          const r = res.value;
          if (r.skip) return;
          const { content } = r;
          const { data, body } = parseFrontmatter(content);

          // Coerce every tag element to a string so numeric YAML tags (e.g. `2024`)
          // can never propagate into docMeta.tags and crash tag tooling downstream.
          const tags: string[] = (Array.isArray(data.tags) ? data.tags : []).map(String);
          const title =
            data.title ?? relPath.replace(/\.md$/, '').split('/').pop() ?? relPath;

          // On incremental rebuild, remove old entry before re-adding
          if (!full && meta.has(relPath)) {
            try { ms.discard(relPath); } catch { /* may not exist */ }
          }

          meta.set(relPath, metadataForNote(relPath, data, body));
          links.set(relPath, extractWikilinks(content));

          ms.add({
            id: relPath,
            title,
            content: body,
            tags: tags.join(' '),
          });

          // Record the mtime only once the file is actually indexed, so a failed
          // read is retried on the next tick instead of being marked current.
          if (r.mtime !== undefined) mtimes.set(mtimeKey(vault, relPath), r.mtime);
          if (full) {
            fileCount++;
          } else {
            updatedCount++;
            changedPaths.push(relPath);
          }
        } catch (err: any) {
          const code = err?.code ?? '';
          const msg = String(err);
          if (code === 'ENOENT' || msg.includes('ENOENT')) {
            skippedEnoent++;
            if (enoentSamples.length < 5) enoentSamples.push(relPath);
          } else if (code === 'EACCES' || code === 'EPERM' || msg.includes('EACCES') || msg.includes('EPERM')) {
            permissionErrors++;
            if (permissionSamples.length < 5) permissionSamples.push(relPath);
          } else {
            otherErrors.push({ path: relPath, error: msg });
          }
        }
      });

      // Log ENOENT as a single summary line with sample paths
      if (skippedEnoent > 0) {
        logger.warn('Skipped missing files during indexing', {
          vault, count: skippedEnoent, samples: enoentSamples,
        });
      }
      // Log permission errors separately so they're clearly visible
      if (permissionErrors > 0) {
        logger.error('Permission denied during indexing', {
          vault, count: permissionErrors, samples: permissionSamples,
        });
      }
      for (const e of otherErrors.slice(0, 5)) {
        logger.warn('Failed to index note', { path: e.path, error: e.error });
      }
      if (otherErrors.length > 5) {
        logger.warn('Additional index errors suppressed', { count: otherErrors.length - 5 });
      }

      // Store index health for dashboard consumption
      healthThisScan.push({
        vault,
        fileCount: files.length,
        indexed: full ? fileCount : meta.size,
        enoent: skippedEnoent,
        enoentSamples,
        permissionErrors,
        permissionSamples,
        otherErrors: otherErrors.length,
      });
    }
  } catch (err) {
    if (full) isFirstBuild = true;
    if (isBootBuild) setIndexState('error');
    throw err;
  }

  if (full) {
    // Swap the freshly built structures in. Vectors of docs that vanished are
    // dropped; every surviving doc is offered to the embedding sync, which skips
    // unchanged text by hash (the boot build skips this — the boot embedding
    // sync reconciles the whole vault once embeddings are loaded).
    const hadPrevious = docMeta.size > 0;
    if (hadPrevious) {
      for (const p of docMeta.keys()) {
        if (!meta.has(p)) { removeFromVectorIndex(p); removedCount++; }
      }
    }
    miniSearch = ms;
    docMeta.clear();
    for (const [p, m] of meta) docMeta.set(p, m);
    docLinks.clear();
    for (const [p, l] of links) docLinks.set(p, l);
    fileMtimes.clear();
    for (const [k, v] of mtimes) fileMtimes.set(k, v);
    if (hadPrevious) changedPaths.push(...meta.keys());
  } else {
    // Remove deleted files from the index. A doc is gone when NO vault claimed
    // its relPath this scan; per-vault mtime state is pruned for every
    // (vault, relPath) pair that was not seen.
    for (const existingPath of [...docMeta.keys()]) {
      if (!claimedBy.has(existingPath)) {
        try { miniSearch.discard(existingPath); } catch { /* may not exist */ }
        docMeta.delete(existingPath);
        docLinks.delete(existingPath);
        removeFromVectorIndex(existingPath);
        removedCount++;
      }
    }
    for (const key of [...fileMtimes.keys()]) {
      if (!seenFiles.has(key)) fileMtimes.delete(key);
    }
  }
  fileCount = docMeta.size;
  lastIndexHealth = healthThisScan;

  // Re-embed changed notes in the background (batched, yielding, hash-skipped).
  if (changedPaths.length > 0 && isEmbeddingsReady()) {
    enqueueEmbedSync(changedPaths);
  }

  const wasFirstBuild = full;
  indexedNoteCount = fileCount;
  setIndexedNotes(fileCount);
  recordIndexRebuild();
  if (isBootBuild) {
    setIndexProgress(readDone, listedTotal);
    setIndexState('ready');
  }

  const elapsedMs = Date.now() - startedAt;
  const prevCollisions = lastIndexUpdate?.collisions ?? 0;
  lastIndexUpdate = {
    at: new Date().toISOString(),
    updated: updatedCount,
    removed: removedCount,
    ms: elapsedMs,
    collisions,
  };

  // Log collisions once per rebuild: loudly on the first build / when the count
  // changes, quietly (debug) when it is the same steady-state figure every tick.
  if (collisions > 0) {
    const payload = { count: collisions, samples: collisionSamples };
    if (wasFirstBuild) {
      logger.warn('Cross-vault path collisions: only the first vault\'s copy is indexed', payload);
    } else if (collisions !== prevCollisions) {
      logger.info('Cross-vault path collisions changed', payload);
    } else {
      logger.debug('Cross-vault path collisions unchanged', payload);
    }
  }

  if (wasFirstBuild) {
    logger.info('Search index rebuilt', { indexedNotes: fileCount, ms: elapsedMs, collisions });
  } else if (updatedCount > 0 || removedCount > 0) {
    logger.info('Search index updated (incremental)', {
      indexedNotes: fileCount, updated: updatedCount, removed: removedCount, ms: elapsedMs, collisions,
    });
  } else {
    logger.debug('Search index unchanged', { ms: elapsedMs });
  }
}

/**
 * Hot re-index of source content after the dynamic source-vault set changes
 * (add/remove). We force a FULL rebuild rather than a surgical add/remove: a
 * full scan re-walks the new vault set and naturally drops docs for a removed
 * vault (chosen for simplicity over surgical per-vault removal — the index is
 * MiniSearch in-memory and rebuilds are cheap relative to a restart). Also
 * prunes now-stale transports from the registry so a removed vault's transport
 * is released.
 */
export async function reindexSourceVaults(): Promise<void> {
  pruneStaleVaultTransports();
  forceFullRebuild();
  await rebuildIndex();
}

/**
 * Index (or re-index) a single note by its vault-relative path.
 * Reads the file, parses frontmatter, and updates the MiniSearch index
 * and docMeta map without triggering a full rebuild.
 *
 * NOTE (Phase 3 / PR 6): not yet migrated to the IVault seam. `readNote`
 * resolves which vault contains `filePath` (and runs symlink-escape checks),
 * whereas the registry is keyed by vault root — wiring this reader would
 * require resolving the owning vault first. The full-scan/incremental path in
 * `rebuildIndex` (the indexing list/read) goes through IVault; single-note
 * re-index stays on `readNote` for now (LocalVault-equivalent behavior).
 */
export async function indexNote(filePath: string): Promise<void> {
  const { content } = await readNote(filePath);
  const { data, body } = parseFrontmatter(content);

  const tags: string[] = (Array.isArray(data.tags) ? data.tags : []).map(String);
  const title =
    data.title ?? filePath.replace(/\.md$/, '').split('/').pop() ?? filePath;

  // Remove old entry if it exists
  try {
    miniSearch.discard(filePath);
  } catch {
    // Document may not exist in the index yet — that's fine
  }

  // Update docMeta
  docMeta.set(filePath, metadataForNote(filePath, data, body));
  docLinks.set(filePath, extractWikilinks(content));

  // Add to MiniSearch
  miniSearch.add({
    id: filePath,
    title,
    content: body,
    tags: tags.join(' '),
  });

  // Update vector index (non-blocking). Same text (title + body) and hash as
  // the boot/rescan paths — see embedTextFor — so an unchanged embed text
  // (e.g. a frontmatter-only heat/last_accessed update) costs no forward pass.
  if (isEmbeddingsReady()) {
    embedAndIndex(filePath, { title: String(title), content: body }).catch(err => {
      logger.warn('Failed to update vector index', { path: filePath, error: String(err) });
    });
  }

  indexedNoteCount = docMeta.size;
  setIndexedNotes(indexedNoteCount);
}

/**
 * Remove a single note from the search index and docMeta map.
 */
export function removeFromIndex(filePath: string): void {
  try {
    miniSearch.discard(filePath);
  } catch {
    // Document may not exist in the index
  }
  docMeta.delete(filePath);
  docLinks.delete(filePath);
  removeFromVectorIndex(filePath);
  indexedNoteCount = docMeta.size;
  setIndexedNotes(indexedNoteCount);
}

const DAY_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

function typeMatches(noteType: string | undefined, wanted: string | string[]): boolean {
  return Array.isArray(wanted) ? noteType !== undefined && wanted.includes(noteType) : noteType === wanted;
}

/** Shared scope filter: every retrieval arm applies it BEFORE ranking. */
function passesFilters(id: string, meta: DocMeta, opts: SearchOptions): boolean {
  const {
    scopePaths, tags, dateFrom, dateTo, type, category, temperature,
    minHeatScore, importance, excludeArchived = true, collections, kinds,
  } = opts;
  if (excludeArchived && meta.archived === true) return false;
  if (type && !typeMatches(meta.type, type)) return false;
  if (kinds && kinds.length > 0 && !kinds.includes(meta.memory_kind)) return false;
  if (category && meta.category !== category) return false;
  if (collections && collections.length > 0 && !collections.includes(meta.collection)) return false;
  if (scopePaths && scopePaths.length > 0 && !scopePaths.some((sp) => id.startsWith(sp))) return false;
  if (tags && tags.length > 0 && !tags.some((t) => meta.tags.includes(t))) return false;
  if (meta.date) {
    // Bounds are inclusive DAYS: a note stamped with a full instant
    // (`2026-11-08T14:00:00Z`) is still inside `dateTo: 2026-11-08`.
    const day = DAY_PREFIX_RE.test(meta.date) ? meta.date.slice(0, 10) : meta.date;
    if (dateFrom && day < dateFrom.slice(0, 10)) return false;
    if (dateTo && day > dateTo.slice(0, 10)) return false;
  } else if (dateFrom || dateTo) {
    return false; // no date metadata — exclude from date-filtered results
  }
  if (temperature && meta.temperature !== temperature) return false;
  if (minHeatScore !== undefined && (meta.heat_score === undefined || meta.heat_score < minHeatScore)) return false;
  if (importance && meta.importance !== importance) return false;
  if (opts.filter && !opts.filter(id, meta)) return false;
  return true;
}

const defaultTokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[];

/** Document frequency of an analysed term (0 = absent; undefined = unknown). */
function termDocFrequency(term: string): number | undefined {
  try {
    // MiniSearch keeps term → (fieldId → (docId → tf)) with no public df
    // accessor. Guarded: any shape change degrades to unweighted coverage.
    const data = (miniSearch as unknown as { _index: { get(t: string): Map<number, Map<number, number>> | undefined } })
      ._index.get(term);
    if (!data) return 0;
    let df = 0;
    for (const perDoc of data.values()) df = Math.max(df, perDoc.size);
    return df;
  } catch {
    return undefined;
  }
}

/**
 * IDF weight of each distinct analysed query term (BM25 idf, floored so even a
 * ubiquitous term still counts a little). Empty when the query has no terms.
 */
export function queryTermWeights(query: string): Map<string, number> {
  const out = new Map<string, number>();
  const n = Math.max(docMeta.size, 1);
  for (const raw of defaultTokenize(query)) {
    const term = config.lexicalAnalyzer ? analyzeTerm(raw) : raw.toLowerCase();
    if (!term || out.has(term)) continue;
    const df = miniSearch ? termDocFrequency(term) : undefined;
    out.set(term, df === undefined ? 1 : Math.max(0.1, Math.log(1 + (n - df + 0.5) / (df + 0.5))));
  }
  return out;
}

/** Share of the query's IDF mass carried by `matched` (the hit's matched query terms). */
function coverageOf(matched: string[] | undefined, weights: Map<string, number>, total: number): number {
  if (!matched || total <= 0) return 0;
  let sum = 0;
  for (const t of new Set(matched)) sum += weights.get(t) ?? 0;
  return Math.min(1, sum / total);
}

/** Characters of a note scanned for its best passage. */
const PASSAGE_SCAN_CHARS = 20_000;

/**
 * Query-aware snippet: the ~`width`-char window of `content` holding the most
 * distinct query terms (accent-insensitive), instead of the note's first
 * characters. Falls back to the head of the note when nothing matches.
 */
export function bestPassage(fullContent: string, query: string, width = 200): string {
  if (fullContent.length <= width) return fullContent;
  // Bounded scan: folding a 100 kB note per result would dominate query time.
  const content = fullContent.length > PASSAGE_SCAN_CHARS ? fullContent.slice(0, PASSAGE_SCAN_CHARS) : fullContent;
  const terms = [...new Set(
    config.lexicalAnalyzer ? analyzeText(query) : query.toLowerCase().split(/\W+/).filter((t) => t.length > 2),
  )];
  if (terms.length === 0) return content.slice(0, width);
  const folded = foldText(content);
  if (folded.length !== content.length) return content.slice(0, width); // folding shifted offsets
  // Term occurrences, capped so a pathological note cannot make this quadratic.
  const hits: Array<[number, number]> = [];
  terms.forEach((t, ti) => {
    let from = 0;
    for (let n = 0; n < 40; n++) {
      const i = folded.indexOf(t, from);
      if (i < 0) break;
      hits.push([i, ti]);
      from = i + t.length;
    }
  });
  if (hits.length === 0) return content.slice(0, width);
  hits.sort((a, b) => a[0] - b[0]);
  let bestStart = hits[0][0];
  let bestCount = 0;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set<number>();
    for (let j = i; j < hits.length && hits[j][0] - hits[i][0] < width; j++) seen.add(hits[j][1]);
    if (seen.size > bestCount) { bestCount = seen.size; bestStart = hits[i][0]; }
  }
  // Start a little before the first hit, on a word boundary when one is near.
  let start = Math.max(0, bestStart - 30);
  if (start > 0) {
    const sp = content.indexOf(' ', start);
    if (sp >= 0 && sp < bestStart) start = sp + 1;
  }
  const end = Math.min(content.length, start + width);
  return (start > 0 ? '…' : '') + content.slice(start, end).trim() + (end < fullContent.length ? '…' : '');
}

/**
 * Search indexed notes with optional filters.
 */
export function searchNotes(
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  return lexicalSearch(query, opts, true);
}

/**
 * Lexical arm. `withSnippets: false` skips the query-aware snippet (hybridSearch
 * builds it later, only for the notes it returns).
 */
function lexicalSearch(query: string, opts: SearchOptions, withSnippets: boolean): SearchResult[] {
  if (!miniSearch) {
    throw new Error(
      'Search index not built. Call rebuildIndex() before searching.',
    );
  }

  const limit = opts.limit ?? 20;
  const results = miniSearch.search(query);

  const weights = queryTermWeights(query);
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;

  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= limit) break;
    const id = r.id as string;
    const meta = docMeta.get(id);
    if (!meta || !passesFilters(id, meta, opts)) continue;
    out.push({
      path: id,
      title: meta.title,
      snippet: withSnippets ? bestPassage(meta.content, query) : '',
      score: r.score,
      lexicalScore: r.score,
      semanticScore: 0,
      graphScore: 0,
      fusedScore: r.score,
      lexicalRaw: r.score,
      coverage: coverageOf(r.queryTerms, weights, totalWeight),
      lexicalEvidence: totalWeight > 0 ? r.score / totalWeight : undefined,
    });
  }
  return out;
}

/**
 * Bitemporal as-of filter. Drops results whose source-note validity window
 * `[valid_from, valid_to)` excludes `asOf`. `valid_from` falls back to the
 * note's `date` when unstamped (matching the ingest default). Applied to a
 * result list so it can gate BOTH the lexical-only early-return path and the
 * fused path. NO-OP contract: callers only invoke this when `asOf` is set, so
 * with no `asOf` recall is byte-identical to today.
 */
function filterByAsOf<T extends { path: string }>(
  results: T[],
  asOf: string,
  pre: { type?: string | string[]; category?: string } = {},
): T[] {
  return results.filter((r) => {
    const meta = docMeta.get(r.path);
    if (!meta) return true; // no metadata → don't drop (fail-open, matches non-temporal behavior)
    // Cheap type/category pre-filter first so the window check only runs on
    // candidates that can survive the post-filters anyway.
    if (pre.type && !typeMatches(meta.type, pre.type)) return false;
    if (pre.category && meta.category !== pre.category) return false;
    const vf = meta.valid_from ?? meta.date;
    return withinWindow(vf, meta.valid_to, asOf);
  });
}

/**
 * Build the note↔note wikilink graph and the title→path index from the current
 * in-memory docMeta. Cheap (no I/O — reuses already-parsed note bodies) and
 * only invoked when the graph arm is active.
 */
function buildLinkGraphFromDocMeta(): {
  linkGraph: Map<string, Set<string>>;
  titleToPath: Map<string, string>;
} {
  const lookup = buildLinkLookup(docMeta.keys());
  const titleToPath = new Map<string, string>();
  const ambiguousTitles = new Set<string>();
  for (const [p, meta] of docMeta) {
    const base = p.replace(/\.md$/, '').split('/').pop()!;
    // Do not route KG entity names to an arbitrary colliding title.
    if (meta.title) {
      if (titleToPath.has(meta.title) && titleToPath.get(meta.title) !== p) {
        titleToPath.delete(meta.title);
        ambiguousTitles.add(meta.title);
      } else if (!ambiguousTitles.has(meta.title) && !titleToPath.has(meta.title)) {
        titleToPath.set(meta.title, p);
      }
    }
    // Also index the path-derived title so KG subjects (which fall back to the
    // basename when a note has no explicit title) still resolve.
    if (lookup.basenames.get(base) === p && !titleToPath.has(base)) titleToPath.set(base, p);
  }

  const linkGraph = new Map<string, Set<string>>();
  for (const [p, meta] of docMeta) {
    const resolved = new Set<string>();
    for (const target of extractWikilinks(meta.content)) {
      const t = resolveWikilink(target, lookup, p);
      if (t) resolved.add(t);
    }
    linkGraph.set(p, resolved);
  }
  return { linkGraph, titleToPath };
}

// Recall graph cache. Building the wikilink graph + PPR transition lists costs
// ~300 ms at 10k notes, so it is built once per index version (exact: every
// index mutation bumps `indexVersion`) rather than per query. KG mention edges
// live outside the index, so the cache also expires on a short TTL.
let cachedRecallGraph: { version: number; at: number; graph: RecallGraph } | null = null;
const RECALL_GRAPH_KG_TTL_MS = 5 * 60_000;

function getRecallGraph(): RecallGraph {
  const now = Date.now();
  if (
    cachedRecallGraph &&
    cachedRecallGraph.version === indexVersion &&
    now - cachedRecallGraph.at < RECALL_GRAPH_KG_TTL_MS
  ) {
    return cachedRecallGraph.graph;
  }
  const { linkGraph, titleToPath } = buildLinkGraphFromDocMeta();
  const mentions = kgAllMentionTriples(); // {subject(title), predicate, object(entity)}
  const graph = buildRecallGraph({ linkGraph, titleToPath, mentions });
  cachedRecallGraph = { version: indexVersion, at: now, graph };
  return graph;
}

/**
 * Run the PPR graph-recall arm for a query, seeded from `seedPaths` (the best
 * direct hits) plus any entities detected in the query.
 *
 * Returns the ranked PPR note results and the seed set, or an EMPTY result on
 * any failure / no-seed condition, so a caller can fuse it unconditionally.
 *
 * Synonymy edges are intentionally NOT built here: they would require an
 * O(N) embedding kNN sweep. The wikilink + mention substrate is sufficient for
 * the multi-hop bridges the arm targets; the `synonymyNeighbors` input of
 * buildRecallGraph remains available for the offline eval to exercise.
 */
function computeGraphArm(
  query: string,
  seedPaths: string[],
  limit: number,
): { results: Array<{ path: string; score: number }>; seeds: Set<string> } {
  try {
    const graph = getRecallGraph();
    const detected = detectEntities(query).map((e) => e.name);
    const seeds = extractSeeds(graph, seedPaths, detected);
    if (seeds.length === 0) return { results: [], seeds: new Set() };

    // Capture a cheap seed→spread readout for the dashboard's Graph-Recall panel
    // (reachable-set sizes at 1/2/3 hops from the seeds). BFS over the same
    // adjacency the PPR walk uses; best-effort, never affects the result.
    try { lastSeedSpread = computeSeedSpread(graph, query, seeds); } catch { /* non-critical */ }

    return { results: runPPR(graph, seeds, { limit }), seeds: new Set(seeds) };
  } catch {
    return { results: [], seeds: new Set() };
  }
}

// ── Recall-graph telemetry (Graph-Recall dashboard panel) ─────────────────
//
// Cheap, honest readouts of the PPR substrate: graph size (nodes/edges/avg
// degree) with a short TTL cache so the 2s SSE tick doesn't rebuild the graph
// every time, plus the last real query's seed→spread (reachable-set sizes at
// 1/2/3 hops). Nothing here is decorative — the numbers are the actual graph.

interface SeedSpread {
  query: string;
  seeds: number;
  hop1: number; hop2: number; hop3: number;
}
let lastSeedSpread: SeedSpread | null = null;

interface RecallGraphStats {
  nodes: number;
  edges: number;
  avgDegree: number;
  lastSeedSpread: SeedSpread | null;
}
let cachedGraphStats: { at: number; stats: RecallGraphStats } | null = null;
const GRAPH_STATS_TTL_MS = 15_000;

/**
 * BFS reachable-set sizes at 1/2/3 hops from the PPR seeds (note-path nodes
 * only, so the counts are notes the walk can reach). Router entity nodes are
 * traversed but not counted. Pure over the prebuilt graph adjacency.
 */
function computeSeedSpread(graph: RecallGraph, query: string, seeds: string[]): SeedSpread {
  const { adj, noteNodes } = graph;
  const seedSet = new Set(seeds.filter((s) => adj.has(s)));
  const visited = new Set<string>(seedSet);
  let frontier = new Set<string>(seedSet);
  const hopCounts: number[] = [];
  for (let hop = 0; hop < 3; hop++) {
    const next = new Set<string>();
    for (const node of frontier) {
      const nbrs = adj.get(node);
      if (!nbrs) continue;
      for (const nbr of nbrs.keys()) {
        if (visited.has(nbr)) continue;
        visited.add(nbr);
        next.add(nbr);
      }
    }
    // Count only note-path nodes reached at this hop.
    let noteHits = 0;
    for (const n of next) if (noteNodes.has(n)) noteHits++;
    hopCounts.push(noteHits);
    frontier = next;
  }
  return {
    query,
    seeds: seedSet.size,
    hop1: hopCounts[0] ?? 0,
    hop2: hopCounts[1] ?? 0,
    hop3: hopCounts[2] ?? 0,
  };
}

/**
 * Recall-graph substrate stats for the dashboard, TTL-cached (15s) so the SSE
 * tick never rebuilds the graph on the hot path. Builds the SAME wikilink +
 * mention graph the PPR arm walks, then counts note-path nodes, undirected
 * edges, and average weighted degree over note nodes. `lastSeedSpread` reflects
 * the most recent real PPR query (null until one runs). Safe to call with the
 * graph arm off — it just reports the substrate + a null spread.
 */
export function getRecallGraphStats(): RecallGraphStats {
  const now = Date.now();
  if (cachedGraphStats && now - cachedGraphStats.at < GRAPH_STATS_TTL_MS) {
    // Refresh only the seed spread (cheap pointer copy) so a fresh query shows
    // through even within the TTL window; the size counts stay cached.
    return { ...cachedGraphStats.stats, lastSeedSpread };
  }
  let stats: RecallGraphStats = { nodes: 0, edges: 0, avgDegree: 0, lastSeedSpread };
  try {
    const graph = getRecallGraph();
    const nodes = graph.noteNodes.size;
    // Count undirected edges once (adjacency is symmetric): sum degrees / 2.
    let edgeEnds = 0;
    let noteDegreeSum = 0;
    for (const [node, nbrs] of graph.adj) {
      edgeEnds += nbrs.size;
      if (graph.noteNodes.has(node)) noteDegreeSum += nbrs.size;
    }
    const edges = Math.round(edgeEnds / 2);
    const avgDegree = nodes > 0 ? Math.round((noteDegreeSum / nodes) * 100) / 100 : 0;
    stats = { nodes, edges, avgDegree, lastSeedSpread };
  } catch {
    // fall through with the zeroed stats
  }
  cachedGraphStats = { at: now, stats };
  return stats;
}

/** Per-note accumulator for arm fusion. */
interface FusedEntry {
  lexical: number;
  semantic: number;
  graph: number;
  lexicalRaw?: number;
  semanticSim?: number;
  coverage?: number;
  lexicalEvidence?: number;
  chunk?: SearchResult['chunk'];
}

/** Query-aware snippet: the lexical passage, or the best chunk for a hit the lexical arm did not find. */
function snippetFor(content: string, query: string, lexical: number, chunk: SearchResult['chunk']): string {
  if (lexical <= 0 && chunk?.text) return chunkSnippet(chunk.text);
  return bestPassage(content, query);
}

/** Head of a chunk as a one-paragraph snippet (same width as bestPassage). */
export function chunkSnippet(text: string, width = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width).trimEnd()}…` : flat;
}

const RRF_K = 60;
/** Direct hits (lexical ⊕ semantic) used to seed the PPR walk. */
const GRAPH_SEED_COUNT = 5;

/**
 * Hybrid search: lexical (MiniSearch BM25) ⊕ semantic (embedding kNN) ⊕ an
 * optional PPR graph arm. Every arm is scope-filtered BEFORE it is ranked, then
 * fused per `config.hybridFusion`:
 *
 *   score (default)  fused = wLex · bm25/bestBm25
 *                          + wSem · max(0, (cos − floor) / (1 − floor))
 *                          + wGraph · ppr/bestPpr          (non-seed notes only)
 *   rrf   (legacy)   fused = Σ 1/(60 + rank + 1) over the arms
 *
 * Falls back to lexical-only (raw BM25 scores) when embeddings are unavailable
 * and the graph arm contributed nothing.
 */
export async function hybridSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const overFetch = limit * 2;
  const rrf = config.hybridFusion === 'rrf';

  const embeddingsReady = isEmbeddingsReady();

  // Lexical (sync) and semantic (async, includes query-embed) are independent.
  // Kick off the semantic query concurrently so its embedding forward pass
  // overlaps the lexical search instead of running strictly after it. The
  // vector index holds EVERY note, so fetch a deep candidate list: with a
  // shallow k a filtered search (type:memory, archived excluded) is starved.
  const semanticPromise = embeddingsReady
    ? searchSemantic(query, Math.max(overFetch, config.semanticCandidates))
    : null;
  // Guard against an unhandled rejection if the synchronous lexical call below
  // throws before we reach the await. The real error is still handled at the
  // await (this attached catch does not consume it there).
  if (semanticPromise) semanticPromise.catch(() => {});

  // Lexical results (always available). Snippets are built later, only for
  // the notes that are actually returned.
  const lexFetch = rrf ? overFetch : Math.max(overFetch, config.lexicalCandidates);
  let lexicalResults = lexicalSearch(query, { ...opts, limit: lexFetch }, false);

  // Bitemporal as-of suppression (ONLY when asOf is passed).
  if (opts.asOf) {
    lexicalResults = filterByAsOf(lexicalResults, opts.asOf, { type: opts.type, category: opts.category });
  }

  const inScope = (p: string): boolean => {
    const meta = docMeta.get(p);
    if (!meta || !passesFilters(p, meta, opts)) return false;
    if (opts.asOf && !withinWindow(meta.valid_from ?? meta.date, meta.valid_to, opts.asOf)) return false;
    return true;
  };

  // Semantic results, scope-filtered so ranks/scores are relative to the
  // candidate pool the caller asked for. Any failure → arm contributes nothing.
  let semanticResults: Array<{ path: string; score: number; chunk?: SearchResult['chunk'] }> = [];
  if (semanticPromise) {
    try {
      semanticResults = (await semanticPromise).filter((r) => inScope(r.path));
    } catch {
      semanticResults = [];
    }
  }

  // ── Fuse the two direct arms ──
  const fused = new Map<string, FusedEntry>();
  const entry = (p: string): FusedEntry => {
    let e = fused.get(p);
    if (!e) { e = { lexical: 0, semantic: 0, graph: 0 }; fused.set(p, e); }
    return e;
  };
  const bestRaw = lexicalResults[0]?.lexicalRaw ?? lexicalResults[0]?.score ?? 0;
  const useSemantic = semanticResults.length > 0;
  lexicalResults.forEach((r, rank) => {
    const e = entry(r.path);
    const raw = r.lexicalRaw ?? r.score;
    e.lexicalRaw = raw;
    e.coverage = r.coverage;
    e.lexicalEvidence = r.lexicalEvidence;
    e.lexical = rrf ? 1 / (RRF_K + rank + 1) : (bestRaw > 0 ? config.fusionLexicalWeight * (raw / bestRaw) : 0);
  });
  const floor = Math.min(Math.max(config.fusionSemanticFloor, 0), 0.99);
  semanticResults.forEach((r, rank) => {
    const e = entry(r.path);
    e.semanticSim = r.score;
    e.chunk = r.chunk;
    e.semantic = rrf
      ? 1 / (RRF_K + rank + 1)
      : config.fusionSemanticWeight * Math.max(0, (r.score - floor) / (1 - floor));
  });

  // ── PPR graph-recall arm (DORMANT by default) ──
  // Seeded from the best DIRECT hits of both arms (not the lexical top alone),
  // and — under score fusion — credited only to notes that are not seeds: a
  // seed's own restart mass is the direct evidence it was already scored for,
  // so adding it again would count that evidence twice.
  const graphArmActive = config.pprRecall || opts.graph === true;
  let graphContributed = false;
  if (graphArmActive) {
    const direct = [...fused.entries()]
      .sort((a, b) => (b[1].lexical + b[1].semantic) - (a[1].lexical + a[1].semantic))
      .map(([p]) => p);
    const seedPaths = rrf ? lexicalResults.map((r) => r.path) : direct.slice(0, GRAPH_SEED_COUNT);
    const { results: ppr, seeds } = computeGraphArm(query, seedPaths, lexicalResults.length + 40);
    if (rrf) {
      for (const [p, v] of pprRrfContribution(ppr, RRF_K)) {
        entry(p).graph += v;
        graphContributed = true;
      }
    } else {
      const spread = ppr.filter((r) => !seeds.has(r.path));
      const best = spread[0]?.score ?? 0;
      if (best > 0) {
        for (const r of spread) {
          entry(r.path).graph += config.pprWeight * (r.score / best);
          graphContributed = true;
        }
      }
    }
  }

  // Lexical-only path (embeddings off / failed / empty, no graph contribution):
  // unchanged raw BM25 scores.
  if (!useSemantic && !graphContributed) {
    return lexicalResults.slice(0, limit).map((r) => {
      const meta = docMeta.get(r.path);
      return { ...r, snippet: meta && opts.snippets !== false ? bestPassage(meta.content, query) : r.snippet };
    });
  }

  // Sort by fused score, re-check scope (graph-arm notes are unfiltered), apply
  // the collection weight and map to SearchResult.
  const total = (e: FusedEntry) => e.lexical + e.semantic + e.graph;
  const ranked: Array<{ path: string; e: FusedEntry; meta: DocMeta; score: number }> = [];
  for (const [fusedPath, e] of fused) {
    const meta = docMeta.get(fusedPath);
    if (!meta) continue;
    if (e.graph > 0 && e.lexical === 0 && e.semantic === 0 && !inScope(fusedPath)) continue;
    ranked.push({ path: fusedPath, e, meta, score: total(e) * getCollectionWeight(meta.collection) });
  }
  ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  const results: SearchResult[] = ranked.slice(0, limit).map(({ path: p, e, meta, score }) => ({
    path: p,
    title: meta.title,
    snippet: opts.snippets !== false ? snippetFor(meta.content, query, e.lexical, e.chunk) : '',
    score,
    lexicalScore: e.lexical,
    semanticScore: e.semantic,
    graphScore: e.graph,
    fusedScore: score,
    lexicalRaw: e.lexicalRaw,
    semanticSim: e.semanticSim,
    coverage: e.coverage,
    lexicalEvidence: e.lexicalEvidence,
    ...(e.chunk ? { chunk: e.chunk } : {}),
  }));

  // LLM reranking pass (if enabled). A caller may force-skip via opts.rerank
  // === false even when the reranker is globally enabled; when opts.rerank is
  // undefined the global setting decides. memory_recall always passes false and
  // reranks AFTER its own re-scoring (so the reranker's order is the final one).
  if (opts.rerank !== false && isRerankerEnabled() && results.length > 1) {
    try {
      const candidates = results.map((r, i) => ({
        index: i,
        title: r.title,
        snippet: r.snippet,
      }));
      const rerankedIndices = await rerankResults(query, candidates);
      const reranked = rerankedIndices.map((idx) => results[idx]).filter(Boolean);
      if (reranked.length > 0) {
        return reranked;
      }
    } catch {
      // Reranker failure — return results in original fused order
    }
  }

  return results;
}

/**
 * Return the last index rebuild health report.
 */
export function getIndexHealth(): IndexHealthEntry[] {
  return lastIndexHealth;
}

/**
 * Return the docMeta map as readonly for external consumers.
 */
export function getDocMeta(): ReadonlyMap<string, Readonly<DocMeta>> {
  return docMeta;
}

export interface DocMetaSummaryEntry {
  path: string;
  title: string;
  heat_score: number;
  temperature: string;
  category: string;
  last_accessed: string | null;
}

export function getCollectionDistribution(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, meta] of docMeta) {
    const c = meta.collection ?? 'general';
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compute vault health stats from the indexed docMeta.
 * Lightweight: iterates docMeta in memory (no disk I/O).
 */
export function getVaultHealth(): {
  fileCountByType: Record<string, number>;
  totalFiles: number;
  totalMdFiles: number;
  archivedNotes: number;
  staleNotes: number;
} {
  const fileCountByType: Record<string, number> = {};
  let totalFiles = 0;
  let archivedNotes = 0;
  let staleNotes = 0;
  const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

  for (const [path, meta] of docMeta) {
    totalFiles++;
    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : 'md';
    fileCountByType[ext] = (fileCountByType[ext] ?? 0) + 1;

    if (meta.archived) archivedNotes++;

    // Check staleness based on last_accessed
    if (meta.last_accessed) {
      const accessed = new Date(meta.last_accessed).getTime();
      if (!isNaN(accessed) && accessed < sixtyDaysAgo) staleNotes++;
    }
  }

  return {
    fileCountByType,
    totalFiles,
    totalMdFiles: fileCountByType['md'] ?? totalFiles,
    archivedNotes,
    staleNotes,
  };
}

export function getDocMetaSummary(): {
  topByHeat: DocMetaSummaryEntry[];
  categoryBreakdown: Record<string, number>;
  heatHistogram: number[];
} {
  const entries: DocMetaSummaryEntry[] = [];
  const catCounts: Record<string, number> = {};
  const histogram = [0, 0, 0, 0]; // [0-4), [4-8), [8-12), [12+)

  for (const [path, meta] of docMeta) {
    const hs = meta.heat_score ?? 0;
    const cat = meta.category ?? 'uncategorized';

    entries.push({
      path,
      title: meta.title,
      heat_score: hs,
      temperature: meta.temperature ?? 'unknown',
      category: cat,
      last_accessed: meta.last_accessed ?? null,
    });

    catCounts[cat] = (catCounts[cat] || 0) + 1;

    const bucket = Math.min(Math.floor(hs / 4), 3);
    histogram[bucket]++;
  }

  entries.sort((a, b) => b.heat_score - a.heat_score);

  return {
    topByHeat: entries.slice(0, 10),
    categoryBreakdown: catCounts,
    heatHistogram: histogram,
  };
}
