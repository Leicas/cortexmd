/**
 * Crash-safe file replacement: write a temp file in the SAME directory, fsync
 * it, then rename it over the target. A reader (Obsidian, Syncthing, the 60 s
 * rescan, a concurrent notes_get) sees either the old bytes or the new bytes —
 * never a truncated file — and a crash/OOM mid-write leaves the old note intact.
 *
 * Sync-tool friendliness:
 *  - the temp name is a dotfile with a non-.md suffix
 *    (`.<name>.<pid>.<n>.cortexmd-tmp`), so the vault glob (`**\/*.md`, dotfiles
 *    excluded), Obsidian and our own indexer never pick it up; it lives for
 *    milliseconds and is unlinked on failure;
 *  - rename-over is exactly how Obsidian and Syncthing write files themselves.
 *
 * Preserved behaviour:
 *  - an existing file's permission bits are copied onto the replacement
 *    (POSIX; ownership can't be preserved without privileges — the server runs
 *    as the vault owner in the container);
 *  - writing to a symlink writes through to the link's target (as writeFile
 *    did) instead of replacing the link with a regular file.
 *
 * Windows: rename over a file another process holds open (Obsidian, an
 * indexer, AV) fails with EPERM/EACCES/EBUSY. Retry with backoff; if it still
 * fails, fall back to a direct in-place write so the user's write is never lost
 * (non-atomic, same as before this change).
 */
import { open, rename, unlink, stat, lstat, realpath, chmod, writeFile, link } from 'node:fs/promises';
import path from 'node:path';

let seq = 0;

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

function tmpPathFor(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `.${base}.${process.pid}.${++seq}.cortexmd-tmp`);
}

async function writeAndSync(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const fh = await open(file, 'wx', mode ?? 0o666);
  try {
    await fh.writeFile(data, typeof data === 'string' ? 'utf-8' : undefined);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function resolveWriteTarget(target: string): Promise<{ real: string; mode?: number }> {
  try {
    const l = await lstat(target);
    if (l.isSymbolicLink()) {
      const real = await realpath(target);
      const s = await stat(real);
      return { real, mode: s.mode & 0o7777 };
    }
    return { real: target, mode: l.mode & 0o7777 };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { real: target };
    throw err;
  }
}

async function renameWithRetry(from: string, to: string, attempts: number): Promise<void> {
  let delay = 10;
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err: any) {
      if (!RETRYABLE.has(err?.code) || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 200);
    }
  }
}

export interface AtomicWriteOptions {
  /** rename retries on EPERM/EACCES/EBUSY before the in-place fallback (default 6). */
  renameAttempts?: number;
  /** Disable the non-atomic fallback (tests). */
  noFallback?: boolean;
}

/** Atomically replace (or create) `target` with `data`. */
export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const { real, mode } = await resolveWriteTarget(target);
  const tmp = tmpPathFor(real);
  try {
    await writeAndSync(tmp, data, mode);
    if (mode !== undefined && process.platform !== 'win32') {
      // `open(..., mode)` is filtered by the umask; force the original bits.
      await chmod(tmp, mode).catch(() => undefined);
    }
    await renameWithRetry(tmp, real, opts.renameAttempts ?? 6);
  } catch (err: any) {
    await unlink(tmp).catch(() => undefined);
    if (opts.noFallback || !RETRYABLE.has(err?.code)) throw err;
    // Last resort (Windows file held open): non-atomic in-place write.
    await writeFile(real, data);
  }
}

/**
 * Atomically create `target`, failing with EEXIST if it already exists (the
 * `wx` contract) — the content is complete the instant the name appears.
 * Uses link(2) (atomic, no-clobber); filesystems without hard links fall back
 * to an exclusive `wx` write.
 */
export async function atomicCreateFile(target: string, data: string | Uint8Array): Promise<void> {
  const tmp = tmpPathFor(target);
  try {
    await writeAndSync(tmp, data);
    try {
      await link(tmp, target);
    } catch (err: any) {
      if (err?.code === 'EEXIST') throw err;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP'].includes(err?.code)) {
        await writeFile(target, data, { flag: 'wx' });
      } else {
        throw err;
      }
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
