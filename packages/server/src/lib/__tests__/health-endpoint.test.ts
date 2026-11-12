import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../../config.js';
import { setIndexState } from '../index-state.js';

// Import the real HTTP app without booting the server (no listen, no index build).
process.env.CORTEXMD_NO_AUTOSTART = '1';
const { __httpTestInternals: http } = await import('../../index.js');

let listener: Server;
let base: string;

beforeAll(async () => {
  listener = http.app.listen(0);
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setIndexState('not_started');
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

describe('/health', () => {
  it('is a minimal liveness payload without credentials', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['commit', 'status', 'version']);
    expect(body.version).toBe(config.appVersion);
    expect(body).not.toHaveProperty('heap');
    expect(body).not.toHaveProperty('restarts');
  });

  it('a wrong bearer gets the minimal payload too (no 401, no detail)', async () => {
    const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('sessions');
  });

  it('returns the full I-1 detail (cortexmd status / HUD fields) with the API key', async () => {
    const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    const body = await res.json();
    for (const k of ['status', 'version', 'commit', 'uptime', 'activeSessions', 'indexedNotes', 'heap', 'sessions', 'lastIndexUpdate', 'restarts', 'index']) {
      expect(body, k).toHaveProperty(k);
    }
    expect(body.heap).toMatchObject({ usedMb: expect.any(Number), limitMb: expect.any(Number), warnPct: config.heapWarnPct });
    expect(typeof body.heap.warn).toBe('boolean');
    expect(body.sessions).toHaveProperty('maxActive');
  });

  it('reports `indexing` while the boot index build runs, `ok` once ready', async () => {
    setIndexState('indexing');
    expect((await (await fetch(`${base}/health`)).json()).status).toBe('indexing');
    setIndexState('ready');
    expect((await (await fetch(`${base}/health`)).json()).status).toBe('ok');
  });
});
