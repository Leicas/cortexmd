import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter, ensureId } from '../lib/frontmatter.js';
import { appendToContent, mergeSection } from '../lib/markdown.js';
import { computeEtag } from '../lib/hash.js';
import { indexNote } from '../lib/search.js';
import { updateGraphForNote } from '../lib/graph.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath, sanitizeContent } from '../lib/sanitize.js';
import { findSimilarNotes } from '../lib/similar-notes.js';
import { detectEntities } from '../lib/entity-detector.js';
import { registerEntity } from '../lib/entity-registry.js';
import { autoLinkEntities, selectAutoRelated, seedEntityKg } from '../lib/auto-link.js';
import { inferNoteCategory } from '../lib/categorize.js';
import { captureCodeRefs } from '../lib/code-nav/refs.js';
import { config } from '../config.js';
import type { SimilarNote } from '../lib/similar-notes.js';

/**
 * If the body contains `[[code:slug:relpath:name]]` wiki-links, capture them
 * into frontmatter as a `code_refs` array so staleness checks can run later.
 */
function maybeAttachCodeRefs(data: Record<string, any>, body: string): void {
  try {
    const refs = captureCodeRefs(body);
    if (refs.length > 0) {
      data.code_refs = refs;
    }
  } catch {
    // Non-critical: code-nav DB may be unavailable; skip silently.
  }
}

/**
 * Ensure a note's frontmatter has a concrete, non-empty category.
 * If `category` is missing/empty, infer it from the frontmatter, path and body.
 * Mutates `data` in place.
 */
function ensureCategory(
  data: Record<string, any>,
  body: string,
  notePath: string,
): void {
  const existing = typeof data.category === 'string' ? data.category.trim() : '';
  if (existing) {
    // Normalize to the trimmed value (drop stray whitespace).
    data.category = existing;
    return;
  }
  const result = inferNoteCategory({
    path: notePath,
    frontmatter: data,
    content: body,
  });
  data.category = result.category || 'general';
}

/**
 * After any write, update last_updated in frontmatter and recompute temperature
 * if the note has a heat_score field (just-updated = max recency points).
 */
async function updateLastUpdatedAndTemperature(notePath: string): Promise<void> {
  try {
    const { content } = await readNote(notePath);
    const { data, body } = parseFrontmatter(content);

    const todayStr = new Date().toISOString().slice(0, 10);
    let changed = false;

    if (data.last_updated !== todayStr) {
      data.last_updated = todayStr;
      changed = true;
    }

    // Backfill category on existing notes that never had one assigned.
    const existingCat = typeof data.category === 'string' ? data.category.trim() : '';
    if (!existingCat) {
      ensureCategory(data, body, notePath);
      changed = true;
    }

    // If the note tracks heat_score, recompute temperature
    // A just-updated note gets max recency points, so bump the score
    if (typeof data.heat_score === 'number') {
      // Recency component for "just updated" = 4 points (max)
      // We add 4 to approximate the fresh recency boost
      // But we cap at a reasonable level — recompute based on current score + fresh recency
      const baseScore = Math.max(0, data.heat_score);
      // If score was decayed, a fresh update should restore some heat
      // Minimum: ensure at least 4 (the recency component for today)
      const newScore = Math.max(baseScore, 4);
      const temperature: 'hot' | 'warm' | 'cold' =
        newScore >= 10 ? 'hot' : newScore >= 4 ? 'warm' : 'cold';

      if (data.heat_score !== newScore || data.temperature !== temperature) {
        data.heat_score = newScore;
        data.temperature = temperature;
        changed = true;
      }
    }

    if (changed) {
      const updated = stringifyFrontmatter(data, body);
      await writeNote(notePath, updated);
    }
  } catch {
    // Non-critical: don't fail the upsert if this post-processing fails
  }
}

/**
 * Run entity detection on content and add high-confidence suggestions to response data.
 */
function addEntitySuggestions(responseData: Record<string, unknown>, content: string, notePath?: string): void {
  try {
    // Strip frontmatter before detection
    const body = content.replace(/^---[\s\S]*?---\s*/, '');
    const entities = detectEntities(body);
    const highConfidence = entities.filter(e => e.confidence > 0.7);
    if (highConfidence.length > 0) {
      responseData.suggestedEntities = highConfidence.map(e => ({
        name: e.name,
        type: e.type,
        confidence: e.confidence,
        signals: e.signals,
      }));
      // Register high-confidence entities in the persistent registry
      for (const entity of highConfidence) {
        registerEntity(entity.name, entity.type, {
          tier: 'detected',
          notePath,
        });
      }
    }
  } catch {
    // Non-critical — don't fail the upsert if entity detection fails
  }
}

