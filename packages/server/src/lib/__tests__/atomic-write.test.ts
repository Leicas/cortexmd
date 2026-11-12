import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, statSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile, atomicCreateFile } from '../atomic-write.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-atomic-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('atomicWriteFile', () => {
  it('creates and replaces a file with no temp file left behind', async () => {
    const target = path.join(root, 'note.md');
    await atomicWriteFile(target, '# v1\n');
    expect(readFileSync(target, 'utf-8')).toBe('# v1\n');
    await atomicWriteFile(target, '# v2 — édité\n');
    expect(readFileSync(target, 'utf-8')).toBe('# v2 — édité\n');
    await atomicWriteFile(target, Buffer.from([0, 1, 2, 255]));
    expect([...readFileSync(target)]).toEqual([0, 1, 2, 255]);
    expect(readdirSync(root).filter((f) => f.includes('cortexmd-tmp'))).toEqual([]);
  });

  // POSIX rename(2) replaces atomically even while readers hold the file open.
  // On Windows a rename over a file another handle is reading can fail with
  // EPERM; after retries atomicWriteFile falls back to an in-place write so the
  // write is never lost (asserted below), which a tight reader loop can observe.
  it.skipIf(process.platform === 'win32')('never exposes a partial file: readers see the old or the new bytes', async () => {
    const target = path.join(root, 'big.md');
    const a = 'a'.repeat(2_000_000);
    const b = 'b'.repeat(2_000_000);
    await atomicWriteFile(target, a);
    let stop = false;
    const reads: string[] = [];
    const reader = (async () => {
      while (!stop) {
        const s = readFileSync(target, 'utf-8');
        reads.push(s.length === a.length && (s === a || s === b) ? 'ok' : `torn:${s.length}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 5; i++) await atomicWriteFile(target, i % 2 ? a : b);
    stop = true;
    await reader;
    expect(reads.filter((r) => r !== 'ok')).toEqual([]);
  });

  it('completes the write even while another handle keeps reading the target', async () => {
    const target = path.join(root, 'contended.md');
    await atomicWriteFile(target, 'old');
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        readFileSync(target);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await atomicWriteFile(target, 'new contents');
    stop = true;
    await reader;
    expect(readFileSync(target, 'utf-8')).toBe('new contents');
    expect(readdirSync(root).filter((f) => f.includes('cortexmd-tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('preserves the permission bits of the file it replaces', async () => {
    const target = path.join(root, 'mode.md');
    writeFileSync(target, 'x');
    chmodSync(target, 0o640);
    await atomicWriteFile(target, 'y');
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink instead of replacing it', async () => {
    const real = path.join(root, 'real.md');
    const link = path.join(root, 'link.md');
    writeFileSync(real, 'old');
    try {
      symlinkSync(real, link);
    } catch {
      return; // no symlink privilege (Windows without developer mode)
    }
    await atomicWriteFile(link, 'new');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf-8')).toBe('new');
  });
});

describe('atomicCreateFile', () => {
  it('creates a new file and refuses to clobber an existing one', async () => {
    const target = path.join(root, 'created.md');
    await atomicCreateFile(target, 'first');
    expect(readFileSync(target, 'utf-8')).toBe('first');
    await expect(atomicCreateFile(target, 'second')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf-8')).toBe('first');
    expect(readdirSync(root).filter((f) => f.includes('cortexmd-tmp'))).toEqual([]);
  });
});
