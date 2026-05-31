import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMetrics } from './lib/metrics.js';
import { getRateLimitSnapshot, resetRateLimit, resetAllRateLimits } from './lib/rate-limit.js';
import { getSessionSnapshots, killSession } from './index.js';
import { getOAuthClients } from './oauth.js';
import { rebuildIndex, getDocMeta, getDocMetaSummary, getCollectionDistribution } from './lib/search.js';
import { kgBootstrap } from './lib/knowledge-graph.js';
import { getEmbeddingStats } from './lib/embeddings.js';
import { getRecentLogs } from './lib/logger.js';
import { getRecentSearchScores, getBenchmarkResults, setBenchmarkResults } from './lib/metrics.js';
import { runBenchmark, saveAsGroundTruth } from './lib/benchmark.js';
import { getIndexHealth } from './lib/search.js';
import { wakeUp } from './lib/memory-stack.js';
import type { MemoryLayer } from './lib/memory-stack.js';
import { isKgInitialized, kgStats } from './lib/knowledge-graph.js';
import { listEntities } from './lib/entity-registry.js';
import { listAgents, readAgentDiary } from './lib/journal.js';
import { listAgents as listAgentDefs, listTeams, listSkills } from './lib/agents.js';
import { runMigration } from './lib/migration.js';
import { runDreamCycle, computeHealth as computeDreamHealth } from './lib/dream-engine.js';
import type { DreamReport } from './lib/dream-engine.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';

export const dashboardRouter = Router();

// Shared variable for async memory stack data in SSE
let memoryStackCache: MemoryLayer[] = [];

// Shared variable for async agent diary data in SSE
let agentDiaryCache: Array<{ agentId: string; lastActive: string; entryCount: number }> = [];

// Dream report history (persisted in memory, max 50 entries)
const MAX_DREAM_HISTORY = 50;
let dreamHistory: DreamReport[] = [];
let lastDreamReport: DreamReport | null = null;
let dreamRunning = false;

// LLM status tracking
let llmStatus: { available: boolean; lastCheck: number; lastError?: string; recentSuggestions: Array<{ group: string; summary: string; timestamp: string }> } = {
  available: false,
  lastCheck: 0,
  recentSuggestions: [],
};

// Dismissed suggestions tracking (session-scoped)
const dismissedSuggestions = new Set<string>();

/** Compute a composite vault health score (0-100) from dream health metrics */
function computeHealthScore(health: DreamReport['health']): { score: number; grade: string; factors: Array<{ name: string; value: number; weight: number; contribution: number }> } {
  const factors = [
    { name: 'Tag Coverage', value: health.tagCoverage, weight: 0.25, contribution: 0 },
    { name: 'Link Density', value: Math.min(health.linkDensity / 3, 1), weight: 0.25, contribution: 0 },
    { name: 'Low Orphan Ratio', value: 1 - Math.min(health.orphanRatio, 1), weight: 0.25, contribution: 0 },
    { name: 'Heat Activity', value: Math.min(health.avgHeatScore / 8, 1), weight: 0.15, contribution: 0 },
    { name: 'Temp Balance', value: computeTempBalance(health.temperatureDistribution), weight: 0.10, contribution: 0 },
  ];

  let score = 0;
  for (const f of factors) {
    f.contribution = f.value * f.weight * 100;
    score += f.contribution;
  }
  score = Math.round(Math.min(100, Math.max(0, score)));

  let grade: string;
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'A-';
  else if (score >= 70) grade = 'B+';
  else if (score >= 60) grade = 'B';
  else if (score >= 50) grade = 'C+';
  else if (score >= 40) grade = 'C';
  else if (score >= 30) grade = 'D';
  else grade = 'F';

  return { score, grade, factors };
}

function computeTempBalance(dist: { hot: number; warm: number; cold: number }): number {
  const total = dist.hot + dist.warm + dist.cold;
  if (total === 0) return 0;
  // Ideal: hot ~15%, warm ~35%, cold ~50%. Score how close we are.
  const hotRatio = dist.hot / total;
  // Penalize extremes (all hot or all cold)
  const hotPenalty = Math.max(0, hotRatio - 0.4) * 2;
  const coldPenalty = Math.max(0, (dist.cold / total) - 0.8) * 2;
  return Math.max(0, 1 - hotPenalty - coldPenalty);
}

// ── POST API endpoints (admin actions) ─────────────────────────────────────

dashboardRouter.post('/dashboard/api/rate-limit/reset', (req: Request, res: Response) => {
  const { key } = req.body as { key?: string };
  if (!key) {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  const existed = resetRateLimit(key);
  res.json({ ok: true, existed });
});

dashboardRouter.post('/dashboard/api/rate-limit/reset-all', (_req: Request, res: Response) => {
  const count = resetAllRateLimits();
  res.json({ ok: true, count });
});

dashboardRouter.post('/dashboard/api/sessions/kill', (req: Request, res: Response) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  const killed = killSession(sessionId);
  res.json({ ok: true, killed });
});

