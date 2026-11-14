/**
 * Pack sync: fetch a declared pack into `<packs root>/<name>/` and swap it
 * into place atomically.
 *
 * Git sources never get a working tree. The flow is
 *   git init --bare  →  git fetch --depth=1 <url> <ref|commit>  →
 *   git ls-tree -r -l FETCH_HEAD  →  git cat-file --batch (selected blobs)
 * and this module writes the selected files itself. So there is no checkout
 * (no hooks, no smudge filters, no symlinks, no submodules, no path traversal
 * by git), the `git` binary is spawned with an argument vector (no shell), and
 * only regular Markdown/JSON blobs plus root licence files are materialised.
 *
 * Triggered explicitly (tool / REST / CLI / dashboard / scheduler). Never at
 * import time and never on the boot path.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { parsePack } from './adapters.js';
import { globToRegExp, packsRoot, resolveSource, syncCaps, validateSpec, type SourceKind } from './spec.js';
import { PackError, type PackFile, type PackManifest, type PackSpec, type SyncCaps } from './types.js';

const LICENSE_RE = /^(licen[sc]e|copying|notice)([.-][A-Za-z0-9.-]+)?$/i;
const CONTENT_EXT_RE = /\.(md|json)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);

export interface SyncOptions {
  root?: string;
  caps?: Partial<SyncCaps>;
  /** Git executable (tests point this at a missing binary). */
  gitBin?: string;
}

interface TreeItem {
  path: string;
  bytes: number;
  /** Blob sha (git) or absolute source path (local). */
  ref: string;
}

/** A path we are willing to create below the pack directory. */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 400 || p.startsWith('/') || /[\0-\x1f\\:*?"<>|]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.endsWith('.') && !seg.endsWith(' '));
}

function isLicenseFile(p: string): boolean {
  return !p.includes('/') && LICENSE_RE.test(p);
}

/** Apply extension, include-glob and cap rules to a raw file list. */
export function selectFiles(
  items: TreeItem[],
  include: string[] | undefined,
  caps: SyncCaps,
): { selected: TreeItem[]; skippedLarge: number } {
  const globs = (include ?? []).map(globToRegExp);
  const selected: TreeItem[] = [];
  let skippedLarge = 0;
  let total = 0;
  for (const it of items) {
    if (!isSafeRelPath(it.path)) continue;
    const license = isLicenseFile(it.path);
    if (!license && !CONTENT_EXT_RE.test(it.path)) continue;
    if (!license && globs.length > 0 && !globs.some((g) => g.test(it.path))) continue;
    if (it.bytes > caps.maxFileBytes) {
      skippedLarge++;
      continue;
    }
    selected.push(it);
    total += it.bytes;
    if (selected.length > caps.maxFiles) {
      throw new PackError('too_many_files', `pack exceeds the ${caps.maxFiles}-file cap (GUIDANCE_PACK_MAX_FILES)`, 413);
    }
    if (total > caps.maxBytes) {
      throw new PackError('too_large', `pack exceeds the ${caps.maxBytes}-byte cap (GUIDANCE_PACK_MAX_BYTES)`, 413);
    }
  }
  return { selected, skippedLarge };
}

function sanitizeGitError(text: string): string {
  return text.replace(/https?:\/\/[^\s@/]+@/g, 'https://').replace(/\s+/g, ' ').trim().slice(0, 300);
}

interface GitCtx {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  baseArgs: string[];
}

function runGit(ctx: GitCtx, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      ctx.bin,
      [...ctx.baseArgs, ...args],
      { cwd: ctx.cwd, env: ctx.env, timeout: ctx.timeoutMs, maxBuffer, encoding: 'buffer', windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout as Buffer);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          return reject(new PackError('git_unavailable', 'the `git` binary is not available on the server; install git or use a local directory source', 503));
        }
        if (e.killed) return reject(new PackError('git_timeout', `git ${args[0]} timed out after ${ctx.timeoutMs} ms`, 504));
        reject(new PackError('git_failed', `git ${args[0]} failed: ${sanitizeGitError(String(stderr ?? '') || e.message)}`, 502));
      },
    );
  });
}

/** Read the selected blobs through one `git cat-file --batch` process. */
function catBlobs(ctx: GitCtx, shas: string[], maxTotal: number): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.bin, [...ctx.baseArgs, 'cat-file', '--batch'], {
      cwd: ctx.cwd,
      env: ctx.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (e: PackError) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(e);
    };
    const timer = setTimeout(() => fail(new PackError('git_timeout', 'git cat-file timed out', 504)), ctx.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new PackError('git_unavailable', 'the `git` binary is not available', 503) : new PackError('git_failed', e.message, 502)),
    );
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxTotal + shas.length * 128 + 4096) return fail(new PackError('too_large', 'pack content exceeds the byte cap', 413));
      chunks.push(d);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (failed) return;
      const buf = Buffer.concat(chunks);
      const out = new Map<string, Buffer>();
      let off = 0;
      while (off < buf.length) {
        const nl = buf.indexOf(0x0a, off);
        if (nl < 0) break;
        const header = buf.subarray(off, nl).toString('utf8').split(' ');
        if (header.length !== 3 || header[1] !== 'blob') {
          return reject(new PackError('git_failed', 'unexpected git cat-file output', 502));
        }
        const len = Number(header[2]);
        out.set(header[0], buf.subarray(nl + 1, nl + 1 + len));
        off = nl + 1 + len + 1;
      }
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(shas.join('\n') + '\n');
  });
}

