import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, listFiles } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { searchNotes } from '../lib/search.js';
import { config } from '../config.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { validateDateString } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    "brief_daily",
    `Generate a daily briefing: recent updates, open tasks, hot items, and daily note summary — tailored by audience (internal = full detail, board = concise, customer = sanitized, no wiki-links). Reads from DailyNotes, recent file modifications, task index, and heat scores.`,
    {
      date: z.string().describe("Date for the brief in YYYY-MM-DD format"),
      audience: z.enum(["internal", "board", "customer"]).describe("Target audience for the brief"),
    },
    wrapToolHandler("brief_daily", async (params) => {
      const date = params.date as string;
      const audience = params.audience as string;

      if (!validateDateString(date)) {
        throw new Error(`Invalid date format: ${date}. Expected YYYY-MM-DD.`);
      }

      const [year, month] = date.split('-');
      const dailyNotePath = `DailyNotes/${year}/${month}/${date}.md`;

      // 1. Read today's daily note
      let dailySummary = '';
      try {
        const { content } = await readNote(dailyNotePath);
        const { body } = parseFrontmatter(content);
        dailySummary = body.trim();
      } catch {
        dailySummary = '_No daily note found for this date._';
      }

      // 2. Find recently modified notes
      const recentNotes: Array<{ path: string; mtime: Date }> = [];
      try {
        const files = await listFiles('.');
        for (const f of files.slice(0, 500)) {
          try {
            const resolved = path.resolve(config.brainVault, f);
            const s = await stat(resolved);
            const diffHours = (Date.now() - s.mtimeMs) / (1000 * 60 * 60);
            if (diffHours <= 48) {
              recentNotes.push({ path: f, mtime: s.mtime });
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
      recentNotes.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // 3. Search for open tasks
      const openTasks: Array<{ path: string; title: string }> = [];
      try {
        const taskResults = searchNotes('task', { limit: 50 });
        for (const r of taskResults) {
          try {
            const { content } = await readNote(r.path);
            const { data } = parseFrontmatter(content);
            if (data.type === 'task' && data.status === 'open') {
              openTasks.push({ path: r.path, title: data.title || r.title });
            }
          } catch {
            // skip
          }
        }
      } catch {
        // search index not ready
      }

      // 4. Search for hot-temperature notes
      const hotItems: Array<{ path: string; title: string; score: number }> = [];
      try {
        const files = await listFiles('.');
        for (const f of files.slice(0, 300)) {
          try {
            const { content } = await readNote(f);
            const { data } = parseFrontmatter(content);
            if (data.temperature === 'hot' || (data.heat_score && data.heat_score >= 7)) {
              hotItems.push({
                path: f,
                title: data.title || f.replace(/\.md$/, '').split('/').pop() || f,
                score: data.heat_score ?? 7,
              });
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }

      // 5. Compile markdown based on audience
      const sections: string[] = [];
      sections.push(`# Daily Brief -- ${date}`);
      sections.push('');

      // Summary
      sections.push('## Summary');
      sections.push('');
      if (audience === 'customer') {
        // External-safe: strip internal references
        const safeSummary = dailySummary
          .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, _target, alias) => alias || '')
          .replace(/<!--[\s\S]*?-->/g, '');
        sections.push(safeSummary || '_No updates._');
      } else {
        sections.push(dailySummary || '_No daily note found._');
      }
      sections.push('');

      // Key Updates
      sections.push('## Key Updates');
      sections.push('');
      const updateLimit = audience === 'board' ? 5 : 15;
      const updatesToShow = recentNotes.slice(0, updateLimit);
      if (updatesToShow.length === 0) {
        sections.push('_No recent updates._');
      } else {
        for (const note of updatesToShow) {
          if (audience === 'customer') {
            const name = note.path.replace(/\.md$/, '').split('/').pop();
            sections.push(`- ${name}`);
          } else {
            sections.push(`- [[${note.path}]] -- modified ${note.mtime.toISOString().slice(0, 16)}`);
          }
        }
      }
      sections.push('');

      // Open Tasks (hide from customer)
      if (audience !== 'customer') {
        sections.push('## Open Tasks');
        sections.push('');
        if (openTasks.length === 0) {
          sections.push('_No open tasks._');
        } else {
          const taskLimit = audience === 'board' ? 5 : openTasks.length;
          for (const task of openTasks.slice(0, taskLimit)) {
            sections.push(`- [ ] [[${task.path}|${task.title}]]`);
          }
        }
        sections.push('');
      }

      // Hot Items (hide from customer)
      if (audience !== 'customer') {
        sections.push('## Hot Items');
        sections.push('');
        if (hotItems.length === 0) {
          sections.push('_No hot items._');
        } else {
          const hotLimit = audience === 'board' ? 3 : hotItems.length;
          for (const item of hotItems.slice(0, hotLimit)) {
            sections.push(`- [[${item.path}|${item.title}]] (score: ${item.score})`);
          }
        }
        sections.push('');
      }

      const markdown = sections.join('\n');

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ markdown }),
        }],
      };
    })
  );
}
