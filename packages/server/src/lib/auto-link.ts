/**
 * Automatic linking on store (Phase A).
 *
 * Centralizes the three "make the graph grow on write" behaviors that used to
 * be either missing or copy-pasted:
 *   1. autoLinkEntities  — detected entities → path-qualified wiki links when
 *      a unique note exists, resolving registry aliases to canonical names.
 *   2. selectAutoRelated — high-scoring `findSimilarNotes` neighbors → strippable
 *      `[[path]]` backlinks (the similarity signal was previously computed on
 *      every store and thrown away).
 *   3. seedEntityKg      — inline `mentions_*` + `co_mentioned` KG triples so the
 *      temporal graph grows on every write, not just on manual bootstrap.
 *
 * Everything here is conservative + reversible and never throws: auto links are
 * clearly marked at the call sites (`## Related (auto)` / `## Entities (auto)`
 * sections, `auto_related` frontmatter) and all behavior is config-gated.
 */
import { config } from '../config.js';
import { logger } from './logger.js';
import { registerEntity, findEntity } from './entity-registry.js';
import { kgAddTriple, isKgInitialized } from './knowledge-graph.js';
import type { DetectedEntity } from './entity-detector.js';
import type { SimilarNote } from './similar-notes.js';
import { getDocMeta } from './search.js';
import { buildLinkLookup, resolveWikilink } from './link-resolver.js';

type EntityType = 'person' | 'project' | 'organization';

/**
 * Resolve a detected surface form to its canonical registry name (collapsing
 * aliases). Returns the input unchanged when the registry has no match. Uses the
 * canonical name for display and lookup. Never throws.
 */
export function resolveCanonical(name: string): string {
  try {
    const hit = findEntity(name);
    if (hit?.name) return hit.name;
  } catch {
    // Registry unavailable — fall back to the raw name.
  }
  return name;
}

/**
 * Resolve detected entities to existing, unambiguous path-qualified wiki
 * links. Keep registry name/type/occurrence fresh; omit unresolved links.
 */
export function autoLinkEntities(
  entities: Array<{ name: string; type: EntityType }>,
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const lookup = buildLinkLookup(getDocMeta().keys());
  for (const e of entities) {
    const raw = e.name.trim();
    if (!raw) continue;
    const canonical = resolveCanonical(raw).trim() || raw;
    let registryPath: string | undefined;
    try { registryPath = findEntity(raw)?.notePath; } catch { /* registry unavailable */ }
    const target = registryPath && lookup.paths.has(registryPath)
      ? registryPath
      : resolveWikilink(canonical, lookup);
    // Do not emit an ambiguous or nonexistent wiki link as though it were
    // connected to an entity note.
    const link = target ? `[[${target}|${canonical}]]` : undefined;
    if (link && !seen.has(link)) {
      seen.add(link);
      links.push(link);
    }
    // Keep the registry fresh; only existing indexed paths are emitted above.
    try {
      registerEntity(e.name, e.type, { tier: 'detected' });
    } catch {
      // Non-critical.
    }
  }
  return links;
}

/**
 * Turn the (already-computed) ranked similar notes into strippable `[[path]]`
 * backlinks, gated by a higher score floor than the advisory surface and capped.
 * Returns [] when the feature is disabled or nothing clears the floor.
 */
export function selectAutoRelated(similar: SimilarNote[]): string[] {
  if (!config.autoLink || !config.autoLinkRelatedNotes) return [];
  return similar
    .filter((n) => n.score >= config.autoLinkRelatedMinScore)
    .slice(0, config.autoLinkRelatedMax)
    .map((n) => `[[${n.path}]]`);
}

// Cap pairwise co-occurrence so a note naming many entities doesn't emit an
// O(n^2) blast of low-value edges.
const CO_OCCURRENCE_ENTITY_CAP = 8;

/**
 * Seed the temporal knowledge graph from a note's detected entities:
 *   subject = note title, predicate = mentions_{person,org,project}, object = entity
 * plus pairwise `co_mentioned` edges between entities that appear together.
 * kgAddTriple is an md5 upsert (idempotent). Config-gated; never throws.
 */
export function seedEntityKg(
  noteTitle: string,
  entities: DetectedEntity[],
  notePath: string,
): void {
  if (!config.autoLink || !config.autoSeedKg || !config.kgEnabled) return;
  if (entities.length === 0 || !isKgInitialized()) return;
  const source = `autolink:store:${notePath}`;
  try {
    for (const e of entities) {
      const predicate =
        e.type === 'person' ? 'mentions_person'
          : e.type === 'organization' ? 'mentions_org'
            : 'mentions_project';
      kgAddTriple(noteTitle, predicate, e.name, { source, confidence: e.confidence });
    }
    const co = entities.slice(0, CO_OCCURRENCE_ENTITY_CAP);
    for (let i = 0; i < co.length; i++) {
      for (let j = i + 1; j < co.length; j++) {
        const a = co[i];
        const b = co[j];
        kgAddTriple(a.name, 'co_mentioned', b.name, {
          source,
          confidence: Math.min(a.confidence, b.confidence) * 0.6,
        });
      }
    }
  } catch (err) {
    logger.warn('seedEntityKg failed', {
      notePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