async function fetchGit(
  src: Extract<SourceKind, { kind: 'git' }>,
  spec: PackSpec,
  caps: SyncCaps,
  workDir: string,
  bin: string,
): Promise<{ commit: string; items: TreeItem[]; read: (items: TreeItem[]) => Promise<Map<string, Buffer>> }> {
  const empty = path.join(workDir, 'empty');
  const repo = path.join(workDir, 'repo.git');
  const emptyCfg = path.join(workDir, 'gitconfig');
  await fs.mkdir(empty, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(emptyCfg, '');
  const ctx: GitCtx = {
    bin,
    cwd: repo,
    timeoutMs: caps.gitTimeoutMs,
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: workDir,
      USERPROFILE: workDir,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      NO_PROXY: process.env.NO_PROXY,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyCfg,
      GIT_TEMPLATE_DIR: empty,
      LC_ALL: 'C',
    },
    baseArgs: [
      '-c', `core.hooksPath=${empty}`,
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      ...(src.fileProtocol ? ['-c', 'protocol.file.allow=always'] : []),
      '-c', 'fetch.fsckObjects=true',
      '-c', 'core.symlinks=false',
      '-c', 'gc.auto=0',
    ],
  };
  await runGit(ctx, ['init', '--bare', '--quiet', `--template=${empty}`, '.']);
  const want = spec.commit ?? spec.ref ?? 'HEAD';
  await runGit(ctx, ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--quiet', '--', src.url, want]);
  const commit = (await runGit(ctx, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new PackError('git_failed', 'could not resolve the fetched commit', 502);
  if (spec.commit && commit !== spec.commit) {
    throw new PackError('pin_mismatch', `fetched commit ${commit.slice(0, 12)} does not match the pin ${spec.commit.slice(0, 12)}`, 409);
  }
  const counted = (await runGit(ctx, ['count-objects', '-v'])).toString('utf8');
  const kib = [...counted.matchAll(/^(?:size|size-pack):\s*(\d+)/gm)].reduce((n, m) => n + Number(m[1]), 0);
  if (kib * 1024 > caps.maxRepoBytes) {
    throw new PackError('too_large', `repository tip is ${kib} KiB, over GUIDANCE_PACK_MAX_REPO_BYTES`, 413);
  }
  const tree = (await runGit(ctx, ['ls-tree', '-r', '-l', '-z', 'FETCH_HEAD'])).toString('utf8');
  const items: TreeItem[] = [];
  for (const rec of tree.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    // Regular files only: no symlinks (120000), no submodules (160000).
    if (m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) continue;
    items.push({ path: m[5], bytes: Number(m[4]) || 0, ref: m[3] });
  }
  return {
    commit,
    items,
    read: async (sel) => {
      const blobs = await catBlobs(ctx, [...new Set(sel.map((s) => s.ref))], caps.maxBytes);
      const out = new Map<string, Buffer>();
      for (const s of sel) {
        const b = blobs.get(s.ref);
        if (!b) throw new PackError('git_failed', `missing blob for ${s.path}`, 502);
        out.set(s.path, b);
      }
      return out;
    },
  };
}

async function walkLocal(dir: string): Promise<TreeItem[]> {
  const items: TreeItem[] = [];
  let visited = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (!rel) throw new PackError('source_unreadable', `cannot read local source: ${(e as Error).message}`, 404);
      return;
    }
    for (const d of dirents) {
      if (++visited > 50_000) throw new PackError('too_many_files', 'local source has too many files', 413);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) await walk(childAbs, childRel);
      } else if (d.isFile()) {
        if (!isLicenseFile(childRel) && !CONTENT_EXT_RE.test(d.name)) continue;
        const st = await fs.lstat(childAbs);
        if (st.isFile()) items.push({ path: childRel, bytes: st.size, ref: childAbs });
      }
    }
  };
  await walk(dir, '');
  return items;
}

function guessSpdx(text: string): string | null {
  const t = text.slice(0, 4000);
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/MIT License/i.test(t) || /Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Creative Commons Attribution 4\.0/i.test(t)) return 'CC-BY-4.0';
  if (/Creative Commons Attribution-ShareAlike 4\.0/i.test(t)) return 'CC-BY-SA-4.0';
  if (/Mozilla Public License,? v(ersion)?\.? ?2\.0/i.test(t)) return 'MPL-2.0';
  if (/GNU (LESSER )?GENERAL PUBLIC LICENSE/i.test(t)) return /LESSER/i.test(t) ? 'LGPL' : 'GPL';
  if (/Redistribution and use in source and binary forms/i.test(t)) return 'BSD';
  if (/CC0 1\.0/i.test(t)) return 'CC0-1.0';
  return null;
}

