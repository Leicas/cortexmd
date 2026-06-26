import { describe, it, expect } from 'vitest';
import { markActivity, getLastActivityAt, shouldFireIdleDream } from '../activity.js';

describe('activity tracking', () => {
  it('markActivity advances the timestamp and never moves it backwards', () => {
    // Anchor above the module's Date.now() init so the assertions are absolute.
    const base = getLastActivityAt() + 1_000_000;
    markActivity(base);
    expect(getLastActivityAt()).toBe(base);
    markActivity(base + 1000);
    expect(getLastActivityAt()).toBe(base + 1000);
    markActivity(base + 500); // stale tick must not rewind
    expect(getLastActivityAt()).toBe(base + 1000);
  });
});

describe('shouldFireIdleDream', () => {
  const IDLE = 300_000; // 5 min

  it('does not fire while the server is still warm', () => {
    // active 1 min ago, idle threshold 5 min
    expect(shouldFireIdleDream(1_060_000, 1_000_000, IDLE, 0)).toBe(false);
  });

  it('fires once the idle threshold is crossed (first edge)', () => {
    // idle for 6 min, never fired before
    expect(shouldFireIdleDream(1_360_000, 1_000_000, IDLE, 0)).toBe(true);
  });

  it('does not fire twice for the same idle edge', () => {
    const lastActivity = 1_000_000;
    // first fire claims this activity timestamp
    expect(shouldFireIdleDream(1_360_000, lastActivity, IDLE, 0)).toBe(true);
    // subsequent ticks with no new activity must not re-fire
    expect(shouldFireIdleDream(1_420_000, lastActivity, IDLE, lastActivity)).toBe(false);
  });

  it('fires again after a new activity burst goes idle', () => {
    const firstEdge = 1_000_000;
    const secondBurst = 2_000_000; // new activity
    // already dreamed the first edge (lastFired = firstEdge)
    expect(shouldFireIdleDream(2_400_000, secondBurst, IDLE, firstEdge)).toBe(true);
  });

  it('fires at exactly the idle threshold (idle for *at least* idleMs)', () => {
    // just under the threshold → still warm
    expect(shouldFireIdleDream(1_299_999, 1_000_000, IDLE, 0)).toBe(false);
    // exactly idleMs elapsed → idle edge
    expect(shouldFireIdleDream(1_300_000, 1_000_000, IDLE, 0)).toBe(true);
  });
});
