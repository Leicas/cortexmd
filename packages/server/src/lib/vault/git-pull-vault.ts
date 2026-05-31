import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fsStat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { computeEtag } from '../hash.js';
import { logger } from '../logger.js';
import type { IVault, VaultEntry, VaultStat } from './ivault.js';

const execFileAsync = promisify(execFile);

/**
 * GitPullVault — the OSS default source transport for self-hosted HTTP mode
 *.
 *
 * Source vaults configured as `name=git+https://host/repo.git#branch` are
 * mounted as a git remote. On first use the repo is shallow-cloned (depth 1)
 * into a cache dir under the data dir; `refresh()` runs `git pull --ff-only`
 * to advance the working tree to the latest upstream snapshot. `list`, `read`
 * and `stat` operate on the cloned working tree exactly like LocalVault.
 *
 * Why read-only sources need NO merge logic (fast-forward only):
 *   The server is the sole writer and NEVER writes to a source vault — every
 *   server write lands in the brain vault via `resolveSafePath`. A source can
 *   therefore only ever change *upstream*. There is no local edit to
 *   reconcile, so a refresh reduces to "fetch the latest snapshot and re-index
 *   the diff" — a fast-forward, never a three-way merge, never a conflict,
 *   never a clobber. We pass `--ff-only` so that if upstream history was
 *   rewritten (a force-push), the pull fails loudly instead of silently
 *   creating a merge commit in a tree we are not supposed to mutate; the
 *   operator can then drop the cache dir to re-clone cleanly. Indexing keys
 *   off content hash + ETag, so re-pull only re-embeds files that changed.
 */
export class GitPullVault implements IVault {
  readonly name: string;
  /** `git+https://host/repo.git#branch` source spec. */
  readonly url: string;
  /** Clone URL (the spec with the `git+` scheme prefix and `#branch` stripped). */
  readonly cloneUrl: string;
  /** Branch to track, or undefined for the remote default branch. */
  readonly branch: string | undefined;
  /** Absolute path of the cached working tree. */
  readonly root: string;

  /** Serializes clone/pull so concurrent refreshes don't race on the tree. */
  private gitLock: Promise<void> = Promise.resolve();
  private cloned = false;

  /**
   * @param name      Source-vault name.
   * @param spec      `git+https://host/repo.git#branch` (branch optional).
   * @param cacheRoot Absolute parent dir for clones (one subdir per vault).
   */
  constructor(name: string, spec: string, cacheRoot: string) {
    this.name = name;
    this.url = spec;
    const { cloneUrl, branch } = parseGitSpec(spec);
    this.cloneUrl = cloneUrl;
    this.branch = branch;
    this.root = path.join(cacheRoot, sanitizeDirName(name));
    this.cloned = existsSync(path.join(this.root, '.git'));
  }

  async *list(prefix?: string): AsyncIterable<VaultEntry> {
    await this.ensureCloned();
    const cwd = prefix ? path.resolve(this.root, prefix) : this.root;
    const relBase = path.relative(this.root, cwd).replace(/\\/g, '/');
    const matches = await glob('**/*.md', {
      cwd,
      nodir: true,
      posix: true,
    });
    for (const m of matches) {
      const relPath = relBase ? `${relBase}/${m}` : m;
      yield { relPath };
    }
  }

  async read(relPath: string): Promise<{ content: Buffer; etag: string }> {
    await this.ensureCloned();
    const abs = path.resolve(this.root, relPath);
    const buf = await readFile(abs);
    // Match LocalVault/readNote: ETag hashes the UTF-8 string content.
    const etag = computeEtag(buf.toString('utf-8'));
    return { content: buf, etag };
  }

  async stat(relPath: string): Promise<VaultStat | null> {
    await this.ensureCloned();
    const abs = path.resolve(this.root, relPath);
    try {
      const s = await fsStat(abs);
      return { relPath, size: s.size, mtimeMs: s.mtimeMs };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Fetch the latest upstream snapshot. Shallow-clones on first use, otherwise
   * runs a fast-forward-only pull. Serialized; errors are swallowed-and-logged
   * so a transient network failure leaves the previous snapshot intact rather
   * than crashing the refresh job.
   */
  async refresh(): Promise<void> {
    await this.withGitLock(async () => {
      if (!this.cloned) {
        await this.clone();
        return;
      }
      try {
        const args = ['pull', '--ff-only'];
        if (this.branch) args.push('origin', this.branch);
        await this.git(this.root, args);
        logger.info('GitPullVault refreshed', { name: this.name });
      } catch (err) {
        logger.warn('GitPullVault refresh (pull) failed — keeping previous snapshot', {
          name: this.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** Clone on first access (e.g. an index list before the first refresh tick). */
  private async ensureCloned(): Promise<void> {
    if (this.cloned) return;
    await this.withGitLock(async () => {
      if (this.cloned) return;
      await this.clone();
    });
  }

  private async clone(): Promise<void> {
    await mkdir(path.dirname(this.root), { recursive: true });
    const args = ['clone', '--depth', '1'];
    if (this.branch) args.push('--branch', this.branch);
    args.push(this.cloneUrl, this.root);
    // Run from the cache parent so a relative target resolves predictably.
    await this.git(path.dirname(this.root), args);
    this.cloned = true;
    logger.info('GitPullVault cloned', {
      name: this.name,
      url: this.cloneUrl,
      branch: this.branch ?? '(default)',
    });
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
    return stdout.toString();
  }

  /** Chain git operations so clone/pull never overlap for this vault. */
  private withGitLock(fn: () => Promise<void>): Promise<void> {
    const next = this.gitLock.then(fn, fn);
    // Keep the chain alive even if a step rejects.
    this.gitLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** True if a SOURCE_VAULTS path entry is a git-pull spec. */
export function isGitSpec(specPath: string): boolean {
  return /^git\+https?:\/\//i.test(specPath.trim());
}

/**
 * Split `git+https://host/repo.git#branch` into its clone URL and branch.
 * The `git+` scheme prefix is stripped; an optional `#branch` fragment selects
 * the branch (undefined → remote default).
 */
export function parseGitSpec(spec: string): { cloneUrl: string; branch: string | undefined } {
  const trimmed = spec.trim().replace(/^git\+/i, '');
  const hash = trimmed.indexOf('#');
  if (hash >= 0) {
    const branch = trimmed.slice(hash + 1).trim();
    return { cloneUrl: trimmed.slice(0, hash), branch: branch || undefined };
  }
  return { cloneUrl: trimmed, branch: undefined };
}

/** Make a vault name safe to use as a single path segment for the cache dir. */
function sanitizeDirName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return safe.length > 0 ? safe : 'source';
}
