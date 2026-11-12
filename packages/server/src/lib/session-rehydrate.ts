/**
 * Transparent recovery of an unknown / expired MCP session id.
 *
 * The Streamable HTTP spec lets a server keep a session alive as long as it
 * likes; it only requires 404 once the server has *terminated* it. cortexmd's
 * per-session state is disposable (a fresh McpServer + transport — tools are
 * stateless across calls), so instead of answering 404 after the 30-min idle
 * sweep or a restart, index.ts treats the presented id as still valid: it
 * builds a new server, primes the transport under the SAME id with an
 * in-process initialize handshake, then serves the client's request on it.
 * Clients that never handle 404 (or handle it by failing the tool call) keep
 * working; the idle sweep / LRU cap / persisted cap still bound memory because
 * the rehydrated session is registered like any other.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

/** Session ids we are willing to adopt: what clients get from us (UUIDs) and similar opaque tokens. */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function isAdoptableSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

interface WebStandardTransportLike {
  handleRequest(req: Request, opts?: unknown): Promise<Response>;
  sessionId?: string;
}

/**
 * Create a transport + server bound to `sessionId`, already initialized.
 * Returns null when the id is not adoptable or the SDK internals needed for
 * priming are missing (the caller then falls back to the spec 404).
 */
export async function rehydrateTransport(
  sessionId: string,
  createServer: () => McpServer,
  protocolVersionHeader?: string,
): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer } | null> {
  if (!isAdoptableSessionId(sessionId)) return null;

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
  const web = (transport as unknown as { _webStandardTransport?: WebStandardTransportLike })._webStandardTransport;
  if (!web || typeof web.handleRequest !== 'function') {
    logger.warn('Session rehydrate unavailable: SDK transport internals changed');
    return null;
  }

  const server = createServer();
  await server.connect(transport);

  const protocolVersion =
    protocolVersionHeader && SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersionHeader)
      ? protocolVersionHeader
      : LATEST_PROTOCOL_VERSION;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  try {
    const initRes = await web.handleRequest(
      new Request('http://cortexmd.internal/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '__cortexmd_rehydrate__',
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'cortexmd-session-rehydrate', version: '1' },
          },
        }),
      }),
    );
    // Drain the (SSE or JSON) initialize response so the stream mapping is released.
    await initRes.text();
    if (!initRes.ok || web.sessionId !== sessionId) throw new Error(`initialize returned HTTP ${initRes.status}`);

    const notifyRes = await web.handleRequest(
      new Request('http://cortexmd.internal/mcp', {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    );
    await notifyRes.text();
  } catch (err) {
    logger.warn('Session rehydrate failed', { error: err instanceof Error ? err.message : String(err) });
    try { await transport.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    return null;
  }

  return { transport, server };
}
