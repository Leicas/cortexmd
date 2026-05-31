import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { writeNote } from '../lib/vault.js';
import { stringifyFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';
import {
  normalizeConversation,
  autoDetectFormat,
} from '../lib/conversation-normalizer.js';
import { extractMemories } from '../lib/memory-extractor.js';
import type { ExtractedMemory } from '../lib/memory-extractor.js';
import { acquireOperation, releaseOperation } from '../lib/operation-mutex.js';

const MAX_CONTENT_LENGTH = 10_000_000; // 10MB

const FORMATS = [
  'claude-code',
  'codex',
  'claude-ai',
  'chatgpt',
  'slack',
  'plain',
] as const;

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
 * Generate a title from the first ~60 characters of content.
 */
function generateTitle(content: string): string {
  const match = content.match(/^[^\n.!?]*/);
  let title = match ? match[0].trim() : content.trim();
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }
  return title || 'Untitled Memory';
}

/**
 * Convert entities to [[wiki-links]] in the content body.
 */
function addWikiLinks(content: string, entities: string[]): string {
  let result = content;
  // Sort by length descending to avoid partial replacements
  const sorted = [...entities].sort((a, b) => b.length - a.length);
  for (const entity of sorted) {
    // Only link the first occurrence, avoid double-linking
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!\\[\\[)\\b(${escaped})\\b(?!\\]\\])`, 'g');
    let replaced = false;
    result = result.replace(regex, (_match, p1: string) => {
      if (replaced) return p1;
      replaced = true;
      return `[[${p1}]]`;
    });
  }
  return result;
}

export function register(server: McpServer): void {
  server.tool(
    'conversations_mine',
    `Mine conversations from various AI tools (Claude Code, Codex, ChatGPT, Slack, etc.) to extract and store memories.

Accepts raw conversation exports and auto-detects the format. Extracts decisions, preferences, milestones, problems, and facts as separate memory notes with proper Obsidian frontmatter and [[wiki-links]].

Use dryRun to preview what would be extracted without storing anything.`,
    {
      content: z
        .string()
        .max(MAX_CONTENT_LENGTH)
        .describe(
          'Raw conversation text or JSON export from an AI tool (max 10MB)',
        ),
      format: z
        .enum(FORMATS)
        .optional()
        .describe(
          'Override auto-detection: claude-code|codex|claude-ai|chatgpt|slack|plain',
        ),
      targetCollection: z
        .string()
        .optional()
        .describe(
          'Vault prefix for stored notes (default: Memories)',
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          'If true, extract but do not store (default: false)',
        ),
    },
    wrapToolHandler('conversations_mine', async (params) => {
      const rawContent = sanitizeContent(params.content as string);

      // Size guard
      if (rawContent.length > MAX_CONTENT_LENGTH) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Content too large. Use the HTTP upload endpoint for files over 10MB.', size: rawContent.length }) }],
          isError: true,
        };
      }

      // Mutex: only one mine operation at a time
      if (!acquireOperation('mine')) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'A mining operation is already in progress', operation: 'mine' }) }],
          isError: true,
        };
      }

      try {
      const format = params.format as string | undefined;
      const targetCollection = (params.targetCollection as string | undefined) ?? 'Memories';
      const dryRun = (params.dryRun as boolean | undefined) ?? false;

      // Step 1: Normalize
      const detectedFormat = format ?? autoDetectFormat(rawContent);
      const exchanges = normalizeConversation(rawContent, detectedFormat);

      if (exchanges.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                exchangesParsed: 0,
                memoriesExtracted: 0,
                stored: 0,
                categories: {},
                message: 'No exchanges could be parsed from the provided content.',
                detectedFormat,
              }),
            },
          ],
        };
      }

      // Step 2: Extract memories
      const memories = extractMemories(exchanges);

      // Step 3: Store (unless dryRun)
      const categoryCounts: Record<string, number> = {};
      let stored = 0;
      const storedPaths: string[] = [];

      const today = new Date().toISOString().slice(0, 10);

      for (const memory of memories) {
        categoryCounts[memory.category] =
          (categoryCounts[memory.category] ?? 0) + 1;

        if (dryRun) continue;

        const title = generateTitle(memory.content);
        const slug = slugify(title);
        const notePath = `${targetCollection}/${memory.category}/${today}-${slug}.md`;

        // Build frontmatter
        const frontmatter: Record<string, unknown> = {
          id: uuidv4(),
          type: 'memory',
          category: memory.category,
          title,
          temperature: 'warm',
          heat_score: 5,
          access_count: 0,
          created: today,
          last_updated: today,
          tags: [
            '#mined',
            `#source:${detectedFormat}`,
          ],
          related: [],
        };

        if (memory.entities.length > 0) {
          frontmatter.entities = memory.entities;
        }

        // Build body with wiki-links for entities
        const bodyContent = addWikiLinks(memory.content, memory.entities);
        const body = `# ${title}\n\n${bodyContent}\n`;

        const noteContent = stringifyFrontmatter(frontmatter, body);

        try {
          await writeNote(notePath, noteContent);
          stored++;
          storedPaths.push(notePath);
        } catch {
          // Skip notes that fail to write (e.g. path issues)
        }
      }

      const responseData: Record<string, unknown> = {
        exchangesParsed: exchanges.length,
        memoriesExtracted: memories.length,
        stored,
        detectedFormat,
        categories: categoryCounts,
      };

      if (dryRun && memories.length > 0) {
        responseData.preview = memories.slice(0, 10).map((m: ExtractedMemory) => ({
          category: m.category,
          content: m.content.slice(0, 200),
          entities: m.entities,
        }));
      }

      if (storedPaths.length > 0) {
        responseData.paths = storedPaths;
      }

      const summary = dryRun
        ? `[DRY RUN] Parsed ${exchanges.length} exchanges, extracted ${memories.length} memories (${Object.entries(categoryCounts).map(([k, v]) => `${k}: ${v}`).join(', ')})`
        : `Parsed ${exchanges.length} exchanges, extracted ${memories.length} memories, stored ${stored} notes`;

      return {
        content: [
          {
            type: 'text' as const,
            text: `${summary}\n\n${JSON.stringify(responseData, null, 2)}`,
          },
        ],
      };
      } finally {
        releaseOperation('mine');
      }
    }),
  );
}
