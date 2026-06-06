import MiniSearch from 'minisearch';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listFiles, readNote } from './vault.js';
import { parseFrontmatter } from './frontmatter.js';
import { setIndexedNotes, recordIndexRebuild } from './metrics.js';
import { logger } from './logger.js';
import { isEmbeddingsReady, searchSemantic, embedAndIndex, removeFromVectorIndex } from './embeddings.js';
import { classifyPath, getCollectionWeight } from './collections.js';
import { isRerankerEnabled, rerankResults } from './reranker.js';
import { isPathIndexable, sourceNameForVault } from './index-allowlist.js';
import { getVault, pruneStaleVaultTransports } from './vault/registry.js';
import { listSourceVaultPaths } from './source-vaults.js';

export interface SearchOptions {
  scopePaths?: string[];
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  type?: string;
  category?: string;
  temperature?: 'hot' | 'warm' | 'cold';
  minHeatScore?: number;
  importance?: string;
  excludeArchived?: boolean;
  collections?: string[];
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;           // keep for backward compat (= fusedScore)
  lexicalScore: number;    // RRF contribution from lexical search
  semanticScore: number;   // RRF contribution from semantic search
  fusedScore: number;      // lexicalScore + semanticScore
}

interface DocMeta {
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
  collection: string;
  // Carried so memory_recall can score/filter without re-reading the file:
  related?: string[];
  validity_alpha?: number;
  validity_beta?: number;
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
const docMeta = new Map<string, DocMeta>();
let indexedNoteCount = 0;
let lastIndexHealth: IndexHealthEntry[] = [];

// Track file modification times for incremental rebuilds
const fileMtimes = new Map<string, number>();
let isFirstBuild = true;

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

/**
 * Rebuild the full-text search index by scanning all vaults.
 * After the first full build, subsequent calls are incremental:
 * only files whose mtime has changed (or new/deleted files) are re-indexed.
 */
export async function rebuildIndex(): Promise<void> {
  if (isFirstBuild) {
    // First build: full scan
    miniSearch = createIndex();
    docMeta.clear();
    fileMtimes.clear();
  }

  lastIndexHealth = [];

  let fileCount = isFirstBuild ? 0 : docMeta.size;
  let updatedCount = 0;
  let removedCount = 0;

  // Track which files we see this scan (to detect deletions)
  const seenFiles = new Set<string>();

  // Dynamic vault set: the brain vault plus the runtime-merged source vaults
  // (env + persisted). Using this rather than the frozen `config.allVaults`
  // means a vault added/removed at runtime is picked up on the next rebuild.
  const vaults = [config.brainVault, ...listSourceVaultPaths()];

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
      if (isFirstBuild) {
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
      if (isFirstBuild && files.length !== before) {
        logger.info('Applied source-vault index allowlist', {
          vault, kept: files.length, excluded: before - files.length,
        });
      }
    }

    let skippedEnoent = 0;
    const enoentSamples: string[] = [];
    let permissionErrors = 0;
    const permissionSamples: string[] = [];
    const otherErrors: Array<{ path: string; error: string }> = [];

    for (const relPath of files) {
      seenFiles.add(relPath);

      try {
        const absPath = path.resolve(vault, relPath);

        // On incremental rebuilds, check mtime to skip unchanged files
        if (!isFirstBuild) {
          try {
            const fileStat = transport
              ? await transport.stat(relPath)
              : await stat(absPath);
            if (fileStat) {
              const mtime = fileStat.mtimeMs;
              const prevMtime = fileMtimes.get(relPath);
              if (prevMtime !== undefined && mtime === prevMtime) {
                continue; // file unchanged, skip
              }
              fileMtimes.set(relPath, mtime);
            }
          } catch {
            // If stat fails, re-index the file anyway
          }
        }

        const content = transport
          ? (await transport.read(relPath)).content.toString('utf-8')
          : await readFile(absPath, 'utf-8');
        const { data, body } = parseFrontmatter(content);

        const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
        const title =
          data.title ?? relPath.replace(/\.md$/, '').split('/').pop() ?? relPath;
        const date = data.date ?? data.created ?? undefined;

        // On incremental rebuild, remove old entry before re-adding
        if (!isFirstBuild && docMeta.has(relPath)) {
          try { miniSearch.discard(relPath); } catch { /* may not exist */ }
        }

        docMeta.set(relPath, {
          date,
          tags,
          content: body,
          title,
          type: typeof data.type === 'string' ? data.type : undefined,
          category: typeof data.category === 'string' ? data.category : undefined,
          temperature: typeof data.temperature === 'string' ? data.temperature : undefined,
          heat_score: typeof data.heat_score === 'number' ? data.heat_score : undefined,
          importance: typeof data.importance === 'string' ? data.importance : undefined,
          last_accessed: typeof data.last_accessed === 'string' ? data.last_accessed : undefined,
          archived: typeof data.archived === 'boolean' ? data.archived : undefined,
          collection: classifyPath(relPath),
          related: Array.isArray(data.related) ? data.related as string[] : undefined,
          validity_alpha: typeof data.validity_alpha === 'number' ? data.validity_alpha : undefined,
          validity_beta: typeof data.validity_beta === 'number' ? data.validity_beta : undefined,
        });

        miniSearch.add({
          id: relPath,
          title,
          content: body,
          tags: tags.join(' '),
        });

        if (isFirstBuild) {
          fileCount++;
          // Store mtime for future incremental builds
          try {
            const fileStat = transport
              ? await transport.stat(relPath)
              : await stat(absPath);
            if (fileStat) fileMtimes.set(relPath, fileStat.mtimeMs);
          } catch { /* non-critical */ }
        } else {
          updatedCount++;
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
    }

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
    lastIndexHealth.push({
      vault,
      fileCount: files.length,
      indexed: isFirstBuild ? fileCount : docMeta.size,
      enoent: skippedEnoent,
      enoentSamples,
      permissionErrors,
      permissionSamples,
      otherErrors: otherErrors.length,
    });
  }

  // Remove deleted files from the index (only on incremental rebuilds)
  if (!isFirstBuild) {
    for (const existingPath of [...docMeta.keys()]) {
      if (!seenFiles.has(existingPath)) {
        try { miniSearch.discard(existingPath); } catch { /* may not exist */ }
        docMeta.delete(existingPath);
        fileMtimes.delete(existingPath);
        removeFromVectorIndex(existingPath);
        removedCount++;
      }
    }
    fileCount = docMeta.size;
  }

  isFirstBuild = false;
  indexedNoteCount = fileCount;
  setIndexedNotes(fileCount);
  recordIndexRebuild();

  if (updatedCount > 0 || removedCount > 0) {
    logger.info('Search index updated (incremental)', {
      indexedNotes: fileCount, updated: updatedCount, removed: removedCount,
    });
  } else if (updatedCount === 0 && removedCount === 0 && !isFirstBuild) {
    logger.debug('Search index unchanged');
  } else {
    logger.info('Search index rebuilt', { indexedNotes: fileCount });
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

  const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
  const title =
    data.title ?? filePath.replace(/\.md$/, '').split('/').pop() ?? filePath;
  const date = data.date ?? data.created ?? undefined;

  // Remove old entry if it exists
  try {
    miniSearch.discard(filePath);
  } catch {
    // Document may not exist in the index yet — that's fine
  }

  // Update docMeta
  docMeta.set(filePath, {
    date,
    tags,
    content: body,
    title,
    type: typeof data.type === 'string' ? data.type : undefined,
    category: typeof data.category === 'string' ? data.category : undefined,
    temperature: typeof data.temperature === 'string' ? data.temperature : undefined,
    heat_score: typeof data.heat_score === 'number' ? data.heat_score : undefined,
    importance: typeof data.importance === 'string' ? data.importance : undefined,
    last_accessed: typeof data.last_accessed === 'string' ? data.last_accessed : undefined,
    archived: typeof data.archived === 'boolean' ? data.archived : undefined,
    collection: classifyPath(filePath),
    related: Array.isArray(data.related) ? data.related as string[] : undefined,
    validity_alpha: typeof data.validity_alpha === 'number' ? data.validity_alpha : undefined,
    validity_beta: typeof data.validity_beta === 'number' ? data.validity_beta : undefined,
  });

  // Add to MiniSearch
  miniSearch.add({
    id: filePath,
    title,
    content: body,
    tags: tags.join(' '),
  });

  // Update vector index (non-blocking)
  if (isEmbeddingsReady()) {
    embedAndIndex(filePath, body).catch(err => {
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
  removeFromVectorIndex(filePath);
  indexedNoteCount = docMeta.size;
  setIndexedNotes(indexedNoteCount);
}

/**
 * Search indexed notes with optional filters.
 */
export function searchNotes(
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  if (!miniSearch) {
    throw new Error(
      'Search index not built. Call rebuildIndex() before searching.',
    );
  }

  const {
    scopePaths, tags, dateFrom, dateTo, limit = 20,
    type, category, temperature, minHeatScore, importance,
    excludeArchived = true, collections,
  } = opts;

  let results = miniSearch.search(query);

  // Post-filter
  const filtered = results.filter((r) => {
    const meta = docMeta.get(r.id as string);
    if (!meta) return false;

    // Exclude archived by default
    if (excludeArchived && meta.archived === true) return false;

    // Collection filter
    if (collections && collections.length > 0 && !collections.includes(meta.collection)) return false;

    // Scope paths — prefix match
    if (scopePaths && scopePaths.length > 0) {
      const id = r.id as string;
      if (!scopePaths.some((sp) => id.startsWith(sp))) return false;
    }

    // Tags filter
    if (tags && tags.length > 0) {
      if (!tags.some((t) => meta.tags.includes(t))) return false;
    }

    // Date range filter
    if (meta.date) {
      if (dateFrom && meta.date < dateFrom) return false;
      if (dateTo && meta.date > dateTo) return false;
    } else if (dateFrom || dateTo) {
      // No date metadata — exclude from date-filtered results
      return false;
    }

    // Type filter
    if (type && meta.type !== type) return false;

    // Category filter
    if (category && meta.category !== category) return false;

    // Temperature filter
    if (temperature && meta.temperature !== temperature) return false;

    // Minimum heat score filter
    if (minHeatScore !== undefined && (meta.heat_score === undefined || meta.heat_score < minHeatScore)) return false;

    // Importance filter
    if (importance && meta.importance !== importance) return false;

    return true;
  });

  return filtered.slice(0, limit).map((r) => {
    const meta = docMeta.get(r.id as string)!;
    return {
      path: r.id as string,
      title: meta.title,
      snippet: meta.content.slice(0, 200),
      score: r.score,
      lexicalScore: r.score,
      semanticScore: 0,
      fusedScore: r.score,
    };
  });
}

/**
 * Hybrid search combining lexical (MiniSearch) and semantic (embeddings) results
 * using Reciprocal Rank Fusion. Falls back to lexical-only if embeddings unavailable.
 */
export async function hybridSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const overFetch = limit * 2;

  // Lexical results (always available)
  const lexicalResults = searchNotes(query, { ...opts, limit: overFetch });

  // Semantic results (if available)
  if (!isEmbeddingsReady()) {
    return lexicalResults.slice(0, limit).map(r => ({
      ...r,
      lexicalScore: r.lexicalScore,
      semanticScore: 0,
      fusedScore: r.lexicalScore,
      score: r.lexicalScore,
    }));
  }

  let semanticResults: Array<{ path: string; score: number }>;
  try {
    semanticResults = await searchSemantic(query, overFetch);
  } catch {
    return lexicalResults.slice(0, limit);
  }

  if (semanticResults.length === 0) {
    return lexicalResults.slice(0, limit);
  }


  // RRF fusion
  const k = 60;
  const fused = new Map<string, { lexical: number; semantic: number }>();

  lexicalResults.forEach((r, rank) => {
    const entry = fused.get(r.path) ?? { lexical: 0, semantic: 0 };
    entry.lexical += 1 / (k + rank + 1);
    fused.set(r.path, entry);
  });

  semanticResults.forEach((r, rank) => {
    const entry = fused.get(r.path) ?? { lexical: 0, semantic: 0 };
    entry.semantic += 1 / (k + rank + 1);
    fused.set(r.path, entry);
  });

  // Sort by fused score descending
  const fusedEntries = [...fused.entries()].sort((a, b) => (b[1].lexical + b[1].semantic) - (a[1].lexical + a[1].semantic));

  // Apply post-filters and map to SearchResult
  const {
    scopePaths, tags, dateFrom, dateTo, type, category, temperature,
    minHeatScore, importance, excludeArchived = true, collections,
  } = opts;

  const results: SearchResult[] = [];
  for (const [fusedPath, fusedEntry] of fusedEntries) {
    if (results.length >= limit) break;

    const meta = docMeta.get(fusedPath);
    if (!meta) continue;

    // Apply same filters as searchNotes
    if (excludeArchived && meta.archived === true) continue;
    if (collections && collections.length > 0 && !collections.includes(meta.collection)) continue;
    if (scopePaths && scopePaths.length > 0 && !scopePaths.some(sp => fusedPath.startsWith(sp))) continue;
    if (tags && tags.length > 0 && !tags.some(t => meta.tags.includes(t))) continue;
    if (meta.date) {
      if (dateFrom && meta.date < dateFrom) continue;
      if (dateTo && meta.date > dateTo) continue;
    } else if (dateFrom || dateTo) {
      continue;
    }
    if (type && meta.type !== type) continue;
    if (category && meta.category !== category) continue;
    if (temperature && meta.temperature !== temperature) continue;
    if (minHeatScore !== undefined && (meta.heat_score === undefined || meta.heat_score < minHeatScore)) continue;
    if (importance && meta.importance !== importance) continue;

    // Apply collection weight boost
    const collectionBoost = getCollectionWeight(meta.collection);
    const rawFused = fusedEntry.lexical + fusedEntry.semantic;
    const boostedScore = rawFused * collectionBoost;

    results.push({
      path: fusedPath,
      title: meta.title,
      snippet: meta.content.slice(0, 200),
      score: boostedScore,
      lexicalScore: fusedEntry.lexical,
      semanticScore: fusedEntry.semantic,
      fusedScore: boostedScore,
    });
  }

  // Re-sort after collection boost (may change ordering)
  results.sort((a, b) => b.score - a.score);

  // LLM reranking pass (if enabled)
  if (isRerankerEnabled() && results.length > 1) {
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
