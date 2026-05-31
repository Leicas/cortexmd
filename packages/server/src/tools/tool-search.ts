import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import {
  getToolsMeta,
  getToolEmbedding,
  buildToolEmbeddings,
  isToolEmbeddingsBuilt,
} from '../lib/tool-meta.js';
import { isEmbeddingsReady, embedText } from '../lib/embeddings.js';

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function substringScore(name: string, description: string, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const haystack = (name + ' ' + description).toLowerCase();
  if (haystack.includes(q)) return 1.0;

  const queryTokens = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (queryTokens.length === 0) return 0;
  let matches = 0;
  for (const t of queryTokens) if (haystack.includes(t)) matches++;
  return matches / queryTokens.length;
}

export function register(server: McpServer): void {
  server.tool(
    'tool_search',
    "Defer-loading tool discovery — semantic search over the full tool registry by name & description. Returns matched tools with their full inputSchema so you can find tools whose exact name you don't recall, or that aren't pre-loaded under a reduced OBSIDIAN_TOOL_PROFILE. Use this when you suspect a tool exists for what you need but you can't remember its name (e.g. 'how do I find related notes' → notes_search, graph_neighbors).",
    {
      query: z
        .string()
        .describe('Natural-language description of the capability you need (e.g. "find related notes", "store a memory")'),
      top_k: z
        .number()
        .optional()
        .default(5)
        .describe('Maximum number of tools to return (default 5).'),
      include_schema: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include each tool\'s inputSchema in the response (default true).'),
    },
    wrapToolHandler('tool_search', async (params) => {
      const query = String(params.query ?? '').trim();
      const topK = (params.top_k as number | undefined) ?? 5;
      const includeSchema = (params.include_schema as boolean | undefined) ?? true;

      const tools = getToolsMeta();
      if (tools.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [],
                hint: 'Tool registry empty — server may still be starting up.',
              }),
            },
          ],
        };
      }

      const scored: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; score: number }> = [];
      let mode: 'semantic' | 'substring' = 'substring';

      if (isEmbeddingsReady()) {
        if (!isToolEmbeddingsBuilt()) {
          await buildToolEmbeddings();
        }
        if (isToolEmbeddingsBuilt()) {
          try {
            const qEmbed = await embedText(query.slice(0, 1024));
            for (const t of tools) {
              const tEmbed = getToolEmbedding(t.name);
              const sem = tEmbed ? cosine(qEmbed, tEmbed) : 0;
              const sub = substringScore(t.name, t.description, query);
              // Boost when both signals agree; floor at substring score.
              const score = Math.max(sem, sub * 0.6);
              scored.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, score });
            }
            mode = 'semantic';
          } catch {
            // Fall through to substring scoring
          }
        }
      }

      if (mode === 'substring') {
        for (const t of tools) {
          scored.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            score: substringScore(t.name, t.description, query),
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.filter((s) => s.score > 0).slice(0, topK);

      const results = top.map((s) => ({
        name: s.name,
        description: s.description,
        score: Math.round(s.score * 10000) / 10000,
        ...(includeSchema ? { inputSchema: s.inputSchema } : {}),
      }));

      const detail =
        `q="${query}" → ${results.length}/${tools.length} tools` +
        (results[0] ? ` (top: ${results[0].name})` : '');

      return {
        _detail: detail,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results,
              totalRegistered: tools.length,
              mode,
            }),
          },
        ],
      };
    }),
  );
}
