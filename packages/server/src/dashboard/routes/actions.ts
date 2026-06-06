/**
 * POST admin action routes. Lifted verbatim from the legacy `dashboard.ts`.
 * Each handler is thin: validate → call a model/lib fn → res.json.
 * The dream-run orchestration moved to `model/dream.ts`.
 */
import type { Router, Request, Response } from 'express';
import { resetRateLimit, resetAllRateLimits } from '../../lib/rate-limit.js';
import { killSession } from '../../index.js';
import { rebuildIndex, getDocMeta } from '../../lib/search.js';
import { kgBootstrap, isKgInitialized } from '../../lib/knowledge-graph.js';
import { backfillEntities } from '../../lib/entity-backfill.js';
import { acquireOperation, releaseOperation } from '../../lib/operation-mutex.js';
import { getBenchmarkResults, setBenchmarkResults } from '../../lib/metrics.js';
import { runBenchmark, saveAsGroundTruth } from '../../lib/benchmark.js';
import { runMigration } from '../../lib/migration.js';
import { isDreamRunning, setDreamRunning, dismissSuggestion } from '../model/state.js';
import { runDashboardDream } from '../model/dream.js';
import { createOAuthClient, deleteOAuthClient } from '../../oauth.js';

export function registerActionRoutes(router: Router): void {
  // Create an OAuth client from the dashboard (auth-gated). Unlike the public
  // /register endpoint there is no per-IP rate limit — the operator is already
  // authenticated. Returns the client_secret ONCE; it is never retrievable again.
  router.post('/dashboard/api/oauth/clients/create', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { client_name?: string; redirect_uris?: string[] };
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (uris.length === 0) {
      res.status(400).json({ error: 'At least one redirect URI is required (paste the OAuth Redirect URL n8n shows you).' });
      return;
    }
    try {
      const client = createOAuthClient({
        client_name: (body.client_name || 'n8n').slice(0, 100),
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'client_secret_post',
      });
      res.json({
        ok: true,
        client_id: client.client_id,
        client_secret: client.client_secret,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/dashboard/api/oauth/clients/delete', (req: Request, res: Response) => {
    const { client_id } = (req.body ?? {}) as { client_id?: string };
    if (!client_id) {
      res.status(400).json({ error: 'client_id is required' });
      return;
    }
    const existed = deleteOAuthClient(client_id);
    res.json({ ok: true, existed });
  });

  router.post('/dashboard/api/rate-limit/reset', (req: Request, res: Response) => {
    const { key } = req.body as { key?: string };
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    const existed = resetRateLimit(key);
    res.json({ ok: true, existed });
  });

  router.post('/dashboard/api/rate-limit/reset-all', (_req: Request, res: Response) => {
    const count = resetAllRateLimits();
    res.json({ ok: true, count });
  });

  router.post('/dashboard/api/sessions/kill', (req: Request, res: Response) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const killed = killSession(sessionId);
    res.json({ ok: true, killed });
  });

  router.post('/dashboard/api/benchmark/run', async (_req: Request, res: Response) => {
    try {
      const summary = await runBenchmark();
      setBenchmarkResults(summary);
      res.json({ ok: true, queries: summary.totalQueries });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/dashboard/api/benchmark/save-ground-truth', (_req: Request, res: Response) => {
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

  router.post('/dashboard/api/index/rebuild', async (_req: Request, res: Response) => {
    try {
      await rebuildIndex();
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/dashboard/api/kg/bootstrap', async (_req: Request, res: Response) => {
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

  // Scan the indexed corpus, run heuristic entity detection, and (re)populate the
  // persistent entity registry (+ optional KG mentions_* triples). Idempotent.
  // MUST stay under /dashboard/* — an /api/* route 401s behind forward-auth.
  router.post('/dashboard/api/entities/rebuild', async (req: Request, res: Response) => {
    if (!acquireOperation('entity-rebuild')) {
      res.status(409).json({ error: 'Entity rebuild already running' });
      return;
    }
    try {
      const body = (req.body ?? {}) as { limit?: number; minConfidence?: number; seedKg?: boolean };
      const dm = getDocMeta();
      const result = backfillEntities(dm, {
        limit: body.limit,
        minConfidence: body.minConfidence,
        seedKg: body.seedKg,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      releaseOperation('entity-rebuild');
    }
  });

  router.post('/dashboard/api/migrate/dry-run', async (_req: Request, res: Response) => {
    try {
      const result = await runMigration(true);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/dashboard/api/migrate/run', async (_req: Request, res: Response) => {
    try {
      const result = await runMigration(false);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/dashboard/api/dream/run', async (req: Request, res: Response) => {
    if (isDreamRunning()) {
      res.status(409).json({ error: 'Dream cycle already running' });
      return;
    }
    try {
      setDreamRunning(true);
      const body = req.body as { daysBack?: number; autoDecay?: boolean; autoArchive?: boolean; llmConsolidate?: boolean } | undefined;
      const { report, llmResult } = await runDashboardDream(body);
      res.json({ ok: true, report, llmResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      setDreamRunning(false);
    }
  });

  router.post('/dashboard/api/dream/dismiss', (req: Request, res: Response) => {
    const { key } = req.body as { key?: string };
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    dismissSuggestion(key);
    res.json({ ok: true });
  });
}
