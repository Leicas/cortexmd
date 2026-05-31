import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { indexNote } from '../lib/search.js';
import { appendJournalEntry } from '../lib/journal.js';

export function register(server: McpServer): void {
  server.tool(
    'memory_promote',
    `Explicitly promote or demote a memory's temperature layer. Use this to manually adjust memory importance when the automatic heat scoring doesn't reflect reality — for example, boosting a cold memory that's suddenly relevant again, cooling a hot memory that's no longer active, or archiving/unarchiving memories. Each action updates the heat_score, temperature, and logs the reason for the change. This is the manual override for the automatic temperature system.`,
    {
      paths: z.array(z.string()).min(1).describe('Vault-relative paths of memories to promote/demote'),
      action: z.enum(['boost', 'cool', 'freeze', 'archive', 'unarchive']).describe(
        'Action: boost (increase heat by 4, cap at 16), cool (decrease by 4, min 0), freeze (set to 0/cold), archive (mark archived), unarchive (remove archived flag and boost)'
      ),
      reason: z.string().optional().describe('Why this promotion/demotion is happening (logged in frontmatter)'),
    },
    wrapToolHandler('memory_promote', async (params) => {
      const paths = (params.paths as string[]).map(sanitizePath);
      const action = params.action as string;
      const reason = (params.reason as string | undefined) ?? '';
      const results: Array<{ path: string; oldTemp: string; newTemp: string; oldScore: number; newScore: number }> = [];
      const errors: string[] = [];

      for (const notePath of paths) {
        try {
          const { content } = await readNote(notePath);
          const { data, body } = parseFrontmatter(content);

          const oldScore = typeof data.heat_score === 'number' ? data.heat_score : 0;
          const oldTemp = typeof data.temperature === 'string' ? data.temperature : 'cold';
          let newScore = oldScore;

          switch (action) {
            case 'boost':
              newScore = Math.min(16, oldScore + 4);
              data.last_accessed = new Date().toISOString().slice(0, 10);
              break;
            case 'cool':
              newScore = Math.max(0, oldScore - 4);
              break;
            case 'freeze':
              newScore = 0;
              break;
            case 'archive':
              newScore = 0;
              data.archived = true;
              data.archived_at = new Date().toISOString().slice(0, 10);
              break;
            case 'unarchive':
              newScore = Math.max(4, oldScore); // at least warm
              delete data.archived;
              delete data.archived_at;
              data.last_accessed = new Date().toISOString().slice(0, 10);
              break;
          }

          const newTemp = newScore >= 10 ? 'hot' : newScore >= 4 ? 'warm' : 'cold';
          data.heat_score = newScore;
          data.temperature = newTemp;
          data.last_updated = new Date().toISOString().slice(0, 10);

          // Track promotion history
          if (reason) {
            const history = Array.isArray(data.promotion_history) ? data.promotion_history : [];
            history.push(`${new Date().toISOString().slice(0, 10)}: ${action} — ${reason}`);
            // Keep last 5 entries
            data.promotion_history = history.slice(-5);
          }

          const updated = stringifyFrontmatter(data, body);
          await writeNote(notePath, updated);
          await indexNote(notePath);

          results.push({ path: notePath, oldTemp, newTemp, oldScore, newScore });
        } catch (err: any) {
          errors.push(`${notePath}: ${err.message}`);
        }
      }

      // Journal entry
      if (results.length > 0) {
        const summary = results.map(r => `${r.path} (${r.oldTemp}→${r.newTemp})`).join(', ');
        await appendJournalEntry(`Memory ${action}: ${summary}${reason ? ` — ${reason}` : ''}`);
      }

      const output = {
        action,
        reason,
        results,
        errors: errors.length > 0 ? errors : undefined,
      };

      return {
        content: [{
          type: 'text',
          text: `${action} applied to ${results.length} memories` +
            (errors.length > 0 ? ` (${errors.length} errors)` : '') +
            `\n\n${JSON.stringify(output, null, 2)}`,
        }],
      };
    })
  );
}
