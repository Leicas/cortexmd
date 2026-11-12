/**
 * Brain-vault backup: timestamped `brain-YYYYMMDDTHHMMSSZ.tar.gz` archives with
 * retention, plus a restore that reproduces every file byte-for-byte.
 *
 * Format: POSIX ustar + PAX `path` records (long / non-ASCII names) — readable
 * by GNU tar, bsdtar and 7-Zip, so a restore needs no cortexmd at all:
 *     mkdir restored && tar -xzf brain-20261111T033000Z.tar.gz -C restored
 * (or `node dist/backup-cli.js restore <archive> <dest>`).
 *
 * Scope: regular files under the brain vault (Obsidian config included).
 * Skipped: `.git/`, `node_modules/`, our own in-flight `*.cortexmd-tmp` files,
 * symlinks (never followed out of the vault), and the backup directory itself
 * when it lives inside the vault. Empty directories are not recorded.
 *
 * Files are streamed one at a time (bounded memory); each note is read whole,
 * and note writes are atomic (atomic-write.ts), so every archived note is a
 * complete version. The archive is written to a temp name and renamed into
 * place, so a crash never leaves a truncated "latest" backup.
 */
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, unlink, utimes, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { logger } from './logger.js';
import { config } from '../config.js';

const BLOCK = 512;
const ARCHIVE_RE = /^brain-\d{8}T\d{6}Z\.tar\.gz$/;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export interface BackupResult {
  file: string;
  files: number;
  bytes: number;
  ms: number;
  pruned: string[];
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function writeString(buf: Buffer, s: string, offset: number, len: number): void {
  buf.write(s.slice(0, len), offset, len, 'utf-8');
}

function header(name: string, size: number, mode: number, mtimeSec: number, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  writeString(h, name, 0, 100);
  writeString(h, octal(mode & 0o7777, 8), 100, 8);
  writeString(h, octal(0, 8), 108, 8);
  writeString(h, octal(0, 8), 116, 8);
  writeString(h, octal(size, 12), 124, 12);
  writeString(h, octal(Math.max(0, Math.floor(mtimeSec)), 12), 136, 12);
  h.fill(0x20, 148, 156); // checksum placeholder = spaces
  h.write(type, 156, 1, 'ascii');
  writeString(h, 'ustar\0', 257, 6);
  writeString(h, '00', 263, 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  writeString(h, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** PAX extended-header record: "<len> key=value\n", len counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf-8');
  const digits = String(bodyLen).length;
  let len = bodyLen + digits;
  if (String(len).length !== digits) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, 'utf-8');
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

/** Tar entries for one file (PAX header first when the name needs it). */
export function tarEntry(relPath: string, data: Buffer, mode: number, mtimeSec: number): Buffer[] {
  const out: Buffer[] = [];
  const asciiShort = Buffer.byteLength(relPath, 'utf-8') <= 100 && /^[\x20-\x7e]*$/.test(relPath);
  if (!asciiShort) {
    const rec = paxRecord('path', relPath);
    out.push(header('PaxHeader/' + relPath.replace(/[^\x20-\x7e]/g, '_').slice(-80), rec.length, 0o644, mtimeSec, 'x'));
    out.push(rec, padding(rec.length));
  }
  out.push(header(asciiShort ? relPath : relPath.replace(/[^\x20-\x7e]/g, '_').slice(-100), data.length, mode, mtimeSec, '0'));
  out.push(data, padding(data.length));
  return out;
}

async function walk(root: string, rel: string, exclude: string | null, out: string[]): Promise<void> {
  const dir = path.join(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(root, childRel);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (exclude && path.resolve(abs) === exclude) continue;
      await walk(root, childRel, exclude, out);
    } else if (e.isFile()) {
      if (e.name.endsWith('.cortexmd-tmp')) continue;
      out.push(childRel);
    }
    // symlinks / sockets / devices: skipped on purpose
  }
}

/** BACKUP_DIR, defaulting to <DATA_DIR>/backups. */
export function resolveBackupDir(): string {
  return config.backupDir || path.join(config.dataDir, 'backups');
}

/**
 * Parse BACKUP_SCHEDULE: 'off' (default) → null; 'on' → daily 03:30; a
 * five-field "M H * * *" cron → itself. Anything else → null (logged by caller).
 */
export function backupCron(raw: string = config.backupSchedule): string | null {
  const v = raw.trim();
  if (!v || v.toLowerCase() === 'off') return null;
  if (v.toLowerCase() === 'on') return '30 3 * * *';
  return /^\d{1,2} \d{1,2} \* \* \*$/.test(v.replace(/\s+/g, ' ')) ? v.replace(/\s+/g, ' ') : null;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Archive `vaultDir` into `backupDir`, then keep only the newest `keep` archives. */
export async function createBackup(opts: {
  vaultDir: string;
  backupDir: string;
  keep: number;
  now?: Date;
}): Promise<BackupResult> {
  const t0 = Date.now();
  const vaultDir = path.resolve(opts.vaultDir);
  const backupDir = path.resolve(opts.backupDir);
  await mkdir(backupDir, { recursive: true });

  const files: string[] = [];
  const nested = backupDir.startsWith(vaultDir + path.sep) ? backupDir : null;
  await walk(vaultDir, '', nested, files);

  const name = `brain-${stamp(opts.now ?? new Date())}.tar.gz`;
  const finalPath = path.join(backupDir, name);
  const tmpPath = `${finalPath}.${process.pid}.partial`;
  const gzip = createGzip({ level: 6 });
  const sink = createWriteStream(tmpPath);
  const done = new Promise<void>((resolve, reject) => {
    sink.on('finish', resolve);
    sink.on('error', reject);
    gzip.on('error', reject);
  });
  gzip.pipe(sink);

  const push = async (b: Buffer): Promise<void> => {
    if (!gzip.write(b)) await once(gzip, 'drain');
  };

  let bytes = 0;
  let archived = 0;
  try {
    for (const rel of files) {
      const abs = path.join(vaultDir, rel);
      let data: Buffer;
      let st;
      try {
        st = await lstat(abs);
        if (!st.isFile()) continue;
        data = await readFile(abs);
      } catch (err: any) {
        if (err?.code === 'ENOENT') continue; // deleted while walking
        throw err;
      }
      for (const b of tarEntry(rel, data, st.mode, st.mtimeMs / 1000)) await push(b);
      bytes += data.length;
      archived++;
    }
    await push(Buffer.alloc(BLOCK * 2, 0));
    gzip.end();
    await done;
    await rename(tmpPath, finalPath);
  } catch (err) {
    gzip.destroy();
    sink.destroy();
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  const pruned = await pruneBackups(backupDir, opts.keep);
  const result = { file: finalPath, files: archived, bytes, ms: Date.now() - t0, pruned };
  logger.info('Brain backup written', { file: name, files: archived, bytes, ms: result.ms, pruned: pruned.length });
  return result;
}

/** Archives in `backupDir`, oldest first. */
export async function listBackups(backupDir: string): Promise<string[]> {
  try {
    return (await readdir(backupDir)).filter((f) => ARCHIVE_RE.test(f)).sort();
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function pruneBackups(backupDir: string, keep: number): Promise<string[]> {
  const all = await listBackups(backupDir);
  const excess = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
  for (const f of excess) await unlink(path.join(backupDir, f)).catch(() => undefined);
  return excess;
}

function parseOctal(buf: Buffer, off: number, len: number): number {
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * Restore an archive into `destDir` (created if missing; must be empty unless
 * `overwrite`). Restores bytes, permission bits and mtimes. Rejects absolute
 * paths and `..` segments.
 */
export async function restoreBackup(archive: string, destDir: string, opts: { overwrite?: boolean } = {}): Promise<{ files: number }> {
  const dest = path.resolve(destDir);
  await mkdir(dest, { recursive: true });
  if (!opts.overwrite && (await readdir(dest)).length > 0) {
    throw new Error(`restore target ${dest} is not empty (pass overwrite to restore over it)`);
  }
  const tar = gunzipSync(await readFile(archive));
  let off = 0;
  let files = 0;
  let paxPath: string | undefined;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = off + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      const text = data.toString('utf-8');
      for (const line of text.split('\n')) {
        const m = /^\d+ path=(.*)$/s.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type !== '0' && type !== '\0') { paxPath = undefined; continue; }
    const prefix = h.toString('utf-8', 345, 500).replace(/\0.*$/s, '');
    const shortName = h.toString('utf-8', 0, 100).replace(/\0.*$/s, '');
    const rel = paxPath ?? (prefix ? `${prefix}/${shortName}` : shortName);
    paxPath = undefined;
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(`refusing unsafe archive path: ${rel}`);
    }
    const target = path.join(dest, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    const mode = parseOctal(h, 100, 8);
    if (mode && process.platform !== 'win32') await chmod(target, mode).catch(() => undefined);
    const mtime = parseOctal(h, 136, 12);
    if (mtime) await utimes(target, mtime, mtime).catch(() => undefined);
    files++;
  }
  return { files };
}
