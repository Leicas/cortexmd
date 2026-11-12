/**
 * SSE route — `GET /dashboard/events`. The single data spine, every 2 s.
 *
 * Cheap by construction (see model/payload.ts):
 *   - the payload is built ONCE per ~1.5 s and shared by every connected
 *     client (it used to be rebuilt per client per tick);
 *   - expensive sections (wakeUp, KG mention triples, entity registry, eval
 *     files, live dream health) sit behind TTL caches;
 *   - after the first full frame each client only receives the top-level
 *     sections whose JSON changed (`{_delta:true, …, _removed?}`); core.js
 *     merges them into its last payload.
 *
 * Every frame's build + encode time and size go into the perf ring
 * (`model/perf.ts`, `GET /dashboard/api/perf`).
 */
import type { Router, Request, Response } from 'express';
import { getSsePayloadSections, encodeSseFrame } from '../model/payload.js';
import { recordSseBuild } from '../model/perf.js';

export function registerSseRoutes(router: Router): void {
  router.get('/dashboard/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const lastSent = new Map<string, string>();
    const send = (): void => {
      const t0 = performance.now();
      const body = encodeSseFrame(getSsePayloadSections(), lastSent);
      recordSseBuild(performance.now() - t0, body.length);
      res.write('data: ' + body + '\n\n');
    };

    send();
    const interval = setInterval(send, 2000);

    req.on('close', () => {
      clearInterval(interval);
    });
  });
}
