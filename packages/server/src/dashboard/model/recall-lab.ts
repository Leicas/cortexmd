/**
 * Recall Lab — playground model. Runs EXACTLY the `memory_recall` tool path
 * (`runMemoryRecall`) with `explain: true` and `touch: false`, so a query typed
 * into the dashboard never bumps access counts or co-recall state (the
 * no-touch seam in src/tools/memory-recall.ts). Search metrics
 * (recordSearchQuery / arm breakdown) ARE still recorded by that path, so
 * playground queries show up in the Retrieval tab's recent-query strips.
 *
 * Each result gets a `bars` breakdown — one row per ranking signal, with a
 * normalized 0..1 `value` for the bar AND a human `text` so the "why it
 * surfaced" view is readable without colour or hover.
 */
import { runMemoryRecall } from '../../tools/memory-recall.js';
import { normalizeCentrality } from '../../lib/recall-signals.js';
import type { RescoredResult, RecallTimeInfo } from '../../lib/memory.js';

export interface RecallLabParams {
  query: string;
  limit?: number;
  categories?: string[];
  temperature?: string;
  minImportance?: string;
  relatedTo?: string[];
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  contextSnippet?: string;
  /** Memory kinds (episodic / semantic / procedural), strict — as the tool's `kinds`. */
  kinds?: string[];
  /** As the tool's `includeEpisodic` (undefined = default tiering). */
  includeEpisodic?: boolean;
}

export interface SignalBar {
  key: 'lexical' | 'semantic' | 'graph' | 'heat' | 'importance' | 'recency' | 'centrality' | 'coRecall' | 'stale';
  label: string;
  /** 0..1 bar length, or null when the signal is unavailable for this result. */
  value: number | null;
  /** Readable value text (never colour-only). */
  text: string;
  /** Marks a penalising signal (stale) so the UI can style + label it. */
  negative?: boolean;
}

export interface RecallLabResult {
  rank: number;
  path: string;
  title: string;
  category: string;
  temperature: string;
  importance: string;
  score: number;
  archived: boolean;
  consolidatedInto?: string;
  snippet: string;
  reason: string;
  match: string;
  bars: SignalBar[];
}

const IMPORTANCE_VALUE: Record<string, number> = { low: 0.25, medium: 0.5, high: 0.75, critical: 1 };
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Clamp list-ish input (array or comma string) to a trimmed string array. */
export function toList(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** Normalize a raw request body / query string into RecallLabParams. */
export function parseRecallLabParams(raw: Record<string, unknown>): RecallLabParams {
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v == null) return undefined;
    const s = String(Array.isArray(v) ? v[0] : v).trim();
    return s ? s : undefined;
  };
  const limitN = parseInt(String(raw.limit ?? '10'), 10);
  return {
    query: str('query') ?? str('q') ?? '',
    limit: Number.isFinite(limitN) ? Math.min(Math.max(limitN, 1), 50) : 10,
    categories: toList(raw.categories ?? raw.category),
    temperature: str('temperature') ?? 'any',
    minImportance: str('minImportance'),
    relatedTo: toList(raw.relatedTo),
    tags: toList(raw.tags),
    dateFrom: str('dateFrom'),
    dateTo: str('dateTo'),
    asOf: str('asOf'),
    contextSnippet: str('contextSnippet'),
    kinds: toList(raw.kinds),
    includeEpisodic: raw.includeEpisodic === true || raw.includeEpisodic === 'true' ? true
      : raw.includeEpisodic === false || raw.includeEpisodic === 'false' ? false : undefined,
  };
}

