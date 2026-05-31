/**
 * GET JSON data routes. Lifted verbatim from the legacy `dashboard.ts`:
 * dream/history, llm/status (throttled health probe), agents, teams, skills,
 * agent-diary/:name.
 */
import type { Router, Request, Response } from 'express';
import { listAgents as listAgentDefs, listTeams, listSkills } from '../../lib/agents.js';
import { readAgentDiary } from '../../lib/journal.js';
import { getDreamHistory, getLlmStatus } from '../model/state.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

export function registerDataRoutes(router: Router): void {
  router.get('/dashboard/api/dream/history', (_req: Request, res: Response) => {
    res.json({
      history: getDreamHistory().map(r => ({
        timestamp: r.timestamp,
        durationMs: r.durationMs,
        themes: r.themes.length,
        orphans: r.orphans.length,
        connections: r.connectionSuggestions.length,
        consolidations: r.consolidationGroups.length,
        decayed: r.lifecycle.decayed,
        archived: r.lifecycle.archived.length,
        health: r.health,
      })),
      total: getDreamHistory().length,
    });
  });

  router.get('/dashboard/api/llm/status', async (_req: Request, res: Response) => {
    const llmStatus = getLlmStatus();
    const now = Date.now();
    const checkUrl = config.enableReranker && config.rerankerBaseUrl
      ? `${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/models`
      : null;

    if (checkUrl) {
      // Only check every 30 seconds
      if (now - llmStatus.lastCheck > 30000) {
        logger.info('LLM health check', { url: checkUrl, enableReranker: config.enableReranker });
        try {
          const healthRes = await fetch(checkUrl, {
            signal: AbortSignal.timeout(3000),
            headers: config.rerankerApiKey ? { 'Authorization': `Bearer ${config.rerankerApiKey}` } : {},
          });
          llmStatus.available = healthRes.ok;
          llmStatus.lastError = healthRes.ok ? undefined : `HTTP ${healthRes.status}`;
          llmStatus.lastCheck = now;
          logger.info('LLM health check result', { url: checkUrl, ok: healthRes.ok, status: healthRes.status });
        } catch (err: any) {
          llmStatus.available = false;
          llmStatus.lastError = `${err.name}: ${err.message}`;
          llmStatus.lastCheck = now;
          logger.warn('LLM health check failed', { url: checkUrl, error: err.message, code: err.cause?.code });
        }
      }
    } else {
      llmStatus.available = false;
      llmStatus.lastError = config.enableReranker
        ? `No RERANKER_BASE_URL configured (enableReranker=${config.enableReranker})`
        : `Reranker disabled (ENABLE_RERANKER=${process.env.ENABLE_RERANKER ?? 'unset'})`;
      llmStatus.lastCheck = now;
    }
    res.json({
      available: llmStatus.available,
      lastCheck: llmStatus.lastCheck,
      lastError: llmStatus.lastError,
      checkUrl,
      model: config.enableReranker ? config.rerankerModel : null,
      baseUrl: config.enableReranker ? config.rerankerBaseUrl : null,
      recentSuggestions: llmStatus.recentSuggestions.slice(-5),
    });
  });

  router.get('/dashboard/api/agents', async (_req: Request, res: Response) => {
    try {
      const agents = await listAgentDefs();
      res.json({ agents, total: agents.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/dashboard/api/teams', async (_req: Request, res: Response) => {
    try {
      const teams = await listTeams();
      res.json({ teams, total: teams.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/dashboard/api/skills', async (_req: Request, res: Response) => {
    try {
      const skills = await listSkills();
      res.json({ skills, total: skills.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/dashboard/api/agent-diary/:name', async (req: Request, res: Response) => {
    try {
      const raw = parseInt(String(req.query.limit ?? '20'), 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 20;
      const result = await readAgentDiary(String(req.params.name), limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
