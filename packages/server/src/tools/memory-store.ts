import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { writeNote } from '../lib/vault.js';
import { stringifyFrontmatter } from '../lib/frontmatter.js';
import { indexNote, searchNotes, getDocMeta } from '../lib/search.js';
import { updateGraphForNote } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { findSimilarNotes } from '../lib/similar-notes.js';
import { autoLinkEntities, selectAutoRelated, seedEntityKg } from '../lib/auto-link.js';
import { isEmbeddingsReady, checkSemanticDuplicate } from '../lib/embeddings.js';
import { extractPreferences, DetectedPreference } from '../lib/preference-detector.js';
import { detectEntities, type DetectedEntity } from '../lib/entity-detector.js';
import { logger } from '../lib/logger.js';
import { detectCategory, MEMORY_CATEGORIES } from '../lib/categorize.js';
import type { MemoryCategory } from '../lib/categorize.js';
import { captureCodeRefs } from '../lib/code-nav/refs.js';
import { detectMemoryConflicts, updateValidity, type MemoryConflict } from '../lib/memory.js';
import { config } from '../config.js';

// Local mutable tuple for z.enum (MEMORY_CATEGORIES is the shared readonly source of truth).
const CATEGORIES = [...MEMORY_CATEGORIES] as [MemoryCategory, ...MemoryCategory[]];

type Category = MemoryCategory;

/**
 * Generate a title from the first prose line, max 80 chars. Skips leading
 * code fences and blank lines so machine-captured memories (which often open
 * with a ```sh block) don't end up titled "```sh".
 */
function generateTitle(content: string): string {
  let firstProse = '';
  let inFence = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    firstProse = line.startsWith('#') ? line.replace(/^#+\s*/, '') : line;
    break;
  }
  // Strip a leading shell prompt ("$ ") so a captured command reads cleanly.
  firstProse = firstProse.replace(/^\$\s+/, '');
  let title = (firstProse || content.trim()).split(/[.!?\n]/)[0].trim();
  if (title.length > 80) {
    title = title.slice(0, 77) + '...';
  }
  return title || 'Untitled Memory';
}