/**
 * Conservative auto-linking for notes we fully own (new notes + replace mode):
 * inject canonical entity wiki-links and similarity backlinks into clearly
 * marked, strippable sections (`## Entities (auto)` / `## Related (auto)`) and
 * seed the KG. Mutates `data` (frontmatter) and returns the augmented body.
 * Never throws. Existing-note append/section merges are intentionally NOT
 * enriched — no surprise edits to curated notes.
 */
async function enrichWithAutoLinks(
  notePath: string,
  data: Record<string, any>,
  body: string,
  similarNotes: SimilarNote[],
): Promise<string> {
  if (!config.autoLink) return body;
  let augmented = body;
  const title =
    (typeof data.title === 'string' && data.title.trim()) ||
    notePath.replace(/\.md$/, '').split('/').pop() ||
    notePath;

  // Entity wiki-links (skip any already present as a [[link]] in the body).
  try {
    const detected = detectEntities(body).filter((e) => e.confidence > config.autoLinkMinConfidence);
    if (detected.length > 0) {
      const links = autoLinkEntities(detected).filter((l) => !augmented.includes(l));
      if (links.length > 0) {
        augmented += `\n\n## Entities (auto)\n${links.map((l) => `- ${l}`).join('\n')}`;
        const existing = Array.isArray(data.related) ? data.related : [];
        data.related = [...new Set([...existing, ...links])];
      }
      seedEntityKg(title, detected, notePath);
    }
  } catch {
    // Non-critical.
  }

  // Similarity backlinks → strippable `## Related (auto)` + `auto_related`.
  // Similar notes are computed once by the caller and reused for the response.
  try {
    const autoRelated = selectAutoRelated(similarNotes).filter((l) => !augmented.includes(l));
    if (autoRelated.length > 0) {
      augmented += `\n\n## Related (auto)\n${autoRelated.map((l) => `- ${l}`).join('\n')}`;
      data.auto_related = autoRelated;
    }
  } catch {
    // Non-critical.
  }

  return augmented;
}

/**
 * Post-write side effects that must NOT block the caller on the critical path:
 * temperature bump, journal entry, search re-index, and graph update. Any of
 * these can involve disk I/O or embedding work; we fire them after writeNote has
 * already returned the etag. Never throws (each step is best-effort).
 */
function schedulePostWrite(notePath: string, finalContent: string): void {
  void (async () => {
    try {
      await updateLastUpdatedAndTemperature(notePath);
      await appendJournalEntry(`Updated note: [[${notePath}]]`);
      await indexNote(notePath);
      updateGraphForNote(notePath, finalContent);
    } catch {
      // Non-critical: post-write enrichment failures must not surface to the caller.
    }
  })();
}

