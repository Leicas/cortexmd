import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAgentDiary, listAgents } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

// Pulled large enough to survive aggressive silent-filtering while still bounding
// the scan; the tool then applies the caller's limit to the filtered set.
const READ_SCAN_CAP = 1000;

interface ParsedEntry {
  date: string;
  time: string;
  text: string;
  silent: boolean;
  source?: string;
}

function parseEntry(entry: { date: string; time: string; text: string }): ParsedEntry {
  const silent = entry.text.includes('_(silent)_');
  const sourceMatch = entry.text.match(/_via\s+([^_]+)_\s*$/);
  const source = sourceMatch ? sourceMatch[1].trim() : undefined;
  return {
    date: entry.date,
    time: entry.time,
    text: entry.text,
    silent,
    source,
  };
}

export function register(server: McpServer): void {
  server.tool(
    'agent_diary_read',
    `Read an agent's diary entries with silent-aware filtering, or list all agents.

Like diary_read, but understands silent entries written via agent_diary_append (hook-driven writes). Entries are tagged with a \`silent\` boolean and optional \`source\` string extracted from the _via {source}_ suffix.

Pass agentName="" to list all agents. Use silentOnly to see only hook snapshots; use excludeSilent to see only deliberate human-authored entries.`,
    {
      agentName: z
        .string()
        .describe('Name of the agent whose diary to read. Pass empty string to list all agents.'),
      limit: z
        .number()
        .optional()
        .describe('Max entries to return after filtering (default: 10)'),
      since: z
        .string()
        .optional()
        .describe('ISO date (YYYY-MM-DD); only return entries on/after this date'),
      silentOnly: z
        .boolean()
        .optional()
        .describe('When true, return only silent entries'),
      excludeSilent: z
        .boolean()
        .optional()
        .describe('When true, exclude silent entries. Mutually exclusive with silentOnly.'),
    },
    wrapToolHandler('agent_diary_read', async (params) => {
      const agentName = (params.agentName as string).trim();
      const limit = (params.limit as number | undefined) ?? 10;
      const since = params.since as string | undefined;
      const silentOnly = (params.silentOnly as boolean | undefined) ?? false;
      const excludeSilent = (params.excludeSilent as boolean | undefined) ?? false;

      if (silentOnly && excludeSilent) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'silentOnly and excludeSilent are mutually exclusive',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!agentName) {
        const agents = await listAgents();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ agents, count: agents.length }, null, 2),
            },
          ],
        };
      }

      const { entries: rawEntries } = await readAgentDiary(agentName, READ_SCAN_CAP);
      const parsed = rawEntries.map(parseEntry);

      const filtered = parsed.filter((e) => {
        if (since && e.date < since) return false;
        if (silentOnly && !e.silent) return false;
        if (excludeSilent && e.silent) return false;
        return true;
      });

      const total = filtered.length;
      const returned = limit > 0 ? filtered.slice(0, limit) : filtered;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                agentName,
                total,
                returned: returned.length,
                entries: returned,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}
