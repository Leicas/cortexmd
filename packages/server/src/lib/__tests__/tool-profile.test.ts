import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  applyToolProfile,
  parseToolProfile,
  profileMembership,
  profileToolNames,
  DEFAULT_TOOL_PROFILE,
} from '../tool-profile.js';

// Core retains the I-6 set, the explicit bounded worker entry point and the
// tool_invoke dispatcher: TINY (6) + NAV_EXTRAS (9) + CORE_EXTRAS (17) +
// CLI/hook dependencies (7) + tool_invoke = 40.
const CORE_I6 = [
  // tiny
  'notes_search', 'memory_recall', 'memory_store', 'code_symbol_search', 'code_file_outline', 'tool_search',
  // nav
  'worker_run',
  'code_symbol_get', 'code_symbol_callers', 'code_symbol_callees', 'code_change_impact',
  'code_full_context', 'code_audit_file', 'code_repo_list', 'code_project_symbol',
  // core
  'memory_consolidate', 'memory_wakeup', 'memory_dream', 'memory_promote',
  'notes_get', 'notes_list', 'notes_upsert', 'notes_archive',
  'journal_append', 'brief_daily', 'agent_diary_append', 'agent_diary_read',
  'graph_neighbors', 'graph_traverse', 'graph_stats', 'tags_list', 'check_duplicate',
  // CLI / hook dependencies
  'kg_query', 'diary_write', 'diary_read',
  'code_index_repo', 'code_ingest_repo', 'code_index_requests_poll', 'code_savings_push',
  // dispatcher for whatever the profile hides
  'tool_invoke',
].sort();

// Default profile: the tools the shipped hooks + instruction templates name.
const STANDARD = [
  'memory_wakeup', 'memory_recall', 'memory_store',
  'notes_search', 'notes_get', 'notes_upsert',
  'agent_diary_append', 'agent_diary_read',
  'code_repo_list', 'code_file_outline', 'code_symbol_search', 'code_symbol_get',
  'code_symbol_callers', 'code_symbol_callees', 'code_change_impact', 'code_call_chain',
  'tool_search', 'tool_invoke',
].sort();

const HIDDEN_SAMPLE = ['tags_merge', 'kg_add', 'graph_orphans', 'notes_delete', 'entity_detect', 'vault_status'];

