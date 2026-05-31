import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { writeNote } from '../lib/vault.js';
import { stringifyFrontmatter } from '../lib/frontmatter.js';
import { indexNote } from '../lib/search.js';
import { updateGraphForNote } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function register(server: McpServer): void {
  server.tool(
    'reasoning_save',
    `Save a reasoning trace — a structured record of why a plan was chosen, what alternatives were considered, and what evidence supports the conclusion. Use at the end of a multi-step decision so the next session can reload the chain instead of re-deriving it.

Stored as a memory under Memories/reasoning/YYYY/MM/. Searchable via reasoning_search by goal tokens (Jaccard).`,
    {
      goal: z
        .string()
        .describe('The original goal or question being reasoned about (1-2 sentences)'),
      steps: z
        .array(z.string())
        .describe('Ordered reasoning steps — what was tried, ruled out, decided'),
      conclusion: z
        .string()
        .describe('Final conclusion or recommendation'),
      confidence: z
        .number()
        .optional()
        .default(0.7)
        .describe('Confidence in the conclusion, 0.0-1.0 (default 0.7)'),
      evidence_paths: z
        .array(z.string())
        .optional()
        .describe('Vault paths that informed the reasoning — emitted as [[wiki-links]] in body'),
      expires_at: z
        .string()
        .optional()
        .describe('ISO date after which this trace should be considered stale (e.g. "2026-12-01")'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Optional tags (always merged with #reasoning)'),
    },
    wrapToolHandler('reasoning_save', async (params) => {
      const goal = sanitizeContent(params.goal as string, 800).trim();
      if (!goal) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'goal is required' }) }],
          isError: true,
        };
      }
      const steps = (params.steps as string[] | undefined) ?? [];
      const conclusion = sanitizeContent(params.conclusion as string, 2000).trim();
      const confidence = Math.max(0, Math.min(1, (params.confidence as number | undefined) ?? 0.7));
      const evidencePaths = (params.evidence_paths as string[] | undefined) ?? [];
      const expiresAt = params.expires_at as string | undefined;
      const userTags = (params.tags as string[] | undefined) ?? [];

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const slug = slugify(goal);
      const notePath = `Memories/reasoning/${year}/${month}/${today}-${slug}.md`;

      const tags = Array.from(new Set([...userTags.map((t) => t.replace(/^#/, '')), 'reasoning']));
      const frontmatter: Record<string, unknown> = {
        id: uuidv4(),
        type: 'memory',
        category: 'reasoning',
        title: goal.slice(0, 80),
        importance: 'medium',
        temperature: 'hot',
        heat_score: 8,
        access_count: 1,
        last_accessed: today,
        created: today,
        last_updated: today,
        tags,
        goal,
        confidence,
      };
      if (expiresAt) frontmatter.expires_at = expiresAt;
      if (evidencePaths.length > 0) {
        frontmatter.evidence_paths = evidencePaths;
        frontmatter.related = evidencePaths.map((p) => `[[${p}]]`);
      }

      const stepsBlock = steps.length > 0
        ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '(no steps recorded)';
      const evidenceBlock = evidencePaths.length > 0
        ? `\n\n## Evidence\n${evidencePaths.map((p) => `- [[${p}]]`).join('\n')}`
        : '';
      const body = `# ${frontmatter.title}\n\n## Goal\n${goal}\n\n## Steps\n${stepsBlock}\n\n## Conclusion\n${conclusion}\n\nConfidence: ${(confidence * 100).toFixed(0)}%${evidenceBlock}\n`;
      const noteContent = stringifyFrontmatter(frontmatter, body);

      await writeNote(notePath, noteContent);
      try { await indexNote(notePath); } catch { /* best-effort */ }
      try { updateGraphForNote(notePath, noteContent); } catch { /* best-effort */ }

      return {
        _detail: `goal="${goal.slice(0, 40)}" → ${notePath}`,
        content: [{ type: 'text', text: JSON.stringify({
          path: notePath,
          confidence,
          steps: steps.length,
          evidenceCount: evidencePaths.length,
        }) }],
      };
    }),
  );
}