dashboardRouter.post('/dashboard/api/benchmark/run', async (_req: Request, res: Response) => {
  try {
    const summary = await runBenchmark();
    setBenchmarkResults(summary);
    res.json({ ok: true, queries: summary.totalQueries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

dashboardRouter.post('/dashboard/api/benchmark/save-ground-truth', (_req: Request, res: Response) => {
  try {
    const bench = getBenchmarkResults();
    if (!bench) {
      res.status(400).json({ error: 'No benchmark results to save. Run a benchmark first.' });
      return;
    }
    saveAsGroundTruth(bench);
    res.json({ ok: true, message: 'Ground truth saved from current benchmark results.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

dashboardRouter.post('/dashboard/api/index/rebuild', async (_req: Request, res: Response) => {
  try {
    await rebuildIndex();
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

dashboardRouter.post('/dashboard/api/kg/bootstrap', async (_req: Request, res: Response) => {
  try {
    if (!isKgInitialized()) {
      res.status(400).json({ error: 'Knowledge graph not initialized (set ENABLE_KG=true)' });
      return;
    }
    const dm = getDocMeta();
    const result = kgBootstrap(dm);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

dashboardRouter.post('/dashboard/api/migrate/dry-run', async (_req: Request, res: Response) => {
  try {
    const result = await runMigration(true);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

dashboardRouter.post('/dashboard/api/migrate/run', async (_req: Request, res: Response) => {
  try {
    const result = await runMigration(false);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Dream cycle from dashboard ─────────────────────────────────────────

dashboardRouter.post('/dashboard/api/dream/run', async (req: Request, res: Response) => {
  if (dreamRunning) {
    res.status(409).json({ error: 'Dream cycle already running' });
    return;
  }
  try {
    dreamRunning = true;
    const body = req.body as { daysBack?: number; autoDecay?: boolean; autoArchive?: boolean; llmConsolidate?: boolean } | undefined;
    const report = await runDreamCycle({
      daysBack: body?.daysBack ?? 7,
      autoDecay: body?.autoDecay ?? true,
      autoArchive: body?.autoArchive ?? false,
    });

    // LLM consolidation if requested
    let llmResult: { attempted: boolean; reason?: string; generated: number; errors: string[] } = {
      attempted: false, generated: 0, errors: [],
    };

    if (body?.llmConsolidate) {
      if (!config.enableReranker || !config.rerankerBaseUrl) {
        llmResult.reason = 'Reranker not configured (ENABLE_RERANKER or RERANKER_BASE_URL missing)';
        logger.warn('Dream LLM skipped', { reason: llmResult.reason });
      } else {
        llmResult.attempted = true;
        const llmUrl = `${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
        logger.info('Dream LLM starting', { url: llmUrl, model: config.rerankerModel });

        // Helper to call the LLM
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
                `You are a memory consolidation assistant. These ${group.paths.length} notes share tags [${group.commonTags.join(', ')}]. Suggest a concise summary that captures their common theme. Suggested title: "${group.suggestedTitle}". Respond with a brief 2-3 sentence summary.`
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

    lastDreamReport = report;
    dreamHistory.push(report);
    if (dreamHistory.length > MAX_DREAM_HISTORY) {
      dreamHistory = dreamHistory.slice(-MAX_DREAM_HISTORY);
    }
    res.json({ ok: true, report, llmResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    dreamRunning = false;
  }
});

dashboardRouter.post('/dashboard/api/dream/dismiss', (req: Request, res: Response) => {
  const { key } = req.body as { key?: string };
  if (!key) {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  dismissedSuggestions.add(key);
  res.json({ ok: true });
});

dashboardRouter.get('/dashboard/api/dream/history', (_req: Request, res: Response) => {
  res.json({
    history: dreamHistory.map(r => ({
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
    total: dreamHistory.length,
  });
});

dashboardRouter.get('/dashboard/api/llm/status', async (_req: Request, res: Response) => {
  // Check LLM availability by pinging the reranker endpoint
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

dashboardRouter.get('/dashboard/api/agents', async (_req: Request, res: Response) => {
  try {
    const agents = await listAgentDefs();
    res.json({ agents, total: agents.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

dashboardRouter.get('/dashboard/api/teams', async (_req: Request, res: Response) => {
  try {
    const teams = await listTeams();
    res.json({ teams, total: teams.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

dashboardRouter.get('/dashboard/api/skills', async (_req: Request, res: Response) => {
  try {
    const skills = await listSkills();
    res.json({ skills, total: skills.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

dashboardRouter.get('/dashboard/api/agent-diary/:name', async (req: Request, res: Response) => {
  try {
    const raw = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 20;
    const result = await readAgentDiary(String(req.params.name), limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── SSE endpoint — streams enriched metrics every 2 seconds ────────────────

dashboardRouter.get('/dashboard/events', (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = () => {
    const metrics = getMetrics();
    const payload: Record<string, unknown> = { ...metrics };

    // Enrich tool calls with percentile stats
    const tc = metrics.toolCalls;
    const enriched: Record<string, unknown> = {};
    for (const [name, m] of Object.entries(tc)) {
      const sorted = [...m.latencies].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      enriched[name] = {
        count: m.count,
        avgLatency: m.count > 0 ? Math.round(m.totalLatency / m.count) : 0,
        p95Latency: sorted.length > 0 ? sorted[Math.min(p95Index, sorted.length - 1)] : 0,
        maxLatency: m.maxLatency,
        errors: m.errors,
        lastCalled: m.lastCalled ?? null,
      };
    }
    payload.toolCalls = enriched;

    // Additional data for dashboard tabs
    payload.rateLimits = getRateLimitSnapshot();
    payload.sessions = getSessionSnapshots();
    payload.oauthClients = getOAuthClients();
    payload.latencyHistory = metrics.latencyHistory;
    payload.recentToolCalls = metrics.recentToolCalls;
    payload.recentErrors = metrics.recentErrors;
    payload.recentAuthFailures = metrics.recentAuthFailures;

    // Memory temperature counts from the search index docMeta (single pass)
    const docMeta = getDocMeta();
    let hot = 0, warm = 0, cold = 0, unset = 0;
    for (const [, meta] of docMeta) {
      switch (meta.temperature) {
        case 'hot': hot++; break;
        case 'warm': warm++; break;
        case 'cold': cold++; break;
        default: unset++; break;
      }
    }
    payload.memoryTemperature = { hot, warm, cold };

    // Enrich memory lifecycle with current temperature distribution
    if (payload.memoryLifecycle) {
      (payload.memoryLifecycle as Record<string, unknown>).temperatureDistribution = { hot, warm, cold, unset };
    }

    // Enriched vault/memory data for verbose dashboard
    const summary = getDocMetaSummary();
    payload.topNotes = summary.topByHeat;
    payload.categoryBreakdown = summary.categoryBreakdown;
    payload.heatHistogram = summary.heatHistogram;
    payload.embeddingStats = getEmbeddingStats();

    // Collections, score breakdowns, benchmark
    payload.collectionDistribution = getCollectionDistribution();
    payload.searchScoreBreakdowns = getRecentSearchScores();
    payload.benchmarkSummary = getBenchmarkResults();

    // Index health (errors during last rebuild)
    payload.indexHealth = getIndexHealth();

    // System logs ring buffer for dashboard
    payload.systemLogs = getRecentLogs();

    // Memory stack layers (L0 + L1) — fetched async, cached by the module
    wakeUp().then(layers => {
      // Attach to next SSE push via a shared variable
      memoryStackCache = layers;
    }).catch(() => { /* non-critical */ });
    payload.memoryStack = memoryStackCache;

    // Knowledge Graph stats
    if (isKgInitialized()) {
      try {
        const stats = kgStats();
        payload.knowledgeGraph = {
          entities: stats.entityCount,
          triples: stats.tripleCount,
          predicates: stats.topPredicates,
        };
      } catch { /* non-critical */ }
    }

    // Entity Registry
    try {
      const tierConfidence: Record<string, number> = { confirmed: 1.0, detected: 0.7, suggested: 0.4 };
      const entities = listEntities();
      payload.entityRegistry = entities.map(e => ({
        name: e.name,
        type: e.type,
        confidence: tierConfidence[e.tier] ?? 0.5,
        confirmed: e.confirmed,
      }));
    } catch { /* non-critical */ }

    // Agent Diaries — async, cached like memoryStack
    listAgents().then(agents => {
      agentDiaryCache = agents.map(a => ({
        agentId: a.name,
        lastActive: a.lastActive,
        entryCount: a.entryCount,
      }));
    }).catch(() => { /* non-critical */ });
    payload.agentDiaries = agentDiaryCache;

    // Dream cycle data for Intelligence tab
    if (lastDreamReport) {
      payload.lastDream = {
        timestamp: lastDreamReport.timestamp,
        durationMs: lastDreamReport.durationMs,
        narrative: lastDreamReport.narrative,
        themes: lastDreamReport.themes,
        orphans: lastDreamReport.orphans.slice(0, 15),
        connectionSuggestions: lastDreamReport.connectionSuggestions.filter(s => !dismissedSuggestions.has(`conn:${s.sourcePath}:${s.targetPath}`)),
        consolidationGroups: lastDreamReport.consolidationGroups.filter(g => !dismissedSuggestions.has(`cons:${g.suggestedTitle}`)),
        health: lastDreamReport.health,
        activity: lastDreamReport.activity,
        lifecycle: lastDreamReport.lifecycle,
      };
      payload.healthScore = computeHealthScore(lastDreamReport.health);
    } else {
      // Compute live health even without a dream report
      try {
        const liveHealth = computeDreamHealth();
        payload.liveHealth = liveHealth;
        payload.healthScore = computeHealthScore(liveHealth);
      } catch { /* non-critical */ }
    }

    // Dream history summary for sparkline/trend
    payload.dreamHistory = dreamHistory.map(r => ({
      timestamp: r.timestamp,
      themes: r.themes.length,
      orphans: r.orphans.length,
      connections: r.connectionSuggestions.length,
      healthScore: computeHealthScore(r.health).score,
      decayed: r.lifecycle.decayed,
    }));

    // Dream running flag
    payload.dreamRunning = dreamRunning;

    // LLM status — check health inline (throttled to every 30s)
    const llmNow = Date.now();
    if (config.enableReranker && config.rerankerBaseUrl && llmNow - llmStatus.lastCheck > 30000) {
      const checkUrl = `${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/models`;
      fetch(checkUrl, { signal: AbortSignal.timeout(3000) })
        .then(r => {
          llmStatus.available = r.ok;
          llmStatus.lastError = r.ok ? undefined : `HTTP ${r.status}`;
          llmStatus.lastCheck = Date.now();
          if (!r.ok) logger.warn('LLM health check failed', { url: checkUrl, status: r.status });
        })
        .catch((err: any) => {
          llmStatus.available = false;
          llmStatus.lastError = `${err.name}: ${err.message}`;
          llmStatus.lastCheck = Date.now();
          logger.warn('LLM health check error', { url: checkUrl, error: err.message, code: err.cause?.code });
        });
    } else if (!config.enableReranker || !config.rerankerBaseUrl) {
      llmStatus.available = false;
      if (!llmStatus.lastError) llmStatus.lastError = 'Reranker not configured';
    }
    payload.llmStatus = {
      configured: config.enableReranker && !!config.rerankerBaseUrl,
      available: llmStatus.available,
      model: config.enableReranker ? config.rerankerModel : null,
      baseUrl: config.enableReranker ? config.rerankerBaseUrl : null,
      lastError: llmStatus.lastError,
      recentSuggestions: llmStatus.recentSuggestions.slice(-5),
    };

    // Entity registry enriched with tier breakdown
    try {
      const entities = listEntities();
      const tierCounts = { confirmed: 0, detected: 0, suggested: 0 };
      const typeCounts: Record<string, number> = {};
      for (const e of entities) {
        tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;
        typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
      }
      payload.entityStats = { tierCounts, typeCounts, total: entities.length };
    } catch { /* non-critical */ }

    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };

  send();
  const interval = setInterval(send, 2000);

  _req.on('close', () => {
    clearInterval(interval);
  });
});

// ── Dashboard HTML page ────────────────────────────────────────────────────

dashboardRouter.get('/dashboard', (_req: Request, res: Response) => {
  res.type('html').send(DASHBOARD_HTML);
});

// ---------------------------------------------------------------------------
// Inline HTML template
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obsidian MCP - Control Panel</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px}
body{
  background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  line-height:1.5;min-height:100vh;
}
:root{
  --bg:#0d1117;--card:#161b22;--border:#30363d;
  --text:#c9d1d9;--text-dim:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;
  --mono:'Cascadia Code','Fira Code','JetBrains Mono',monospace;
}
a{color:var(--blue);text-decoration:none}

/* Layout */
.shell{display:flex;flex-direction:column;min-height:100vh}
.header{
  display:flex;align-items:center;justify-content:space-between;
  padding:.75rem 1.5rem;background:var(--card);border-bottom:1px solid var(--border);
  flex-wrap:wrap;gap:.75rem;
}
.header h1{font-size:1.15rem;font-weight:600;letter-spacing:-.02em}
.header h1 span{color:var(--blue)}
.status-group{display:flex;align-items:center;gap:1.25rem}
.status-badge{display:flex;align-items:center;gap:.4rem;font-size:.85rem}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)}
#uptime,#clock{font-family:var(--mono);font-size:.8rem;color:var(--text-dim)}

/* Tabs */
.tab-bar{
  display:flex;gap:0;background:var(--card);border-bottom:1px solid var(--border);
  padding:0 1.5rem;overflow-x:auto;
}
.tab-btn{
  padding:.6rem 1.25rem;font-size:.85rem;font-weight:500;color:var(--text-dim);
  background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;
  white-space:nowrap;transition:color .15s,border-color .15s;
}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--blue);border-bottom-color:var(--blue)}

.content{padding:1.5rem;flex:1}
.tab-panel{display:none}
.tab-panel.active{display:block}

/* Grid helpers */
.row{display:grid;gap:1rem;margin-bottom:1rem}
.row-4{grid-template-columns:repeat(4,1fr)}
.row-3{grid-template-columns:repeat(3,1fr)}
.row-2{grid-template-columns:1fr 1fr}
.row-1{grid-template-columns:1fr}
@media(max-width:900px){.row-4,.row-2,.row-3{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.row-4,.row-2,.row-3{grid-template-columns:1fr}}

/* Cards */
.card{
  background:var(--card);border:1px solid var(--border);border-radius:8px;
  padding:1.25rem;transition:border-color .2s;
}
.card:hover{border-color:#484f58}
.card-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:.25rem}
.card-value{font-size:1.6rem;font-weight:700;font-family:var(--mono)}
.card-sub{font-size:.75rem;color:var(--text-dim);margin-top:.2rem;font-family:var(--mono)}
.section-title{font-size:.95rem;font-weight:600;margin-bottom:.75rem}

/* Charts */
.chart-wrap{margin-top:.75rem;height:140px;position:relative}
.chart-wrap svg{width:100%;height:100%}

/* Tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{
  text-align:left;padding:.55rem .75rem;color:var(--text-dim);font-weight:500;
  border-bottom:1px solid var(--border);white-space:nowrap;user-select:none;cursor:pointer;
}
th:hover{color:var(--text)}
th .sort-arrow{margin-left:.25rem;font-size:.6rem;opacity:.5}
td{padding:.5rem .75rem;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:.78rem}
tr:hover td{background:rgba(88,166,255,.04)}
tr:last-child td{border-bottom:none}
.lat-green{color:var(--green)}
.lat-yellow{color:var(--yellow)}
.lat-red{color:var(--red)}
.err-red{color:var(--red);font-weight:600}
.mono{font-family:var(--mono)}

/* Buttons */
.btn{
  display:inline-flex;align-items:center;gap:.3rem;
  padding:.3rem .7rem;font-size:.75rem;font-weight:500;
  border:1px solid var(--border);border-radius:6px;cursor:pointer;
  background:var(--card);color:var(--text);transition:all .15s;
}
.btn:hover{border-color:#484f58;background:#1c2129}
.btn-primary{border-color:var(--blue);color:var(--blue)}
.btn-primary:hover{background:rgba(88,166,255,.12)}
.btn-danger{border-color:var(--red);color:var(--red)}
.btn-danger:hover{background:rgba(248,81,73,.12)}

/* Badges */
.badge{
  display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.7rem;
  font-weight:600;font-family:var(--mono);
}
.badge-hot{background:rgba(248,81,73,.15);color:var(--red)}
.badge-warm{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-cold{background:rgba(88,166,255,.15);color:var(--blue)}

/* Stacked bar */
.stacked-bar{display:flex;height:24px;border-radius:6px;overflow:hidden;margin-top:.5rem}
.stacked-bar .seg{display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:600;font-family:var(--mono);color:#fff;min-width:0}
.seg-hot{background:var(--red)}
.seg-warm{background:var(--yellow)}
.seg-cold{background:var(--blue)}

/* Histogram bars */
.hist-bar{flex:1;border-radius:4px 4px 0 0;min-width:0;display:flex;align-items:flex-end;justify-content:center;font-size:.65rem;font-weight:600;font-family:var(--mono);color:var(--text);transition:height .3s}
/* Category horizontal bars */
.cat-row{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem;font-size:.78rem}
.cat-row .cat-label{width:100px;text-align:right;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.cat-row .cat-bar-wrap{flex:1;height:18px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden}
.cat-row .cat-bar{height:100%;border-radius:4px;transition:width .3s;display:flex;align-items:center;padding-left:.4rem;font-size:.65rem;font-weight:600;font-family:var(--mono);color:#fff;min-width:0}
.cat-row .cat-count{width:32px;text-align:right;font-family:var(--mono);font-size:.75rem;color:var(--text);flex-shrink:0}
/* Search feed */
.search-item{display:flex;gap:.5rem;padding:.3rem 0;border-bottom:1px solid var(--border);font-size:.78rem}
.search-item .s-ts{color:var(--text-dim);font-family:var(--mono);flex-shrink:0;width:64px}
.search-item .s-query{color:var(--blue);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.search-item .s-count{color:var(--text);font-family:var(--mono);width:48px;text-align:right;flex-shrink:0}
.search-item .s-lat{color:var(--text-dim);font-family:var(--mono);width:56px;text-align:right;flex-shrink:0}

/* Feed / logs */
.feed{max-height:400px;overflow-y:auto;font-size:.8rem}
.feed::-webkit-scrollbar{width:5px}
.feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.feed-item{
  display:flex;gap:.75rem;padding:.4rem 0;border-bottom:1px solid var(--border);
}
.feed-item:hover{background:rgba(88,166,255,.04)}
.feed-ts{color:var(--text-dim);font-family:var(--mono);flex-shrink:0;width:72px}
.feed-tool{color:var(--blue);font-weight:500;width:140px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-status{width:40px;flex-shrink:0;text-align:center}
.feed-status.ok{color:var(--green)}
.feed-status.error{color:var(--red)}
.feed-dur{color:var(--text-dim);font-family:var(--mono);flex-shrink:0;width:60px;text-align:right}

.error-item{
  padding:.5rem .75rem;border-radius:6px;margin-bottom:.4rem;
  background:rgba(248,81,73,.06);border:1px solid rgba(248,81,73,.18);
  font-size:.78rem;display:flex;gap:.75rem;flex-wrap:wrap;
}
.error-item .e-ts{color:var(--text-dim);font-family:var(--mono);flex-shrink:0;width:72px}
.error-item .e-tool{color:var(--red);font-weight:600;width:140px;flex-shrink:0}
.error-item .e-msg{color:var(--text);flex:1;word-break:break-word}

.empty-msg{color:var(--text-dim);font-style:italic;font-size:.8rem;padding:1rem 0}

/* System log entries */
.log-entry{display:flex;gap:.5rem;padding:.25rem .4rem;border-bottom:1px solid var(--border);font-family:var(--mono);white-space:nowrap}
.log-entry:hover{background:rgba(88,166,255,.04)}
.log-entry .log-ts{color:var(--text-dim);flex-shrink:0;width:72px}
.log-entry .log-level{flex-shrink:0;width:48px;font-weight:600;text-transform:uppercase}
.log-entry .log-level.l-debug{color:var(--text-dim)}
.log-entry .log-level.l-info{color:var(--blue)}
.log-entry .log-level.l-warn{color:var(--yellow)}
.log-entry .log-level.l-error{color:var(--red)}
.log-entry .log-msg{flex:2;overflow:hidden;text-overflow:ellipsis;color:var(--text);min-width:0}
.log-entry .log-src{color:var(--text-dim);flex-shrink:0;width:72px;overflow:hidden;text-overflow:ellipsis;font-size:.7rem;opacity:.7}
.log-entry .log-meta{color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0}
.log-entry.copied{background:rgba(63,185,80,.1);transition:background .3s}

/* Score breakdown bars */
.score-row{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;font-size:.75rem}
.score-row .sr-query{width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--blue);flex-shrink:0}
.score-row .sr-bar-wrap{flex:1;display:flex;flex-direction:column;gap:.2rem}
.score-row .sr-bar{display:flex;height:14px;border-radius:3px;overflow:hidden}
.score-row .sr-seg{height:100%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:600;color:#fff;min-width:0}
.sr-seg.lex{background:var(--blue)}
.sr-seg.sem{background:var(--green)}
.score-row .sr-path{font-size:.65rem;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Benchmark gauge */
.bench-gauge{text-align:center;padding:.5rem}
.bench-gauge .bg-label{font-size:.65rem;text-transform:uppercase;color:var(--text-dim);letter-spacing:.05em}
.bench-gauge .bg-value{font-size:1.4rem;font-weight:700;font-family:var(--mono)}
.bg-good{color:var(--green)}
.bg-mid{color:var(--yellow)}
.bg-low{color:var(--red)}
.bg-na{color:var(--text-dim)}

/* Toast */
.toast-container{position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem}
.toast{
  padding:.6rem 1rem;border-radius:8px;font-size:.8rem;font-weight:500;
  background:var(--card);border:1px solid var(--border);color:var(--text);
  box-shadow:0 4px 16px rgba(0,0,0,.4);animation:toastIn .2s ease-out;
  max-width:320px;
}
.toast.success{border-color:var(--green);color:var(--green)}
.toast.error{border-color:var(--red);color:var(--red)}
@keyframes toastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

/* Intelligence tab — theme cluster cards */
.theme-card{
  padding:.6rem .8rem;border-radius:6px;margin-bottom:.5rem;
  background:rgba(88,166,255,.03);border:1px solid var(--border);
  transition:border-color .2s;
}
.theme-card:hover{border-color:var(--blue)}
.theme-card .theme-name{font-weight:600;font-size:.82rem;color:var(--blue);margin-bottom:.2rem}
.theme-card .theme-meta{display:flex;gap:.75rem;font-size:.7rem;color:var(--text-dim);flex-wrap:wrap}
.theme-card .theme-tags{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.3rem}
.theme-card .theme-tag{
  display:inline-block;padding:.1rem .4rem;border-radius:8px;font-size:.65rem;
  background:rgba(88,166,255,.1);color:var(--blue);font-family:var(--mono);
}

/* AI recommendation cards */
.rec-card{
  padding:.5rem .75rem;border-radius:6px;margin-bottom:.4rem;
  border:1px solid var(--border);transition:all .2s;
  display:flex;gap:.5rem;align-items:flex-start;
}
.rec-card:hover{border-color:var(--blue);background:rgba(88,166,255,.03)}
.rec-card.rec-connection{border-left:3px solid var(--green)}
.rec-card.rec-consolidation{border-left:3px solid var(--yellow)}
.rec-card .rec-body{flex:1;min-width:0}
.rec-card .rec-type{font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:.15rem}
.rec-card .rec-type.type-connection{color:var(--green)}
.rec-card .rec-type.type-consolidation{color:var(--yellow)}
.rec-card .rec-text{font-size:.78rem;color:var(--text);line-height:1.4}
.rec-card .rec-confidence{font-size:.65rem;color:var(--text-dim);font-family:var(--mono)}
.rec-card .rec-actions{display:flex;gap:.3rem;flex-shrink:0}

/* Orphan action badges */
.action-badge{
  display:inline-block;padding:.15rem .5rem;border-radius:8px;
  font-size:.65rem;font-weight:600;font-family:var(--mono);
}
.action-link{background:rgba(88,166,255,.15);color:var(--blue)}
.action-consolidate{background:rgba(210,153,34,.15);color:var(--yellow)}
.action-archive{background:rgba(248,81,73,.15);color:var(--red)}
.action-review{background:rgba(188,140,255,.15);color:#bc8cff}

/* Health factor bars */
.health-factor{display:flex;align-items:center;gap:.4rem;margin-bottom:.25rem}
.health-factor .hf-label{width:80px;text-align:right;color:var(--text-dim);font-size:.65rem;flex-shrink:0}
.health-factor .hf-bar-wrap{flex:1;height:10px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden}
.health-factor .hf-bar{height:100%;border-radius:4px;transition:width .5s}

/* LLM suggestion items */
.llm-suggestion{padding:.35rem .5rem;border-radius:4px;margin-bottom:.3rem;background:rgba(63,185,80,.04);border:1px solid rgba(63,185,80,.15);font-size:.72rem}
.llm-suggestion .llm-group{color:var(--green);font-weight:600;font-size:.68rem;margin-bottom:.1rem}
.llm-suggestion .llm-text{color:var(--text);line-height:1.4}
.llm-suggestion .llm-ts{color:var(--text-dim);font-size:.6rem;font-family:var(--mono)}

/* Dream history mini-table */
.dh-row{display:flex;gap:.5rem;padding:.2rem 0;border-bottom:1px solid var(--border);font-size:.72rem;font-family:var(--mono)}
.dh-row:hover{background:rgba(88,166,255,.04)}
.dh-ts{color:var(--text-dim);width:80px;flex-shrink:0}
.dh-score{width:40px;text-align:center;font-weight:700;flex-shrink:0}
.dh-metrics{flex:1;color:var(--text-dim)}

/* Pulse animation for running dream */
@keyframes pulse{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}
.dream-running{animation:pulse 1.5s ease-in-out infinite}
</style>
</head>
<body>

<div class="shell">
<div class="header">
  <h1><span>Obsidian MCP</span> &mdash; Control Panel</h1>
  <div class="status-group">
    <div class="status-badge"><span class="status-dot"></span> Online</div>
    <span id="uptime">&mdash;</span>
    <span id="clock">&mdash;</span>
    <form method="POST" action="/logout" style="margin:0">
      <button type="submit" class="btn">Logout</button>
    </form>
  </div>
</div>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="overview">Overview</button>
  <button class="tab-btn" data-tab="sessions">Sessions</button>
  <button class="tab-btn" data-tab="ratelimits">Rate Limits</button>
  <button class="tab-btn" data-tab="vault">Vault &amp; Memory</button>
  <button class="tab-btn" data-tab="intelligence">Intelligence</button>
  <button class="tab-btn" data-tab="agents">Agents</button>
  <button class="tab-btn" data-tab="code">Code</button>
  <button class="tab-btn" data-tab="logs">Logs</button>
</div>

<div class="content">

<!-- ====== TAB 1: Overview ====== -->
<div id="tab-overview" class="tab-panel active">
  <div class="row row-4">
    <div class="card">
      <div class="card-label">MCP Requests</div>
      <div class="card-value" id="mcpRequests">0</div>
      <div class="card-sub"><span id="rpm">0</span> req/min</div>
      <div class="card-sub" id="requestBreakdown" style="margin-top:.25rem;font-size:.65rem;color:var(--text-dim)"></div>
    </div>
    <div class="card">
      <div class="card-label">Active Sessions</div>
      <div class="card-value" id="activeSessions">0</div>
    </div>
    <div class="card">
      <div class="card-label">Indexed Notes</div>
      <div class="card-value" id="indexedNotes">0</div>
    </div>
    <div class="card">
      <div class="card-label">Error Responses</div>
      <div class="card-value" id="errorRate">0</div>
      <div class="card-sub" id="errorPct" style="font-size:.75rem"></div>
    </div>
  </div>

  <div class="row row-4">
    <div class="card">
      <div class="card-label">Log: Errors</div>
      <div class="card-value" id="logErrorCount" style="color:var(--red)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Log: Warnings</div>
      <div class="card-value" id="logWarnCount" style="color:var(--yellow)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Log: Info</div>
      <div class="card-value" id="logInfoCount" style="color:var(--blue)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Embedding Status</div>
      <div class="card-value" id="ovEmbStatus" style="font-size:1.1rem">&mdash;</div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Requests / min</div>
      <div class="chart-wrap"><svg id="chartRpm" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="card">
      <div class="section-title">Avg Latency (ms)</div>
      <div class="chart-wrap"><svg id="chartLatency" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-title">Tool Usage</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-col="name">Tool <span class="sort-arrow"></span></th>
              <th data-col="count">Calls <span class="sort-arrow"></span></th>
              <th data-col="avg">Avg Latency <span class="sort-arrow"></span></th>
              <th data-col="p95">P95 Latency <span class="sort-arrow"></span></th>
              <th data-col="max">Max Latency <span class="sort-arrow"></span></th>
              <th data-col="errors">Errors <span class="sort-arrow"></span></th>
              <th data-col="last">Last Called <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody id="toolTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ====== TAB 2: Sessions ====== -->
<div id="tab-sessions" class="tab-panel">
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Active Sessions</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session ID</th>
              <th>IP</th>
              <th>Client</th>
              <th>Created</th>
              <th>Last Activity</th>
              <th>Requests</th>
              <th>Recent Tools</th>
              <th>Tool Breakdown</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sessionsTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ====== TAB 3: Rate Limits ====== -->
<div id="tab-ratelimits" class="tab-panel">
  <div class="row row-1">
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
        <div class="section-title" style="margin-bottom:0">Rate Limits</div>
        <button class="btn btn-danger" onclick="postAction('/dashboard/api/rate-limit/reset-all',{})">Reset All</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>IP Address</th>
              <th>Request Count</th>
              <th>Remaining</th>
              <th>Reset At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="rateLimitTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ====== TAB 4: Vault & Memory ====== -->
<div id="tab-vault" class="tab-panel">
  <div class="row row-1">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <div class="section-title" style="margin-bottom:0">Read-only Vaults</div>
        <button class="btn" onclick="loadSourceVaults()">Refresh</button>
      </div>
      <div class="card-sub" style="margin-bottom:.75rem">
        Additional source folders indexed read-only. Env-managed entries (SOURCE_VAULTS) are immutable; persisted entries can be removed here. Adding or removing a vault triggers a background reindex.
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
              <th>Include Globs</th>
              <th>Source</th>
              <th>Indexed</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sourceVaultsBody"><tr><td colspan="7" class="empty-msg">Loading...</td></tr></tbody>
        </table>
      </div>

      <div style="margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem">
        <div class="section-title" style="font-size:.85rem">Add a read-only vault</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem">
          <div>
            <label class="card-label" for="svPath">Folder path *</label>
            <input id="svPath" type="text" placeholder="/abs/path/to/vault" autocomplete="off"
              style="width:100%;box-sizing:border-box;padding:.4rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:.78rem">
          </div>
          <div>
            <label class="card-label" for="svName">Name (optional)</label>
            <input id="svName" type="text" placeholder="defaults to folder name" autocomplete="off"
              style="width:100%;box-sizing:border-box;padding:.4rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:.78rem">
          </div>
        </div>
        <div style="margin-top:.5rem">
          <label class="card-label" for="svGlobs">Include globs (optional, comma or newline separated)</label>
          <textarea id="svGlobs" rows="2" placeholder="**/*.md, notes/**"
            style="width:100%;box-sizing:border-box;padding:.4rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:.78rem;resize:vertical"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.6rem">
          <button class="btn btn-primary" id="svAddBtn" onclick="addSourceVault()">Add vault</button>
          <span id="svFeedback" style="font-size:.78rem"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="row row-3">
    <div class="card">
      <div class="section-title">Vault Index</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <span>Indexed notes: <strong class="mono" id="vaultNotes">0</strong></span>
        <button class="btn btn-primary" onclick="postAction('/dashboard/api/index/rebuild',{})">Rebuild Now</button>
      </div>
      <div class="card-sub" id="vaultRebuild">&mdash;</div>
      <div id="indexHealthInfo" style="margin-top:.5rem;font-size:.75rem"></div>
    </div>
    <div class="card">
      <div class="section-title">Memory Temperature</div>
      <div style="display:flex;gap:1rem;margin-bottom:.5rem">
        <span class="badge badge-hot" id="memHot">Hot: 0</span>
        <span class="badge badge-warm" id="memWarm">Warm: 0</span>
        <span class="badge badge-cold" id="memCold">Cold: 0</span>
      </div>
      <div class="stacked-bar" id="memBar"></div>
    </div>
    <div class="card">
      <div class="section-title">Semantic Search</div>
      <div style="display:flex;gap:1rem;align-items:center;margin-bottom:.5rem">
        <span class="badge" id="embeddingBadge" style="background:rgba(88,166,255,.15);color:var(--blue)">Loading...</span>
      </div>
      <div class="card-sub">Model: <span class="mono" id="embModel">&mdash;</span></div>
      <div class="card-sub">Vectors: <span class="mono" id="embVectors">0</span></div>
      <div class="card-sub">Avg embed: <span class="mono" id="embAvgTime">&mdash;</span></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <div class="section-title" style="margin-bottom:0">Vault Migration</div>
        <div style="display:flex;gap:.5rem">
          <button class="btn" onclick="runMigrationAction(true)">Dry Run</button>
          <button class="btn btn-primary" id="btnMigrateRun" onclick="runMigrationAction(false)">Migrate Now</button>
        </div>
      </div>
      <div class="card-sub" style="margin-bottom:.5rem">Move memories to year/month subfolders, split journal into daily files, split diaries into per-day files, merge insight/insights.</div>
      <div id="migrationResult" style="font-size:.78rem;max-height:200px;overflow-y:auto"></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Memory Stack (L0 + L1)</div>
      <div id="memoryStackL0" style="margin-bottom:.75rem">
        <div class="card-label">L0 &mdash; Identity</div>
        <div id="msIdentity" style="font-size:.8rem;color:var(--text);padding:.4rem .6rem;background:rgba(88,166,255,.05);border-radius:6px;border:1px solid var(--border);margin-top:.25rem;white-space:pre-wrap"><span class="empty-msg">Loading identity...</span></div>
      </div>
      <div id="memoryStackL1">
        <div class="card-label">L1 &mdash; Essential Narrative</div>
        <div id="msNarrative" style="font-size:.75rem;color:var(--text);padding:.4rem .6rem;background:rgba(63,185,80,.05);border-radius:6px;border:1px solid var(--border);margin-top:.25rem;max-height:280px;overflow-y:auto;white-space:pre-wrap"><span class="empty-msg">Loading narrative...</span></div>
      </div>
      <div style="margin-top:.5rem;font-size:.65rem;color:var(--text-dim)">
        Total tokens: <span class="mono" id="msTokenCount">0</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Search Quality Benchmarks</div>
      <!-- TODO: wire to benchmark results after Phase 10 integration -->
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div>
          <div class="card-label">Recall@5</div>
          <div class="card-value mono" id="sqbRecall5" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">NDCG@10</div>
          <div class="card-value mono" id="sqbNdcg10" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">Avg Latency</div>
          <div class="card-value mono" id="sqbAvgLat" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">Last Run</div>
          <div class="card-value mono" id="sqbLastRun" style="font-size:.9rem;color:var(--text-dim)">&mdash;</div>
        </div>
      </div>
      <div style="margin-top:.75rem;font-size:.72rem;color:var(--text-dim)">
        Run a benchmark from the Retrieval Quality section below, or via the API, to populate these metrics.
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Temperature Over Time</div>
      <div class="chart-wrap" style="height:160px">
        <svg id="chartTempHistory" viewBox="0 0 600 160" preserveAspectRatio="none"></svg>
      </div>
      <div style="display:flex;gap:1rem;margin-top:.5rem;font-size:.7rem">
        <span style="color:var(--red)">&#9632; Hot</span>
        <span style="color:var(--yellow)">&#9632; Warm</span>
        <span style="color:var(--blue)">&#9632; Cold</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Heat Score Distribution</div>
      <div id="heatHistogram" style="display:flex;gap:8px;align-items:flex-end;height:120px;padding-top:8px"></div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:.4rem;font-size:.65rem;color:var(--text-dim)">
        <span style="flex:1;text-align:center">0–3</span>
        <span style="flex:1;text-align:center">4–7</span>
        <span style="flex:1;text-align:center">8–11</span>
        <span style="flex:1;text-align:center">12+</span>
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Top 10 Hottest Notes</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Title</th><th>Score</th><th>Temp</th><th>Category</th><th>Last Accessed</th>
          </tr></thead>
          <tbody id="topNotesBody"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Memory Categories</div>
      <div id="categoryBars"></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Search Quality</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Searches</div><div class="card-value mono" id="sqTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Results</div><div class="card-value mono" id="sqAvgResults" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Latency</div><div class="card-value mono" id="sqAvgLatency" style="font-size:1.3rem">&mdash;</div></div>
        <div><div class="card-label">Zero-Result Rate</div><div class="card-value mono" id="sqZeroRate" style="font-size:1.3rem">0%</div></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Recent Searches</div>
      <div class="feed" id="recentSearchesFeed" style="max-height:200px"><div class="empty-msg">No searches recorded.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Vault Health</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Indexed Files</div><div class="card-value mono" id="vhTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Archived Notes</div><div class="card-value mono" id="vhArchived" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Stale Notes (60d+)</div><div class="card-value mono" id="vhStale" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">File Types</div><div id="vhFileTypes" style="font-size:.75rem;color:var(--text-dim);font-family:var(--mono)">&mdash;</div></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Link Density</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Wiki-Links</div><div class="card-value mono" id="ldTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Links / Note</div><div class="card-value mono" id="ldAvg" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Orphan Notes</div><div class="card-value mono" id="ldOrphans" style="font-size:1.3rem;color:var(--yellow)">0</div></div>
        <div><div class="card-label">Most Linked</div><div id="ldMostLinked" style="font-size:.72rem;color:var(--text-dim);font-family:var(--mono);max-height:80px;overflow-y:auto">&mdash;</div></div>
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Search Analytics</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem">
        <div><div class="card-label">Lexical-Only Hits</div><div class="card-value mono" id="saLexOnly" style="font-size:1.2rem;color:var(--blue)">0</div></div>
        <div><div class="card-label">Semantic-Only Hits</div><div class="card-value mono" id="saSemOnly" style="font-size:1.2rem;color:var(--green)">0</div></div>
        <div><div class="card-label">Both (Hybrid)</div><div class="card-value mono" id="saBoth" style="font-size:1.2rem;color:var(--yellow)">0</div></div>
      </div>
      <div class="card-label">Average Score Contribution</div>
      <div class="stacked-bar" id="saContribBar" style="margin-top:.35rem"></div>
      <div style="display:flex;gap:1rem;margin-top:.35rem;font-size:.65rem">
        <span style="color:var(--blue)">&#9632; Lexical</span>
        <span style="color:var(--green)">&#9632; Semantic</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Memory Lifecycle</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:.75rem">
        <div><div class="card-label">Total Archived</div><div class="card-value mono" id="mlArchived" style="font-size:1.2rem">0</div></div>
        <div><div class="card-label">Total Consolidated</div><div class="card-value mono" id="mlConsolidated" style="font-size:1.2rem">0</div></div>
      </div>
      <div class="card-label">Temperature Distribution (all notes)</div>
      <div class="stacked-bar" id="mlTempBar" style="margin-top:.35rem"></div>
      <div style="display:flex;gap:1rem;margin-top:.35rem;font-size:.65rem">
        <span style="color:var(--red)">&#9632; Hot</span>
        <span style="color:var(--yellow)">&#9632; Warm</span>
        <span style="color:var(--blue)">&#9632; Cold</span>
        <span style="color:var(--text-dim)">&#9632; Unset</span>
      </div>
      <div id="mlRecentOps" style="margin-top:.75rem;max-height:120px;overflow-y:auto;font-size:.72rem"><div class="empty-msg">No recent lifecycle events.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Recent Memory Operations</div>
      <div class="feed" id="memoryOpsFeed" style="max-height:260px"><div class="empty-msg">No memory operations recorded.</div></div>
    </div>
    <div class="card">
      <div class="section-title">Recent Notes Accessed</div>
      <div class="feed" id="notesAccessFeed" style="max-height:260px"><div class="empty-msg">No notes accessed yet.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Collections</div>
      <div id="collectionBars"><div class="empty-msg">No collection data.</div></div>
    </div>
    <div class="card">
      <div class="section-title">Score Breakdown (Recent Searches)</div>
      <div id="scoreBreakdowns" style="max-height:260px;overflow-y:auto"><div class="empty-msg">No searches with score data.</div></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <div class="section-title" style="margin-bottom:0">Retrieval Quality Benchmark</div>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-primary" onclick="postAction('/dashboard/api/benchmark/run',{})">Run Benchmark</button>
          <button class="btn" id="btnSaveGroundTruth" onclick="postAction('/dashboard/api/benchmark/save-ground-truth',{})" style="display:none">Save as Ground Truth</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem;margin-bottom:.75rem" id="benchmarkGauges"></div>
      <div class="card-sub" id="benchmarkTimestamp">No benchmark run yet</div>
      <div class="table-wrap" style="margin-top:.75rem">
        <table>
          <thead><tr><th>Query</th><th>Results</th><th>P@5</th><th>P@10</th><th>NDCG@10</th><th>Latency</th><th>Top Retrieved</th></tr></thead>
          <tbody id="benchmarkTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ====== TAB 5: Intelligence ====== -->
<div id="tab-intelligence" class="tab-panel">

  <!-- Row 1: Health Score + Dream Narrative + LLM Status -->
  <div class="row row-3">
    <div class="card" style="text-align:center">
      <div class="card-label">Vault Health Score</div>
      <div id="healthGauge" style="position:relative;width:120px;height:120px;margin:.5rem auto">
        <svg viewBox="0 0 120 120" style="width:100%;height:100%">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="8"/>
          <circle id="healthArc" cx="60" cy="60" r="50" fill="none" stroke="var(--green)" stroke-width="8"
            stroke-dasharray="314" stroke-dashoffset="314" stroke-linecap="round"
            transform="rotate(-90 60 60)" style="transition:stroke-dashoffset .8s ease,stroke .3s"/>
        </svg>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
          <div id="healthScoreValue" class="mono" style="font-size:1.8rem;font-weight:700;color:var(--green)">--</div>
          <div id="healthGradeValue" style="font-size:.7rem;color:var(--text-dim)">--</div>
        </div>
      </div>
      <div id="healthFactors" style="text-align:left;font-size:.7rem;margin-top:.5rem"></div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <div class="section-title" style="margin-bottom:0">Dream Insights</div>
        <div style="display:flex;gap:.4rem;align-items:center">
          <span id="dreamStatus" style="font-size:.7rem;color:var(--text-dim)">No dream run yet</span>
          <button class="btn btn-primary" id="btnDreamRun" onclick="runDreamCycle(false)">Run Dream</button>
          <button class="btn" id="btnDreamLlm" onclick="runDreamCycle(true)" style="border-color:var(--green);color:var(--green)">LLM Dream</button>
        </div>
      </div>
      <div id="dreamNarrative" style="font-size:.8rem;color:var(--text);padding:.6rem .8rem;background:rgba(88,166,255,.04);border-radius:6px;border:1px solid var(--border);min-height:60px;line-height:1.6;white-space:pre-wrap">
        <span class="empty-msg">Run a dream cycle to analyze your vault and discover themes, orphans, and connection opportunities.</span>
      </div>
      <div id="dreamActivity" style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-top:.5rem">
      </div>
    </div>
    <div class="card">
      <div class="section-title">Local LLM</div>
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">
        <span id="llmDot" style="width:10px;height:10px;border-radius:50%;background:var(--text-dim);flex-shrink:0"></span>
        <span id="llmStatusText" style="font-size:.8rem">Checking...</span>
      </div>
      <div class="card-sub">Model: <span class="mono" id="llmModel">&mdash;</span></div>
      <div class="card-sub" id="llmUrl" style="font-size:.65rem;color:var(--text-dim);word-break:break-all"></div>
      <div class="card-sub" id="llmError" style="color:var(--red);display:none;font-size:.72rem;margin-top:.25rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Recent LLM Suggestions</div>
        <div id="llmSuggestions" style="margin-top:.25rem;max-height:140px;overflow-y:auto;font-size:.75rem">
          <span class="empty-msg">No LLM suggestions yet. Run a dream cycle with LLM consolidation enabled.</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Row 2: Theme Clusters + Actionable Recommendations -->
  <div class="row row-2">
    <div class="card">
      <div class="section-title">Theme Clusters</div>
      <div id="themeClusters" style="max-height:320px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to detect recurring themes across your memories.</span>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <div class="section-title" style="margin-bottom:0">AI Recommendations</div>
        <span id="recsCount" style="font-size:.7rem;color:var(--text-dim)"></span>
      </div>
      <div id="aiRecommendations" style="max-height:320px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to generate connection suggestions and consolidation opportunities.</span>
      </div>
    </div>
  </div>

  <!-- Row 3: Orphan Memories -->
  <div class="row row-1">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <div class="section-title" style="margin-bottom:0">Orphan Memories</div>
        <div style="display:flex;gap:.75rem;font-size:.7rem" id="orphanSummary"></div>
      </div>
      <div class="table-wrap" style="max-height:240px;overflow-y:auto">
        <table>
          <thead><tr>
            <th>Title</th><th>Temp</th><th>Heat</th><th>Last Access</th><th>Suggested Action</th>
          </tr></thead>
          <tbody id="orphanTableBody">
            <tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Row 4: Entity Intelligence + Knowledge Graph -->
  <div class="row row-2">
    <div class="card">
      <div class="section-title">Entity Intelligence</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem">
        <div>
          <div class="card-label">Total Entities</div>
          <div class="card-value mono" id="eiTotal" style="font-size:1.3rem">0</div>
        </div>
        <div>
          <div class="card-label">Confirmed</div>
          <div class="card-value mono" id="eiConfirmed" style="font-size:1.3rem;color:var(--green)">0</div>
        </div>
        <div>
          <div class="card-label">Detected</div>
          <div class="card-value mono" id="eiDetected" style="font-size:1.3rem;color:var(--yellow)">0</div>
        </div>
      </div>
      <div class="card-label">Detection Quality</div>
      <div class="stacked-bar" id="entityTierBar" style="margin-top:.35rem;margin-bottom:.5rem"></div>
      <div style="display:flex;gap:1rem;margin-bottom:.75rem;font-size:.65rem">
        <span style="color:var(--green)">&#9632; Confirmed</span>
        <span style="color:var(--yellow)">&#9632; Detected</span>
        <span style="color:var(--text-dim)">&#9632; Suggested</span>
      </div>
      <div class="card-label">Type Breakdown</div>
      <div id="entityTypeBars" style="margin-top:.35rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Entity Registry</div>
        <div class="table-wrap" style="max-height:200px;overflow-y:auto">
          <table>
            <thead><tr><th>Entity</th><th>Type</th><th>Confidence</th><th>Status</th></tr></thead>
            <tbody id="entityRegistryBody">
              <tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <div class="section-title" style="margin-bottom:0">Knowledge Graph</div>
        <button class="btn btn-primary" id="btnKgBootstrap" onclick="postAction('/dashboard/api/kg/bootstrap',{})">Bootstrap KG</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div>
          <div class="card-label">Entities</div>
          <div class="card-value mono" id="kgEntities" style="font-size:1.3rem;color:var(--text-dim)">0</div>
        </div>
        <div>
          <div class="card-label">Triples</div>
          <div class="card-value mono" id="kgTriples" style="font-size:1.3rem;color:var(--text-dim)">0</div>
        </div>
      </div>
      <div style="margin-top:.75rem">
        <div class="card-label">Top Predicates</div>
        <div id="kgPredicates" style="margin-top:.25rem;font-size:.78rem"><span class="empty-msg">Knowledge graph empty — click Bootstrap KG to populate from vault notes.</span></div>
      </div>
    </div>
  </div>

  <!-- Row 5: Dream History + Agent Awareness -->
  <div class="row row-2">
    <div class="card">
      <div class="section-title">Dream History</div>
      <div class="chart-wrap" style="height:120px">
        <svg id="chartDreamHealth" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
      </div>
      <div style="display:flex;gap:1rem;margin-top:.3rem;font-size:.65rem">
        <span style="color:var(--green)">&#9632; Health Score</span>
        <span style="color:var(--yellow)">&#9632; Themes</span>
        <span style="color:var(--red)">&#9632; Orphans</span>
      </div>
      <div id="dreamHistoryTable" style="margin-top:.5rem;max-height:160px;overflow-y:auto;font-size:.75rem">
        <span class="empty-msg">No dream cycles recorded yet.</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Agent Awareness</div>
      <div class="card-sub" style="margin-bottom:.5rem;font-style:italic;color:var(--text-dim)">What the AI has been thinking about</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Agent</th><th>Last Active</th><th>Entries</th></tr></thead>
          <tbody id="agentDiariesBody">
            <tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>
          </tbody>
        </table>
      </div>
      <div id="agentRecentActivity" style="margin-top:.75rem;max-height:160px;overflow-y:auto;font-size:.75rem">
      </div>
    </div>
  </div>

</div>

<!-- ====== TAB: Agents ====== -->
<div id="tab-agents" class="tab-panel">
  <div class="row row-3">
    <div class="card"><div class="card-label">Agents</div><div class="card-value mono" id="agCountAgents">0</div></div>
    <div class="card"><div class="card-label">Teams</div><div class="card-value mono" id="agCountTeams">0</div></div>
    <div class="card"><div class="card-label">Skills</div><div class="card-value mono" id="agCountSkills">0</div></div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Agents</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Role</th><th>Model</th><th>Tags</th><th>Path</th></tr></thead>
        <tbody id="agentsTableBody"><tr><td colspan="6" class="empty-msg" style="text-align:center">Loading...</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Teams</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Coordination</th><th>Members</th><th>Path</th></tr></thead>
        <tbody id="teamsTableBody"><tr><td colspan="5" class="empty-msg" style="text-align:center">Loading...</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Skills</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Trigger</th><th>Description</th><th>Tags</th><th>Path</th></tr></thead>
        <tbody id="skillsTableBody"><tr><td colspan="6" class="empty-msg" style="text-align:center">Loading...</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;gap:.75rem;flex-wrap:wrap">
        <div class="section-title" style="margin-bottom:0">Agent Diary</div>
        <div style="display:flex;gap:.5rem;align-items:center">
          <select id="diaryAgentSelect" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.25rem .5rem;font-size:.8rem">
            <option value="">Select agent...</option>
          </select>
          <select id="diaryLimitSelect" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.25rem .5rem;font-size:.8rem">
            <option value="20">Last 20</option>
            <option value="50">Last 50</option>
            <option value="200">Last 200</option>
          </select>
        </div>
      </div>
      <div id="diaryBody" style="max-height:380px;overflow-y:auto;font-size:.78rem">
        <span class="empty-msg">Select an agent to view recent diary entries.</span>
      </div>
    </div>
  </div>
</div>

<!-- ====== TAB 6.5: Code ====== -->
<div id="tab-code" class="tab-panel">
  <div class="row row-4">
    <div class="card">
      <div class="card-label">Repos</div>
      <div class="card-value" id="codeRepoCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">Symbols</div>
      <div class="card-value" id="codeSymbolCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">Files</div>
      <div class="card-value" id="codeFileCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">DB Size</div>
      <div class="card-value" id="codeDbSize">0</div>
      <div class="card-sub" id="codeCallStats">0 / 0 calls resolved</div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Per-Repo Stats</div>
      <table class="data-table">
        <thead>
          <tr><th>Slug</th><th>Symbols</th><th>Files</th><th>Last Indexed</th></tr>
        </thead>
        <tbody id="codeRepoTable"></tbody>
      </table>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Token Savings (vs Read/Grep baseline)</div>
      <div style="margin-bottom:.6rem;font-size:.82rem" id="codeSavingsSummary">No code-nav tool calls recorded yet.</div>
      <table class="data-table">
        <thead>
          <tr><th>Tool</th><th>Calls</th><th>Tokens Saved</th><th>Avg / Call</th></tr>
        </thead>
        <tbody id="codeSavingsTable"></tbody>
      </table>
      <div style="margin-top:1rem;font-size:.78rem;font-weight:600;color:var(--text-dim)">By Repo</div>
      <table class="data-table" style="margin-top:.4rem">
        <thead>
          <tr><th>Repo</th><th>Calls</th><th>Tokens Saved</th><th>Avg / Call</th></tr>
        </thead>
        <tbody id="codeSavingsRepoTable"></tbody>
      </table>
      <div style="margin-top:.7rem;font-size:.72rem;color:var(--text-dim)" id="codeSavingsChart"></div>
    </div>
  </div>
</div>

<!-- ====== TAB 7: Logs ====== -->
<div id="tab-logs" class="tab-panel">
  <div class="row row-1">
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <div class="section-title" style="margin-bottom:0">System Logs</div>
        <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
          <select id="logFilterSource" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.2rem .4rem;font-size:.75rem">
            <option value="all">All modules</option>
            <option value="embeddings">embeddings</option>
            <option value="search">search</option>
            <option value="vault">vault</option>
            <option value="auth">auth</option>
            <option value="sessions">sessions</option>
            <option value="metrics">metrics</option>
            <option value="server">server</option>
            <option value="general">general</option>
          </select>
          <input id="logFilterText" type="text" placeholder="Filter text..." style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.2rem .4rem;font-size:.75rem;width:140px">
          <div style="display:flex;gap:.4rem;align-items:center">
            <label style="font-size:.72rem;color:var(--text-dim)"><input type="checkbox" id="logFilterDebug" style="margin-right:.2rem"> dbg</label>
            <label style="font-size:.72rem;color:var(--text)"><input type="checkbox" id="logFilterInfo" checked style="margin-right:.2rem"> info</label>
            <label style="font-size:.72rem;color:var(--yellow)"><input type="checkbox" id="logFilterWarn" checked style="margin-right:.2rem"> warn</label>
            <label style="font-size:.72rem;color:var(--red)"><input type="checkbox" id="logFilterError" checked style="margin-right:.2rem"> err</label>
          </div>
        </div>
      </div>
      <div class="feed" id="systemLogsFeed" style="max-height:500px;font-size:.75rem"><div class="empty-msg">No logs captured.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Recent Tool Calls</div>
      <div class="feed" id="logToolCalls"><div class="empty-msg">No tool calls recorded.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title" style="color:var(--red)">Recent Errors</div>
      <div id="logErrors"><div class="empty-msg">No errors recorded.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title" style="color:var(--yellow)">Auth Failures</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>IP Address</th>
              <th>Method</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody id="authFailuresTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

</div><!-- .content -->
</div><!-- .shell -->

<div class="toast-container" id="toastContainer"></div>

<script>
(function(){
  /* ── State ── */
  var data = {};
  var activeTab = 'overview';
  var sortCol = 'last';
  var sortDir = -1;
  var agentsLoaded = false;
  var agentsData = { agents: [], teams: [], skills: [] };

  /* ── Helpers ── */
  function fmt(n){ return n == null ? '\\u2014' : Number(n).toLocaleString(); }
  function fmtMs(ms){ return ms == null ? '\\u2014' : ms + ' ms'; }
  function fmtUptime(ms){
    var s = Math.floor(ms/1000);
    var d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
    var p = []; if(d) p.push(d+'d'); p.push(h+'h'); p.push(m+'m'); return p.join(' ');
  }
  function fmtTime(ts){
    if(!ts) return '\\u2014';
    return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function fmtAgo(ts){
    if(!ts) return '\\u2014';
    var timestamp = typeof ts === 'string' ? new Date(ts).getTime() : ts;
    if(isNaN(timestamp)) return '\\u2014';
    var diff = Date.now() - timestamp;
    if(diff < 0) return 'just now';
    if(diff < 60000) return Math.floor(diff/1000)+'s ago';
    if(diff < 3600000) return Math.floor(diff/60000)+'m ago';
    if(diff < 86400000) return Math.floor(diff/3600000)+'h ago';
    return Math.floor(diff/86400000)+'d ago';
  }
  function fmtDate(ts){
    if(!ts) return '\\u2014';
    return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function latClass(ms){
    if(ms < 100) return 'lat-green';
    if(ms < 500) return 'lat-yellow';
    return 'lat-red';
  }
  function esc(s){
    var d = document.createElement('span');
    d.textContent = s || '';
    return d.innerHTML;
  }
  function escAttr(s){
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function truncate(s, n){
    if(!s) return '\\u2014';
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }

  /* ── Toast ── */
  function showToast(msg, type){
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(function(){ el.remove(); }, 3000);
  }

  /* ── Migration helper ── */
  window.runMigrationAction = function(dryRun){
    var url = dryRun ? '/dashboard/api/migrate/dry-run' : '/dashboard/api/migrate/run';
    var resultEl = document.getElementById('migrationResult');
    if(!dryRun && !confirm('This will move files in the vault. Originals are backed up as .migrated.md. Proceed?')) return;
    resultEl.innerHTML = '<span style="color:var(--text-dim)">Running ' + (dryRun ? 'dry run' : 'migration') + '...</span>';
    fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d.ok && d.error){ resultEl.innerHTML = '<span style="color:var(--red)">' + d.error + '</span>'; return; }
        var prefix = d.dryRun ? '<strong style="color:var(--blue)">[DRY RUN]</strong> ' : '<strong style="color:var(--green)">[DONE]</strong> ';
        var lines = [
          prefix + 'Migration ' + d.status,
          'Memories moved: <strong>' + d.memoriesMoved + '</strong>',
          'Insights merged: <strong>' + d.insightsMerged + '</strong>',
          'Journal entries split: <strong>' + d.journalEntriesSplit + '</strong>',
          'Diary files split: <strong>' + d.diaryFilesSplit + '</strong>',
        ];
        if(d.errors && d.errors.length > 0){
          lines.push('<span style="color:var(--red)">Errors (' + d.errors.length + '):</span>');
          d.errors.forEach(function(e){ lines.push('&nbsp;&nbsp;' + e); });
        }
        resultEl.innerHTML = lines.join('<br>');
        if(!d.dryRun && d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit > 0){
          showToast('Migration complete: ' + (d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit) + ' items moved', 'success');
        }
      })
      .catch(function(e){ resultEl.innerHTML = '<span style="color:var(--red)">Request failed: ' + e.message + '</span>'; });
  };

  /* ── Admin API helper ── */
  window.postAction = function(url, body){
    fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.ok) showToast('Action completed', 'success');
      else showToast(d.error || 'Unknown error', 'error');
    })
    .catch(function(e){ showToast('Request failed: ' + e.message, 'error'); });
  };

  window.copyLogLine = function(el){
    var text = el.getAttribute('data-full') || el.textContent;
    navigator.clipboard.writeText(text).then(function(){
      el.classList.add('copied');
      showToast('Copied to clipboard', 'success');
      setTimeout(function(){ el.classList.remove('copied'); }, 1000);
    }).catch(function(){ showToast('Copy failed', 'error'); });
  };

  window.killSessionAction = function(sid){
    if(!confirm('Kill session ' + sid.slice(0,8) + '...?')) return;
    postAction('/dashboard/api/sessions/kill', {sessionId: sid});
  };

  window.resetRateLimitAction = function(key){
    postAction('/dashboard/api/rate-limit/reset', {key: key});
  };

  /* ── Read-only source vaults (Component C) ── */
  window.loadSourceVaults = function(){
    var body = document.getElementById('sourceVaultsBody');
    if(!body) return;
    fetch('/api/source-vaults', { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var vaults = (d && d.vaults) || [];
        if(!vaults.length){
          body.innerHTML = '<tr><td colspan="7" class="empty-msg">No read-only vaults configured.</td></tr>';
          return;
        }
        body.innerHTML = vaults.map(function(v){
          var globs = (v.includeGlobs && v.includeGlobs.length)
            ? esc(v.includeGlobs.join(', '))
            : '<span style="color:var(--text-dim)">all</span>';
          var badge = v.source === 'env'
            ? '<span class="badge" style="background:rgba(210,153,34,.15);color:var(--yellow)">env</span>'
            : '<span class="badge" style="background:rgba(63,185,80,.15);color:var(--green)">persisted</span>';
          var indexed = (v.indexedDocs != null) ? fmt(v.indexedDocs) : '\\u2014';
          var statusColor = v.status === 'ok' ? 'var(--green)'
            : (v.status === 'degraded' ? 'var(--red)' : 'var(--text-dim)');
          var action = v.source === 'env'
            ? '<span style="color:var(--text-dim);font-size:.7rem">immutable</span>'
            : '<button class="btn btn-danger" onclick="removeSourceVault(\\'' + escAttr(v.name) + '\\')">Remove</button>';
          return '<tr>'
            + '<td>' + esc(v.name) + '</td>'
            + '<td title="' + escAttr(v.path) + '">' + esc(v.path) + '</td>'
            + '<td>' + globs + '</td>'
            + '<td>' + badge + '</td>'
            + '<td>' + indexed + '</td>'
            + '<td style="color:' + statusColor + '">' + esc(v.status || '') + '</td>'
            + '<td>' + action + '</td>'
            + '</tr>';
        }).join('');
      })
      .catch(function(e){
        body.innerHTML = '<tr><td colspan="7" class="empty-msg">Failed to load: ' + esc(e.message) + '</td></tr>';
      });
  };

  window.addSourceVault = function(){
    var fb = document.getElementById('svFeedback');
    var btn = document.getElementById('svAddBtn');
    var path = (document.getElementById('svPath').value || '').trim();
    var name = (document.getElementById('svName').value || '').trim();
    var globsRaw = (document.getElementById('svGlobs').value || '');
    if(!path){
      fb.style.color = 'var(--red)';
      fb.textContent = 'Folder path is required.';
      return;
    }
    var includeGlobs = globsRaw.split(/[,\\n]/).map(function(g){ return g.trim(); }).filter(Boolean);
    var payload = { path: path };
    if(name) payload.name = name;
    if(includeGlobs.length) payload.includeGlobs = includeGlobs;
    btn.disabled = true;
    fb.style.color = 'var(--text-dim)';
    fb.textContent = 'Adding...';
    fetch('/api/source-vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){
        btn.disabled = false;
        if(res.ok){
          fb.style.color = 'var(--green)';
          fb.textContent = 'Added "' + (res.d.name || name || path) + '". Reindexing...';
          document.getElementById('svPath').value = '';
          document.getElementById('svName').value = '';
          document.getElementById('svGlobs').value = '';
          loadSourceVaults();
        } else {
          fb.style.color = 'var(--red)';
          fb.textContent = (res.d && res.d.error) || 'Failed to add vault.';
        }
      })
      .catch(function(e){
        btn.disabled = false;
        fb.style.color = 'var(--red)';
        fb.textContent = 'Request failed: ' + e.message;
      });
  };

  window.removeSourceVault = function(name){
    if(!confirm('Remove read-only vault "' + name + '"? It will be dropped from the index.')) return;
    var fb = document.getElementById('svFeedback');
    fetch('/api/source-vaults/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
    })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){
        if(res.ok){
          fb.style.color = 'var(--green)';
          fb.textContent = 'Removed "' + name + '". Reindexing...';
          loadSourceVaults();
        } else {
          fb.style.color = 'var(--red)';
          fb.textContent = (res.d && res.d.error) || 'Failed to remove vault.';
        }
      })
      .catch(function(e){
        fb.style.color = 'var(--red)';
        fb.textContent = 'Request failed: ' + e.message;
      });
  };

  /* ── Tab switching ── */
  function switchTab(tabId){
    activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(function(p){
      p.classList.toggle('active', p.id === 'tab-' + tabId);
    });
    if(tabId === 'vault') loadSourceVaults();
    renderCurrentTab();
  }
  document.querySelectorAll('.tab-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchTab(b.getAttribute('data-tab')); });
  });

  /* ── SVG Chart ── */
  function drawChart(svgId, points, color){
    var svg = document.getElementById(svgId);
    if(!svg || points.length < 2) {
      if(svg) svg.innerHTML = '';
      return;
    }
    var w = 600, h = 140, pad = 2;
    var vals = points.map(function(p){ return p.y; });
    var max = Math.max.apply(null, vals.concat([1]));
    var step = w / (points.length - 1);

    var pts = points.map(function(p, i){
      var x = i * step;
      var y = h - pad - (p.y / max) * (h - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });

    var linePoints = pts.join(' ');
    var areaPoints = linePoints + ' ' + ((points.length-1)*step).toFixed(1) + ',' + h + ' 0,' + h;

    svg.innerHTML = '<polygon points="' + areaPoints + '" fill="' + color + '" opacity="0.1"/>'
      + '<polyline points="' + linePoints + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  /* ── Renderers ── */
  function renderOverview(){
    var d2 = data;
    var rbc = d2.requestsByCategory || {health:0,mcp:0,oauth:0,dashboard:0,other:0};
    document.getElementById('mcpRequests').textContent = fmt(rbc.mcp);
    document.getElementById('rpm').textContent = fmt(d2.requestsPerMinute);
    document.getElementById('activeSessions').textContent = fmt(d2.activeSessionsCount);
    document.getElementById('indexedNotes').textContent = fmt(d2.indexedNotes);
    document.getElementById('uptime').textContent = fmtUptime(d2.uptime);

    // Request breakdown secondary line
    var parts = [];
    if(rbc.oauth) parts.push('oauth ' + fmt(rbc.oauth));
    if(rbc.dashboard) parts.push('dash ' + fmt(rbc.dashboard));
    if(rbc.health) parts.push('health ' + fmt(rbc.health));
    if(rbc.other) parts.push('other ' + fmt(rbc.other));
    document.getElementById('requestBreakdown').textContent = parts.length ? parts.join(' \\u00b7 ') : '';

    // Error responses
    var errCount = d2.errorResponses || 0;
    var errEl = document.getElementById('errorRate');
    errEl.textContent = fmt(errCount);
    errEl.style.color = errCount > 0 ? 'var(--red)' : 'var(--green)';
    var totalNonHealth = d2.totalRequests - (rbc.health || 0);
    var errPctVal = totalNonHealth > 0 ? ((errCount / totalNonHealth) * 100).toFixed(1) : '0';
    document.getElementById('errorPct').textContent = errPctVal + '% of non-health requests';

    // Charts from latencyHistory
    var lh = d2.latencyHistory || [];
    var rpmPts = lh.map(function(e){ return {y: e.requestCount}; });
    var latPts = lh.map(function(e){ return {y: e.avgLatencyMs}; });
    drawChart('chartRpm', rpmPts, '#58a6ff');
    drawChart('chartLatency', latPts, '#3fb950');

    // Log level counts from system logs
    var sysLogs = data.systemLogs || [];
    var errC = 0, warnC = 0, infoC = 0;
    for(var li=0;li<sysLogs.length;li++){
      if(sysLogs[li].level==='error') errC++;
      else if(sysLogs[li].level==='warn') warnC++;
      else if(sysLogs[li].level==='info') infoC++;
    }
    document.getElementById('logErrorCount').textContent = fmt(errC);
    document.getElementById('logWarnCount').textContent = fmt(warnC);
    document.getElementById('logInfoCount').textContent = fmt(infoC);

    // Embedding status in overview
    var embSt = data.embeddingStats || {};
    var ovEmb = document.getElementById('ovEmbStatus');
    if(embSt.ready){
      ovEmb.textContent = 'Active (' + fmt(embSt.indexSize) + ')';
      ovEmb.style.color = 'var(--green)';
    } else {
      ovEmb.textContent = 'Disabled';
      ovEmb.style.color = 'var(--red)';
    }

    // Tool table
    renderToolTable(data.toolCalls || {});
  }

  function renderToolTable(tc){
    var entries = [];
    for(var k in tc){ if(tc.hasOwnProperty(k)) entries.push([k, tc[k]]); }
    entries.sort(function(a,b){
      var va, vb;
      switch(sortCol){
        case 'name': return sortDir * a[0].localeCompare(b[0]);
        case 'count': va = a[1].count; vb = b[1].count; break;
        case 'avg': va = a[1].avgLatency; vb = b[1].avgLatency; break;
        case 'p95': va = a[1].p95Latency; vb = b[1].p95Latency; break;
        case 'max': va = a[1].maxLatency; vb = b[1].maxLatency; break;
        case 'errors': va = a[1].errors; vb = b[1].errors; break;
        case 'last': va = a[1].lastCalled||0; vb = b[1].lastCalled||0; break;
        default: va = a[1].count; vb = b[1].count;
      }
      return sortDir * ((va || 0) - (vb || 0));
    });
    var tbody = document.getElementById('toolTableBody');
    if(!entries.length){
      tbody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="text-align:center">No tool calls recorded</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(function(e){
      var name = e[0], m = e[1];
      return '<tr>'
        +'<td>'+esc(name)+'</td>'
        +'<td>'+fmt(m.count)+'</td>'
        +'<td class="'+latClass(m.avgLatency)+'">'+fmtMs(m.avgLatency)+'</td>'
        +'<td class="'+latClass(m.p95Latency)+'">'+fmtMs(m.p95Latency)+'</td>'
        +'<td class="'+latClass(m.maxLatency)+'">'+fmtMs(m.maxLatency)+'</td>'
        +'<td'+(m.errors>0?' class="err-red"':'')+'>'+m.errors+'</td>'
        +'<td>'+fmtAgo(m.lastCalled)+'</td>'
        +'</tr>';
    }).join('');
  }

  document.querySelectorAll('th[data-col]').forEach(function(th){
    th.addEventListener('click', function(){
      var col = th.getAttribute('data-col');
      if(sortCol === col) sortDir *= -1;
      else { sortCol = col; sortDir = -1; }
      document.querySelectorAll('th[data-col] .sort-arrow').forEach(function(a){ a.textContent = ''; });
      th.querySelector('.sort-arrow').textContent = sortDir > 0 ? '\\u25B2' : '\\u25BC';
      if(data.toolCalls) renderToolTable(data.toolCalls);
    });
    // Set initial sort arrow
    if(th.getAttribute('data-col') === sortCol){
      th.querySelector('.sort-arrow').textContent = sortDir > 0 ? '\\u25B2' : '\\u25BC';
    }
  });

  function renderSessions(){
    var sessions = data.sessions || [];
    var tbody = document.getElementById('sessionsTableBody');
    if(!sessions.length){
      tbody.innerHTML = '<tr><td colspan="9" class="empty-msg" style="text-align:center">No active sessions</td></tr>';
      return;
    }
    tbody.innerHTML = sessions.map(function(s){
      var ci = s.clientInfo;
      var clientStr = ci ? esc((ci.sub || '') + (ci.clientId ? ' (' + ci.clientId.slice(0,8) + ')' : '')) : '\\u2014';
      var recentTools = (s.lastTools || []).map(function(t){ return '<span style="color:var(--blue);margin-right:.3rem">'+esc(t)+'</span>'; }).join('');
      var toolBreakdown = '';
      var tc = s.toolCounts || {};
      var tcEntries = [];
      for(var k in tc){ if(tc.hasOwnProperty(k)) tcEntries.push([k, tc[k]]); }
      tcEntries.sort(function(a,b){ return b[1]-a[1]; });
      toolBreakdown = tcEntries.slice(0,5).map(function(e){ return esc(e[0])+':'+e[1]; }).join(', ');
      if(tcEntries.length > 5) toolBreakdown += ' +' + (tcEntries.length-5) + ' more';
      return '<tr>'
        +'<td title="'+esc(s.sessionId)+'" style="cursor:help">'+esc(truncate(s.sessionId,8))+'</td>'
        +'<td>'+esc(s.ip || '\\u2014')+'</td>'
        +'<td>'+clientStr+'</td>'
        +'<td>'+fmtDate(s.createdAt)+'</td>'
        +'<td>'+fmtAgo(s.lastActivity)+'</td>'
        +'<td>'+fmt(s.requestCount)+'</td>'
        +'<td style="font-size:.7rem">'+recentTools+'</td>'
        +'<td style="font-size:.7rem;color:var(--text-dim)">'+toolBreakdown+'</td>'
        +'<td><button class="btn btn-danger" onclick="killSessionAction(\\'' + esc(s.sessionId) + '\\')">Kill</button></td>'
        +'</tr>';
    }).join('');
  }

  function renderRateLimits(){
    var limits = data.rateLimits || [];
    var tbody = document.getElementById('rateLimitTableBody');
    if(!limits.length){
      tbody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No IPs currently being tracked</td></tr>';
      return;
    }
    tbody.innerHTML = limits.map(function(r){
      var ip = r.key.replace(/^auth:/, '');
      return '<tr>'
        +'<td>'+esc(ip)+'</td>'
        +'<td>'+fmt(r.count)+'</td>'
        +'<td>'+fmt(r.remaining)+'</td>'
        +'<td>'+fmtDate(r.resetAt)+'</td>'
        +'<td><button class="btn btn-danger" onclick="resetRateLimitAction(\\'' + esc(r.key) + '\\')">Reset</button></td>'
        +'</tr>';
    }).join('');
  }

  function renderVault(){
    document.getElementById('vaultNotes').textContent = fmt(data.indexedNotes);
    var rb = data.lastIndexRebuild;
    document.getElementById('vaultRebuild').textContent = rb ? 'Last rebuilt ' + fmtAgo(rb) : 'Never rebuilt';

    // Index health diagnostics
    var ih = data.indexHealth || [];
    var ihEl = document.getElementById('indexHealthInfo');
    if(ih.length){
      ihEl.innerHTML = ih.map(function(v){
        var parts = ['<strong>' + esc(v.vault.split('/').pop() || v.vault) + '</strong>: ' + v.indexed + '/' + v.fileCount + ' indexed'];
        if(v.enoent > 0){
          parts.push('<span style="color:var(--yellow)">' + v.enoent + ' missing (ENOENT)</span>');
          if(v.enoentSamples && v.enoentSamples.length){
            parts.push('<span style="color:var(--text-dim);font-size:.65rem"> e.g. ' + v.enoentSamples.slice(0,3).map(function(s){return esc(s.split('/').pop()||s);}).join(', ') + '</span>');
          }
        }
        if(v.permissionErrors > 0){
          parts.push('<span style="color:var(--red)">' + v.permissionErrors + ' permission denied (EACCES/EPERM)</span>');
          if(v.permissionSamples && v.permissionSamples.length){
            parts.push('<span style="color:var(--text-dim);font-size:.65rem"> e.g. ' + v.permissionSamples.slice(0,3).map(function(s){return esc(s.split('/').pop()||s);}).join(', ') + '</span>');
          }
        }
        if(v.otherErrors > 0){
          parts.push('<span style="color:var(--red)">' + v.otherErrors + ' other errors</span>');
        }
        if(v.enoent === 0 && v.permissionErrors === 0 && v.otherErrors === 0){
          parts.push('<span style="color:var(--green)">\\u2713 clean</span>');
        }
        return '<div style="margin-bottom:.25rem">' + parts.join(' \\u00b7 ') + '</div>';
      }).join('');
    } else {
      ihEl.innerHTML = '';
    }

    // Memory temperature from real docMeta counts
    var mt = data.memoryTemperature || { hot: 0, warm: 0, cold: 0 };
    document.getElementById('memHot').textContent = 'Hot: ' + fmt(mt.hot);
    document.getElementById('memWarm').textContent = 'Warm: ' + fmt(mt.warm);
    document.getElementById('memCold').textContent = 'Cold: ' + fmt(mt.cold);

    // Stacked bar
    var total = mt.hot + mt.warm + mt.cold;
    var bar = document.getElementById('memBar');
    if(total > 0){
      var hPct = ((mt.hot/total)*100).toFixed(1);
      var wPct = ((mt.warm/total)*100).toFixed(1);
      var cPct = ((mt.cold/total)*100).toFixed(1);
      bar.innerHTML = '<div class="seg seg-hot" style="width:'+hPct+'%">'+mt.hot+'</div>'
        +'<div class="seg seg-warm" style="width:'+wPct+'%">'+mt.warm+'</div>'
        +'<div class="seg seg-cold" style="width:'+cPct+'%">'+mt.cold+'</div>';
    } else {
      bar.innerHTML = '';
    }

    // ── Temperature time-series (stacked area chart) ──
    var th = data.temperatureHistory || [];
    if(th.length >= 2){
      var svg = document.getElementById('chartTempHistory');
      var w = 600, h = 160, pad = 4;
      var maxVal = 1;
      for(var i=0;i<th.length;i++){
        var s = th[i].hot + th[i].warm + th[i].cold;
        if(s > maxVal) maxVal = s;
      }
      var step = w / (th.length - 1);
      function yPos(v){ return h - pad - (v / maxVal) * (h - 2 * pad); }

      // Build stacked areas: cold on bottom, warm in middle, hot on top
      var coldPts = [], warmPts = [], hotPts = [];
      for(var i=0;i<th.length;i++){
        var x = (i * step).toFixed(1);
        var yCold = yPos(th[i].cold);
        var yWarm = yPos(th[i].cold + th[i].warm);
        var yHot = yPos(th[i].cold + th[i].warm + th[i].hot);
        coldPts.push(x+','+yCold.toFixed(1));
        warmPts.push(x+','+yWarm.toFixed(1));
        hotPts.push(x+','+yHot.toFixed(1));
      }
      var baseline = ' '+((th.length-1)*step).toFixed(1)+','+h+' 0,'+h;

      svg.innerHTML =
        '<polygon points="'+coldPts.join(' ')+baseline+'" fill="#58a6ff" opacity="0.2"/>'
        +'<polyline points="'+coldPts.join(' ')+'" fill="none" stroke="#58a6ff" stroke-width="1.2"/>'
        +'<polygon points="'+warmPts.join(' ')+baseline+'" fill="#d29922" opacity="0.2"/>'
        +'<polyline points="'+warmPts.join(' ')+'" fill="none" stroke="#d29922" stroke-width="1.2"/>'
        +'<polygon points="'+hotPts.join(' ')+baseline+'" fill="#f85149" opacity="0.2"/>'
        +'<polyline points="'+hotPts.join(' ')+'" fill="none" stroke="#f85149" stroke-width="1.2"/>';
    }

    // ── Heat score histogram ──
    var hist = data.heatHistogram || [0,0,0,0];
    var histMax = Math.max.apply(null, hist.concat([1]));
    var histColors = ['#58a6ff','#3fb950','#d29922','#f85149'];
    var histEl = document.getElementById('heatHistogram');
    histEl.innerHTML = hist.map(function(count, i){
      var pct = (count / histMax * 100).toFixed(0);
      return '<div class="hist-bar" style="height:'+Math.max(pct,4)+'%;background:'+histColors[i]+'">'+(count||'')+'</div>';
    }).join('');

    // ── Embedding stats ──
    var es = data.embeddingStats || {};
    var embBadge = document.getElementById('embeddingBadge');
    if(es.ready){
      embBadge.textContent = 'Active';
      embBadge.style.background = 'rgba(63,185,80,.15)';
      embBadge.style.color = 'var(--green)';
    } else {
      embBadge.textContent = 'Disabled';
      embBadge.style.background = 'rgba(248,81,73,.15)';
      embBadge.style.color = 'var(--red)';
    }
    document.getElementById('embModel').textContent = es.model || '\\u2014';
    document.getElementById('embVectors').textContent = fmt(es.indexSize);
    document.getElementById('embAvgTime').textContent = es.avgEmbedTimeMs ? es.avgEmbedTimeMs + ' ms' : '\\u2014';

    // ── Top 10 hottest notes ──
    var topNotes = data.topNotes || [];
    var tnBody = document.getElementById('topNotesBody');
    if(!topNotes.length){
      tnBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No notes indexed</td></tr>';
    } else {
      tnBody.innerHTML = topNotes.map(function(n){
        var tempBadge = '<span class="badge badge-'+(n.temperature||'warm')+'">'+esc(n.temperature||'?')+'</span>';
        return '<tr>'
          +'<td title="'+esc(n.path)+'" style="cursor:help;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(n.title)+'</td>'
          +'<td class="'+latClass(16-(n.heat_score||0))+'">'+fmt(n.heat_score)+'</td>'
          +'<td>'+tempBadge+'</td>'
          +'<td>'+esc(n.category||'\\u2014')+'</td>'
          +'<td>'+esc(n.last_accessed||'\\u2014')+'</td>'
          +'</tr>';
      }).join('');
    }

    // ── Memory categories breakdown ──
    var cats = data.categoryBreakdown || {};
    var catEntries = [];
    for(var k in cats){ if(cats.hasOwnProperty(k)) catEntries.push([k, cats[k]]); }
    catEntries.sort(function(a,b){ return b[1]-a[1]; });
    var catMax = catEntries.length > 0 ? catEntries[0][1] : 1;
    var catColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#f778ba','#79c0ff','#56d364','#e3b341','#ff7b72'];
    var catEl = document.getElementById('categoryBars');
    if(!catEntries.length){
      catEl.innerHTML = '<div class="empty-msg">No categories found</div>';
    } else {
      catEl.innerHTML = catEntries.map(function(e, i){
        var pct = (e[1]/catMax*100).toFixed(0);
        var color = catColors[i % catColors.length];
        return '<div class="cat-row">'
          +'<span class="cat-label">'+esc(e[0])+'</span>'
          +'<div class="cat-bar-wrap"><div class="cat-bar" style="width:'+pct+'%;background:'+color+'">'+e[1]+'</div></div>'
          +'<span class="cat-count">'+e[1]+'</span>'
          +'</div>';
      }).join('');
    }

    // ── Search quality indicators ──
    var sq = data.searchStats || {};
    document.getElementById('sqTotal').textContent = fmt(sq.totalSearches);
    document.getElementById('sqAvgResults').textContent = fmt(sq.avgResultCount);
    document.getElementById('sqAvgLatency').textContent = sq.avgLatencyMs ? sq.avgLatencyMs + ' ms' : '\\u2014';
    var zeroRate = sq.totalSearches > 0 ? ((sq.zeroResultCount / sq.totalSearches) * 100).toFixed(1) : '0';
    var zrEl = document.getElementById('sqZeroRate');
    zrEl.textContent = zeroRate + '%';
    zrEl.style.color = parseFloat(zeroRate) > 20 ? 'var(--red)' : parseFloat(zeroRate) > 10 ? 'var(--yellow)' : 'var(--green)';

    // ── Recent searches feed ──
    var rs = data.recentSearches || [];
    var rsEl = document.getElementById('recentSearchesFeed');
    if(!rs.length){
      rsEl.innerHTML = '<div class="empty-msg">No searches recorded.</div>';
    } else {
      rsEl.innerHTML = rs.slice().reverse().map(function(s){
        return '<div class="search-item">'
          +'<span class="s-ts">'+fmtTime(s.timestamp)+'</span>'
          +'<span class="s-query" title="'+esc(s.query)+'">'+esc(s.query)+'</span>'
          +'<span class="s-count">'+s.resultCount+' hits</span>'
          +'<span class="s-lat">'+s.latencyMs+' ms</span>'
          +'</div>';
      }).join('');
    }

    // ── Vault Health ──
    var vh = data.vaultHealth;
    if(vh){
      document.getElementById('vhTotal').textContent = fmt(vh.totalFiles);
      document.getElementById('vhArchived').textContent = fmt(vh.archivedNotes);
      var vhStaleEl = document.getElementById('vhStale');
      vhStaleEl.textContent = fmt(vh.staleNotes);
      vhStaleEl.style.color = vh.staleNotes > 10 ? 'var(--yellow)' : 'var(--green)';
      var ftEntries = [];
      for(var ftk in vh.fileCountByType){ if(vh.fileCountByType.hasOwnProperty(ftk)) ftEntries.push(ftk + ':' + vh.fileCountByType[ftk]); }
      document.getElementById('vhFileTypes').textContent = ftEntries.join(' \\u00b7 ') || '\\u2014';
    }

    // ── Link Density ──
    var ld = data.linkDensity;
    if(ld){
      document.getElementById('ldTotal').textContent = fmt(ld.totalLinks);
      document.getElementById('ldAvg').textContent = ld.avgLinksPerNote.toFixed(1);
      var ldOrpEl = document.getElementById('ldOrphans');
      ldOrpEl.textContent = fmt(ld.orphanNotes);
      ldOrpEl.style.color = ld.orphanNotes > 20 ? 'var(--red)' : ld.orphanNotes > 5 ? 'var(--yellow)' : 'var(--green)';
      var mlEl = document.getElementById('ldMostLinked');
      if(ld.mostLinked && ld.mostLinked.length){
        mlEl.innerHTML = ld.mostLinked.slice(0,5).map(function(m){
          var short = m.path.split('/').pop() || m.path;
          return '<div title="'+esc(m.path)+'">'+esc(short)+' <span style="color:var(--blue)">'+m.inbound+'</span></div>';
        }).join('');
      } else {
        mlEl.textContent = '\\u2014';
      }
    }

    // ── Search Analytics ──
    var sa = data.searchTypeStats || {};
    document.getElementById('saLexOnly').textContent = fmt(sa.lexicalOnlyHits);
    document.getElementById('saSemOnly').textContent = fmt(sa.semanticOnlyHits);
    document.getElementById('saBoth').textContent = fmt(sa.bothHits);

    var avgLex = sa.avgLexicalContribution || 0;
    var avgSem = sa.avgSemanticContribution || 0;
    var saBar = document.getElementById('saContribBar');
    if(avgLex + avgSem > 0){
      var lexPctSa = (avgLex / (avgLex + avgSem) * 100).toFixed(0);
      var semPctSa = (100 - parseFloat(lexPctSa)).toFixed(0);
      saBar.innerHTML = '<div class="seg" style="width:'+lexPctSa+'%;background:var(--blue)">'+lexPctSa+'%</div>'
        +'<div class="seg" style="width:'+semPctSa+'%;background:var(--green)">'+semPctSa+'%</div>';
    } else {
      saBar.innerHTML = '<div class="seg" style="width:100%;background:var(--border);color:var(--text-dim)">No data</div>';
    }

    // ── Memory Lifecycle ──
    var ml = data.memoryLifecycle || {};
    document.getElementById('mlArchived').textContent = fmt(ml.totalArchived);
    document.getElementById('mlConsolidated').textContent = fmt(ml.totalConsolidated);

    var td = ml.temperatureDistribution || {hot:0,warm:0,cold:0,unset:0};
    var tdTotal = td.hot + td.warm + td.cold + td.unset;
    var mlBar = document.getElementById('mlTempBar');
    if(tdTotal > 0){
      var tdHotPct = (td.hot/tdTotal*100).toFixed(1);
      var tdWarmPct = (td.warm/tdTotal*100).toFixed(1);
      var tdColdPct = (td.cold/tdTotal*100).toFixed(1);
      var tdUnsetPct = (td.unset/tdTotal*100).toFixed(1);
      mlBar.innerHTML = '<div class="seg seg-hot" style="width:'+tdHotPct+'%">'+(td.hot||'')+'</div>'
        +'<div class="seg seg-warm" style="width:'+tdWarmPct+'%">'+(td.warm||'')+'</div>'
        +'<div class="seg seg-cold" style="width:'+tdColdPct+'%">'+(td.cold||'')+'</div>'
        +'<div class="seg" style="width:'+tdUnsetPct+'%;background:var(--border);color:var(--text-dim)">'+(td.unset||'')+'</div>';
    } else {
      mlBar.innerHTML = '';
    }

    var mlOpsEl = document.getElementById('mlRecentOps');
    var recentArchives = ml.recentArchives || [];
    var recentConsols = ml.recentConsolidations || [];
    var allLifecycleOps = [];
    for(var ai=0;ai<recentArchives.length;ai++){
      allLifecycleOps.push({ts:recentArchives[ai].timestamp, text:'Archived '+esc((recentArchives[ai].path||'').split('/').pop()||recentArchives[ai].path), type:'archive'});
    }
    for(var ci=0;ci<recentConsols.length;ci++){
      allLifecycleOps.push({ts:recentConsols[ci].timestamp, text:'Consolidated '+recentConsols[ci].count+' notes', type:'consolidate'});
    }
    allLifecycleOps.sort(function(a,b){ return b.ts-a.ts; });
    if(!allLifecycleOps.length){
      mlOpsEl.innerHTML = '<div class="empty-msg">No recent lifecycle events.</div>';
    } else {
      mlOpsEl.innerHTML = allLifecycleOps.slice(0,10).map(function(op){
        var color = op.type === 'archive' ? 'var(--yellow)' : 'var(--green)';
        return '<div style="padding:.2rem 0;border-bottom:1px solid var(--border);display:flex;gap:.5rem">'
          +'<span style="color:var(--text-dim);font-family:var(--mono);width:60px;flex-shrink:0">'+fmtTime(op.ts)+'</span>'
          +'<span style="color:'+color+'">'+op.text+'</span>'
          +'</div>';
      }).join('');
    }

    // ── Recent memory operations ──
    var allCalls = data.recentToolCalls || [];
    var memOps = allCalls.filter(function(c){ return c.tool && c.tool.indexOf('memory_') === 0; });
    var moEl = document.getElementById('memoryOpsFeed');
    if(!memOps.length){
      moEl.innerHTML = '<div class="empty-msg">No memory operations recorded.</div>';
    } else {
      moEl.innerHTML = memOps.slice().reverse().map(function(c){
        return '<div class="feed-item" style="flex-wrap:wrap">'
          +'<span class="feed-ts">'+fmtTime(c.timestamp)+'</span>'
          +'<span class="feed-tool">'+esc(c.tool)+'</span>'
          +'<span class="feed-status '+(c.status==='ok'?'ok':'error')+'">'+(c.status==='ok'?'\\u2713':'\\u2717')+'</span>'
          +'<span class="feed-dur">'+fmtMs(c.durationMs)+'</span>'
          +(c.detail ? '<span style="width:100%;font-size:.72rem;color:var(--text-dim);margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escAttr(c.detail)+'">'+esc(c.detail)+'</span>' : '')
          +'</div>';
      }).join('');
    }

    // ── Recent notes accessed ──
    var noteOps = allCalls.filter(function(c){ return c.tool === 'notes_get'; });
    var naEl = document.getElementById('notesAccessFeed');
    if(naEl){
      if(!noteOps.length){
        naEl.innerHTML = '<div class="empty-msg">No notes accessed yet.</div>';
      } else {
        naEl.innerHTML = noteOps.slice().reverse().map(function(c){
          return '<div class="feed-item">'
            +'<span class="feed-ts">'+fmtTime(c.timestamp)+'</span>'
            +'<span class="feed-status '+(c.status==='ok'?'ok':'error')+'">'+(c.status==='ok'?'\\u2713':'\\u2717')+'</span>'
            +'<span style="flex:1;color:var(--text);font-size:.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(c.detail||'')+'">'+esc(c.detail||c.tool)+'</span>'
            +'<span class="feed-dur">'+fmtMs(c.durationMs)+'</span>'
            +'</div>';
        }).join('');
      }
    }

    // ── Collection distribution ──
    var colDist = data.collectionDistribution || {};
    var colEntries = [];
    for(var ck in colDist){ if(colDist.hasOwnProperty(ck)) colEntries.push([ck, colDist[ck]]); }
    colEntries.sort(function(a,b){ return b[1]-a[1]; });
    var colMax = colEntries.length > 0 ? colEntries[0][1] : 1;
    var colColors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#f778ba','#79c0ff'];
    var colEl = document.getElementById('collectionBars');
    if(!colEntries.length){
      colEl.innerHTML = '<div class="empty-msg">No collection data</div>';
    } else {
      colEl.innerHTML = colEntries.map(function(e, i){
        var pct = (e[1]/colMax*100).toFixed(0);
        var color = colColors[i % colColors.length];
        return '<div class="cat-row">'
          +'<span class="cat-label">'+esc(e[0])+'</span>'
          +'<div class="cat-bar-wrap"><div class="cat-bar" style="width:'+pct+'%;background:'+color+'">'+e[1]+'</div></div>'
          +'<span class="cat-count">'+e[1]+'</span>'
          +'</div>';
      }).join('');
    }

    // ── Score breakdown (recent searches) ──
    var ssb = data.searchScoreBreakdowns || [];
    var sbEl = document.getElementById('scoreBreakdowns');
    if(!ssb.length){
      sbEl.innerHTML = '<div class="empty-msg">No searches with score data.</div>';
    } else {
      sbEl.innerHTML = ssb.slice().reverse().map(function(s){
        var rows = s.results.map(function(r){
          var total = r.lexical + r.semantic;
          if(total === 0) total = 1;
          var lexPct = (r.lexical / total * 100).toFixed(0);
          var semPct = (r.semantic / total * 100).toFixed(0);
          var pathShort = r.path.split('/').pop() || r.path;
          return '<div class="score-row">'
            +'<span class="sr-path" title="'+esc(r.path)+'">'+esc(pathShort)+'</span>'
            +'<div class="sr-bar-wrap"><div class="sr-bar">'
            +'<div class="sr-seg lex" style="width:'+lexPct+'%" title="Lexical: '+r.lexical.toFixed(4)+'">'+(parseInt(lexPct)>15?lexPct+'%':'')+'</div>'
            +'<div class="sr-seg sem" style="width:'+semPct+'%" title="Semantic: '+r.semantic.toFixed(4)+'">'+(parseInt(semPct)>15?semPct+'%':'')+'</div>'
            +'</div></div>'
            +'</div>';
        }).join('');
        return '<div style="margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)">'
          +'<div style="font-size:.75rem;margin-bottom:.3rem"><span style="color:var(--blue)">'+esc(s.query)+'</span> <span style="color:var(--text-dim)">'+fmtTime(s.timestamp)+'</span></div>'
          +rows
          +'</div>';
      }).join('');
    }

    // ── Memory Stack (L0 + L1) ──
    var ms = data.memoryStack || [];
    var l0 = null, l1 = null;
    for(var mi=0;mi<ms.length;mi++){
      if(ms[mi].level === 0) l0 = ms[mi];
      if(ms[mi].level === 1) l1 = ms[mi];
    }
    var msIdEl = document.getElementById('msIdentity');
    if(l0 && l0.content){
      msIdEl.textContent = l0.content;
    } else {
      msIdEl.innerHTML = '<span class="empty-msg">No identity loaded yet.</span>';
    }
    var msNarrEl = document.getElementById('msNarrative');
    if(l1 && l1.content){
      msNarrEl.textContent = l1.content;
    } else {
      msNarrEl.innerHTML = '<span class="empty-msg">No narrative loaded yet.</span>';
    }
    var msTotalTokens = 0;
    for(var ti=0;ti<ms.length;ti++) msTotalTokens += (ms[ti].tokens || 0);
    document.getElementById('msTokenCount').textContent = fmt(msTotalTokens);

    // ── Search Quality Benchmarks summary ──
    var sqBench = data.benchmarkSummary;
    if(sqBench){
      var sqbR5El = document.getElementById('sqbRecall5');
      var sqbNdcgEl = document.getElementById('sqbNdcg10');
      var sqbLatEl = document.getElementById('sqbAvgLat');
      var sqbRunEl = document.getElementById('sqbLastRun');
      var r5Val = sqBench.avgRecallAt5;
      var ndcgVal = sqBench.avgNdcgAt10;
      var avgLatVal = sqBench.totalQueries > 0 ? Math.round(sqBench.totalLatencyMs / sqBench.totalQueries) : 0;
      function sqbColor(v){ if(v < 0) return 'var(--text-dim)'; if(v >= 0.7) return 'var(--green)'; if(v >= 0.4) return 'var(--yellow)'; return 'var(--red)'; }
      sqbR5El.textContent = r5Val >= 0 ? (r5Val * 100).toFixed(0) + '%' : '\\u2014';
      sqbR5El.style.color = sqbColor(r5Val);
      sqbNdcgEl.textContent = ndcgVal >= 0 ? (ndcgVal * 100).toFixed(0) + '%' : '\\u2014';
      sqbNdcgEl.style.color = sqbColor(ndcgVal);
      sqbLatEl.textContent = avgLatVal + ' ms';
      sqbLatEl.style.color = avgLatVal < 100 ? 'var(--green)' : avgLatVal < 500 ? 'var(--yellow)' : 'var(--red)';
      sqbRunEl.textContent = fmtAgo(sqBench.timestamp);
    }

    // ── Retrieval benchmark ──
    var bench = data.benchmarkSummary;
    var bgEl = document.getElementById('benchmarkGauges');
    var btBody = document.getElementById('benchmarkTableBody');
    var btTs = document.getElementById('benchmarkTimestamp');
    var btnSave = document.getElementById('btnSaveGroundTruth');
    if(!bench){
      bgEl.innerHTML = '';
      btBody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="text-align:center">No benchmark run yet. Click "Run Benchmark" to start.</td></tr>';
      if(btnSave) btnSave.style.display = 'none';
    } else {
      if(btnSave) btnSave.style.display = '';
      btTs.textContent = 'Last run: ' + fmtDate(bench.timestamp) + ' \\u00b7 ' + bench.totalQueries + ' queries \\u00b7 ' + bench.totalLatencyMs + ' ms total';

      function gaugeClass(v){ if(v < 0) return 'bg-na'; if(v >= 0.7) return 'bg-good'; if(v >= 0.4) return 'bg-mid'; return 'bg-low'; }
      function gaugeVal(v){ return v < 0 ? 'N/A' : (v * 100).toFixed(0) + '%'; }

      // Show avg latency and avg results as the first two gauges when no ground truth
      var hasGroundTruth = bench.avgPrecisionAt5 >= 0;
      var avgLat = bench.totalQueries > 0 ? Math.round(bench.totalLatencyMs / bench.totalQueries) : 0;
      var avgResults = bench.results.length > 0 ? Math.round(bench.results.reduce(function(s,r){return s+r.retrievedCount;},0)/bench.results.length) : 0;

      var gauges;
      if(hasGroundTruth){
        gauges = [
          ['P@5', bench.avgPrecisionAt5],
          ['P@10', bench.avgPrecisionAt10],
          ['R@5', bench.avgRecallAt5],
          ['R@10', bench.avgRecallAt10],
          ['NDCG@10', bench.avgNdcgAt10],
        ];
      } else {
        gauges = [
          ['P@5', bench.avgPrecisionAt5],
          ['P@10', bench.avgPrecisionAt10],
          ['R@5', bench.avgRecallAt5],
          ['R@10', bench.avgRecallAt10],
          ['NDCG@10', bench.avgNdcgAt10],
        ];
      }
      bgEl.innerHTML = gauges.map(function(g){
        return '<div class="bench-gauge">'
          +'<div class="bg-label">'+g[0]+'</div>'
          +'<div class="bg-value '+gaugeClass(g[1])+'">'+gaugeVal(g[1])+'</div>'
          +'</div>';
      }).join('');
      if(!hasGroundTruth){
        bgEl.innerHTML += '<div style="grid-column:1/-1;font-size:.72rem;color:var(--text-dim);text-align:center;padding:.25rem">No ground truth set. Click "Save as Ground Truth" to use current results as baseline, then re-run to compare.</div>';
      }

      btBody.innerHTML = bench.results.map(function(r){
        var topPaths = (r.retrievedPaths || []).slice(0,5).map(function(p){
          var short = p.path.split('/').pop() || p.path;
          return '<div style="font-size:.65rem;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(p.path)+' ('+p.score+')">'+esc(short)+'</div>';
        }).join('');
        return '<tr>'
          +'<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.query)+(r.description?' — '+esc(r.description):'')+'">'+esc(r.query)+'</td>'
          +'<td>'+r.retrievedCount+(r.expectedCount ? '/'+r.expectedCount : '')+'</td>'
          +'<td class="'+gaugeClass(r.precisionAt5)+'">'+gaugeVal(r.precisionAt5)+'</td>'
          +'<td class="'+gaugeClass(r.precisionAt10)+'">'+gaugeVal(r.precisionAt10)+'</td>'
          +'<td class="'+gaugeClass(r.ndcgAt10)+'">'+gaugeVal(r.ndcgAt10)+'</td>'
          +'<td class="'+latClass(r.latencyMs)+'">'+fmtMs(r.latencyMs)+'</td>'
          +'<td style="max-width:200px">'+topPaths+'</td>'
          +'</tr>';
      }).join('');
    }
  }

  function renderLogs(){
    // ── System logs ──
    var logs = data.systemLogs || [];
    var showDebug = document.getElementById('logFilterDebug').checked;
    var showInfo = document.getElementById('logFilterInfo').checked;
    var showWarn = document.getElementById('logFilterWarn').checked;
    var showError = document.getElementById('logFilterError').checked;
    var sourceFilter = document.getElementById('logFilterSource').value;
    var textFilter = (document.getElementById('logFilterText').value || '').toLowerCase();

    var filtered = logs.filter(function(l){
      // Level filter
      if(l.level === 'debug' && !showDebug) return false;
      if(l.level === 'info' && !showInfo) return false;
      if(l.level === 'warn' && !showWarn) return false;
      if(l.level === 'error' && !showError) return false;
      // Source filter
      if(sourceFilter !== 'all' && (l.source || 'general') !== sourceFilter) return false;
      // Text filter
      if(textFilter && l.message.toLowerCase().indexOf(textFilter) === -1) return false;
      return true;
    });

    var slEl = document.getElementById('systemLogsFeed');
    if(!filtered.length){
      slEl.innerHTML = '<div class="empty-msg">No logs matching filters (' + logs.length + ' total).</div>';
    } else {
      slEl.innerHTML = filtered.map(function(l){
        var metaStr = l.meta ? JSON.stringify(l.meta) : '';
        var ts = l.timestamp ? new Date(l.timestamp).toISOString() : '';
        var fullLine = ts + ' [' + (l.source||'general') + '] ' + l.level.toUpperCase() + ' ' + l.message + (metaStr ? ' ' + metaStr : '');
        return '<div class="log-entry" data-full="'+escAttr(fullLine)+'" onclick="copyLogLine(this)" style="cursor:pointer" title="Click to copy">'
          +'<span class="log-ts">'+fmtTime(l.timestamp)+'</span>'
          +'<span class="log-level l-'+l.level+'">'+l.level+'</span>'
          +'<span class="log-src">'+ esc(l.source||'general') +'</span>'
          +'<span class="log-msg">'+esc(l.message)+'</span>'
          +(metaStr ? '<span class="log-meta" title="'+escAttr(metaStr)+'">'+esc(metaStr)+'</span>' : '')
          +'</div>';
      }).join('');
      slEl.scrollTop = slEl.scrollHeight;
    }

    // Wire up filter listeners once
    if(!renderLogs._filtersWired){
      renderLogs._filtersWired = true;
      ['logFilterDebug','logFilterInfo','logFilterWarn','logFilterError'].forEach(function(id){
        document.getElementById(id).addEventListener('change', function(){ renderLogs(); });
      });
      document.getElementById('logFilterSource').addEventListener('change', function(){ renderLogs(); });
      var textInput = document.getElementById('logFilterText');
      var textTimer = null;
      textInput.addEventListener('input', function(){
        clearTimeout(textTimer);
        textTimer = setTimeout(function(){ renderLogs(); }, 200);
      });
    }

    var calls = data.recentToolCalls || [];
    var el = document.getElementById('logToolCalls');
    if(!calls.length){
      el.innerHTML = '<div class="empty-msg">No tool calls recorded.</div>';
    } else {
      el.innerHTML = calls.slice().reverse().map(function(c){
        return '<div class="feed-item" style="flex-wrap:wrap">'
          +'<span class="feed-ts">'+fmtTime(c.timestamp)+'</span>'
          +'<span class="feed-tool">'+esc(c.tool)+'</span>'
          +'<span class="feed-status '+(c.status==='ok'?'ok':'error')+'">'+(c.status==='ok'?'\\u2713':'\\u2717')+'</span>'
          +'<span class="feed-dur">'+fmtMs(c.durationMs)+'</span>'
          +(c.detail ? '<span style="width:100%;font-size:.72rem;color:var(--text-dim);margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escAttr(c.detail)+'">'+esc(c.detail)+'</span>' : '')
          +'</div>';
      }).join('');
    }

    var errors = data.recentErrors || [];
    var eel = document.getElementById('logErrors');
    if(!errors.length){
      eel.innerHTML = '<div class="empty-msg">No errors recorded.</div>';
    } else {
      eel.innerHTML = errors.slice().reverse().map(function(e){
        return '<div class="error-item">'
          +'<span class="e-ts">'+fmtTime(e.timestamp)+'</span>'
          +'<span class="e-tool">'+esc(e.tool)+'</span>'
          +'<span class="e-msg">'+esc(e.message)+'</span>'
          +'</div>';
      }).join('');
    }

    var authFails = data.recentAuthFailures || [];
    var afBody = document.getElementById('authFailuresTableBody');
    if(!authFails.length){
      afBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No auth failures recorded.</td></tr>';
    } else {
      afBody.innerHTML = authFails.slice().reverse().map(function(f){
        return '<tr>'
          +'<td>'+fmtTime(f.timestamp)+'</td>'
          +'<td>'+esc(f.ip)+'</td>'
          +'<td>'+esc(f.method)+'</td>'
          +'<td>'+esc(f.path)+'</td>'
          +'</tr>';
      }).join('');
    }
  }

  /* ── Dream cycle from dashboard ── */
  window.runDreamCycle = function(withLlm){
    var btn = document.getElementById('btnDreamRun');
    var llmBtn = document.getElementById('btnDreamLlm');
    btn.disabled = true;
    if(llmBtn) llmBtn.disabled = true;
    var label = withLlm ? 'LLM Dreaming...' : 'Dreaming...';
    (withLlm ? llmBtn : btn).textContent = label;
    btn.classList.add('dream-running');
    fetch('/dashboard/api/dream/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ daysBack: 7, autoDecay: true, autoArchive: false, llmConsolidate: !!withLlm }),
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      btn.disabled = false;
      btn.textContent = 'Run Dream';
      btn.classList.remove('dream-running');
      if(llmBtn){ llmBtn.disabled = false; llmBtn.textContent = 'LLM Dream'; }
      if(d.ok){
        var msg = 'Dream cycle complete';
        if(withLlm && d.llmResult){
          var lr = d.llmResult;
          if(!lr.attempted && lr.reason) msg += ' — LLM skipped: ' + lr.reason;
          else if(lr.generated > 0) msg += ' — LLM generated ' + lr.generated + ' suggestions';
          else if(lr.errors.length > 0) msg += ' — LLM failed: ' + lr.errors[0];
        }
        showToast(msg, d.llmResult && d.llmResult.errors && d.llmResult.errors.length ? 'error' : 'success');
      } else showToast(d.error || 'Dream cycle failed', 'error');
    })
    .catch(function(e){
      btn.disabled = false;
      btn.textContent = 'Run Dream';
      btn.classList.remove('dream-running');
      if(llmBtn){ llmBtn.disabled = false; llmBtn.textContent = 'LLM Dream'; }
      showToast('Dream cycle failed: ' + e.message, 'error');
    });
  };

  window.dismissRec = function(key){
    fetch('/dashboard/api/dream/dismiss', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ key: key }),
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.ok) showToast('Dismissed', 'success');
    })
    .catch(function(){ /* ignore */ });
  };

  function renderIntelligence(){
    // ── 1. Health Score Gauge ──
    var hs = data.healthScore;
    if(hs){
      var arc = document.getElementById('healthArc');
      var offset = 314 - (hs.score / 100) * 314;
      arc.setAttribute('stroke-dashoffset', offset.toString());
      var scoreColor = hs.score >= 70 ? 'var(--green)' : hs.score >= 40 ? 'var(--yellow)' : 'var(--red)';
      arc.setAttribute('stroke', scoreColor);
      document.getElementById('healthScoreValue').textContent = hs.score;
      document.getElementById('healthScoreValue').style.color = scoreColor;
      document.getElementById('healthGradeValue').textContent = 'Grade: ' + hs.grade;

      var hfEl = document.getElementById('healthFactors');
      if(hs.factors){
        hfEl.innerHTML = hs.factors.map(function(f){
          var pct = Math.round(f.value * 100);
          var color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--red)';
          return '<div class="health-factor">'
            +'<span class="hf-label">'+esc(f.name)+'</span>'
            +'<div class="hf-bar-wrap"><div class="hf-bar" style="width:'+pct+'%;background:'+color+'"></div></div>'
            +'<span style="font-size:.6rem;font-family:var(--mono);color:'+color+';width:28px;text-align:right">'+pct+'%</span>'
            +'</div>';
        }).join('');
      }
    }

    // ── 2. Dream Narrative & Activity ──
    var dream = data.lastDream;
    var dreamBtn = document.getElementById('btnDreamRun');
    if(data.dreamRunning){
      dreamBtn.disabled = true;
      dreamBtn.textContent = 'Running...';
      dreamBtn.classList.add('dream-running');
    } else {
      dreamBtn.disabled = false;
      dreamBtn.textContent = 'Run Dream';
      dreamBtn.classList.remove('dream-running');
    }

    if(dream){
      document.getElementById('dreamStatus').textContent = 'Last: ' + fmtAgo(dream.timestamp) + ' (' + dream.durationMs + 'ms)';
      document.getElementById('dreamNarrative').textContent = dream.narrative;

      var actEl = document.getElementById('dreamActivity');
      var act = dream.activity || {};
      actEl.innerHTML = '<div style="text-align:center"><div class="card-label">Notes</div><div class="mono" style="font-size:1.1rem;font-weight:600">'+fmt(act.totalNotes)+'</div></div>'
        +'<div style="text-align:center"><div class="card-label">Recently Active</div><div class="mono" style="font-size:1.1rem;font-weight:600;color:var(--green)">'+fmt(act.recentlyAccessed)+'</div></div>'
        +'<div style="text-align:center"><div class="card-label">Decayed</div><div class="mono" style="font-size:1.1rem;font-weight:600;color:var(--yellow)">'+fmt(dream.lifecycle ? dream.lifecycle.decayed : 0)+'</div></div>';
    }

    // ── 3. LLM Status ──
    var llm = data.llmStatus || {};
    var llmDot = document.getElementById('llmDot');
    var llmText = document.getElementById('llmStatusText');
    if(!llm.configured){
      llmDot.style.background = 'var(--text-dim)';
      llmText.textContent = 'Not configured';
      llmText.style.color = 'var(--text-dim)';
    } else if(llm.available){
      llmDot.style.background = 'var(--green)';
      llmDot.style.boxShadow = '0 0 6px var(--green)';
      llmText.textContent = 'Online';
      llmText.style.color = 'var(--green)';
    } else {
      llmDot.style.background = 'var(--red)';
      llmText.textContent = 'Offline';
      llmText.style.color = 'var(--red)';
    }
    document.getElementById('llmModel').textContent = llm.model || '\\u2014';
    var llmUrlEl = document.getElementById('llmUrl');
    if(llm.baseUrl) llmUrlEl.textContent = llm.baseUrl + '/v1/...';
    var llmErrEl = document.getElementById('llmError');
    if(llm.lastError && !llm.available){
      llmErrEl.textContent = '\\u26a0 ' + llm.lastError;
      llmErrEl.style.display = '';
    } else {
      llmErrEl.style.display = 'none';
    }

    var llmSugEl = document.getElementById('llmSuggestions');
    var suggestions = llm.recentSuggestions || [];
    if(!suggestions.length){
      llmSugEl.innerHTML = '<span class="empty-msg">No LLM suggestions yet. Run a dream cycle with LLM consolidation.</span>';
    } else {
      llmSugEl.innerHTML = suggestions.slice().reverse().map(function(s){
        return '<div class="llm-suggestion">'
          +'<div class="llm-group">'+esc(s.group)+'</div>'
          +'<div class="llm-text">'+esc(s.summary)+'</div>'
          +'<div class="llm-ts">'+fmtAgo(s.timestamp)+'</div>'
          +'</div>';
      }).join('');
    }

    // ── 4. Theme Clusters ──
    var tcEl = document.getElementById('themeClusters');
    if(dream && dream.themes && dream.themes.length){
      var tempIcons = {hot: '&#9632;', warm: '&#9632;', cold: '&#9632;'};
      var tempColors = {hot: 'var(--red)', warm: 'var(--yellow)', cold: 'var(--blue)'};
      tcEl.innerHTML = dream.themes.map(function(t){
        var tempColor = tempColors[t.temperature] || 'var(--text-dim)';
        return '<div class="theme-card">'
          +'<div class="theme-name">'+esc(t.name)+'</div>'
          +'<div class="theme-meta">'
          +'<span>'+t.memoryPaths.length+' memories</span>'
          +'<span style="color:'+tempColor+'">'+tempIcons[t.temperature]+' '+t.temperature+'</span>'
          +'</div>'
          +'<div style="font-size:.75rem;color:var(--text);margin-top:.2rem">'+esc(t.summary)+'</div>'
          +'<div class="theme-tags">'+t.tags.map(function(tag){ return '<span class="theme-tag">#'+esc(tag)+'</span>'; }).join('')+'</div>'
          +'</div>';
      }).join('');
    } else {
      tcEl.innerHTML = '<span class="empty-msg">Run a dream cycle to detect recurring themes across your memories.</span>';
    }

    // ── 5. AI Recommendations (connections + consolidations) ──
    var recsEl = document.getElementById('aiRecommendations');
    var recCards = [];
    if(dream){
      var conns = dream.connectionSuggestions || [];
      for(var ci=0;ci<conns.length;ci++){
        var c = conns[ci];
        var srcShort = c.sourcePath.split('/').pop() || c.sourcePath;
        var tgtShort = c.targetPath.split('/').pop() || c.targetPath;
        var dismissKey = 'conn:'+c.sourcePath+':'+c.targetPath;
        recCards.push('<div class="rec-card rec-connection">'
          +'<div class="rec-body">'
          +'<div class="rec-type type-connection">Connection Suggestion</div>'
          +'<div class="rec-text"><strong>'+esc(srcShort.replace(/\\.md$/,''))+'</strong> \\u2194 <strong>'+esc(tgtShort.replace(/\\.md$/,''))+'</strong></div>'
          +'<div class="rec-confidence">'+esc(c.reason)+' \\u00b7 '+(c.confidence*100).toFixed(0)+'% confidence</div>'
          +'</div>'
          +'<div class="rec-actions"><button class="btn" style="font-size:.65rem;padding:.15rem .4rem" onclick="dismissRec(\\''+escAttr(dismissKey)+'\\')">Dismiss</button></div>'
          +'</div>');
      }
      var groups = dream.consolidationGroups || [];
      for(var gi=0;gi<groups.length;gi++){
        var g = groups[gi];
        var dismissKeyG = 'cons:'+g.suggestedTitle;
        recCards.push('<div class="rec-card rec-consolidation">'
          +'<div class="rec-body">'
          +'<div class="rec-type type-consolidation">Consolidation Group</div>'
          +'<div class="rec-text"><strong>'+esc(g.suggestedTitle)+'</strong> \\u2014 '+g.paths.length+' notes</div>'
          +'<div class="rec-confidence">Tags: '+g.commonTags.map(function(t){return '#'+t;}).join(', ')+' \\u00b7 avg heat: '+(g.avgHeatScore||0).toFixed(1)+'</div>'
          +'</div>'
          +'<div class="rec-actions"><button class="btn" style="font-size:.65rem;padding:.15rem .4rem" onclick="dismissRec(\\''+escAttr(dismissKeyG)+'\\')">Dismiss</button></div>'
          +'</div>');
      }
    }
    var recsCountEl = document.getElementById('recsCount');
    if(recCards.length){
      recsEl.innerHTML = recCards.join('');
      recsCountEl.textContent = recCards.length + ' recommendations';
    } else {
      recsEl.innerHTML = '<span class="empty-msg">Run a dream cycle to generate connection suggestions and consolidation opportunities.</span>';
      recsCountEl.textContent = '';
    }

    // ── 6. Orphan Memories ──
    var orphans = dream ? dream.orphans || [] : [];
    var orphanBody = document.getElementById('orphanTableBody');
    var orphanSummary = document.getElementById('orphanSummary');
    if(!orphans.length){
      orphanBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>';
      orphanSummary.innerHTML = '';
    } else {
      var actionCounts = {};
      orphans.forEach(function(o){ actionCounts[o.suggestedAction] = (actionCounts[o.suggestedAction]||0)+1; });
      var summaryParts = [];
      if(actionCounts.link) summaryParts.push('<span class="action-badge action-link">'+actionCounts.link+' link</span>');
      if(actionCounts.review) summaryParts.push('<span class="action-badge action-review">'+actionCounts.review+' review</span>');
      if(actionCounts.consolidate) summaryParts.push('<span class="action-badge action-consolidate">'+actionCounts.consolidate+' consolidate</span>');
      if(actionCounts.archive) summaryParts.push('<span class="action-badge action-archive">'+actionCounts.archive+' archive</span>');
      orphanSummary.innerHTML = summaryParts.join('');

      orphanBody.innerHTML = orphans.map(function(o){
        var actionClass = 'action-'+o.suggestedAction;
        var tempBadge = '<span class="badge badge-'+(o.temperature||'cold')+'">'+esc(o.temperature||'?')+'</span>';
        var daysTxt = o.daysSinceAccess < 0 ? 'never' : o.daysSinceAccess + 'd ago';
        return '<tr>'
          +'<td title="'+esc(o.path)+'" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help">'+esc(o.title)+'</td>'
          +'<td>'+tempBadge+'</td>'
          +'<td class="mono">'+(o.heat_score||0).toFixed(1)+'</td>'
          +'<td class="mono" style="color:var(--text-dim)">'+daysTxt+'</td>'
          +'<td><span class="action-badge '+actionClass+'">'+esc(o.suggestedAction)+'</span></td>'
          +'</tr>';
      }).join('');
    }

    // ── 7. Entity Intelligence ──
    var es = data.entityStats || { tierCounts: {}, typeCounts: {}, total: 0 };
    document.getElementById('eiTotal').textContent = fmt(es.total);
    document.getElementById('eiConfirmed').textContent = fmt(es.tierCounts.confirmed || 0);
    document.getElementById('eiDetected').textContent = fmt(es.tierCounts.detected || 0);

    // Tier bar
    var tierTotal = es.total || 1;
    var confPct = ((es.tierCounts.confirmed||0)/tierTotal*100).toFixed(1);
    var detPct = ((es.tierCounts.detected||0)/tierTotal*100).toFixed(1);
    var sugPct = ((es.tierCounts.suggested||0)/tierTotal*100).toFixed(1);
    var tierBar = document.getElementById('entityTierBar');
    if(es.total > 0){
      tierBar.innerHTML = '<div class="seg" style="width:'+confPct+'%;background:var(--green);min-width:0">'+(es.tierCounts.confirmed||'')+'</div>'
        +'<div class="seg" style="width:'+detPct+'%;background:var(--yellow);min-width:0">'+(es.tierCounts.detected||'')+'</div>'
        +'<div class="seg" style="width:'+sugPct+'%;background:var(--border);color:var(--text-dim);min-width:0">'+(es.tierCounts.suggested||'')+'</div>';
    } else {
      tierBar.innerHTML = '<div class="seg" style="width:100%;background:var(--border);color:var(--text-dim)">No entities</div>';
    }

    // Type breakdown bars
    var typeEntries = [];
    for(var tk in es.typeCounts){ if(es.typeCounts.hasOwnProperty(tk)) typeEntries.push([tk, es.typeCounts[tk]]); }
    typeEntries.sort(function(a,b){ return b[1]-a[1]; });
    var typeMax = typeEntries.length > 0 ? typeEntries[0][1] : 1;
    var typeColors = {person: '#58a6ff', project: '#3fb950', organization: '#d29922'};
    var typeEl = document.getElementById('entityTypeBars');
    if(!typeEntries.length){
      typeEl.innerHTML = '<span class="empty-msg">No entities</span>';
    } else {
      typeEl.innerHTML = typeEntries.map(function(e){
        var pct = (e[1]/typeMax*100).toFixed(0);
        var color = typeColors[e[0]] || 'var(--text-dim)';
        return '<div class="cat-row">'
          +'<span class="cat-label">'+esc(e[0])+'</span>'
          +'<div class="cat-bar-wrap"><div class="cat-bar" style="width:'+pct+'%;background:'+color+'">'+e[1]+'</div></div>'
          +'<span class="cat-count">'+e[1]+'</span>'
          +'</div>';
      }).join('');
    }

    // Entity registry table
    var entities = data.entityRegistry || [];
    var erBody = document.getElementById('entityRegistryBody');
    if(!entities.length){
      erBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>';
    } else {
      erBody.innerHTML = entities.map(function(e){
        var confColor = e.confidence >= 0.8 ? 'var(--green)' : e.confidence >= 0.5 ? 'var(--yellow)' : 'var(--red)';
        var statusLabel = e.confirmed ? '<span style="color:var(--green)">\\u2713 confirmed</span>' : '<span style="color:var(--text-dim)">detected</span>';
        return '<tr>'
          +'<td>'+esc(e.name)+'</td>'
          +'<td>'+esc(e.type)+'</td>'
          +'<td style="color:'+confColor+'">'+(e.confidence*100).toFixed(0)+'%</td>'
          +'<td>'+statusLabel+'</td>'
          +'</tr>';
      }).join('');
    }

    // ── 8. Knowledge Graph ──
    var kgData = data.knowledgeGraph || {entities:0, triples:0, predicates:[]};
    document.getElementById('kgEntities').textContent = fmt(kgData.entities);
    document.getElementById('kgTriples').textContent = fmt(kgData.triples);
    var kgPredEl = document.getElementById('kgPredicates');
    if(kgData.predicates && kgData.predicates.length){
      kgPredEl.innerHTML = kgData.predicates.map(function(p){
        return '<div style="display:flex;justify-content:space-between;padding:.15rem 0;border-bottom:1px solid var(--border)">'
          +'<span style="color:var(--blue)">'+esc(p.name)+'</span>'
          +'<span class="mono" style="color:var(--text-dim)">'+fmt(p.count)+'</span>'
          +'</div>';
      }).join('');
    } else {
      kgPredEl.innerHTML = '<span class="empty-msg">Knowledge graph empty or not enabled (set KG_ENABLED=true).</span>';
    }

    // ── 9. Dream History ──
    var dh = data.dreamHistory || [];
    if(dh.length >= 2){
      var svg = document.getElementById('chartDreamHealth');
      var w = 600, h = 120, pad = 4;
      var maxScore = 100;
      var maxThemes = 1, maxOrphans = 1;
      for(var di=0;di<dh.length;di++){
        if(dh[di].themes > maxThemes) maxThemes = dh[di].themes;
        if(dh[di].orphans > maxOrphans) maxOrphans = dh[di].orphans;
      }
      var step = w / (dh.length - 1);
      function dhY(v, maxV){ return h - pad - (v / maxV) * (h - 2 * pad); }

      var healthPts = [], themePts = [], orphanPts = [];
      for(var di2=0;di2<dh.length;di2++){
        var x = (di2 * step).toFixed(1);
        healthPts.push(x+','+dhY(dh[di2].healthScore, maxScore).toFixed(1));
        themePts.push(x+','+dhY(dh[di2].themes, maxThemes).toFixed(1));
        orphanPts.push(x+','+dhY(dh[di2].orphans, maxOrphans).toFixed(1));
      }
      svg.innerHTML =
        '<polyline points="'+healthPts.join(' ')+'" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round"/>'
        +'<polyline points="'+themePts.join(' ')+'" fill="none" stroke="#d29922" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="4 2"/>'
        +'<polyline points="'+orphanPts.join(' ')+'" fill="none" stroke="#f85149" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="4 2"/>';
    }

    var dhTableEl = document.getElementById('dreamHistoryTable');
    if(!dh.length){
      dhTableEl.innerHTML = '<span class="empty-msg">No dream cycles recorded yet.</span>';
    } else {
      dhTableEl.innerHTML = dh.slice().reverse().slice(0, 20).map(function(d){
        var scoreColor = d.healthScore >= 70 ? 'var(--green)' : d.healthScore >= 40 ? 'var(--yellow)' : 'var(--red)';
        return '<div class="dh-row">'
          +'<span class="dh-ts">'+fmtAgo(d.timestamp)+'</span>'
          +'<span class="dh-score" style="color:'+scoreColor+'">'+d.healthScore+'</span>'
          +'<span class="dh-metrics">'+d.themes+'T '+d.orphans+'O '+d.connections+'C'+(d.decayed?' '+d.decayed+'D':'')+'</span>'
          +'</div>';
      }).join('');
    }

    // ── 10. Agent Awareness ──
    var agents = data.agentDiaries || [];
    var adBody = document.getElementById('agentDiariesBody');
    if(!agents.length){
      adBody.innerHTML = '<tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>';
    } else {
      adBody.innerHTML = agents.map(function(a){
        return '<tr>'
          +'<td style="color:var(--blue);font-weight:500">'+esc(a.agentId)+'</td>'
          +'<td>'+fmtAgo(a.lastActive)+'</td>'
          +'<td>'+fmt(a.entryCount)+'</td>'
          +'</tr>';
      }).join('');
    }

    // Cross-reference agent activity with dream themes for "thinking about" section
    var activityEl = document.getElementById('agentRecentActivity');
    var thinkingParts = [];
    if(dream && dream.themes && dream.themes.length){
      thinkingParts.push('<div style="font-size:.72rem;color:var(--text-dim);margin-bottom:.3rem;font-style:italic">Based on recent dream analysis and agent activity:</div>');
      var activeThemes = dream.themes.filter(function(t){ return t.temperature === 'hot' || t.temperature === 'warm'; });
      if(activeThemes.length){
        thinkingParts.push('<div style="margin-bottom:.3rem;font-size:.75rem"><strong style="color:var(--blue)">Active focus areas:</strong> ' + activeThemes.map(function(t){ return t.name + ' ('+t.memoryPaths.length+')'; }).join(', ') + '</div>');
      }
      if(dream.lifecycle && dream.lifecycle.decayed > 0){
        thinkingParts.push('<div style="font-size:.72rem;color:var(--yellow)">Pruned '+dream.lifecycle.decayed+' stale memories during last dream cycle.</div>');
      }
      if(dream.connectionSuggestions && dream.connectionSuggestions.length > 0){
        thinkingParts.push('<div style="font-size:.72rem;color:var(--green)">Discovered '+dream.connectionSuggestions.length+' potential connections between notes.</div>');
      }
    }
    if(thinkingParts.length){
      activityEl.innerHTML = thinkingParts.join('');
    } else if(!agents.length) {
      activityEl.innerHTML = '';
    } else {
      activityEl.innerHTML = '<div style="font-size:.72rem;color:var(--text-dim);font-style:italic">Run a dream cycle to see what the AI has been thinking about.</div>';
    }
  }

  function fetchAgentsData(){
    Promise.all([
      fetch('/dashboard/api/agents').then(function(r){ return r.json(); }),
      fetch('/dashboard/api/teams').then(function(r){ return r.json(); }),
      fetch('/dashboard/api/skills').then(function(r){ return r.json(); })
    ]).then(function(res){
      agentsData.agents = res[0].agents || [];
      agentsData.teams  = res[1].teams  || [];
      agentsData.skills = res[2].skills || [];
      agentsLoaded = true;
      renderAgents();
    }).catch(function(){ /* leave Loading... */ });
  }

  function renderAgents(){
    if(!agentsLoaded){ fetchAgentsData(); return; }

    document.getElementById('agCountAgents').textContent = agentsData.agents.length;
    document.getElementById('agCountTeams').textContent  = agentsData.teams.length;
    document.getElementById('agCountSkills').textContent = agentsData.skills.length;

    var agentsBody = document.getElementById('agentsTableBody');
    if(!agentsData.agents.length){
      agentsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No agents.</td></tr>';
    } else {
      agentsBody.innerHTML = agentsData.agents.map(function(a){
        return '<tr>'
          +'<td class="mono">'+esc(a.name)+'</td>'
          +'<td>'+esc(a.display_name)+'</td>'
          +'<td>'+esc(a.role)+'</td>'
          +'<td class="mono">'+esc(a.model)+'</td>'
          +'<td>'+esc((a.tags||[]).join(' \\u00b7 '))+'</td>'
          +'<td class="mono">'+esc(a.path)+'</td>'
          +'</tr>';
      }).join('');
    }

    var teamsBody = document.getElementById('teamsTableBody');
    if(!agentsData.teams.length){
      teamsBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No teams.</td></tr>';
    } else {
      teamsBody.innerHTML = agentsData.teams.map(function(t){
        return '<tr>'
          +'<td class="mono">'+esc(t.name)+'</td>'
          +'<td>'+esc(t.display_name)+'</td>'
          +'<td>'+esc(t.coordination)+'</td>'
          +'<td class="mono">'+fmt(t.member_count)+'</td>'
          +'<td class="mono">'+esc(t.path)+'</td>'
          +'</tr>';
      }).join('');
    }

    var skillsBody = document.getElementById('skillsTableBody');
    if(!agentsData.skills.length){
      skillsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No skills.</td></tr>';
    } else {
      skillsBody.innerHTML = agentsData.skills.map(function(s){
        return '<tr>'
          +'<td class="mono">'+esc(s.name)+'</td>'
          +'<td>'+esc(s.display_name)+'</td>'
          +'<td class="mono">'+esc(s.trigger)+'</td>'
          +'<td>'+esc(s.description)+'</td>'
          +'<td>'+esc((s.tags||[]).join(' \\u00b7 '))+'</td>'
          +'<td class="mono">'+esc(s.path)+'</td>'
          +'</tr>';
      }).join('');
    }

    var sel = document.getElementById('diaryAgentSelect');
    var diaries = data.agentDiaries || [];
    var current = sel.value;
    var opts = '<option value="">Select agent...</option>' + diaries.map(function(d){
      return '<option value="'+escAttr(d.agentId)+'">'+esc(d.agentId)+'</option>';
    }).join('');
    if(sel.innerHTML !== opts){
      sel.innerHTML = opts;
      if(current) sel.value = current;
    }

    if(!sel.dataset.listener){
      sel.addEventListener('change', loadDiary);
      sel.dataset.listener = '1';
    }
    var limitSel = document.getElementById('diaryLimitSelect');
    if(!limitSel.dataset.listener){
      limitSel.addEventListener('change', loadDiary);
      limitSel.dataset.listener = '1';
    }
  }

  function loadDiary(){
    var agent = document.getElementById('diaryAgentSelect').value;
    var limit = document.getElementById('diaryLimitSelect').value;
    var body = document.getElementById('diaryBody');
    if(!agent){
      body.innerHTML = '<span class="empty-msg">Select an agent to view recent diary entries.</span>';
      return;
    }
    body.innerHTML = '<span class="empty-msg">Loading...</span>';
    fetch('/dashboard/api/agent-diary/' + encodeURIComponent(agent) + '?limit=' + encodeURIComponent(limit))
      .then(function(r){ return r.json(); })
      .then(function(d){
        var entries = d.entries || [];
        if(!entries.length){
          body.innerHTML = '<span class="empty-msg">No diary entries.</span>';
          return;
        }
        body.innerHTML = entries.map(function(e){
          var text = e.text || '';
          var badges = '';
          if(text.indexOf('_(silent)_') !== -1){
            badges += '<span class="badge badge-warm" style="margin-right:.3rem">silent</span>';
            text = text.replace(/^_\\(silent\\)_\\s*/, '');
          }
          var srcMatch = text.match(/_via\\s+([^_]+)_\\s*$/);
          if(srcMatch){
            badges += '<span class="badge badge-cold" style="margin-right:.3rem">via '+esc(srcMatch[1].trim())+'</span>';
            text = text.replace(/\\s*_via\\s+[^_]+_\\s*$/, '');
          }
          return '<div style="padding:.4rem .6rem;border-bottom:1px solid var(--border)">'
            +'<span class="mono" style="color:var(--text-dim);margin-right:.5rem">'+esc(e.date)+' '+esc(e.time)+'</span>'
            +badges
            +esc(text.trim())
            +'</div>';
        }).join('');
      })
      .catch(function(){
        body.innerHTML = '<span class="empty-msg">Failed to load diary.</span>';
      });
  }

  function renderCurrentTab(){
    switch(activeTab){
      case 'overview': renderOverview(); break;
      case 'sessions': renderSessions(); break;
      case 'ratelimits': renderRateLimits(); break;
      case 'vault': renderVault(); break;
      case 'intelligence': renderIntelligence(); break;
      case 'agents': renderAgents(); break;
      case 'code': renderCode(); break;
      case 'logs': renderLogs(); break;
    }
  }

  function fmtBytes(n){
    if(!n) return '0';
    var units = ['B','KB','MB','GB'];
    var i = 0;
    var v = n;
    while(v >= 1024 && i < units.length - 1){ v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function renderCode(){
    var cn = data.codeNav || null;
    if(!cn){
      document.getElementById('codeRepoCount').textContent = '0';
      document.getElementById('codeSymbolCount').textContent = '0';
      document.getElementById('codeFileCount').textContent = '0';
      document.getElementById('codeDbSize').textContent = '\\u2014';
      document.getElementById('codeCallStats').textContent = 'no data';
      var tb = document.getElementById('codeRepoTable');
      tb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No repos registered. Use code_repo_register / code_repo_scan.</td></tr>';
    } else {
      document.getElementById('codeRepoCount').textContent = fmt(cn.repoCount);
      document.getElementById('codeSymbolCount').textContent = fmt(cn.symbolCount);
      document.getElementById('codeFileCount').textContent = fmt(cn.fileCount);
      document.getElementById('codeDbSize').textContent = fmtBytes(cn.dbSizeBytes);
      var resolved = (cn.callCount && cn.callCount.resolved) || 0;
      var unresolved = (cn.callCount && cn.callCount.unresolved) || 0;
      document.getElementById('codeCallStats').textContent = fmt(resolved) + ' / ' + fmt(resolved + unresolved) + ' calls resolved';
      var rows = (cn.perRepo || []).map(function(r){
        return '<tr>'
          +'<td>'+esc(r.slug)+'</td>'
          +'<td>'+fmt(r.symbols)+'</td>'
          +'<td>'+fmt(r.files)+'</td>'
          +'<td>'+(r.lastIndexedAt ? fmtAgo(r.lastIndexedAt) : '\\u2014')+'</td>'
          +'</tr>';
      });
      var tb = document.getElementById('codeRepoTable');
      if(rows.length === 0){
        tb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No repos registered.</td></tr>';
      } else {
        tb.innerHTML = rows.join('');
      }
    }
    renderCodeSavings();
  }

  function renderCodeSavings(){
    var sv = data.codeNavSavings || null;
    var summary = document.getElementById('codeSavingsSummary');
    var tb = document.getElementById('codeSavingsTable');
    var rb = document.getElementById('codeSavingsRepoTable');
    var chart = document.getElementById('codeSavingsChart');
    if(!sv || !sv.totalCalls){
      summary.textContent = 'No code-nav tool calls recorded yet.';
      tb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No data yet — call code_symbol_search / code_file_outline / etc. to populate.</td></tr>';
      if(rb) rb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No per-repo data yet.</td></tr>';
      chart.textContent = '';
      return;
    }
    // $0.003/1k tokens — Claude Sonnet input pricing (rough baseline).
    var costUsd = (sv.totalSaved / 1000) * 0.003;
    summary.innerHTML = 'Total tokens saved: <strong>'+fmt(sv.totalSaved)
      +'</strong> across <strong>'+fmt(sv.totalCalls)+'</strong> calls '
      +'(\\u2248 $'+costUsd.toFixed(2)+' at Claude Sonnet input pricing — approximate).';
    var byTool = sv.savedByTool || {};
    var names = Object.keys(byTool).sort(function(a,b){
      return byTool[b].tokensSaved - byTool[a].tokensSaved;
    });
    var rows = names.map(function(name){
      var t = byTool[name];
      return '<tr>'
        +'<td>'+esc(name)+'</td>'
        +'<td>'+fmt(t.calls)+'</td>'
        +'<td>'+fmt(t.tokensSaved)+'</td>'
        +'<td>'+fmt(t.avgSaved)+'</td>'
        +'</tr>';
    });
    tb.innerHTML = rows.join('');

    // Per-repo savings table (best-effort attribution).
    if(rb){
      var byRepo = sv.savedByRepo || {};
      var repos = Object.keys(byRepo).sort(function(a,b){
        return byRepo[b].tokensSaved - byRepo[a].tokensSaved;
      });
      if(repos.length === 0){
        rb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No per-repo data yet — multi-repo or unattributed calls only.</td></tr>';
      } else {
        var rrows = repos.map(function(slug){
          var r = byRepo[slug];
          return '<tr>'
            +'<td>'+esc(slug)+'</td>'
            +'<td>'+fmt(r.calls)+'</td>'
            +'<td>'+fmt(r.tokensSaved)+'</td>'
            +'<td>'+fmt(r.avgSaved)+'</td>'
            +'</tr>';
        });
        rb.innerHTML = rrows.join('');
      }
    }

    // Render a tiny ASCII bar chart of cumulativeSaved over the last samples.
    var hist = sv.history || [];
    if(hist.length < 2){
      chart.textContent = '';
    } else {
      var maxVal = hist[hist.length-1].cumulativeSaved || 1;
      var step = Math.max(1, Math.floor(hist.length/30));
      var blocks = '';
      for(var i=0;i<hist.length;i+=step){
        var frac = hist[i].cumulativeSaved / maxVal;
        var bars = ['\\u2581','\\u2582','\\u2583','\\u2584','\\u2585','\\u2586','\\u2587','\\u2588'];
        var idx = Math.max(0, Math.min(7, Math.floor(frac*8)));
        blocks += bars[idx];
      }
      chart.textContent = 'Cumulative savings trend: '+blocks;
    }
  }

  /* ── Clock ── */
  function tickClock(){
    document.getElementById('clock').textContent = new Date().toLocaleTimeString();
  }
  setInterval(tickClock, 1000);
  tickClock();

  /* ── SSE ── */
  function connect(){
    var es = new EventSource('/dashboard/events');
    es.onmessage = function(ev){
      try{
        data = JSON.parse(ev.data);
        // Always update header regardless of tab
        document.getElementById('uptime').textContent = fmtUptime(data.uptime);
        renderCurrentTab();
      }catch(err){ console.error('Dashboard parse error:', err); }
    };
    es.onerror = function(){
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();
})();
</script>
</body>
</html>`;