/**
 * Slugify a string for use in file paths.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function register(server: McpServer): void {
  server.tool(
    "memory_store",
    `Store a structured memory with auto-categorization, heat tracking, dedup detection, and entity extraction. Use this for knowledge worth recalling later — facts, decisions, observations, plans, preferences.

NOT for raw note editing (use notes_upsert), NOT for session logs (use diary_write), NOT for event logging (use journal_append).

Embed [[wiki-links]] to people, projects, and concepts — well-linked memories rank higher in recall and feed the knowledge graph. Use relatedPaths to auto-generate a Related section.

Categories: observation, decision, insight, conversation, fact, preference, plan, reflection. Auto-detected from content if omitted. Temporal categories go to Memories/{cat}/YYYY/MM/, timeless (fact, preference) stay flat.`,
    {
      content: z.string().describe("Memory content in markdown. Embed [[wiki-links]] to people, projects, and concepts mentioned in this memory"),
      category: z
        .enum(CATEGORIES)
        .optional()
        .describe("Memory category — auto-detected from content if omitted"),
      title: z.string().optional().describe("Memory title — auto-generated from first sentence if omitted"),
      tags: z.array(z.string()).optional().describe("Tags for the memory"),
      relatedPaths: z.array(z.string()).optional().describe("Vault paths to link as related notes — generates [[wiki-links]] in frontmatter and a Related section in the body"),
      context: z
        .object({
          conversationId: z.string().optional(),
          toolName: z.string().optional(),
          trigger: z.string().optional(),
        })
        .optional()
        .describe("Context metadata about how this memory was created"),
      importance: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .default('medium')
        .describe("Importance level of this memory"),
      skipDedupe: z
        .boolean()
        .optional()
        .describe("Skip semantic duplicate detection. Use when you know the content is unique or want to force storage"),
    },
    wrapToolHandler("memory_store", async (params) => {
      const content = sanitizeContent(params.content as string);
      const category = (params.category as Category | undefined) ?? detectCategory(content);
      const title = (params.title as string | undefined) ?? generateTitle(content);
      const tags = params.tags as string[] | undefined;
      const relatedPaths = params.relatedPaths as string[] | undefined;
      const context = params.context as { conversationId?: string; toolName?: string; trigger?: string } | undefined;
      const importance = (params.importance as string | undefined) ?? 'medium';
      const skipDedupe = params.skipDedupe as boolean | undefined;

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const slug = slugify(title);

      // Temporal categories get year/month subfolders to avoid flat dumps.
      // Timeless categories (facts, preferences) stay flat since they accumulate slowly.
      const TIMELESS_CATEGORIES = new Set(['fact', 'preference']);
      const subdir = TIMELESS_CATEGORIES.has(category) ? '' : `${year}/${month}/`;
      // n8n's email triage tags its full-body captures `matrimail`. Route those
      // to a separate EmailLog/ collection so they don't flood Memories/ or the
      // graph. (The triage's audit subworkflow still writes a msg:<id> marker to
      // Memories/ for idempotency, so this doesn't affect dedup.) Curated
      // memories keep going to Memories/.
      const isEmailCapture = (tags ?? []).includes('matrimail');
      const baseDir = isEmailCapture ? 'EmailLog' : 'Memories';
      const notePath = `${baseDir}/${category}/${subdir}${today}-${slug}.md`;

      // Dedup check: search for existing memories with similar title in the same category
      try {
        const dedupQuery = title + ' ' + content.slice(0, 50);
        const dedupResults = searchNotes(dedupQuery, {
          scopePaths: [`Memories/${category}/`],
          limit: 10,
        });

        for (const result of dedupResults) {
          const existingSlug = slugify(result.title);
          if (levenshteinDistance(slug, existingSlug) < 3) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Possible duplicate found: "${result.title}" at ${result.path}. Use notes_upsert to update it instead, or pass a different title to create a new memory.\n\n${JSON.stringify({ duplicate_warning: true, existingPath: result.path, existingTitle: result.title })}`,
                },
              ],
              isError: false,
            };
          }
        }
      } catch {
        // Index may not be ready — skip dedup check
      }

      // Semantic duplicate detection via embeddings
      if (!skipDedupe && isEmbeddingsReady()) {
        try {
          const semanticResult = await checkSemanticDuplicate(content);
          if (semanticResult.isDuplicate && semanticResult.matchPath) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    stored: false,
                    reason: 'semantic_duplicate',
                    existingPath: semanticResult.matchPath,
                    similarity: semanticResult.similarity,
                  }),
                },
              ],
              isError: false,
            };
          }
        } catch {
          // Embeddings may not be ready — skip semantic dedup
        }
      }

      // Conflict detection for facts and decisions
      let potential_conflicts: Array<{ path: string; title: string }> | undefined;
      if (category === 'fact' || category === 'decision') {
        try {
          const conflictResults = searchNotes(title, {
            limit: 5,
          });

          const docMetaMap = getDocMeta();
          const conflicts: Array<{ path: string; title: string }> = [];
          for (const result of conflictResults) {
            // Skip if it's the same path we're about to write
            if (result.path === notePath) continue;
            // Look up metadata from the index
            const meta = docMetaMap.get(result.path);
            // Only consider memories of the same category
            if (!meta || meta.type !== 'memory') continue;
            if (meta.category !== category) continue;

            // Heuristic: check for shared tags or similar title
            const resultTags = new Set(Array.isArray(meta.tags) ? meta.tags : []);
            const inputTags = new Set(tags ?? []);
            const sharedTags = [...inputTags].filter((t) => resultTags.has(t));

            const titleDistance = levenshteinDistance(
              slugify(title),
              slugify(result.title),
            );
            const maxLen = Math.max(slugify(title).length, slugify(result.title).length);
            const titleSimilar = maxLen > 0 && titleDistance / maxLen < 0.4;

            if (sharedTags.length > 0 || titleSimilar) {
              conflicts.push({ path: result.path, title: result.title });
            }
          }

          if (conflicts.length > 0) {
            potential_conflicts = conflicts;
          }
        } catch {
          // Index may not be ready — skip conflict detection
        }
      }

      // Semantic contradiction detection: find existing memories sharing the
      // primary [[wiki-link]] entity that semantically match (≥0.80 cosine)
      // but have low Jaccard token overlap (<0.5) — strong paraphrased-
      // contradiction signal (e.g. "X is enabled" vs "X is disabled"). Non-
      // blocking; surfaced to the agent in the response and persisted as
      // `contradicts:` in frontmatter for durability.
      let contradictions: MemoryConflict[] = [];
      if (config.memoryContradictionDetect) {
        try {
          contradictions = await detectMemoryConflicts(content, [], { excludePath: notePath });
        } catch {
          // Never crash memory_store on conflict detection
          contradictions = [];
        }
      }

      // Bayesian validity: each detected contradiction is a soft β-bump
      // against the existing memory's trust score. Fire-and-forget.
      if (config.memoryValidity && contradictions.length > 0) {
        for (const c of contradictions) {
          updateValidity(c.path, 'failure').catch(() => undefined);
        }
      }

      // Auto-link detected entities so the memory joins the graph instead of
      // landing as an orphan. Resolve each high-confidence entity to its note
      // (creating a stub under Entities/ when none exists yet).
      let highConfidence: DetectedEntity[] = [];
      try {
        highConfidence = detectEntities(content).filter((e) => e.confidence > config.autoLinkMinConfidence);
      } catch {
        highConfidence = [];
      }
      // Skip auto-linking/KG-seeding for email captures — they'd spawn a node
      // per sender. Curated memories still get linked + seeded into the graph.
      const entityLinks = isEmailCapture || !config.autoLink ? [] : autoLinkEntities(highConfidence);
      if (!isEmailCapture) {
        seedEntityKg(title, highConfidence, notePath);
      }

      // Persist the (otherwise discarded) similarity signal as strippable
      // `## Related (auto)` backlinks. Computed before the body is built so the
      // links land in the note itself and become real graph edges; the same
      // result is reused for the response payload below.
      const { similarNotes, suggestion: similarSuggestion } = await findSimilarNotes(content, notePath);
      const autoRelated = isEmailCapture ? [] : selectAutoRelated(similarNotes);

      // Build frontmatter
      const frontmatter: Record<string, unknown> = {
        id: uuidv4(),
        type: 'memory',
        category,
        title,
        importance,
        temperature: 'hot',
        heat_score: 10,
        access_count: 1,
        last_accessed: today,
        created: today,
        last_updated: today,
      };

      if (contradictions.length > 0) {
        frontmatter.contradicts = contradictions.map((c) => c.path);
      }

      if (tags && tags.length > 0) {
        frontmatter.tags = tags;
      }

      const relatedLinks = [
        ...(relatedPaths ?? []).map((p) => `[[${p}]]`),
        ...entityLinks,
      ];
      if (relatedLinks.length > 0) {
        frontmatter.related = relatedLinks;
      }
      // Similarity backlinks are kept in a SEPARATE frontmatter key (not merged
      // into curated `related`) so they stay distinguishable and strippable.
      if (autoRelated.length > 0) {
        frontmatter.auto_related = autoRelated;
      }

      if (context) {
        frontmatter.context = context;
      }

      // Build body
      const relatedSection =
        relatedPaths && relatedPaths.length > 0
          ? `\n\n## Related\n${relatedPaths.map((p) => `- [[${p}]]`).join('\n')}`
          : '';
      const entitySection =
        entityLinks.length > 0
          ? `\n\n## Entities\n${entityLinks.map((l) => `- ${l}`).join('\n')}`
          : '';
      const autoRelatedSection =
        autoRelated.length > 0
          ? `\n\n## Related (auto)\n${autoRelated.map((l) => `- ${l}`).join('\n')}`
          : '';

      const body = `# ${title}\n\n${content}${relatedSection}${entitySection}${autoRelatedSection}\n`;

      // Capture any [[code:...]] wiki-links into frontmatter for staleness checks.
      try {
        const refs = captureCodeRefs(body);
        if (refs.length > 0) frontmatter.code_refs = refs;
      } catch {
        // Non-critical
      }

      const noteContent = stringifyFrontmatter(frontmatter, body);
      await writeNote(notePath, noteContent);

      // Update index and graph incrementally
      await indexNote(notePath);
      updateGraphForNote(notePath, noteContent);

      // Task 4: Check for consolidation candidates sharing 2+ tags
      let consolidation_suggested: { paths: string[]; commonTags: string[] } | undefined;
      if (tags && tags.length >= 2) {
        try {
          const docMetaMap = getDocMeta();
          const tagSet = new Set(tags);
          const matches: { path: string; sharedTags: string[] }[] = [];

          for (const [docPath, meta] of docMetaMap) {
            if (docPath === notePath) continue;
            const shared = meta.tags.filter((t: string) => tagSet.has(t));
            if (shared.length >= 2) {
              matches.push({ path: docPath, sharedTags: shared });
            }
          }

          if (matches.length >= 5) {
            const commonTagCounts = new Map<string, number>();
            for (const m of matches) {
              for (const t of m.sharedTags) {
                commonTagCounts.set(t, (commonTagCounts.get(t) ?? 0) + 1);
              }
            }
            const topCommonTags = [...commonTagCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([t]) => t);

            consolidation_suggested = {
              paths: matches.slice(0, 10).map((m) => m.path),
              commonTags: topCommonTags,
            };
          }
        } catch {
          // ignore — index may not be ready
        }
      }

      // (similarNotes / similarSuggestion were computed earlier, before the body
      // was built, so the similarity backlinks could be embedded in the note.)

      // Phase 9: Extract and auto-store preferences
      let extractedPreferences: DetectedPreference[] = [];
      const storedPrefPaths: string[] = [];
      try {
        extractedPreferences = extractPreferences(content);

        if (extractedPreferences.length > 0 && category !== 'preference') {
          // Check existing preference notes for dedup (simple substring check)
          const existingPrefNotes = searchNotes('preference', {
            scopePaths: ['Memories/preference/'],
            limit: 50,
          });
          const existingPrefTexts = existingPrefNotes.map(n =>
            n.snippet.toLowerCase().replace(/\s+/g, ' ').trim()
          );

          for (const pref of extractedPreferences) {
            const prefLower = pref.statement.toLowerCase().replace(/\s+/g, ' ').trim();

            // Skip if substantially similar to existing preference (>70% char overlap)
            const isDuplicate = existingPrefTexts.some(existing => {
              if (existing.includes(prefLower) || prefLower.includes(existing)) return true;
              // Simple Levenshtein ratio check for short statements
              if (prefLower.length < 200 && existing.length < 200) {
                const maxLen = Math.max(prefLower.length, existing.length);
                const dist = levenshteinDistance(prefLower, existing);
                return maxLen > 0 && dist / maxLen < 0.3;
              }
              return false;
            });

            if (isDuplicate) continue;

            // Build and store auto-extracted preference memory
            const prefTitle = generateTitle(pref.statement);
            const prefSlug = slugify(prefTitle);
            const prefPath = `Memories/preference/${today}-${prefSlug}.md`;  // preferences are timeless — flat
            const prefTags = ['#auto-extracted', ...(pref.entity ? [`#${pref.entity.toLowerCase().replace(/\s+/g, '-')}`] : [])];

            const prefFrontmatter: Record<string, unknown> = {
              id: uuidv4(),
              type: 'memory',
              category: 'preference',
              title: prefTitle,
              importance: 'medium',
              temperature: 'warm',
              heat_score: 6,
              access_count: 1,
              last_accessed: today,
              created: today,
              last_updated: today,
              tags: prefTags,
              related: [`[[${notePath}]]`],
              auto_extracted: true,
              preference_type: pref.type,
            };

            const prefBody = `# ${prefTitle}\n\n${pref.statement}\n\n## Source\nExtracted from [[${notePath}]]\n`;
            const prefContent = stringifyFrontmatter(prefFrontmatter, prefBody);

            try {
              await writeNote(prefPath, prefContent);
              await indexNote(prefPath);
              updateGraphForNote(prefPath, prefContent);
              storedPrefPaths.push(prefPath);
            } catch (prefErr) {
              logger.warn('Failed to store auto-extracted preference', {
                path: prefPath,
                error: prefErr instanceof Error ? prefErr.message : String(prefErr),
              });
            }
          }
        }
      } catch {
        // Non-critical — don't fail memory storage if preference extraction fails
      }

      // Entities were detected and linked earlier (see autoLinkEntities);
      // reuse that high-confidence set for the response payload.
      const suggestedEntities: Array<{ name: string; type: string; confidence: number }> =
        highConfidence.map((e) => ({ name: e.name, type: e.type, confidence: e.confidence }));

      const responseData: Record<string, unknown> = {
        path: notePath,
        category,
        temperature: 'hot',
      };
      if (potential_conflicts && potential_conflicts.length > 0) {
        responseData.potential_conflicts = potential_conflicts;
      }
      if (contradictions.length > 0) {
        responseData.conflicts = contradictions;
      }
      if (consolidation_suggested) {
        responseData.consolidation_suggested = consolidation_suggested;
      }
      if (similarNotes.length > 0) {
        responseData.similarNotes = similarNotes;
        responseData.suggestion = similarSuggestion;
      }
      if (storedPrefPaths.length > 0) {
        responseData.extractedPreferences = storedPrefPaths;
      }
      if (suggestedEntities.length > 0) {
        responseData.suggestedEntities = suggestedEntities;
      }

      const summary = `Stored ${category} memory "${title}" → ${notePath} (temperature: hot)` +
        (potential_conflicts && potential_conflicts.length > 0
          ? `\n⚠ Found ${potential_conflicts.length} potentially conflicting ${category} memories — review before relying on this memory.`
          : '') +
        (contradictions.length > 0
          ? `\n⚠ Semantic contradiction: ${contradictions.length} same-entity memor${contradictions.length === 1 ? 'y' : 'ies'} (≥0.80 cosine, low token overlap). Review: ${contradictions.map((c) => c.path).join(', ')}`
          : '') +
        (consolidation_suggested
          ? `\n⚠ Consolidation suggested: ${consolidation_suggested.paths.length} memories share tags [${consolidation_suggested.commonTags.join(', ')}]`
          : '') +
        (similarNotes.length > 0
          ? `\n📎 ${similarSuggestion}`
          : '') +
        (storedPrefPaths.length > 0
          ? `\n🔖 Auto-extracted ${storedPrefPaths.length} preference(s): ${storedPrefPaths.join(', ')}`
          : '');

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${JSON.stringify(responseData, null, 2)}`,
          },
        ],
      };
    })
  );
}
