/**
 * Dream-cycle orchestration for the dashboard, including optional LLM
 * consolidation/synthesis. Lifted verbatim from the legacy
 * `POST /dashboard/api/dream/run` handler body. Pushes the resulting report
 * into `state.dreamHistory` via `recordDreamReport`.
 */
import { runDreamCycle } from '../../lib/dream-engine.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { recordDreamReport, getLlmStatus } from './state.js';

export interface DreamRunOptions {
  daysBack?: number;
  autoDecay?: boolean;
  autoArchive?: boolean;
  llmConsolidate?: boolean;
}

export interface DreamLlmResult {
  attempted: boolean;
  reason?: string;
  generated: number;
  errors: string[];
}

/** Run a dream cycle (+ optional LLM tasks) and record it in history. */
export async function runDashboardDream(
  body: DreamRunOptions | undefined,
): Promise<{ report: Awaited<ReturnType<typeof runDreamCycle>>; llmResult: DreamLlmResult }> {
  const report = await runDreamCycle({
    daysBack: body?.daysBack ?? 7,
    autoDecay: body?.autoDecay ?? true,
    autoArchive: body?.autoArchive ?? false,
  });

  const llmStatus = getLlmStatus();
  const llmResult: DreamLlmResult = { attempted: false, generated: 0, errors: [] };

  if (body?.llmConsolidate) {
    if (!config.enableReranker || !config.rerankerBaseUrl) {
      llmResult.reason = 'Reranker not configured (ENABLE_RERANKER or RERANKER_BASE_URL missing)';
      logger.warn('Dream LLM skipped', { reason: llmResult.reason });
    } else {
      llmResult.attempted = true;
      const llmUrl = `${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
      logger.info('Dream LLM starting', { url: llmUrl, model: config.rerankerModel });

      const callLlm = async (prompt: string): Promise<string | null> => {
        const llmRes = await fetch(llmUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.rerankerApiKey ? { 'Authorization': `Bearer ${config.rerankerApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.rerankerModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 300,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(config.rerankerTimeoutMs),
        });
        if (!llmRes.ok) return null;
        const data = await llmRes.json() as any;
        return data?.choices?.[0]?.message?.content ?? null;
      };

      // Task 1: Consolidation groups (if any)
      if (report.consolidationGroups.length > 0) {
        const topGroups = report.consolidationGroups.slice(0, 3);
        for (const group of topGroups) {
          try {
            const text = await callLlm(
              `You are a memory consolidation assistant. These ${group.paths.length} notes share tags [${group.commonTags.join(', ')}]. Suggest a concise summary that captures their common theme. Suggested title: "${group.suggestedTitle}". Respond with a brief 2-3 sentence summary.`,
            );
            if (text) {
              llmStatus.recentSuggestions.push({ group: `Consolidate: ${group.suggestedTitle}`, summary: text, timestamp: new Date().toISOString() });
              llmResult.generated++;
            }
          } catch (err: any) {
            llmResult.errors.push(`Consolidate ${group.suggestedTitle}: ${err.message}`);
            logger.warn('LLM consolidation failed', { group: group.suggestedTitle, error: err.message });
          }
        }
      }

      // Task 2: Dream synthesis — always run (themes + health + actionable advice)
      try {
        const themeList = report.themes.length > 0
          ? report.themes.map(t => `"${t.name}" (${t.memoryPaths.length} notes, ${t.temperature})`).join(', ')
          : 'no themes detected';
        const orphanCount = report.orphans.length;
        const connCount = report.connectionSuggestions.length;
        const h = report.health;

        const synthesisPrompt = `You are a knowledge management assistant analyzing a personal knowledge vault.

Dream cycle results:
- ${report.activity.totalNotes} notes (${report.activity.hotCount} hot, ${report.activity.warmCount} warm, ${report.activity.coldCount} cold)
- ${report.activity.recentlyCreated} recently created, ${report.activity.recentlyAccessed} recently accessed
- Themes: ${themeList}
- ${orphanCount} orphan memories (disconnected, no links/tags)
- ${connCount} suggested connections between unlinked notes
- Health: ${Math.round(h.tagCoverage * 100)}% tag coverage, ${h.linkDensity.toFixed(1)} avg links/note, ${Math.round(h.orphanRatio * 100)}% orphan ratio
- Decayed ${report.lifecycle.decayed} stale memories

Give a brief 3-4 sentence analysis: what patterns do you see, what should the user focus on, and one specific actionable suggestion to improve vault health.`;

        const synthesis = await callLlm(synthesisPrompt);
        if (synthesis) {
          llmStatus.recentSuggestions.push({ group: 'Dream Synthesis', summary: synthesis, timestamp: new Date().toISOString() });
          llmResult.generated++;
          logger.info('LLM dream synthesis generated');
        }
      } catch (err: any) {
        llmResult.errors.push(`Dream synthesis: ${err.message}`);
        logger.warn('LLM dream synthesis failed', { error: err.message });
      }

      // Trim suggestions
      if (llmStatus.recentSuggestions.length > 20) {
        llmStatus.recentSuggestions = llmStatus.recentSuggestions.slice(-20);
      }
    }
  }

  recordDreamReport(report);
  return { report, llmResult };
}
