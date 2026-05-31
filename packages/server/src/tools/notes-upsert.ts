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
import { inferNoteCategory } from '../lib/categorize.js';
import { captureCodeRefs } from '../lib/code-nav/refs.js';

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

      if (mergeMode === "replace") {
        // For new notes, ensure frontmatter has an id and a concrete category.
        const { data, body } = parseFrontmatter(noteContent);
        ensureId(data);
        ensureCategory(data, body, notePath);
        maybeAttachCodeRefs(data, body);
        finalContent = stringifyFrontmatter(data, body);
        await writeNote(notePath, finalContent, ifMatch);
      } else if (mergeMode === "append") {
        let existing: string;
        try {
          const result = await readNote(notePath);
          existing = result.content;
        } catch {
          // Note doesn't exist yet; treat content as a new note
          const { data, body } = parseFrontmatter(noteContent);
          ensureId(data);
          ensureCategory(data, body, notePath);
          maybeAttachCodeRefs(data, body);
          finalContent = stringifyFrontmatter(data, body);
          await writeNote(notePath, finalContent);
          await updateLastUpdatedAndTemperature(notePath);
          const etag = computeEtag(finalContent);
          await appendJournalEntry(`Updated note: [[${notePath}]]`);
          await indexNote(notePath);
          updateGraphForNote(notePath, finalContent);

          const { similarNotes, suggestion } = await findSimilarNotes(noteContent, notePath);
          const responseData: Record<string, unknown> = { path: notePath, updated: true, etag };
          if (similarNotes.length > 0) {
            responseData.similarNotes = similarNotes;
            responseData.suggestion = suggestion;
          }
          addEntitySuggestions(responseData, finalContent, notePath);
          return {
            content: [
              { type: "text", text: JSON.stringify(responseData) },
            ],
          };
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
          const { data, body } = parseFrontmatter(noteContent);
          ensureId(data);
          ensureCategory(data, body, notePath);
          maybeAttachCodeRefs(data, body);
          finalContent = stringifyFrontmatter(data, body);
          await writeNote(notePath, finalContent);
          await updateLastUpdatedAndTemperature(notePath);
          const etag = computeEtag(finalContent);
          await appendJournalEntry(`Updated note: [[${notePath}]]`);
          await indexNote(notePath);
          updateGraphForNote(notePath, finalContent);

          const { similarNotes, suggestion } = await findSimilarNotes(noteContent, notePath);
          const responseData: Record<string, unknown> = { path: notePath, updated: true, etag };
          if (similarNotes.length > 0) {
            responseData.similarNotes = similarNotes;
            responseData.suggestion = suggestion;
          }
          addEntitySuggestions(responseData, finalContent, notePath);
          return {
            content: [
              { type: "text", text: JSON.stringify(responseData) },
            ],
          };
        }
        finalContent = mergeSection(existing, sectionTitle, noteContent);
        await writeNote(notePath, finalContent);
      }

      await updateLastUpdatedAndTemperature(notePath);
      const etag = computeEtag(finalContent);
      await appendJournalEntry(`Updated note: [[${notePath}]]`);
      await indexNote(notePath);
      updateGraphForNote(notePath, finalContent);

      const { similarNotes, suggestion } = await findSimilarNotes(finalContent, notePath);
      const responseData: Record<string, unknown> = { path: notePath, updated: true, etag };
      if (similarNotes.length > 0) {
        responseData.similarNotes = similarNotes;
        responseData.suggestion = suggestion;
      }
      addEntitySuggestions(responseData, finalContent, notePath);

      return {
        content: [
          { type: "text", text: JSON.stringify(responseData) },
        ],
      };
    })
  );
}