export function register(server: McpServer): void {
  server.tool(
    "notes_upsert",
    `Create or update a note in the vault with support for replace, append, or section-merge modes.

Use wiki-links in content to build the knowledge graph: [[Note Name]] links to another note, [[Note Name|display text]] customizes the displayed text, and [[Note Name#Heading]] links to a specific section. Every wiki-link creates a bidirectional connection visible in graph_neighbors, so proactively link to related people ([[CRM/John Doe.md]]), projects ([[Projects/Acme.md]]), and concepts. Well-linked notes surface better in search and recall.`,
    {
      path: z.string().describe("Vault-relative path to the note"),
      content: z.string().describe("Markdown content to write or merge. Embed [[wiki-links]] to connect this note to related notes — each link strengthens the knowledge graph"),
      mergeMode: z.enum(["replace", "append", "section"]).describe("How to merge content: replace, append, or section"),
      sectionTitle: z.string().optional().describe("Section title for section merge mode"),
      ifMatch: z.string().optional().describe("ETag for optimistic concurrency (replace mode)"),
    },
    wrapToolHandler("notes_upsert", async (params) => {
      const notePath = sanitizePath(params.path as string);
      const noteContent = sanitizeContent(params.content as string);
      const mergeMode = params.mergeMode as string;
      const sectionTitle = params.sectionTitle as string | undefined;
      const ifMatch = params.ifMatch as string | undefined;

      let finalContent: string;

      // Compute similar notes ONCE per upsert (no LLM rerank — internal
      // enrichment/suggestion work should not pay for a reranker pass). The
      // same result feeds both the auto-link enrichment and the response.
      const { similarNotes, suggestion } = await findSimilarNotes(noteContent, notePath);

      /**
       * Build the tool response from the etag + already-computed similar notes.
       * Shared by every branch so the response schema stays identical.
       */
      const buildResponse = (etag: string, content: string) => {
        const responseData: Record<string, unknown> = { path: notePath, updated: true, etag };
        if (similarNotes.length > 0) {
          responseData.similarNotes = similarNotes;
          responseData.suggestion = suggestion;
        }
        addEntitySuggestions(responseData, content, notePath);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(responseData) },
          ],
        };
      };

      if (mergeMode === "replace") {
        // For new notes, ensure frontmatter has an id and a concrete category.
        const parsed = parseFrontmatter(noteContent);
        const body = parsed.body;
        let data = parsed.data;
        data = ensureId(data);
        ensureCategory(data, body, notePath);
        const enrichedBody = await enrichWithAutoLinks(notePath, data, body, similarNotes);
        maybeAttachCodeRefs(data, enrichedBody);
        finalContent = stringifyFrontmatter(data, enrichedBody);
        await writeNote(notePath, finalContent, ifMatch);
      } else if (mergeMode === "append") {
        let existing: string;
        try {
          const result = await readNote(notePath);
          existing = result.content;
        } catch {
          // Note doesn't exist yet; treat content as a new note
          const parsed = parseFrontmatter(noteContent);
          const body = parsed.body;
          let data = parsed.data;
          data = ensureId(data);
          ensureCategory(data, body, notePath);
          const enrichedBody = await enrichWithAutoLinks(notePath, data, body, similarNotes);
          maybeAttachCodeRefs(data, enrichedBody);
          finalContent = stringifyFrontmatter(data, enrichedBody);
          await writeNote(notePath, finalContent);
          const etag = computeEtag(finalContent);
          // Post-write work is fire-and-forget so the caller isn't blocked.
          schedulePostWrite(notePath, finalContent);
          return buildResponse(etag, finalContent);
        }
        finalContent = appendToContent(existing, noteContent);
        await writeNote(notePath, finalContent);
      } else {
        // section mode
        if (!sectionTitle) {
          throw new Error("sectionTitle is required for section merge mode");
        }
        let existing: string;
        try {
          const result = await readNote(notePath);
          existing = result.content;
        } catch {
          const parsed = parseFrontmatter(noteContent);
          const body = parsed.body;
          let data = parsed.data;
          data = ensureId(data);
          ensureCategory(data, body, notePath);
          const enrichedBody = await enrichWithAutoLinks(notePath, data, body, similarNotes);
          maybeAttachCodeRefs(data, enrichedBody);
          finalContent = stringifyFrontmatter(data, enrichedBody);
          await writeNote(notePath, finalContent);
          const etag = computeEtag(finalContent);
          // Post-write work is fire-and-forget so the caller isn't blocked.
          schedulePostWrite(notePath, finalContent);
          return buildResponse(etag, finalContent);
        }
        finalContent = mergeSection(existing, sectionTitle, noteContent);
        await writeNote(notePath, finalContent);
      }

      const etag = computeEtag(finalContent);

      // Seed the KG from the merged content so existing-note append/section
      // merges still grow the temporal graph (no body mutation here — that's
      // reserved for the new-note/replace paths via enrichWithAutoLinks).
      // kgAddTriple is an idempotent upsert, so re-seeding replace mode is safe.
      if (config.autoLink) {
        try {
          const detected = detectEntities(finalContent).filter((e) => e.confidence > config.autoLinkMinConfidence);
          const seedTitle = notePath.replace(/\.md$/, '').split('/').pop() || notePath;
          seedEntityKg(seedTitle, detected, notePath);
        } catch {
          // Non-critical.
        }
      }

      // Bitemporal supersession pass (DORMANT unless config.bitemporalKg). Closes
      // any superseded KG rival (never deletes) and stamps the earlier source
      // note's validity window. No-op + identical to today when the flag is off.
      // Kept synchronous (flag-gated) so validity is durable before the response.
      if (config.bitemporalKg) {
        try {
          const { runSupersessionPass } = await import('../lib/bitemporal.js');
          const { data, body } = parseFrontmatter(finalContent);
          await runSupersessionPass(notePath, data, body);
        } catch {
          // Non-critical — never fail an upsert on a bitemporal error.
        }
      }

      // Post-write work (temperature, journal, re-index, graph) is fire-and-forget
      // so the caller gets the etag without waiting on enrichment/indexing.
      schedulePostWrite(notePath, finalContent);

      return buildResponse(etag, finalContent);
    })
  );
}
