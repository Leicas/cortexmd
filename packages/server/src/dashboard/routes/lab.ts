/**
 * Recall Lab + Memories routes. All live under `/dashboard/api/*`, so they are
 * gated by `dashboardAuthMiddleware` (mounted in index.ts) and every non-GET is
 * CSRF-checked by `dashboardSecurityMiddleware` (security.ts).
 *
 *   GET|POST /dashboard/api/recall            playground (read-only, no-touch)
 *   GET      /dashboard/api/wakeup            wakeup inspector
 *   GET      /dashboard/api/wakeup/options    agent / project / preset options
 *   GET      /dashboard/api/eval/runs         eval run history (summaries)
 *   GET      /dashboard/api/eval/compare      ?run=&baseline= per-query diff
 *   GET      /dashboard/api/memories          inbox listing (filters in query)
 *   GET      /dashboard/api/memories/note     ?path= detail
 *   POST     /dashboard/api/memories/update   {path, etag, body?, fields?}
 *   POST     /dashboard/api/memories/archive  {path, reason?}
 *   POST     /dashboard/api/memories/noise    {path}
 *   POST     /dashboard/api/memories/delete   {path, reason, confirm:true}
 */
import type { Router, Request, Response } from 'express';
import { runRecallLab, parseRecallLabParams } from '../model/recall-lab.js';
import { buildWakeupPreview, wakeupOptions } from '../model/wakeup-preview.js';
import { readEvalRuns, summarize, diffRuns, resultsDir } from '../model/eval-runs.js';
import {
  listMemories, memoryFacets, getMemoryDetail, updateMemory, archiveMemory, deleteMemory,
} from '../model/memories.js';

function fail(res: Response, err: unknown, fallback = 500): void {
  const e = err as { status?: number; message?: string };
  const msg = e?.message ?? String(err);
  const status = typeof e?.status === 'number' ? e.status
    : /not found|ENOENT|does not exist/i.test(msg) ? 404
    : /invalid|traversal|outside|read-only|readonly/i.test(msg) ? 400
    : fallback;
  res.status(status).json({ error: msg });
}

const qs = (req: Request, k: string): string | undefined => {
  const v = req.query[k];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
};

export function registerLabRoutes(router: Router): void {
  const recall = async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown>;
      const params = parseRecallLabParams(raw ?? {});
      if (!params.query) { res.status(400).json({ error: 'query is required' }); return; }
      res.json(await runRecallLab(params));
    } catch (err) { fail(res, err); }
  };
  router.get('/dashboard/api/recall', recall);
  router.post('/dashboard/api/recall', recall);

  router.get('/dashboard/api/wakeup/options', async (_req, res) => {
    try { res.json(await wakeupOptions()); } catch (err) { fail(res, err); }
  });
  router.get('/dashboard/api/wakeup', async (req, res) => {
    try {
      res.json(await buildWakeupPreview({
        preset: qs(req, 'preset'), agentName: qs(req, 'agent'), project: qs(req, 'project'), collection: qs(req, 'collection'),
      }));
    } catch (err) { fail(res, err); }
  });

  router.get('/dashboard/api/eval/runs', (_req, res) => {
    try {
      const runs = readEvalRuns();
      res.json({ dir: resultsDir(), runs: runs.map(summarize) });
    } catch (err) { fail(res, err); }
  });
  router.get('/dashboard/api/eval/compare', (req, res) => {
    try {
      const runs = readEvalRuns();
      const cur = runs.find((r) => r.id === qs(req, 'run')) ?? runs[runs.length - 1];
      const base = runs.find((r) => r.id === qs(req, 'baseline')) ?? runs[runs.length - 2];
      if (!cur || !base) { res.json({ run: cur?.id ?? null, baseline: base?.id ?? null, diffs: [] }); return; }
      res.json({ run: cur.id, baseline: base.id, diffs: diffRuns(base, cur) });
    } catch (err) { fail(res, err); }
  });

  router.get('/dashboard/api/memories', async (req, res) => {
    try {
      const limitN = parseInt(qs(req, 'limit') ?? '200', 10);
      const since = qs(req, 'since');
      const result = await listMemories({
        q: qs(req, 'q'),
        since: since === 'all' ? '' : since,
        until: qs(req, 'until'),
        category: qs(req, 'category'),
        temperature: qs(req, 'temperature'),
        agent: qs(req, 'agent'),
        machine: qs(req, 'machine'),
        project: qs(req, 'project'),
        source: qs(req, 'source'),
        includeArchived: qs(req, 'archived') === '1',
        allNotes: qs(req, 'all') === '1',
        limit: Number.isFinite(limitN) ? limitN : 200,
      });
      res.json({ ...result, facets: memoryFacets() });
    } catch (err) { fail(res, err); }
  });
  router.get('/dashboard/api/memories/note', async (req, res) => {
    try { res.json(await getMemoryDetail(qs(req, 'path') ?? '')); } catch (err) { fail(res, err); }
  });

  const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const pathOf = (b: Record<string, unknown>): string => String(b.path ?? '').trim();

  router.post('/dashboard/api/memories/update', async (req, res) => {
    const b = bodyOf(req);
    if (!pathOf(b)) { res.status(400).json({ error: 'path is required' }); return; }
    try {
      const out = await updateMemory(pathOf(b), {
        etag: typeof b.etag === 'string' ? b.etag : undefined,
        body: typeof b.body === 'string' ? b.body : undefined,
        fields: b.fields && typeof b.fields === 'object' ? b.fields as Record<string, unknown> : undefined,
      });
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err); }
  });
  router.post('/dashboard/api/memories/archive', async (req, res) => {
    const b = bodyOf(req);
    if (!pathOf(b)) { res.status(400).json({ error: 'path is required' }); return; }
    try { res.json({ ok: true, ...(await archiveMemory(pathOf(b), typeof b.reason === 'string' ? b.reason.slice(0, 300) : undefined)) }); }
    catch (err) { fail(res, err); }
  });
  router.post('/dashboard/api/memories/noise', async (req, res) => {
    const b = bodyOf(req);
    if (!pathOf(b)) { res.status(400).json({ error: 'path is required' }); return; }
    try { res.json({ ok: true, ...(await archiveMemory(pathOf(b), 'marked as noise from dashboard', { noise: true })) }); }
    catch (err) { fail(res, err); }
  });
  router.post('/dashboard/api/memories/delete', async (req, res) => {
    const b = bodyOf(req);
    if (!pathOf(b)) { res.status(400).json({ error: 'path is required' }); return; }
    if (b.confirm !== true) { res.status(400).json({ error: 'Deletion not confirmed (confirm: true required).' }); return; }
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 300) : 'deleted from dashboard';
    try { res.json({ ok: true, ...(await deleteMemory(pathOf(b), reason)) }); }
    catch (err) { fail(res, err); }
  });
}
