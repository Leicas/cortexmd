import { describe, expect, it } from 'vitest';
import {
  forEachOrderedConcurrent,
  getIndexState,
  setIndexState,
  waitForIndexReady,
  IndexNotReadyError,
} from '../index-state.js';

describe('forEachOrderedConcurrent', () => {
  it('consumes results in input order while bounding in-flight work', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const consumed: number[] = [];
    await forEachOrderedConcurrent(
      items,
      5,
      async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Later items finish first: order must still be preserved.
        await new Promise((r) => setTimeout(r, (40 - i) % 7));
        inFlight--;
        return i * 2;
      },
      (i, r) => {
        expect(r.status).toBe('fulfilled');
        if (r.status === 'fulfilled') expect(r.value).toBe(i * 2);
        consumed.push(i);
      },
    );
    expect(consumed).toEqual(items);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('reports per-item failures (sync throw or rejection) without aborting the scan', async () => {
    const seen: Array<[number, string]> = [];
    await forEachOrderedConcurrent(
      [1, 2, 3],
      2,
      (i) => {
        if (i === 2) throw new Error('boom');
        return Promise.resolve(i);
      },
      (i, r) => { seen.push([i, r.status]); },
    );
    expect(seen).toEqual([[1, 'fulfilled'], [2, 'rejected'], [3, 'fulfilled']]);
  });
});

describe('index readiness gate', () => {
  it('is open before any build, waits while indexing, and resolves on ready', async () => {
    expect(getIndexState()).toBe('not_started');
    expect(await waitForIndexReady(0)).toBe(true);

    setIndexState('indexing');
    expect(await waitForIndexReady(10)).toBe(false); // times out

    const pending = waitForIndexReady(5_000);
    setIndexState('ready');
    expect(await pending).toBe(true);

    setIndexState('error');
    expect(await waitForIndexReady(1_000)).toBe(false);
    setIndexState('not_started');
  });

  it('IndexNotReadyError is a retryable INDEXING error', () => {
    const err = new IndexNotReadyError();
    expect(err.code).toBe('INDEXING');
    expect(err.message).toMatch(/still indexing/);
  });
});