/** Build the per-result signal bars. Lexical/semantic/graph are normalized against the set max. */
export function buildSignalBars(r: RescoredResult, maxes: { lex: number; sem: number; graph: number }): SignalBar[] {
  const s = r.signals;
  const graphRaw = graphContribution(r);
  const bars: SignalBar[] = [];
  bars.push({
    key: 'lexical', label: 'Lexical',
    value: maxes.lex > 0 ? r.lexicalScore / maxes.lex : 0,
    text: r.lexicalScore > 0 ? r3(r.lexicalScore).toString() : 'no match',
  });
  bars.push({
    key: 'semantic', label: 'Semantic',
    value: maxes.sem > 0 ? r.semanticScore / maxes.sem : 0,
    text: r.semanticScore > 0 ? r3(r.semanticScore).toString() : 'no match',
  });
  bars.push({
    key: 'graph', label: 'Graph',
    value: graphRaw == null ? null : maxes.graph > 0 ? graphRaw / maxes.graph : 0,
    text: graphRaw == null ? 'n/a' : graphRaw > 0 ? r3(graphRaw).toString() : 'none',
  });
  const heat = s?.heatScore;
  bars.push({
    key: 'heat', label: 'Heat',
    value: typeof heat === 'number' ? Math.min(Math.max(heat, 0), 16) / 16 : null,
    text: typeof heat === 'number' ? `${r3(heat)} / 16 · ${r.temperature}` : r.temperature,
  });
  bars.push({
    key: 'importance', label: 'Importance',
    value: IMPORTANCE_VALUE[r.importance] ?? 0.5,
    text: r.importance,
  });
  bars.push({
    key: 'recency', label: 'Recency',
    value: s ? s.recency : null,
    text: s ? `${Math.round(s.recency * 100)}%` : 'n/a',
  });
  bars.push({
    key: 'centrality', label: 'Centrality',
    value: s ? normalizeCentrality(s.inboundLinks) : null,
    text: s ? `${s.inboundLinks} inbound link${s.inboundLinks === 1 ? '' : 's'}` : 'n/a',
  });
  bars.push({
    key: 'coRecall', label: 'Co-recall',
    value: s?.coRecall ? Math.min(s.coRecall / 0.5, 1) : 0,
    text: s?.coRecall ? `+${Math.round(s.coRecall * 100)}%` : 'none',
  });
  const validity = s?.validity;
  bars.push({
    key: 'stale', label: 'Stale',
    value: s?.stale ? 1 : 0,
    text: s?.stale
      ? `stale — rank halved${validity != null ? ` (validity ${validity})` : ''}`
      : validity != null ? `no (validity ${validity})` : 'no',
    negative: true,
  });
  return bars;
}

/** Graph-arm RRF share: explicit graphScore when present, else fused − lexical − semantic. */
function graphContribution(r: RescoredResult): number | null {
  const explicit = (r as RescoredResult & { graphScore?: number }).graphScore;
  if (typeof explicit === 'number') return explicit;
  if (typeof r.fusedScore !== 'number') return null;
  const g = r.fusedScore - r.lexicalScore - r.semanticScore;
  return g > 1e-6 ? g : 0;
}

export async function runRecallLab(params: RecallLabParams): Promise<{
  query: string; tookMs: number; results: RecallLabResult[]; time?: RecallTimeInfo;
}> {
  const t0 = Date.now();
  const { results, time } = await runMemoryRecall(
    { ...params, explain: true, includeContent: false },
    { touch: false },
  );
  const maxes = { lex: 0, sem: 0, graph: 0 };
  for (const r of results) {
    maxes.lex = Math.max(maxes.lex, r.lexicalScore || 0);
    maxes.sem = Math.max(maxes.sem, r.semanticScore || 0);
    maxes.graph = Math.max(maxes.graph, graphContribution(r) ?? 0);
  }
  return {
    query: params.query,
    tookMs: Date.now() - t0,
    ...(time ? { time } : {}),
    results: results.map((r, i) => ({
      rank: i + 1,
      path: r.path,
      title: r.title,
      category: r.category,
      temperature: r.temperature,
      importance: r.importance,
      score: r3(r.score),
      archived: !!r.archived,
      consolidatedInto: r.consolidatedInto,
      snippet: r.snippet,
      reason: r.signals?.reason ?? '',
      match: r.signals?.match ?? '',
      bars: buildSignalBars(r, maxes),
    })),
  };
}
