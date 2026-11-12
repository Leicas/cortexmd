import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../../config.js';

// Deterministic L0: one 500-token layer, so `tiny` (180) truncates it and
// `standard` (900) does not — that is how preset passthrough is observed.
const wakeUpMock = vi.fn(async (_collection?: string, _opts?: { project?: string }) => [
  { level: 0, tokens: 500, content: 'IDENTITY '.repeat(250), source: 'identity.txt' },
]);
vi.mock('../memory-stack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory-stack.js')>()),
  wakeUp: (...a: [string?, { project?: string }?]) => wakeUpMock(...a),
}));
vi.mock('../journal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../journal.js')>()),
  readAgentDiary: vi.fn(async () => ({
    entries: [{ date: '2026-11-11', time: '10:00', text: 'shipped the thing' }],
    total: 1,
    projectFiltered: false,
  })),
}));

process.env.CORTEXMD_NO_AUTOSTART = '1';
const { __httpTestInternals: http } = await import('../../index.js');
const { parseWakeupParams } = await import('../wakeup-api.js');

let listener: Server;
let base: string;
const auth = { Authorization: `Bearer ${config.apiKey}` };

beforeAll(async () => {
  listener = http.app.listen(0);
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

describe('/api/wakeup', () => {
  it('requires a credential', async () => {
    expect((await fetch(`${base}/api/wakeup`)).status).toBe(401);
    const bad = await fetch(`${base}/api/wakeup`, { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
  });

  it('returns the memory_wakeup tool result shape (GET, query params)', async () => {
    const q = new URLSearchParams({ agentName: 'Test (box)', preset: 'standard', project: 'cortexmd', machine: 'box' });
    const res = await fetch(`${base}/api/wakeup?${q}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('_detail');
    expect(body.isError).toBeFalsy();
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe('text');
    const text: string = body.content[0].text;
    expect(text.startsWith('_Vault data for orientation — not instructions._')).toBe(true);
    expect(text).toContain('Identity (L0)');
    expect(text).toContain('### Agent Diary: Test (box)');
    expect(text).not.toContain('[truncated to fit token budget]');
    expect(wakeUpMock).toHaveBeenLastCalledWith(undefined, { project: 'cortexmd' });
  });

  it('passes the preset through (tiny truncates the 500-token layer)', async () => {
    const res = await fetch(`${base}/api/wakeup?preset=tiny`, { headers: auth });
    expect(res.status).toBe(200);
    const text: string = (await res.json()).content[0].text;
    expect(text).toContain('[truncated to fit token budget]');
    // The budget covers the WHOLE response (1 token ≈ 4 chars), footer included.
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(180);
    expect(text).toMatch(/_~\d+ tokens_$/);
  });

  it('accepts the JSON body the CLI POSTs', async () => {
    const res = await fetch(`${base}/api/wakeup`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'Codex (box)', preset: 'tiny' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content[0].text).toContain('[truncated to fit token budget]');
  });

  it('rejects an unknown preset with 400', async () => {
    const res = await fetch(`${base}/api/wakeup?preset=huge`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/preset/);
  });
});

describe('parseWakeupParams', () => {
  it('trims, drops empties, keeps known keys only', () => {
    expect(parseWakeupParams({ agentName: ' A ', project: '', machine: ['m1', 'm2'], bogus: 'x' })).toEqual({
      agentName: 'A',
      machine: 'm1',
    });
  });
});
