/**
 * Search-index readiness + shared indexing helpers.
 *
 * The HTTP server listens BEFORE the first index build finishes, so readiness
 * is explicit: /health reports `indexing` and tool calls wait (bounded) for the
 * build instead of silently answering from an empty index.
 *
 * `not_started` means no build was ever kicked off (unit tests, scripts) — the
 * gate is open in that state so code that never boots the index never blocks.
 * Only the FIRST build gates; later incremental rescans and forced full
 * rebuilds swap their result in atomically and never block readers.
 *
 * Kept out of search.ts (no imports) so graph.ts / tool-wrapper.ts / index.ts
 * can read it without pulling the whole search module.
 */

export type IndexState = 'not_started' | 'indexing' | 'ready' | 'error';

let indexState: IndexState = 'not_started';
const progress = { done: 0, total: 0 };
let waiters: Array<() => void> = [];

export function setIndexState(next: IndexState): void {
  indexState = next;
  if (next === 'ready' || next === 'error') {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  }
}

/** Current readiness of the in-memory search index. */
export function getIndexState(): IndexState {
  return indexState;
}

export function setIndexProgress(done: number, total: number): void {
  progress.done = done;
  progress.total = total;
}

/** Files read so far / files listed during the boot build. */
export function getIndexProgress(): { done: number; total: number } {
  return { ...progress };
}

/**
 * Resolve true once the index is usable, false if `timeoutMs` elapses first or
 * the first build failed. Immediate true when no build was started or one has
 * already completed.
 */
export function waitForIndexReady(timeoutMs: number): Promise<boolean> {
  if (indexState === 'ready' || indexState === 'not_started') return Promise.resolve(true);
  if (indexState === 'error') return Promise.resolve(false);
  return new Promise((resolve) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve(indexState === 'ready');
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== onReady);
      resolve(false);
    }, Math.max(0, timeoutMs));
    timer.unref?.();
    waiters.push(onReady);
  });
}

/** Error thrown by tool calls that arrive while the boot index is building. */
export class IndexNotReadyError extends Error {
  readonly code = 'INDEXING';
  constructor() {
    const { done, total } = progress;
    super(
      `cortexmd is still indexing the vault (${done}/${total || '?'} notes read); ` +
        'the index is not ready yet',
    );
  }
}

/**
 * Raw (unresolved) wikilink targets per indexed note, extracted from the FULL
 * file text (frontmatter included — e.g. `related: ["[[X]]"]`) while the file
 * is already in memory for indexing. graph.ts builds the link graph from this
 * instead of re-reading every file. Maintained by search.ts.
 */
export const docLinks = new Map<string, string[]>();

/**
 * Run `work` over `items` with at most `concurrency` in flight, handing results
 * to `consume` strictly in input order. Reads overlap, while the order in which
 * docs enter MiniSearch/docMeta stays identical to a sequential scan (MiniSearch
 * short ids, Map iteration order and score tie-breaks are unchanged).
 */
export async function forEachOrderedConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
  consume: (item: T, result: PromiseSettledResult<R>) => void | Promise<void>,
): Promise<void> {
  const n = items.length;
  const width = Math.max(1, Math.floor(concurrency) || 1);
  const pending: Array<Promise<PromiseSettledResult<R>> | undefined> = new Array(n);
  let next = 0;
  const start = (): void => {
    const i = next++;
    let p: Promise<R>;
    try {
      p = work(items[i]);
    } catch (err) {
      p = Promise.reject(err);
    }
    pending[i] = p.then(
      (value): PromiseSettledResult<R> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseSettledResult<R> => ({ status: 'rejected', reason }),
    );
  };
  while (next < n && next < width) start();
  for (let i = 0; i < n; i++) {
    const settled = await pending[i]!;
    pending[i] = undefined; // release the file text as soon as it is consumed
    if (next < n) start();
    await consume(items[i], settled);
  }
}
