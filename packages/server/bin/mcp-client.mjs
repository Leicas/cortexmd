// Minimal streamable-HTTP MCP client used by code-index.mjs.
// Performs the two-step handshake: initialize (capture mcp-session-id) → tools/call.
// Designed to stay <80 lines; no third-party deps.

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

/** Parse a streamable-HTTP MCP response body (either JSON or SSE-style). */
async function parseMcpResponse(res) {
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ctype.includes('text/event-stream')) {
    // SSE — find the data: lines and JSON-parse each, return the first that has a result/error.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.result || parsed.error || parsed.jsonrpc) return parsed;
      } catch { /* skip non-json data lines */ }
    }
    throw new Error(`MCP SSE response had no JSON-RPC payload: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`MCP response was not JSON (${ctype}): ${text.slice(0, 200)}`);
  }
}

/**
 * Create an MCP session: send `initialize`, capture mcp-session-id header.
 * Returns { sessionId, initializeResult }.
 */
export async function mcpInitialize({ url, apiKey }) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cortexmd-code-index', version: '1.0.0' },
    },
  };
  const res = await fetch(`${url.replace(/\/+$/, '')}/mcp`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MCP initialize failed: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('MCP initialize succeeded but no mcp-session-id header was returned. Server transport behavior may have changed.');
  }
  const parsed = await parseMcpResponse(res);
  if (parsed.error) {
    throw new Error(`MCP initialize error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  return { sessionId, initializeResult: parsed.result };
}

/** Call a tool on an open MCP session. */
export async function mcpToolsCall({ url, apiKey, sessionId, toolName, args }) {
  const body = {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: toolName, arguments: args },
  };
  const res = await fetch(`${url.replace(/\/+$/, '')}/mcp`, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Authorization': `Bearer ${apiKey}`, 'mcp-session-id': sessionId },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MCP tools/call failed: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  const parsed = await parseMcpResponse(res);
  if (parsed.error) {
    throw new Error(`Tool error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}
