/**
 * Hook/CLI-facing wakeup (GET|POST /api/wakeup). One round-trip, no MCP
 * session handshake, and exactly the `memory_wakeup` tool's result: it calls
 * the tool's own wrapped handler (`memoryWakeupHandler`), so the budget fit,
 * metrics and error shape are the tool's. Arguments are validated by
 * `parseWakeupParams` (the tool's zod schema does not run on this path).
 */
import { memoryWakeupHandler } from '../tools/memory-wakeup.js';

export const WAKEUP_PRESETS = ['tiny', 'standard', 'full'] as const;
export type WakeupPreset = (typeof WAKEUP_PRESETS)[number];

export interface WakeupApiParams {
  agentName?: string;
  preset?: WakeupPreset;
  project?: string;
  machine?: string;
  collection?: string;
}

export interface WakeupToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function str(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

/**
 * Normalize query-string (GET) or JSON-body (POST — what `cortexmd wakeup`
 * sends) parameters. An unknown preset throws `{ status: 400, message }`.
 */
export function parseWakeupParams(raw: Record<string, unknown>): WakeupApiParams {
  const out: WakeupApiParams = {};
  const preset = str(raw.preset);
  if (preset !== undefined) {
    if (!(WAKEUP_PRESETS as readonly string[]).includes(preset)) {
      throw Object.assign(new Error(`preset must be one of ${WAKEUP_PRESETS.join('|')}`), { status: 400 });
    }
    out.preset = preset as WakeupPreset;
  }
  for (const k of ['agentName', 'project', 'machine', 'collection'] as const) {
    const v = str(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Run `memory_wakeup` in-process and return its CallToolResult unchanged. */
export async function wakeupForApi(params: WakeupApiParams): Promise<WakeupToolResult> {
  return memoryWakeupHandler({ ...params }, { requestId: 'api-wakeup' });
}