const inFlight = new Map<string, Promise<PackManifest>>();

/** Sync one pack. Concurrent calls for the same pack share one run. */
export function syncPack(specInput: PackSpec, opts: SyncOptions = {}): Promise<PackManifest> {
  const root = opts.root ?? packsRoot();
  const key = `${root}\0${specInput.name}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = doSync(specInput, root, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doSync(specInput: PackSpec, root: string, opts: SyncOptions): Promise<PackManifest> {
  const origin = specInput.origin ?? 'registry';
  const spec = validateSpec(specInput, origin);
  const src = resolveSource(spec.source, origin === 'env');
  const caps: SyncCaps = { ...syncCaps(), ...opts.caps };
  const started = Date.now();

  await fs.mkdir(root, { recursive: true });
  const tag = crypto.randomBytes(6).toString('hex');
  const workDir = path.join(root, `.work-${spec.name}-${tag}`);
  const staging = path.join(root, `.staging-${spec.name}-${tag}`);
  const contentDir = path.join(staging, 'content');
  const dest = path.join(root, spec.name);
  try {
    await fs.mkdir(contentDir, { recursive: true });

    let commit: string | null = null;
    let selected: TreeItem[];
    let skippedLarge: number;
    let data: Map<string, Buffer>;
    if (src.kind === 'git') {
      await fs.mkdir(workDir, { recursive: true });
      const fetched = await fetchGit(src, spec, caps, workDir, opts.gitBin ?? process.env.GUIDANCE_GIT_BIN ?? 'git');
      commit = fetched.commit;
      ({ selected, skippedLarge } = selectFiles(fetched.items, spec.include, caps));
      data = await fetched.read(selected);
    } else {
      if (spec.commit) throw new PackError('bad_commit', 'a commit pin needs a git source');
      const items = await walkLocal(src.dir);
      ({ selected, skippedLarge } = selectFiles(items, spec.include, caps));
      data = new Map();
      for (const it of selected) data.set(it.path, await fs.readFile(it.ref));
    }

    const files: PackFile[] = [];
    let bytes = 0;
    let licenseFile: string | null = null;
    let spdx: string | null = null;
    for (const it of selected) {
      const buf = data.get(it.path)!;
      if (buf.length > caps.maxFileBytes) {
        skippedLarge++;
        continue;
      }
      const target = path.join(contentDir, ...it.path.split('/'));
      if (!target.startsWith(contentDir + path.sep)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf);
      bytes += buf.length;
      if (isLicenseFile(it.path)) {
        if (!licenseFile || /^licen[sc]e/i.test(it.path)) {
          licenseFile = it.path;
          spdx = guessSpdx(buf.toString('utf8')) ?? spdx;
        }
      } else {
        files.push({ path: it.path, bytes: buf.length });
      }
    }
    if (!spdx) {
      // Fall back to a root package.json `license` string (read as data).
      const pkg = data.get('package.json');
      if (pkg) {
        try {
          const lic = (JSON.parse(pkg.toString('utf8')) as { license?: unknown }).license;
          if (typeof lic === 'string' && /^[\w .()+-]{1,60}$/.test(lic)) spdx = lic;
        } catch {
          // ignore
        }
      }
    }

    const parsed = await parsePack(
      { pack: spec.name, files, read: (rel) => fs.readFile(path.join(contentDir, ...rel.split('/')), 'utf8') },
      spec.adapter,
    );
    if (parsed.entries.length === 0) {
      throw new PackError('empty_pack', 'no Markdown guides found in the pack (check the include globs)', 422);
    }

    const manifest: PackManifest = {
      name: spec.name,
      source: { kind: src.kind, url: src.kind === 'git' ? src.url : src.dir },
      ref: spec.ref ?? null,
      commit,
      pinned: Boolean(spec.commit),
      license: { file: licenseFile, spdx },
      syncedAt: new Date().toISOString(),
      files: files.length,
      bytes,
      skippedLarge,
      adapter: parsed.adapter,
      entries: parsed.entries.length,
      skills: parsed.skills.length,
    };
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // Atomic swap: the live directory is replaced only once staging is complete.
    const old = path.join(root, `.old-${spec.name}-${tag}`);
    let hadOld = false;
    try {
      await fs.rename(dest, old);
      hadOld = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      await fs.rename(staging, dest);
    } catch (e) {
      if (hadOld) await fs.rename(old, dest).catch(() => {});
      throw e;
    }
    if (hadOld) await fs.rm(old, { recursive: true, force: true }).catch(() => {});

    logger.info('Guidance pack synced', {
      pack: spec.name,
      commit: commit?.slice(0, 12) ?? null,
      entries: manifest.entries,
      files: manifest.files,
      ms: Date.now() - started,
    });
    return manifest;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove a synced pack's files. Returns false when nothing was installed. */
export async function removePackFiles(name: string, root = packsRoot()): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new PackError('bad_name', 'bad pack name');
  const dir = path.join(root, name);
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  return true;
}
