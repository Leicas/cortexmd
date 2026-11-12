/**
 * Recall Lab - wakeup inspector model. Calls `runMemoryWakeup`
 * (src/tools/memory-wakeup.ts), the single implementation behind the
 * `memory_wakeup` tool and `/api/wakeup`, and returns its STRUCTURED layers
 * (+ the notes that feed L1) instead of the rendered markdown, so the
 * dashboard shows per-layer token bars against exactly the budget an agent
 * gets. Read-only: it never writes to the vault and records no tool metrics.
 */
import { listAgentNames } from '../../lib/journal.js';
import { runMemoryWakeup, WAKEUP_PRESETS, type WakeupLayerInfo, type WakeupPresetName } from '../../tools/memory-wakeup.js';
import { getDocMeta } from '../../lib/search.js';

/** Whole-response token budget per preset (from the tool's own table). */
export const PRESET_BUDGET: Record<WakeupPresetName, number> = {
  tiny: WAKEUP_PRESETS.tiny.budget,
  standard: WAKEUP_PRESETS.standard.budget,
  full: WAKEUP_PRESETS.full.budget,
};
export type WakeupPreset = WakeupPresetName;

/** A wakeup layer as the tool rendered it (see WakeupLayerInfo). */
export type WakeupLayerView = WakeupLayerInfo;

export interface WakeupPreview {
  preset: WakeupPreset;
  budget: number;
  agentName?: string;
  project?: string;
  /** Tokens of the whole rendered response (headers and footer included). */
  totalTokens: number;
  /** Tokens of the layers that count against the budget (content only). */
  budgetTokens: number;
  layers: WakeupLayerView[];
  l1Notes: Array<{ path: string; title: string; temperature?: string; heat?: number; category?: string }>;
  diaryFiltered: boolean;
}

/** `[[path|title]]` / `[[path]]` → unique vault paths (with `.md`). */
export function extractL1Notes(content: string): Array<{ path: string; title: string }> {
  const out: Array<{ path: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    const raw = m[1].trim();
    const path = raw.endsWith('.md') ? raw : `${raw}.md`;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, title: (m[2] ?? raw.split('/').pop() ?? raw).trim() });
  }
  return out;
}

export async function buildWakeupPreview(opts: {
  preset?: string; agentName?: string; project?: string; collection?: string;
}): Promise<WakeupPreview> {
  const preset: WakeupPreset = (opts.preset && opts.preset in PRESET_BUDGET ? opts.preset : 'standard') as WakeupPreset;
  const budget = PRESET_BUDGET[preset];
  const project = opts.project?.trim() || undefined;
  const agentName = opts.agentName?.trim() || undefined;

  const { layers, totalTokens, diaryFiltered } = await runMemoryWakeup({
    preset, agentName, project, collection: opts.collection || undefined,
  });
  const budgetTokens = layers.filter((l) => l.inBudget).reduce((n, l) => n + l.tokens, 0);

  // Notes that feed L1 — the [[links]] the narrative actually emitted, in the
  // shown (possibly truncated) text, enriched from the index.
  const l1 = layers.find((l) => l.source === 'top-memories');
  const dm = getDocMeta();
  const l1Notes = l1 ? extractL1Notes(l1.content).map((n) => {
    const meta = dm.get(n.path);
    return { ...n, title: meta?.title ?? n.title, temperature: meta?.temperature, heat: meta?.heat_score, category: meta?.category };
  }) : [];

  return { preset, budget, agentName, project, totalTokens, budgetTokens, layers, l1Notes, diaryFiltered };
}

/** Selector options: known diary agents + `Projects/*` slugs from the index. */
export async function wakeupOptions(): Promise<{ agents: string[]; projects: string[]; presets: Record<string, number> }> {
  let agents: string[] = [];
  try { agents = await listAgentNames(); } catch { /* none */ }
  const projects = new Set<string>();
  for (const p of getDocMeta().keys()) {
    const m = /^Projects\/([^/]+)\.md$/i.exec(p) ?? /^Projects\/([^/]+)\//i.exec(p);
    if (m) projects.add(m[1]);
  }
  return { agents: agents.sort(), projects: [...projects].sort().slice(0, 300), presets: { ...PRESET_BUDGET } };
}
