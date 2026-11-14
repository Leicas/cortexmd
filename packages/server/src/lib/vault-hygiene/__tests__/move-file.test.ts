import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveFile } from '../fs-runner.js';

const exdev = async (): Promise<void> => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

describe('moveFile', () => {
  it('falls back to copy + unlink when rename crosses devices', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hygiene-move-'));
    try {
      const src = path.join(dir, 'a.md');
      const dest = path.join(dir, 'b.md');
      await writeFile(src, 'note body');
      await moveFile(src, dest, exdev);
      expect(await readFile(dest, 'utf8')).toBe('note body');
      await expect(access(src)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rethrows other rename errors and leaves the source in place', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hygiene-move-'));
    try {
      const src = path.join(dir, 'a.md');
      await writeFile(src, 'note body');
      const eperm = async (): Promise<void> => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      };
      await expect(moveFile(src, path.join(dir, 'b.md'), eperm)).rejects.toMatchObject({ code: 'EPERM' });
      expect(await readFile(src, 'utf8')).toBe('note body');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
