/**
 * Entity registry backfill.
 *
 * Scans the already-indexed note corpus, runs the EXISTING heuristic entity
 * detector (`detectEntities`), and (re)populates the persistent entity registry
 * via the EXISTING `registerEntity` upsert path — the same path the incremental
 * write hooks (memory_store/notes_upsert) use. Optionally seeds the knowledge
 * graph with `mentions_*` triples via the EXISTING `kgAddTriple`.
 *
 * This file REUSES detection/registry/KG logic — it does not reinvent any of it.
 *
 * Why it exists: the registry only fills incrementally on writes, so a vault
 * that predates the write hooks shows an empty dashboard "Entity Intelligence"
 * panel. This backfill seeds the registry from the existing corpus so the SSE
 * payload's `entityStats` / `entityRegistry[]` populate live on the next tick.
 *
 * Idempotency / safe to re-run: guaranteed by `registerEntity`'s normalized-name
 * dedup + monotonic tier (never downgrades a `confirmed` entity) and
 * `kgAddTriple`'s md5 upsert. Re-running only bumps occurrences/lastSeen.
 */

import { detectEntities } from './entity-detector.js';
import { loadRegistry, registerEntity, saveRegistry } from './entity-registry.js';
import { isKgInitialized, kgAddTriple } from './knowledge-graph.js';
import { logger } from './logger.js';

/** Minimal structural shape of a corpus note. A structural subset of search.ts's DocMeta. */
export interface BackfillDocMeta {
  title: string;
  content: string;
  collection: string;
  archived?: boolean;
}

export interface EntityBackfillOptions {
  /** Max notes to scan this run (corpus may be 3000+). Default: all. */
  limit?: number;
  /** Per-note content slice fed to the detector. Default 5000 (match kgBootstrap). */
  maxCharsPerNote?: number;
  /** Min detector confidence to register. Default 0.7 (match write hooks). */
  minConfidence?: number;
  /** Also seed KG entity↔note `mentions_*` triples while scanning. Default true if KG init'd. */
  seedKg?: boolean;
  /** Skip notes whose collection is in this set (e.g. EmailLog to avoid sender spam). */
  excludeCollections?: string[];
}

export interface EntityBackfillResult {
  /** Notes actually scanned (after limit / skip filters). */
  scanned: number;
  /** Total `registerEntity` calls made (includes occurrence bumps on existing entities). */
  entitiesUpserted: number;
  /** Distinct normalized entity names touched this run. */
  uniqueEntities: number;
  /** Entity↔note `mentions_*` triples created this run (0 if KG not seeded). */
  kgTriples: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

const DEFAULT_MAX_CHARS = 5000;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_EXCLUDE_COLLECTIONS = ['EmailLog'];

/**
 * Synchronous single-pass backfill over a corpus map.
 *
 * REUSES: detectEntities (detection), registerEntity (dedup/merge/occurrences/
 * monotonic-tier), kgAddTriple (idempotent KG seeding). No detection, dedup, or
 * triple logic is reimplemented here.
 */
export function backfillEntities(
  docMeta: ReadonlyMap<string, BackfillDocMeta>,
  opts: EntityBackfillOptions = {},
): EntityBackfillResult {
  const start = Date.now();
  const maxChars = opts.maxCharsPerNote ?? DEFAULT_MAX_CHARS;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const excluded = new Set(opts.excludeCollections ?? DEFAULT_EXCLUDE_COLLECTIONS);
  const seedKg = (opts.seedKg ?? true) && isKgInitialized();

  // Explicit load up front (registerEntity lazy-loads too, but this keeps intent clear
  // and ensures detector's registry-aware confidence boost sees the persisted state).
  loadRegistry();

  let entries = [...docMeta.entries()];
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    entries = entries.slice(0, opts.limit);
  }

  let scanned = 0;
  let entitiesUpserted = 0;
  let kgTriples = 0;
  const touched = new Set<string>();

  for (const [notePath, meta] of entries) {
    if (meta.archived === true) continue;
    if (meta.collection && excluded.has(meta.collection)) continue;

    scanned++;
    const content = meta.content ?? '';
    if (!content) continue;

    const noteTitle = meta.title || notePath.replace(/\.md$/, '').split('/').pop() || notePath;

    const detected = detectEntities(content.slice(0, maxChars))
      .filter((e) => e.confidence >= minConfidence);

    for (const e of detected) {
      // REUSE the registry upsert: dedup by normalized name, merge aliases,
      // increment occurrences, set tier='detected' (monotonic — never downgrades
      // a 'confirmed' entity), track firstSeen/lastSeen + a representative notePath.
      registerEntity(e.name, e.type, { tier: 'detected', notePath });
      entitiesUpserted++;
      touched.add(`${e.type}:${e.name.toLowerCase().replace(/\s+/g, ' ').trim()}`);

      if (seedKg) {
        // Same predicate mapping kgBootstrap uses; kgAddTriple is an md5 upsert (idempotent).
        const predicate = e.type === 'person' ? 'mentions_person'
          : e.type === 'organization' ? 'mentions_org'
            : 'mentions_project';
        try {
          const added = kgAddTriple(noteTitle, predicate, e.name, {
            source: `backfill:entity-detect:${notePath}`,
            confidence: e.confidence,
          });
          if (added.created) kgTriples++;
        } catch (err) {
          // KG write failure must not abort the registry backfill.
          logger.warn('entity-backfill: kgAddTriple failed', {
            notePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Force-flush past registerEntity's 500ms debounce so the result is durable
  // immediately even if the process is short-lived.
  saveRegistry();

  const result: EntityBackfillResult = {
    scanned,
    entitiesUpserted,
    uniqueEntities: touched.size,
    kgTriples,
    durationMs: Date.now() - start,
  };

  logger.info('Entity backfill complete', { ...result, seedKg });
  return result;
}

/**
 * Async, corpus-wide entry point used by the dashboard HTTP action and any tool.
 * Pulls the indexed corpus from search.ts (covers brain + source vaults, which the
 * indexer already merged in) and runs the synchronous backfill.
 *
 * Pass `getDocMeta()`'s value directly — its DocMeta is a structural superset of
 * BackfillDocMeta. Imported lazily so this module stays unit-testable without the
 * full indexer (tests pass an in-memory map to `backfillEntities` directly).
 */
export async function rebuildEntityRegistry(
  opts: EntityBackfillOptions = {},
): Promise<EntityBackfillResult> {
  const { getDocMeta } = await import('./search.js');
  return backfillEntities(getDocMeta(), opts);
}
