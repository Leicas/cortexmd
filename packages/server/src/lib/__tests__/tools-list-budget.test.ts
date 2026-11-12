import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../mcp-server.js';
import { applyToolProfile, DEFAULT_TOOL_PROFILE, parseToolProfile } from '../tool-profile.js';
import { register as registerToolInvoke } from '../../tools/tool-invoke.js';

/**
 * Manifest budget for the DEFAULT profile: the serialized `tools/list` result
 * is what every client without tool deferral pays per session. ~4 chars/token,
 * so 24k chars ≈ 6k tokens. Measured when introduced: ~20.4k chars (18 tools),
 * versus ~87k chars (86 tools) when `full` was the default.
 */
const DEFAULT_TOOLS_LIST_BUDGET_CHARS = 24_000;

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'budget-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
}

describe('default tools/list', () => {
  it('unset profile resolves to standard', () => {
    expect(parseToolProfile(undefined)).toBe('standard');
    expect(DEFAULT_TOOL_PROFILE).toBe('standard');
  });

  it('is the standard surface and stays within the token budget', async () => {
    const server = createServer({ profile: DEFAULT_TOOL_PROFILE, searchFetch: false });
    const client = await connect(server);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toMatchInlineSnapshot(`
        [
          "agent_diary_append",
          "agent_diary_read",
          "code_call_chain",
          "code_change_impact",
          "code_file_outline",
          "code_repo_list",
          "code_symbol_callees",
          "code_symbol_callers",
          "code_symbol_get",
          "code_symbol_search",
          "memory_recall",
          "memory_store",
          "memory_wakeup",
          "notes_get",
          "notes_search",
          "notes_upsert",
          "tool_invoke",
          "tool_search",
        ]
      `);
      const size = JSON.stringify(result).length;
      expect(size, `default tools/list is ${size} chars`).toBeLessThan(DEFAULT_TOOLS_LIST_BUDGET_CHARS);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('full advertises every registered tool (TOOL_PROFILE=full restores the old surface)', async () => {
    const server = createServer({ profile: 'full', searchFetch: false });
    const client = await connect(server);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(80);
      expect(names).toContain('kg_query');
      expect(names).not.toContain('search');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('chatgpt profile adds search + fetch', async () => {
    const server = createServer({ profile: 'chatgpt' });
    const client = await connect(server);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('search');
      expect(names).toContain('fetch');
      expect(names).toContain('memory_recall');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('tool_invoke (reach hidden tools from tools/list-only clients)', () => {
  it('validates against the hidden tool\'s real zod schema (real registry)', async () => {
    const server = createServer({ profile: 'standard', searchFetch: false });
    const client = await connect(server);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).not.toContain('kg_query');
      // kg_query requires `entity`; omitting it must fail validation in the SDK.
      const res = await client.callTool({ name: 'tool_invoke', arguments: { name: 'kg_query', arguments: {} } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Invalid arguments for tool kg_query/);

      const unknown = await client.callTool({ name: 'tool_invoke', arguments: { name: 'no_such_tool' } });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/unknown tool/);

      const self = await client.callTool({ name: 'tool_invoke', arguments: { name: 'tool_invoke' } });
      expect(self.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('vault_hygiene is hidden under standard but reachable via tool_search + tool_invoke', async () => {
    const server = createServer({ profile: 'standard', searchFetch: false });
    const client = await connect(server);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).not.toContain('vault_hygiene');

      const found = await client.callTool({
        name: 'tool_search',
        arguments: { query: 'vault hygiene', top_k: 5, include_schema: true },
      });
      expect(found.isError).toBeFalsy();
      const hit = (JSON.parse(text(found)).results as Array<{ name: string; inputSchema?: unknown }>)
        .find((r) => r.name === 'vault_hygiene');
      expect(hit, text(found)).toBeDefined();
      expect(hit!.inputSchema).toMatchObject({ type: 'object' });

      // Dispatch reaches the real tool: its zod schema rejects sample > 200
      // (validation fails before the handler, so no vault is read).
      const res = await client.callTool({
        name: 'tool_invoke',
        arguments: { name: 'vault_hygiene', arguments: { sample: 999 } },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Invalid arguments for tool vault_hygiene/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('dispatches to a hidden tool with parsed (defaulted) arguments', async () => {
    const server = new McpServer({ name: 'invoke-test', version: '0.0.0' });
    server.tool('visible', 'v', {}, async () => ({ content: [{ type: 'text' as const, text: 'v' }] }));
    server.tool(
      'hidden_echo',
      'echo',
      { word: z.string(), times: z.number().optional().default(2) },
      async (args) => ({ content: [{ type: 'text' as const, text: args.word.repeat(args.times) }] }),
    );
    registerToolInvoke(server);
    applyToolProfile(server, 'tiny'); // advertises tool_invoke, hides hidden_echo
    const client = await connect(server);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).toEqual(['tool_invoke']);
      const ok = await client.callTool({
        name: 'tool_invoke',
        arguments: { name: 'hidden_echo', arguments: { word: 'ab' } },
      });
      expect(ok.isError).toBeFalsy();
      expect(text(ok)).toBe('abab');

      const bad = await client.callTool({
        name: 'tool_invoke',
        arguments: { name: 'hidden_echo', arguments: { word: 3 } },
      });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/Invalid arguments for tool hidden_echo/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
