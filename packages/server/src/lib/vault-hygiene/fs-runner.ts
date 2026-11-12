/**
 * Filesystem side of the hygiene tool (CLI only — the MCP tool never applies).
 *
 *   loadVaultDir   — read a vault directory into [path, text] pairs
 *   applyPlan      — back up every file it will touch (+ manifest), then
 *                    write modifications and MOVE archived notes (never delete)
 *   restoreBackup  — put every backed-up file back byte-for-byte and remove
 *                    the archive copies the apply created
 *   treeDigest     — sha256 over every file in a tree (restore verification)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlannedChange } from './model.js';

const SKIP_DIRS = new Set(['node_modules']);

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walk(root, p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

export async function loadVaultDir(root: string): Promise<{ files: Array<[string, string]>; otherFiles: string[] }> {
  const all = await walk(root);
  const files: Array<[string, string]> = [];
  const otherFiles: string[] = [];
  for (const p of all) {
    if (/\.md$/i.test(p)) files.push([p, await fs.readFile(path.join(root, p), 'utf8')]);
    else otherFiles.push(p);
  }
  return { files, otherFiles };
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

export interface ManifestEntry {
  path: string;
  op: 'modify' | 'archive' | 'create';
  to?: string;
  /** Backup copy (relative to the run dir); absent for `create`. */
  backup?: string;
  /** null for `create` (the file did not exist). */
  sha256Before: string | null;
  sha256After?: string;
  commands: string[];
}

export interface Manifest {
  tool: 'cortexmd vault-hygiene';
  version: 1;
  vaultRoot: string;
  createdAt: string;
  commands: string[];
  status: 'backed-up' | 'applied' | 'restored';
  entries: ManifestEntry[];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Back up, then apply. Returns the backup run directory (holds manifest.json
 * and files/<original path>). Refuses a backup dir inside the vault.
 */
export async function applyPlan(
  vaultRoot: string,
  plan: PlannedChange[],
  backupDir: string,
  commands: string[],
): Promise<{ runDir: string; manifest: Manifest }> {
  if (isInside(backupDir, vaultRoot)) throw new Error('--backup-dir must be outside the vault');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(backupDir, `vault-hygiene-${stamp}`);
  await fs.mkdir(path.join(runDir, 'files'), { recursive: true });

  const manifest: Manifest = {
    tool: 'cortexmd vault-hygiene', version: 1, vaultRoot: path.resolve(vaultRoot),
    createdAt: new Date().toISOString(), commands, status: 'backed-up', entries: [],
  };
  // 1. Back up every file that will change or move, BEFORE touching anything.
  for (const c of plan) {
    const src = path.join(vaultRoot, c.path);
    if (c.op === 'create') {
      try { await fs.access(src); throw new Error(`refusing to create over an existing file: ${c.path}`); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
      manifest.entries.push({ path: c.path, op: 'create', sha256Before: null, commands: c.commands });
      continue;
    }
    const backup = path.join('files', c.path);
    const buf = await fs.readFile(src);
    await fs.mkdir(path.dirname(path.join(runDir, backup)), { recursive: true });
    await fs.writeFile(path.join(runDir, backup), buf);
    if (c.op === 'archive') {
      try { await fs.access(path.join(vaultRoot, c.to!)); throw new Error(`archive destination exists: ${c.to}`); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    }
    manifest.entries.push({ path: c.path, op: c.op, ...(c.to ? { to: c.to } : {}), backup, sha256Before: sha256(buf), commands: c.commands });
  }
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 2. Apply. Archived notes are moved (rename), never deleted.
  for (let i = 0; i < plan.length; i++) {
    const c = plan[i];
    const entry = manifest.entries[i];
    const src = path.join(vaultRoot, c.path);
    if (c.op === 'modify' || c.op === 'create') {
      if (c.op === 'create') await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, c.newContent!, { encoding: 'utf8', flag: c.op === 'create' ? 'wx' : 'w' });
      entry.sha256After = sha256(Buffer.from(c.newContent!, 'utf8'));
    } else {
      const dest = path.join(vaultRoot, c.to!);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      if (c.newContent !== undefined) await fs.writeFile(dest, c.newContent, 'utf8');
      entry.sha256After = sha256(await fs.readFile(dest));
    }
  }
  manifest.status = 'applied';
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { runDir, manifest };
}

/**
 * Restore a backup run: every original file goes back byte-for-byte; archive
 * copies created by the apply are removed (only when unchanged since apply).
 * Returns per-file verification.
 */
export async function restoreBackup(runDir: string, vaultRoot?: string): Promise<{
  restored: number; verified: number; mismatched: string[]; keptArchiveCopies: string[];
}> {
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8')) as Manifest;
  const root = vaultRoot ?? manifest.vaultRoot;
  const mismatched: string[] = [];
  const keptArchiveCopies: string[] = [];
  const touchedDirs = new Set<string>();
  let restored = 0;
  let verified = 0;
  for (const e of manifest.entries) {
    if (e.op === 'create') {
      // Remove what the apply created — only when unchanged since.
      const target = path.join(root, e.path);
      try {
        if (sha256(await fs.readFile(target)) === e.sha256After) {
          await fs.rm(target);
          touchedDirs.add(path.dirname(target));
          restored++;
          verified++;
        } else {
          keptArchiveCopies.push(e.path);
        }
      } catch { restored++; verified++; /* already gone */ }
      continue;
    }
    const buf = await fs.readFile(path.join(runDir, e.backup!));
    if (e.op === 'archive' && e.to) {
      const dest = path.join(root, e.to);
      try {
        const cur = await fs.readFile(dest);
        if (!e.sha256After || sha256(cur) === e.sha256After) {
          await fs.rm(dest);
          touchedDirs.add(path.dirname(dest));
        } else {
          keptArchiveCopies.push(e.to);
        }
      } catch { /* already gone */ }
    }
    const target = path.join(root, e.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
    restored++;
    if (sha256(await fs.readFile(target)) === e.sha256Before) verified++;
    else mismatched.push(e.path);
  }
  // Remove archive directories the apply created and that are now empty.
  const dirs = [...touchedDirs].sort((a, b) => b.length - a.length);
  for (let d of dirs) {
    while (isInside(d, root) && path.resolve(d) !== path.resolve(root)) {
      try { await fs.rmdir(d); } catch { break; }
      d = path.dirname(d);
    }
  }
  manifest.status = 'restored';
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { restored, verified, mismatched, keptArchiveCopies };
}

/** sha256 over (path, sha256(content)) of every file in a tree — dotfiles included. */
export async function treeDigest(root: string): Promise<{ files: number; digest: string }> {
  async function all(rel = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await all(p)));
      else if (e.isFile()) out.push(p);
    }
    return out;
  }
  const files = (await all()).sort();
  const h = createHash('sha256');
  for (const f of files) h.update(`${f}\u0000${sha256(await fs.readFile(path.join(root, f)))}\n`);
  return { files: files.length, digest: h.digest('hex') };
}
