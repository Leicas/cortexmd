import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createBackup, restoreBackup, listBackups, backupCron } from '../backup.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort();
}

function makeVault(): string {
  const vault = path.join(root, 'vault');
  const put = (rel: string, data: string | Buffer): void => {
    const abs = path.join(vault, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  };
  put('Inbox/plain.md', '---\ntitle: Plain\n---\n# Plain\n\n[[Other]]\n');
  put('05 CRM/Société Générale — réunion.md', '# Unicode name\n\nAccents: é à ü 漢字 🚀\n');
  put(`Deep/${'very-long-directory-name-'.repeat(4)}/${'long-file-name-'.repeat(8)}.md`, '# long path\n');
  put('Assets/image/blob.bin', Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)));
  put('.obsidian/app.json', '{"theme":"dark"}');
  put('empty.md', '');
  put('exact512.md', 'x'.repeat(512));
  // Excluded:
  put('.git/HEAD', 'ref: refs/heads/main\n');
  put('Inbox/.plain.md.123.1.cortexmd-tmp', 'half-written');
  return vault;
}

describe('brain backup', () => {
  const vault = makeVault();
  const backups = path.join(root, 'backups');
  const expected = walk(vault).filter((p) => !p.startsWith('.git/') && !p.endsWith('.cortexmd-tmp'));

  it('restores every file byte-identical (names, unicode, long paths, binary, mtimes)', async () => {
    const r = await createBackup({ vaultDir: vault, backupDir: backups, keep: 5, now: new Date('2026-11-11T03:30:00Z') });
    expect(path.basename(r.file)).toBe('brain-20261111T033000Z.tar.gz');
    expect(r.files).toBe(expected.length);

    const dest = path.join(root, 'restored');
    const out = await restoreBackup(r.file, dest);
    expect(out.files).toBe(expected.length);
    expect(walk(dest)).toEqual(expected);
    for (const rel of expected) {
      expect(readFileSync(path.join(dest, rel)).equals(readFileSync(path.join(vault, rel))), rel).toBe(true);
      expect(Math.floor(statSync(path.join(dest, rel)).mtimeMs / 1000)).toBe(
        Math.floor(statSync(path.join(vault, rel)).mtimeMs / 1000),
      );
    }
    await expect(restoreBackup(r.file, dest)).rejects.toThrow(/not empty/);
  });

  it('is a standard tar.gz: the system tar extracts it identically', async () => {
    const probe = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
    if (probe.status !== 0) return; // no tar binary on this host
    const [archive] = await listBackups(backups);
    const dest = path.join(root, 'restored-tar');
    mkdirSync(dest, { recursive: true });
    // Relative paths + cwd: GNU tar reads "D:\..." as a remote host spec.
    const res = spawnSync('tar', ['-xzf', archive, '-C', path.relative(backups, dest).split(path.sep).join('/')], { cwd: backups, encoding: 'utf-8' });
    expect(res.status, res.stderr).toBe(0);
    expect(walk(dest)).toEqual(expected);
    for (const rel of expected) {
      expect(readFileSync(path.join(dest, rel)).equals(readFileSync(path.join(vault, rel))), rel).toBe(true);
    }
  });

  it('keeps only the newest BACKUP_KEEP archives', async () => {
    for (const ts of ['2026-11-12T03:30:00Z', '2026-11-13T03:30:00Z', '2026-11-14T03:30:00Z']) {
      await createBackup({ vaultDir: vault, backupDir: backups, keep: 2, now: new Date(ts) });
    }
    expect(await listBackups(backups)).toEqual([
      'brain-20261113T033000Z.tar.gz',
      'brain-20261114T033000Z.tar.gz',
    ]);
  });

  it('skips a backup directory nested inside the vault', async () => {
    const nested = path.join(vault, 'Backups');
    const r = await createBackup({ vaultDir: vault, backupDir: nested, keep: 3, now: new Date('2026-11-15T00:00:00Z') });
    const r2 = await createBackup({ vaultDir: vault, backupDir: nested, keep: 3, now: new Date('2026-11-16T00:00:00Z') });
    expect(r2.files).toBe(r.files);
    rmSync(nested, { recursive: true, force: true });
  });

  it('parses BACKUP_SCHEDULE', () => {
    expect(backupCron('off')).toBeNull();
    expect(backupCron('')).toBeNull();
    expect(backupCron('on')).toBe('30 3 * * *');
    expect(backupCron('15 2 * * *')).toBe('15 2 * * *');
    expect(backupCron('*/5 * * * *')).toBeNull();
  });
});
