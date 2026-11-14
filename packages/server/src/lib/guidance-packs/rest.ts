/**
 * REST surface for guidance packs (hooks, the `cortexmd guidance` CLI and
 * other non-MCP clients):
 *
 *   GET    /api/guidance/search?q=&pack=&limit=      → { results: [{pack,id,description}] }
 *   GET    /api/guidance/get?id=a,b&pack=&section=&maxTokens= → { guides: [...], text }
 *   GET    /api/guidance/packs                        → { packs: [...] }
 *   POST   /api/guidance/packs        {name, source, ref?, commit?, include?, refresh?}  (admin)
 *   POST   /api/guidance/packs/:name/sync                                               (admin)
 *   DELETE /api/guidance/packs/:name                                                    (admin)
 *
 * Every route sits behind the same middleware as /api/recall (API key or the
 * owner's OAuth token). The admin routes make the server fetch from the
 * network, so on top of auth the source must pass the HTTPS host allowlist in
 * spec.ts, and GUIDANCE_PACKS_ADMIN=off disables add/remove.
 *
 * The same handlers back the dashboard tab under /dashboard/api/guidance/*
 * (dashboard auth + CSRF, applied by the /dashboard mounts in index.ts).
 */
import type { Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import { GUIDANCE_PREAMBLE, addPack, getGuides, listPacks, removePack, searchGuidance, syncDeclaredPack } from './store.js';
import { adminEnabled, allowedHosts, parsePacksEnv } from './spec.js';
import { PackError } from './types.js';

interface Routable {
  get(path: string, ...handlers: RequestHandler[]): unknown;
  post(path: string, ...handlers: RequestHandler[]): unknown;
  delete(path: string, ...handlers: RequestHandler[]): unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function fail(res: Response, route: string, err: unknown): void {
  if (err instanceof PackError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error(`${route} failed`, { error: (err as Error).message });
  res.status(500).json({ error: (err as Error).message });
}

export function registerGuidanceRoutes(app: Routable, prefix: string, ...auth: RequestHandler[]): void {
  app.get(`${prefix}/search`, ...auth, async (req: Request, res: Response) => {
    try {
      const query = str(req.query.q) ?? str(req.query.query);
      if (!query) {
        res.status(400).json({ error: 'q required' });
        return;
      }
      const { results, packs, tookMs } = await searchGuidance(query, { pack: str(req.query.pack), limit: num(req.query.limit) });
      res.json({ note: GUIDANCE_PREAMBLE, results, packs, tookMs });
    } catch (err) {
      fail(res, `${prefix}/search`, err);
    }
  });

  app.get(`${prefix}/get`, ...auth, async (req: Request, res: Response) => {
    try {
      const ids = (str(req.query.id) ?? str(req.query.ids) ?? '').split(',');
      const guides = await getGuides(ids, {
        pack: str(req.query.pack),
        section: str(req.query.section),
        maxTokens: num(req.query.maxTokens),
      });
      res.status(guides.some((g) => g.found) ? 200 : 404).json({
        guides: guides.map(({ text: _text, ...meta }) => meta),
        text: guides.map((g) => g.text).join('\n\n'),
      });
    } catch (err) {
      fail(res, `${prefix}/get`, err);
    }
  });

  app.get(`${prefix}/packs`, ...auth, async (_req: Request, res: Response) => {
    try {
      // configErrors: rejected GUIDANCE_PACKS entries (never fatal at boot, so surfaced here).
      const configErrors = parsePacksEnv(process.env.GUIDANCE_PACKS).errors;
      res.json({ packs: await listPacks(), admin: adminEnabled(), allowedHosts: allowedHosts(), ...(configErrors.length ? { configErrors } : {}) });
    } catch (err) {
      fail(res, `${prefix}/packs`, err);
    }
  });

  app.post(`${prefix}/packs`, ...auth, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { spec, manifest } = await addPack(body, { sync: body.sync !== false });
      logger.info('Guidance pack added', { pack: spec.name, source: spec.source });
      res.json({ ok: true, pack: spec.name, manifest });
    } catch (err) {
      fail(res, `${prefix}/packs`, err);
    }
  });

  app.post(`${prefix}/packs/:name/sync`, ...auth, async (req: Request, res: Response) => {
    try {
      const manifest = await syncDeclaredPack(String(req.params.name));
      res.json({ ok: true, pack: manifest.name, manifest });
    } catch (err) {
      fail(res, `${prefix}/packs/:name/sync`, err);
    }
  });

  app.delete(`${prefix}/packs/:name`, ...auth, async (req: Request, res: Response) => {
    try {
      const result = await removePack(String(req.params.name));
      res.status(result.removed ? 200 : 404).json({ ok: result.removed, ...result });
    } catch (err) {
      fail(res, `${prefix}/packs/:name`, err);
    }
  });
}
