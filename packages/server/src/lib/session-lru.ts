/**
 * Pure helpers for MCP session bookkeeping (LRU eviction, stale-metadata
 * pruning, persistence capping). Kept free of transport/Express references so
 * they are unit-testable; index.ts wires them to the live session map.
 */

export interface SessionLike {
  lastActivity: number;
}

/**
 * IDs to evict (least-recent `lastActivity` first) so that, after `incoming`
 * new sessions are inserted, the map holds at most `maxActive` entries.
 * `maxActive <= 0` disables the cap.
 */
export function selectSessionsToEvict<T extends SessionLike>(
  sessions: ReadonlyMap<string, T>,
  maxActive: number,
  incoming = 1,
): string[] {
  if (!(maxActive > 0)) return [];
  const overflow = sessions.size + incoming - maxActive;
  if (overflow <= 0) return [];
  return Array.from(sessions.entries())
    .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
    .slice(0, overflow)
    .map(([id]) => id);
}

/**
 * Delete entries whose `lastActivity` is older than `retentionMs`.
 * Returns the number of entries removed. `retentionMs <= 0` prunes nothing.
 */
export function pruneStaleSessionMeta<T extends SessionLike>(
  meta: Map<string, T>,
  retentionMs: number,
  now: number = Date.now(),
): number {
  if (!(retentionMs > 0)) return 0;
  let removed = 0;
  for (const [id, entry] of meta) {
    if (now - entry.lastActivity > retentionMs) {
      meta.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Newest-first copy of `records`, capped at `maxRecords` (<= 0 → uncapped).
 */
export function capSessionRecords<T extends SessionLike>(records: readonly T[], maxRecords: number): T[] {
  const sorted = [...records].sort((a, b) => b.lastActivity - a.lastActivity);
  return maxRecords > 0 ? sorted.slice(0, maxRecords) : sorted;
}
