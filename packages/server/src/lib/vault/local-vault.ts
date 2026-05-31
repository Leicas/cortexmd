import { readFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import { computeEtag } from '../hash.js';
import type { IVault, VaultEntry, VaultStat } from './ivault.js';

/**
 * LocalVault — direct filesystem transport.
 *
 * Wraps the CURRENT filesystem read/list/stat behavior for a single vault root.
 * This is the only transport in local-stdio mode and is always the brain
 * vault's transport. `refresh()` is a no-op — there is nothing to fetch for a
 * local directory.
 *
 * Behavior parity notes:
 *  - `list()` mirrors `vault.listFiles(root)`: a POSIX markdown glob under the
 *    vault root, returning vault-relative paths.
 *  - `read()` mirrors `vault.readNote()`: reads UTF-8 content and computes the
 *    same SHA-256 ETag over the string content.
 *
 * Allowlist / denied-segment filtering is intentionally NOT applied here; it
 * stays where it lives today (search.rebuildIndex via index-allowlist), so this
 * extraction does not change observable behavior.
 */
export class LocalVault implements IVault {
  readonly name: string;
  /** Absolute filesystem root of this vault. */
  readonly root: string;

  constructor(name: string, root: string) {
    this.name = name;
    this.root = root;
  }

  async *list(prefix?: string): AsyncIterable<VaultEntry> {
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
    const abs = path.resolve(this.root, relPath);
    const buf = await readFile(abs);
    // Match readNote's ETag, which hashes the UTF-8 string content.
    const etag = computeEtag(buf.toString('utf-8'));
    return { content: buf, etag };
  }

  async stat(relPath: string): Promise<VaultStat | null> {
    const abs = path.resolve(this.root, relPath);
    try {
      const s = await fsStat(abs);
      return { relPath, size: s.size, mtimeMs: s.mtimeMs };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refresh(): Promise<void> {
    // No-op: a local directory is always current.
  }
}
