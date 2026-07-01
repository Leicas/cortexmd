/**
 * `eval-report-reader.ts` — pure fs readers for the persisted eval artifacts the
 * Retrieval tab's "Recall Quality" panel surfaces. The eval harness
 * (`src/eval/index.ts`, run out-of-band) writes two files into the data dir:
 *
 *   - `<dataDir>/eval-report.json`   — the LAST report (arm-compare, headline
 *                                      metrics). Shape: {@link PersistedEvalReport}.
 *   - `<dataDir>/eval-history.jsonl` — one headline row per run (append-only),
 *                                      so the trend line has durable history
 *                                      without unbounded growth. Reader tails
 *                                      the last {@link HISTORY_TAIL} lines.
 *
 * Both readers are tolerant of missing / malformed files (return null / []),
 * because the eval is an offline step that may never have run. `buildSsePayload`
 * calls them once per tick — cheap (a few KB JSON), same `config.dataDir`
 * convention the metrics persistence already uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RetrievalPayload, RetrievalQualityArm } from '../payload.types.js';

/** The on-disk shape of `<dataDir>/eval-report.json`. Written by src/eval/index.ts. */
export interface PersistedEvalReport {
  ranAt: number;
  mode: 'temporal' | 'real-vault';
  k: number;
  arms: RetrievalQualityArm[];
}

/** One line of `<dataDir>/eval-history.jsonl`. */
export interface EvalHistoryRow {
  ranAt: number;
  recallAtK: number;
  pointInTimeAccuracy: number;
  staleLeakRate: number;
}

export const EVAL_REPORT_FILE = 'eval-report.json';
export const EVAL_HISTORY_FILE = 'eval-history.jsonl';
/** How many trailing history rows the trend line consumes. */
export const HISTORY_TAIL = 30;

const VALID_ARMS = new Set(['baseline', 'bitemporal', 'ppr', 'ppr-bitemporal']);

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** Coerce one raw arm object into a typed {@link RetrievalQualityArm} (or null if unusable). */
function coerceArm(raw: unknown): RetrievalQualityArm | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const arm = typeof o.arm === 'string' && VALID_ARMS.has(o.arm) ? (o.arm as RetrievalQualityArm['arm']) : null;
  if (!arm) return null;
  return {
    arm,
    recallAtK: num(o.recallAtK),
    pointInTimeAccuracy: num(o.pointInTimeAccuracy),
    staleLeakRate: num(o.staleLeakRate),
    mrr: numOrNull(o.mrr),
    avgLatencyMs: numOrNull(o.avgLatencyMs),
  };
}

/**
 * Read `<dataDir>/eval-report.json`, coerced to the {@link RetrievalPayload}
 * `quality` shape. Returns null when the file is absent, unreadable, malformed,
 * or carries no usable arms.
 */
export function readLastEvalReport(dataDir: string): RetrievalPayload['quality'] {
  try {
    const raw = fs.readFileSync(path.join(dataDir, EVAL_REPORT_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const arms = Array.isArray(parsed.arms)
      ? parsed.arms.map(coerceArm).filter((a): a is RetrievalQualityArm => a !== null)
      : [];
    if (arms.length === 0) return null;
    const mode = parsed.mode === 'temporal' || parsed.mode === 'real-vault' ? parsed.mode : null;
    return {
      ranAt: numOrNull(parsed.ranAt),
      mode,
      k: num(parsed.k, 10),
      arms,
    };
  } catch {
    return null;
  }
}

/**
 * Read the last {@link HISTORY_TAIL} lines of `<dataDir>/eval-history.jsonl`,
 * oldest→newest, dropping blank / malformed lines. Returns [] on any failure.
 */
export function readEvalHistory(dataDir: string): RetrievalPayload['qualityHistory'] {
  try {
    const raw = fs.readFileSync(path.join(dataDir, EVAL_HISTORY_FILE), 'utf-8');
    const rows: RetrievalPayload['qualityHistory'] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed) as Record<string, unknown>;
        const ranAt = num(o.ranAt, NaN);
        if (!isFinite(ranAt)) continue;
        rows.push({
          ranAt,
          recallAtK: num(o.recallAtK),
          pointInTimeAccuracy: num(o.pointInTimeAccuracy),
          staleLeakRate: num(o.staleLeakRate),
        });
      } catch {
        // skip a bad line, keep the rest
      }
    }
    return rows.slice(-HISTORY_TAIL);
  } catch {
    return [];
  }
}
