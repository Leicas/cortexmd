/**
 * IVault — the read-transport seam.
 *
 * `IVault` abstracts *how source-vault bytes arrive* so that indexing can read
 * a vault without caring whether it lives on the local filesystem (LocalVault),
 * behind a periodic `git pull` (GitPullVault, future PR), or over WebDAV/S3.
 *
 * Writes are deliberately NOT part of this seam: the server is the sole writer
 * and always writes directly to the local brain vault via `resolveSafePath`
 * (see lib/vault.ts). Only source reads are pluggable.
 */

/** A single entry returned while listing a vault. */
export interface VaultEntry {
  /** Vault-relative path (POSIX separators), e.g. "Notes/foo.md". */
  relPath: string;
}

/** Lightweight stat for a vault-relative path. */
export interface VaultStat {
  /** Vault-relative path (POSIX separators). */
  relPath: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number;
}

export interface IVault {
  /** Stable name of this vault (the brain vault, or a source-vault name). */
  readonly name: string;

  /**
   * List entries under an optional vault-relative prefix. Used by indexing.
   * Yields vault-relative paths; denied segments / allowlist filtering remain
   * the caller's responsibility (kept where it is today).
   */
  list(prefix?: string): AsyncIterable<VaultEntry>;

  /** Read a vault-relative path, returning its bytes and a content ETag. */
  read(relPath: string): Promise<{ content: Buffer; etag: string }>;

  /** Stat a vault-relative path, or null if it does not exist. */
  stat(relPath: string): Promise<VaultStat | null>;

  /**
   * Refresh the backing store. No-op for LocalVault; for git-pull / WebDAV / S3
   * this fetches the latest snapshot so a subsequent list/read sees it.
   */
  refresh(): Promise<void>;
}
