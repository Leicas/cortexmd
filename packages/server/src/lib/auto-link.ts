/**
 * Automatic linking on store (Phase A).
 *
 * Centralizes the three "make the graph grow on write" behaviors that used to
 * be either missing or copy-pasted:
 *   1. autoLinkEntities  — detected entities → `[[Canonical Name]]` wiki-links,
 *      resolving aliases to their canonical registry name so "GH" and "GitHub"
 *      collapse onto one node.
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

type EntityType = 'person' | 'project' | 'organization';

/**
 * Resolve a detected surface form to its canonical registry name (collapsing
 * aliases). Returns the input unchanged when the registry has no match. Uses the
 * canonical NAME (never the registry's notePath, which can be stale) so the
 * basename-resolving graph still links to the right note. Never throws.
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
 * Resolve detected entities to bare `[[Canonical Name]]` wiki-links so a stored
 * note connects into the graph instead of orphaning. Links by canonical name so
 * the graph resolves to the real note by basename. Also keeps the registry's
 * name/type/occurrence fresh. Never throws.
 */
export function autoLinkEntities(
  entities: Array<{ name: string; type: EntityType }>,
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    const raw = e.name.trim();
    if (!raw) continue;
    const canonical = resolveCanonical(raw).trim() || raw;
    const link = `[[${canonical}]]`;
    if (!seen.has(link)) {
      seen.add(link);
      links.push(link);
    }
    // Keep the registry fresh, but don't record a notePath from here — it can be
    // stale and point at the wrong note.
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
