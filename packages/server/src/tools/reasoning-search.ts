import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { searchNotes } from '../lib/search.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

const STOPWORDS = new Set([
  'the','and','for','that','this','with','from','have','been','are','was','were',
  'will','can','could','would','should','not','but','they','their','them','what',
  'which','when','where','how','who','all','some','any','also','just','about',
  'into','onto','your','you','our','its','his','her','him','she','than','then','too',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

export function register(server: McpServer): void {
  server.tool(
    'reasoning_search',
    `Search prior reasoning traces by goal-token Jaccard. Use this before re-deriving a conclusion you may have already reasoned about. Returns up to N traces with goal, conclusion, confidence, and the steps that led there.

Default Jaccard threshold 0.3 — pairs that share roughly a third of their distinctive tokens. Lower for broader matches, higher for tight matches only.`,
    {
      goal: z.string().describe('Goal/question to find prior reasoning for'),
      threshold: z
        .number()
        .optional()
        .default(0.3)
        .describe('Minimum Jaccard similarity, 0.0-1.0 (default 0.3)'),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe('Maximum traces to return (default 5)'),
      includeExpired: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include traces past their expires_at (default false)'),
    },
    wrapToolHandler('reasoning_search', async (params) => {
      const goal = (params.goal as string ?? '').trim();
      if (!goal) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'goal is required' }) }],
          isError: true,
        };
      }
      const threshold = Math.max(0, Math.min(1, (params.threshold as number | undefined) ?? 0.3));
      const limit = Math.max(1, Math.min(20, (params.limit as number | undefined) ?? 5));
      const includeExpired = (params.includeExpired as boolean | undefined) ?? false;

      const goalTokens = tokenize(goal);
      if (goalTokens.size === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
        };
      }

      // Use the lexical index to shortlist reasoning notes (over-fetch, then Jaccard-rank).
      const candidates = searchNotes(goal, {
        scopePaths: ['Memories/reasoning/'],
        limit: limit * 4,
      });

      const today = new Date().toISOString().slice(0, 10);
      const scored: Array<{
        path: string; title: string; goal: string; conclusion: string;
        steps: string[]; confidence: number; expires_at?: string;
        score: number; expired: boolean;
      }> = [];

      for (const cand of candidates) {
        try {
          const { content } = await readNote(cand.path);
          const { data, body } = parseFrontmatter(content);
          if (data.type !== 'memory' || data.category !== 'reasoning') continue;
          const candGoal = (data.goal as string | undefined) ?? cand.title;
          const score = jaccard(goalTokens, tokenize(candGoal));
          if (score < threshold) continue;

          const expiresAt = data.expires_at as string | undefined;
          const expired = !!expiresAt && expiresAt < today;
          if (expired && !includeExpired) continue;

          // Extract conclusion + steps from body (best-effort markdown parse)
          const concMatch = body.match(/##\s*Conclusion\s*\n([\s\S]*?)(?:\n##|\n\nConfidence:|$)/i);
          const conclusion = (concMatch?.[1] ?? '').trim();
          const stepsMatch = body.match(/##\s*Steps\s*\n([\s\S]*?)(?:\n##|$)/i);
          const stepsBlock = stepsMatch?.[1] ?? '';
          const steps = stepsBlock
            .split('\n')
            .map((l) => l.replace(/^\s*\d+\.\s*/, '').trim())
            .filter((l) => l.length > 0)
            .slice(0, 8);

          scored.push({
            path: cand.path,
            title: (data.title as string | undefined) ?? cand.title,
            goal: candGoal,
            conclusion: conclusion.slice(0, 400),
            steps,
            confidence: typeof data.confidence === 'number' ? data.confidence : 0.7,
            expires_at: expiresAt,
            score: Math.round(score * 10000) / 10000,
            expired,
          });
        } catch {
          // skip unreadable
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const results = scored.slice(0, limit);

      return {
        _detail: `goal="${goal.slice(0, 40)}" → ${results.length} traces`,
        content: [{ type: 'text', text: JSON.stringify({ results }) }],
      };
    }),
  );
}
