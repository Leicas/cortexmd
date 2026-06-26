/**
 * Activity tracking for the idle-edge dream trigger.
 *
 * Every MCP tool call and hook-driven capture marks activity. A scheduler job
 * polls `shouldFireIdleDream` and, once the server has been quiet for longer
 * than the idle threshold, fires one lightweight dream pass — consolidating
 * promptly after a work burst instead of waiting for the nightly cron.
 *
 * Cross-platform by construction: this is pure wall-clock bookkeeping over the
 * server's own request stream, with no OS-level idle probing (iai-pme's
 * detector is macOS-only `ioreg`/`pmset`). Works identically on Linux, macOS,
 * and Windows, and in both local-stdio and HTTP deployments.
 */

let lastActivityAt = Date.now();

/** Record that the server just did meaningful work (tool call / capture). */
export function markActivity(now: number = Date.now()): void {
  if (now > lastActivityAt) lastActivityAt = now;
}

/** Timestamp (ms) of the most recent activity. */
export function getLastActivityAt(): number {
  return lastActivityAt;
}

/**
 * Decide whether an idle-edge dream should fire *now*. Pure so it can be unit
 * tested without timers.
 *
 * Fires once per idle edge:
 *   1. The server must have been idle for at least `idleMs`.
 *   2. There must have been new activity since the last idle dream — otherwise
 *      we already consolidated this quiet period and must not loop on it.
 *
 * @param now                   current time (ms)
 * @param lastActivity          timestamp of the latest activity (ms)
 * @param idleMs                how long quiet before we consider the edge
 * @param lastFiredForActivity  the `lastActivity` value captured the last time
 *                              an idle dream fired (0 if never)
 */
export function shouldFireIdleDream(
  now: number,
  lastActivity: number,
  idleMs: number,
  lastFiredForActivity: number,
): boolean {
  if (now - lastActivity < idleMs) return false; // still warm
  if (lastActivity <= lastFiredForActivity) return false; // already dreamed this edge
  return true;
}
