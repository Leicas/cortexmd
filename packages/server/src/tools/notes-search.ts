import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hybridSearch } from '../lib/search.js';
import { readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeQuery, sanitizePath, validateDateString } from '../lib/sanitize.js';
import { recordSearchQuery, recordSearchScoreBreakdown, recordSearchTypeBreakdown } from '../lib/metrics.js';

const IMPORTANCE_ORDER = ['low', 'medium', 'high', 'critical'];

export function register(server: McpServer): void {
  server.tool(
    "notes_search",
    "Search notes in the vault by query, with optional filters for scope paths, tags, date range, type, category, temperature, importance, and result limit. Use search results to discover existing notes worth linking to — when creating or updating a note, search for related topics first and add [[wiki-links]] to connect them",
    {
      query: z.string().describe("Search query string"),
      scopePaths: z.array(z.string()).optional().describe("Limit search to these vault paths"),
      tags: z.array(z.string()).optional().describe("Filter results by tags"),
      dateFrom: z.string().optional().describe("Filter results from this date (ISO 8601)"),
      dateTo: z.string().optional().describe("Filter results up to this date (ISO 8601)"),
      limit: z.number().optional().describe("Maximum number of results to return"),
      type: z.string().optional().describe("Filter by frontmatter type field"),
      category: z.string().optional().describe("Filter by frontmatter category field"),
      temperature: z
        .enum(['hot', 'warm', 'cold'])
        .optional()
        .describe("Filter by temperature"),
      minHeatScore: z.number().optional().describe("Minimum heat_score to include"),
      importance: z
        .enum(['low', 'medium', 'high', 'critical'])
        .optional()
        .describe("Minimum importance level"),
      excludeArchived: z
        .boolean()
        .optional()
        .describe("Exclude notes with temperature=cold or type=archive"),
      collections: z
        .array(z.string())
        .optional()
        .describe("Filter by collection names (e.g. 'memories', 'crm', 'daily-notes', 'projects', 'ops', 'archive', 'general')"),
    },
    wrapToolHandler("notes_search", async (params) => {
      const query = sanitizeQuery(params.query as string);
      const scopePaths = (params.scopePaths as string[] | undefined)?.map((p) => sanitizePath(p));

      const dateFrom = params.dateFrom as string | undefined;
      const dateTo = params.dateTo as string | undefined;

      if (dateFrom && !validateDateString(dateFrom)) {
        throw new Error(`Invalid dateFrom format: ${dateFrom}. Expected YYYY-MM-DD.`);
      }
      if (dateTo && !validateDateString(dateTo)) {
        throw new Error(`Invalid dateTo format: ${dateTo}. Expected YYYY-MM-DD.`);
      }

      const filterType = params.type as string | undefined;
      const filterCategory = params.category as string | undefined;
      const filterTemperature = params.temperature as string | undefined;
      const minHeatScore = params.minHeatScore as number | undefined;
      const filterImportance = params.importance as string | undefined;
      const excludeArchived = params.excludeArchived as boolean | undefined;

      const needsFrontmatterFilter =
        filterType || filterCategory || filterTemperature ||
        minHeatScore !== undefined || filterImportance || excludeArchived;

      // Over-fetch if we need to post-filter by frontmatter
      const requestLimit = needsFrontmatterFilter
        ? (params.limit as number | undefined ?? 20) * 3
        : params.limit as number | undefined;

      const searchStart = Date.now();
      const searchResults = await hybridSearch(query, {
        scopePaths,
        tags: params.tags as string[] | undefined,
        dateFrom,
        dateTo,
        limit: requestLimit,
        collections: params.collections as string[] | undefined,
      });

      const searchDurationMs = Date.now() - searchStart;

      if (!needsFrontmatterFilter) {
        const results = searchResults.slice(0, params.limit as number | undefined ?? 20);
        recordSearchQuery(query, results.length, searchDurationMs);
        recordSearchScoreBreakdown(query, results);
        recordSearchTypeBreakdown(results);
        const detailStr = `q="${query}" → ${results.length} results` +
          (results.length > 0 ? ` (top: ${results[0].path.split('/').pop()?.replace(/\.md$/, '')})` : '');
        return {
          _detail: detailStr,
          content: [{ type: "text", text: JSON.stringify({ results }) }],
        };
      }

      // Post-filter by frontmatter fields
      const minImportanceIdx = filterImportance ? IMPORTANCE_ORDER.indexOf(filterImportance) : -1;
      const finalLimit = params.limit as number | undefined ?? 20;
      const filtered: typeof searchResults = [];

      for (const result of searchResults) {
        if (filtered.length >= finalLimit) break;
        try {
          const { content } = await readNote(result.path);
          const { data } = parseFrontmatter(content);

          if (filterType && data.type !== filterType) continue;
          if (filterCategory && data.category !== filterCategory) continue;
          if (filterTemperature && data.temperature !== filterTemperature) continue;
          if (minHeatScore !== undefined && (typeof data.heat_score !== 'number' || data.heat_score < minHeatScore)) continue;
          if (minImportanceIdx >= 0) {
            const noteIdx = IMPORTANCE_ORDER.indexOf(data.importance as string ?? 'medium');
            if (noteIdx < minImportanceIdx) continue;
          }
          if (excludeArchived) {
            if (data.temperature === 'cold' || data.type === 'archive') continue;
          }

          filtered.push(result);
        } catch {
          // skip unreadable notes
        }
      }

      recordSearchQuery(query, filtered.length, searchDurationMs);
      recordSearchScoreBreakdown(query, filtered);
      recordSearchTypeBreakdown(filtered);
      const detailStr = `q="${query}" → ${filtered.length} results` +
        (filtered.length > 0 ? ` (top: ${filtered[0].path.split('/').pop()?.replace(/\.md$/, '')})` : '');
      return {
        _detail: detailStr,
        content: [{ type: "text", text: JSON.stringify({ results: filtered }) }],
      };
    })
  );
}
