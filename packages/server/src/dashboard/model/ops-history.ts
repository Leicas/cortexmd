/**
 * Small in-memory ring buffer of process vitals for the Overview sparklines:
 * heap / rss / active sessions / indexed notes, sampled every SAMPLE_MS for the
 * last ~2 h. In-memory on purpose: a restart empties it, and `bootAt` marks
 * where the current process began (the restart marker on the chart; the
 * previous exit reason comes from /health `restarts.lastExit`).
 */
import { getSessionSnapshots } from '../../index.js';
import { getIndexedNoteCount } from '../../lib/search.js';

export interface OpsSample { t: number; heapMb: number; rssMb: number; sessions: number; notes: number }

export const SAMPLE_MS = 30_000;
const MAX_SAMPLES = 240; // 2 h at 30 s
const samples: OpsSample[] = [];
let timer: NodeJS.Timeout | null = null;
const bootAt = Date.now() - Math.round(process.uptime() * 1000);

function countSessions(): number {
  try {
    const s = getSessionSnapshots() as unknown;
    if (Array.isArray(s)) return s.length;
    if (s && typeof s === 'object') return Object.keys(s).length;
  } catch { /* not ready */ }
  return 0;
}

export function sampleOps(now = Date.now()): OpsSample {
  const m = process.memoryUsage();
  let notes = 0;
  try { notes = getIndexedNoteCount(); } catch { /* index not built */ }
  const s: OpsSample = {
    t: now,
    heapMb: Math.round(m.heapUsed / 1048576),
    rssMb: Math.round(m.rss / 1048576),
    sessions: countSessions(),
    notes,
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return s;
}

/** Start sampling (idempotent; the timer is unref'd so it never holds the process open). */
export function ensureOpsSampler(): void {
  if (timer) return;
  sampleOps();
  timer = setInterval(() => sampleOps(), SAMPLE_MS);
  timer.unref?.();
}

export function getOpsHistory(): { bootAt: number; intervalMs: number; samples: OpsSample[] } {
  ensureOpsSampler();
  return { bootAt, intervalMs: SAMPLE_MS, samples: samples.slice() };
}
