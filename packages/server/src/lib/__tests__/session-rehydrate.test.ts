import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../../config.js';

// Import the real HTTP app without booting the server (no listen, no index build).
process.env.CORTEXMD_NO_AUTOSTART = '1';
const { __httpTestInternals: http } = await import('../../index.js');

let listener: Server;
let baseUrl: URL;
const original = { ...config };
const AUTH = { Authorization: `Bearer ${config.apiKey}` };

beforeAll(async () => {
  listener = http.app.listen(0);
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  baseUrl = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  Object.assign(config, original);
  for (const [, entry] of http.sessions) await entry.transport.close?.();
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

async function connectClient(sessionId?: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(baseUrl, { requestInit: { headers: AUTH }, sessionId });
  const client = new Client({ name: 'rehydrate-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Raw JSON-RPC POST carrying a session id the server has never seen. */
async function postWithSession(sessionId: string, body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify(body),
  });
}

describe('MCP session rehydration (no 404 after idle expiry)', () => {
  it('an idle-swept session id keeps working transparently and is tracked again', async () => {
    const { client, transport } = await connectClient();
    try {
      const sid = transport.sessionId!;
      expect(sid).toBeTruthy();
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect(http.sessions.has(sid)).toBe(true);

      // Simulate 30 min of idleness, then run the real idle sweep.
      (config as { sessionTimeoutMs: number }).sessionTimeoutMs = 1_000;
      http.sessions.get(sid)!.lastActivity = Date.now() - 60_000;
      http.cleanupSessions();
      expect(http.sessions.has(sid)).toBe(false);
      // Metadata retained (bounded) for the owner check / tool history.
      expect(http.persistedSessionMeta.has(sid)).toBe(true);

      // Same client, same session id: no 404, the call just works.
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('memory_recall');
      expect(transport.sessionId).toBe(sid);
      expect(http.sessions.has(sid)).toBe(true);
      expect(http.persistedSessionMeta.has(sid)).toBe(false);
    } finally {
      Object.assign(config, { sessionTimeoutMs: original.sessionTimeoutMs });
      await client.close();
    }
  });

  it('an unknown session id (e.g. issued before a restart) is adopted on a non-initialize request', async () => {
    const sid = `restart-${crypto.randomUUID()}`;
    const res = await postWithSession(sid, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('memory_recall');
    expect(res.headers.get('mcp-session-id')).toBe(sid);
    expect(http.sessions.has(sid)).toBe(true);
  });

  it('rehydrated sessions respect the LRU cap (no session leak)', async () => {
    (config as { maxActiveSessions: number }).maxActiveSessions = 2;
    try {
      const ids = [1, 2, 3, 4].map((i) => `lru-${i}-${crypto.randomUUID()}`);
      for (const sid of ids) {
        const res = await postWithSession(sid, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(res.status).toBe(200);
        await res.text();
        expect(http.sessions.size).toBeLessThanOrEqual(2);
      }
      expect(http.sessions.has(ids[3])).toBe(true);
      expect(http.sessions.has(ids[0])).toBe(false);
    } finally {
      Object.assign(config, { maxActiveSessions: original.maxActiveSessions });
    }
  });

  it('retained metadata stays within maxPersistedSessions', async () => {
    (config as { maxActiveSessions: number }).maxActiveSessions = 1;
    (config as { maxPersistedSessions: number }).maxPersistedSessions = 2;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await postWithSession(`cap-${i}-${crypto.randomUUID()}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
        await res.text();
      }
      expect(http.sessions.size).toBe(1);
      expect(http.persistedSessionMeta.size).toBeLessThanOrEqual(2);
    } finally {
      Object.assign(config, {
        maxActiveSessions: original.maxActiveSessions,
        maxPersistedSessions: original.maxPersistedSessions,
      });
    }
  });

  it('still 404s an id that cannot be adopted', async () => {
    const res = await postWithSession('bad id!', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(404);
  });

  it('still requires authentication', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': crypto.randomUUID() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
