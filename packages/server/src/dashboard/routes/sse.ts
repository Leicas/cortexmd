/**
 * SSE route — `GET /dashboard/events`. The single data spine: pushes the full
 * `buildSsePayload()` object every 2 seconds. One stream, all tabs.
 * Lifted verbatim from the legacy `dashboard.ts` SSE handler (the payload
 * assembly moved to `model/payload.ts`).
 */
import type { Router, Request, Response } from 'express';
import { buildSsePayload } from '../model/payload.js';

export function registerSseRoutes(router: Router): void {
  router.get('/dashboard/events', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (): void => {
      const payload = buildSsePayload();
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    send();
    const interval = setInterval(send, 2000);

    _req.on('close', () => {
      clearInterval(interval);
    });
  });
}
