/**
 * Page + static asset routes.
 *
 * `GET /dashboard` → renderPage() (the HTML shell).
 * `GET /dashboard/assets/**` → static client assets (CSS + ES modules), served
 * from an inline registry read once at module load (Option A, ARCHITECTURE.md §2).
 *
 * Assets live in `src/dashboard/assets/` and must be present at the runtime path
 * `dist/dashboard/assets/` (the build copies them — see package.json `build`).
 * The path is resolved relative to this compiled module via `import.meta.url`,
 * so `dist/dashboard/routes/page.js` → `dist/dashboard/assets`.
 *
 * Auth: these routes are registered on `dashboardRouter`, which is mounted in
 * `index.ts` AFTER `app.use('/dashboard', dashboardAuthMiddleware)`, so assets
 * are gated for free. Nothing here is newly public.
 */
import type { Router, Request, Response } from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import { renderPage } from '../views/layout.js';
import { logger } from '../../lib/logger.js';

interface Asset { body: Buffer; contentType: string; }

const assetsDir = fileURLToPath(new URL('../assets', import.meta.url));

function contentTypeFor(file: string): string {
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

/** Recursively read every asset into a URL-path → Asset registry. */
function loadAssets(): Map<string, Asset> {
  const registry = new Map<string, Asset>();
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      logger.warn('Dashboard assets dir unreadable', { dir, error: String(err) });
      return;
    }
    for (const name of entries) {
      const full = nodePath.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        registry.set(rel, { body: readFileSync(full), contentType: contentTypeFor(name) });
      }
    }
  };
  walk(assetsDir, '');
  return registry;
}

const ASSETS = loadAssets();

export function registerPageRoutes(router: Router): void {
  // Static assets. The wildcard captures the path after /dashboard/assets/.
  router.get('/dashboard/assets/{*assetPath}', (req: Request, res: Response) => {
    const captured = (req.params as Record<string, string | string[]>).assetPath;
    const relPath = Array.isArray(captured) ? captured.join('/') : String(captured ?? '');
    // Normalize and reject traversal.
    const normalized = relPath.replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '');
    const asset = ASSETS.get(normalized);
    if (!asset) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.setHeader('Content-Type', asset.contentType);
    // `no-cache` = the browser MAY store the asset but MUST revalidate with the
    // server before reuse. Express auto-generates an ETag for the body and
    // returns 304 when unchanged, so this stays bandwidth-cheap while
    // guaranteeing a fresh module after every deploy. A hard `max-age` here was
    // the bug: the per-tab ES modules (e.g. intelligence.js) are statically
    // imported at bare URLs that never carry the `?v=` cache-bust token, so a
    // long TTL pinned the *old* JS even after the server HTML had updated.
    res.setHeader('Cache-Control', 'no-cache');
    res.send(asset.body);
  });

  // Dashboard page.
  router.get('/dashboard', (_req: Request, res: Response) => {
    res.type('html').send(renderPage());
  });
}
