import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { trimWords, DIARY_WORD_LIMIT, DIARY_WORD_LIMIT_TOPIC } from './diary-trim.js';

export function register(server: McpServer): void {
  server.tool(
    'agent_diary_append',
    `Append ONE line to the agent diary Ops/Agent Diaries/<agentName>/YYYY-MM-DD.md.
Entry format: a single line (newlines are replaced by " / " — memory_wakeup only reads the first line), ≤60 words for Stop recaps / ≤120 for PreCompact handoffs: outcome → open threads → files touched. topic = repo or task name.
Every entry links the PROJECT and MACHINE it was written from: pass project (git repo slug, e.g. "cortexmd") and machine (hostname, e.g. "Ao") and the entry is suffixed with " · [[Projects/cortexmd]] @ [[Machines/Ao]]". machine defaults to the parenthesised host in agentName ("Claude Code (Ao)" → "Ao").
silent=true marks an unattended hook write (rendered "_(silent)_ … #hook _via <source>_"); silent=false is a deliberate recap (same as diary_write).
agentName must be the machine-scoped name ("Claude Code (<hostname>)" on Claude Code). Facts only — never secrets, credentials or pasted third-party text.`,
    {
      agentName: z
        .string()
        .describe('Machine-scoped agent name, e.g. "Claude Code (my-laptop)" (used as directory and diary heading; must match memory_wakeup)'),
      entry: z
        .string()
        .describe('One line, no newlines: outcome → open threads → files touched. Include [[wiki-links]] to notes.'),
      topic: z
        .string()
        .optional()
        .describe('Optional topic prefix shown in bold before the entry text'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags to append as hashtags to the entry'),
      silent: z
        .boolean()
        .optional()
        .describe('When true, render with a _(silent)_ marker and inject #hook tag. Default false.'),
      source: z
        .string()
        .optional()
        .describe('Source annotation, e.g. "hook:Stop" — appended as _via {source}_'),
      project: z
        .string()
        .optional()
        .describe('Project slug the agent is working on (git repo name, e.g. "cortexmd") — rendered as [[Projects/<slug>]]'),
      machine: z
        .string()
        .optional()
        .describe('Machine the agent runs on (hostname, e.g. "Ao") — rendered as [[Machines/<id>]]. Defaults to the "(host)" in agentName.'),
    },
    wrapToolHandler('agent_diary_append', async (params) => {
      const agentName = (params.agentName as string).trim();
      if (!agentName) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'agentName is required' }),
            },
          ],
          isError: true,
        };
      }

      const topic = params.topic as string | undefined;
      // ≤60 words for a Stop recap, ≤120 for a PreCompact handoff (topic set):
      // every diary line is re-read by memory_wakeup on each session start.
      const trimmed = trimWords(
        sanitizeContent(params.entry as string, 5000),
        topic ? DIARY_WORD_LIMIT_TOPIC : DIARY_WORD_LIMIT,
      );
      const rawEntry = trimmed.text;
      const userTags = (params.tags as string[] | undefined) ?? [];
      const silent = (params.silent as boolean | undefined) ?? false;
      const source = params.source as string | undefined;
      const project = params.project as string | undefined;
      const machine = params.machine as string | undefined;

      const normalizeTag = (t: string): string => (t.startsWith('#') ? t : `#${t}`);

      let text: string;
      if (silent) {
        const tagSet = new Set<string>(['#hook', ...userTags.map(normalizeTag)]);
        const hashtags = Array.from(tagSet).join(' ');
        const body = topic ? `**${topic}** — ${rawEntry}` : rawEntry;
        text = `_(silent)_ ${body} ${hashtags}`.trimEnd();
        if (source) {
          text = `${text} _via ${source}_`;
        }
      } else {
        const body = topic ? `**[${topic}]** ${rawEntry}` : rawEntry;
        if (userTags.length > 0) {
          const hashtags = userTags.map(normalizeTag).join(' ');
          text = `${body} ${hashtags}`;
        } else {
          text = body;
        }
      }

      const result = await appendJournalEntry(text, undefined, agentName, { project, machine });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: result.path,
              lineRef: result.lineRef,
              agentName,
              silent,
              ...(project ? { project } : {}),
              ...(machine ? { machine } : {}),
              ...(trimmed.truncated ? { truncated: true, words: trimmed.words, limit: trimmed.limit } : {}),
            }),
          },
        ],
      };
    }),
  );
}