function registerDummyTools(server: McpServer, names: string[]): void {
  for (const name of names) {
    server.tool(name, `dummy ${name}`, {}, async () => ({
      content: [{ type: 'text' as const, text: `ok:${name}` }],
    }));
  }
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('parseToolProfile', () => {
  it('defaults to standard (lean surface) unless a profile is explicitly chosen', () => {
    expect(DEFAULT_TOOL_PROFILE).toBe('standard');
    expect(parseToolProfile('full')).toBe('full');
    expect(parseToolProfile('')).toBe('standard');
    expect(parseToolProfile(undefined)).toBe('standard');
    expect(parseToolProfile('bogus')).toBe('standard');
  });

  it('honours an explicit profile', () => {
    expect(parseToolProfile('FULL')).toBe('full');
    expect(parseToolProfile(' core ')).toBe('core');
    expect(parseToolProfile('tiny')).toBe('tiny');
    expect(parseToolProfile('lean')).toBe('lean');
    expect(parseToolProfile('nav')).toBe('nav');
    expect(parseToolProfile('standard')).toBe('standard');
    expect(parseToolProfile('ChatGPT')).toBe('chatgpt');
  });
});

describe('profile membership', () => {
  it('core is exactly the I-6 set plus bounded worker execution and tool_invoke (40 tools)', () => {
    expect(profileToolNames('core')).toEqual(CORE_I6);
    expect(profileMembership('core')!.size).toBe(40);
  });

  it('standard is the hook/template surface; chatgpt adds search + fetch', () => {
    expect(profileToolNames('standard')).toEqual(STANDARD);
    expect(profileToolNames('chatgpt')).toEqual([...STANDARD, 'fetch', 'search'].sort());
  });

  it('every reduced profile advertises tool_invoke so hidden tools stay reachable', () => {
    for (const p of ['tiny', 'nav', 'standard', 'chatgpt', 'core', 'lean'] as const) {
      expect(profileMembership(p)!.has('tool_invoke')).toBe(true);
    }
  });

  it('profiles nest: tiny ⊂ nav ⊂ core ⊂ lean; full is unbounded', () => {
    const tiny = profileMembership('tiny')!;
    const nav = profileMembership('nav')!;
    const core = profileMembership('core')!;
    const lean = profileMembership('lean')!;
    for (const n of tiny) expect(nav.has(n)).toBe(true);
    for (const n of nav) expect(core.has(n)).toBe(true);
    for (const n of core) expect(lean.has(n)).toBe(true);
    expect(tiny.size).toBe(7);
    expect(nav.size).toBe(16);
    expect(tiny.has('worker_run')).toBe(false);
    expect(nav.has('worker_run')).toBe(true);
    expect(lean.size).toBeGreaterThan(core.size);
    expect(profileMembership('full')).toBeNull();
    expect(profileToolNames('full')).toBeNull();
  });
});

describe('applyToolProfile (lazy loading: hidden but callable)', () => {
  it('tools/list returns exactly the I-6 set under core, and a hidden tool is still callable', async () => {
    const server = new McpServer({ name: 'cortexmd-test', version: '0.0.0' });
    registerDummyTools(server, [...CORE_I6, ...HIDDEN_SAMPLE]);

    const result = applyToolProfile(server, 'core');
    expect(result.profile).toBe('core');
    expect(result.kept).toBe(40);
    expect(result.hidden).toBe(HIDDEN_SAMPLE.length);
    expect(result.disabled).toBe(0);

    // Nothing is disabled at the SDK level.
    const reg = (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
    for (const name of [...CORE_I6, ...HIDDEN_SAMPLE]) expect(reg[name].enabled).toBe(true);

    const client = await connect(server);
    try {
      // (a) tools/list is the I-6 set — exactly.
      const listed = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(listed).toEqual(CORE_I6);
      for (const hidden of HIDDEN_SAMPLE) expect(listed).not.toContain(hidden);

      // The advertised entries still carry a JSON-Schema inputSchema (we only filter).
      const search = (await client.listTools()).tools.find((t) => t.name === 'notes_search');
      expect(search?.inputSchema).toMatchObject({ type: 'object' });

      // (b) a hidden tool is still callable.
      const res = await client.callTool({ name: 'tags_merge', arguments: {} });
      expect(res.isError).toBeFalsy();
      expect((res.content as Array<{ text: string }>)[0].text).toBe('ok:tags_merge');

      // …and so is an advertised one.
      const res2 = await client.callTool({ name: 'memory_recall', arguments: {} });
      expect((res2.content as Array<{ text: string }>)[0].text).toBe('ok:memory_recall');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('full advertises everything', async () => {
    const server = new McpServer({ name: 'cortexmd-test', version: '0.0.0' });
    registerDummyTools(server, ['notes_search', 'tags_merge']);
    const result = applyToolProfile(server, 'full');
    expect(result).toEqual({ profile: 'full', kept: 2, hidden: 0, disabled: 0 });
    const client = await connect(server);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(listed).toEqual(['notes_search', 'tags_merge']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('re-enables tools an older build may have disabled', async () => {
    const server = new McpServer({ name: 'cortexmd-test', version: '0.0.0' });
    registerDummyTools(server, ['notes_search', 'tags_merge']);
    const reg = (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
    reg.tags_merge.enabled = false;
    applyToolProfile(server, 'tiny');
    expect(reg.tags_merge.enabled).toBe(true);
    const client = await connect(server);
    try {
      const res = await client.callTool({ name: 'tags_merge', arguments: {} });
      expect(res.isError).toBeFalsy();
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).toEqual(['notes_search']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
