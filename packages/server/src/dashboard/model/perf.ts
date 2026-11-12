/**
 * Tiny in-memory perf ring for the dashboard SSE spine: how long each payload
 * took to build (+ serialize) and how big it was. Read by
 * `GET /dashboard/api/perf`. Bounded; never persisted.
 */
const MAX = 200;
const samples: Array<{ ts: number; ms: number; bytes: number }> = [];

export function recordSseBuild(ms: number, bytes: number): void {
  samples.push({ ts: Date.now(), ms, bytes });
  if (samples.length > MAX) samples.splice(0, samples.length - MAX);
}

export function getSseBuildStats(): {
  count: number; p50Ms: number; p95Ms: number; maxMs: number; meanMs: number; avgBytes: number;
} {
  if (samples.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0, avgBytes: 0 };
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const q = (p: number): number => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  const r = (v: number): number => Math.round(v * 100) / 100;
  return {
    count: ms.length,
    p50Ms: r(q(0.5)),
    p95Ms: r(q(0.95)),
    maxMs: r(ms[ms.length - 1]),
    meanMs: r(ms.reduce((a, b) => a + b, 0) / ms.length),
    avgBytes: Math.round(samples.reduce((a, s) => a + s.bytes, 0) / samples.length),
  };
}

export function resetSseBuildStats(): void { samples.length = 0; }
