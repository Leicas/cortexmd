/**
 * Simple in-memory sliding-window rate limiter.
 */

interface WindowEntry {
  timestamps: number[];
}

const store = new Map<string, WindowEntry>();

/**
 * Check whether a request identified by `key` is allowed under the given
 * sliding-window rate limit.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Prune timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= maxRequests) {
    const oldest = entry.timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldest + windowMs,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: maxRequests - entry.timestamps.length,
    resetAt: now + windowMs,
  };
}

/**
 * Periodically clean up expired entries to prevent unbounded memory growth.
 * Call this on a timer (e.g. every 60 s).
 */
export function cleanupExpired(windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

/**
 * Return a snapshot of all rate-limit entries with an `auth:` prefix.
 */
export function getRateLimitSnapshot(): Array<{
  key: string;
  count: number;
  remaining: number;
  resetAt: number;
}> {
  const results: Array<{ key: string; count: number; remaining: number; resetAt: number }> = [];
  for (const [key, entry] of store) {
    if (!key.startsWith('auth:')) continue;
    const count = entry.timestamps.length;
    const oldest = entry.timestamps[0] ?? Date.now();
    results.push({
      key,
      count,
      remaining: Math.max(0, count),
      resetAt: oldest + 60_000, // assume 60s window
    });
  }
  return results;
}

/**
 * Delete a single rate-limit entry by key.
 * Returns whether the key existed.
 */
export function resetRateLimit(key: string): boolean {
  return store.delete(key);
}

/**
 * Clear all `auth:` prefixed rate-limit entries.
 * Returns the number of entries deleted.
 */
export function resetAllRateLimits(): number {
  let count = 0;
  for (const key of store.keys()) {
    if (key.startsWith('auth:')) {
      store.delete(key);
      count++;
    }
  }
  return count;
}
