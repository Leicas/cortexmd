# The IVault transport seam

cortexmd hides *how source-vault bytes arrive* behind a single interface,
`IVault`, so the source of bytes is pluggable without touching any of the
search / memory / code-nav logic above it. This is the seam that lets the same
server build run identically in local-stdio mode (filesystem reads) and in
self-hosted HTTP mode (git / WebDAV / S3 reads).

For the data model these transports serve, see [`brain-vault.md`](./brain-vault.md).

## The interface

```ts
interface IVault {
  readonly name: string;
  list(prefix?: string): AsyncIterable<VaultEntry>;       // for indexing
  read(relPath: string): Promise<{ content: Buffer; etag: string }>;
  stat(relPath: string): Promise<VaultStat | null>;
  refresh(): Promise<void>;   // re-sync the underlying source
}
```

Note what is **absent**: there is no `write()` on the source side. Writes never
flow through this seam at all — they go straight to the local `BRAIN_VAULT`
(itself a `LocalVault`), and write routing enforces brain-only containment
separately. The source-vault transports are read-only **by type**, which makes
the one-way model from [`brain-vault.md`](./brain-vault.md) impossible to
violate by accident.

## Implementations

A registry builds one `IVault` per configured vault root and selects the
transport from the scheme of the configured path. Readers never know or care
which one they got.

| Configured path | Transport | `refresh()` |
|-----------------|-----------|-------------|
| plain filesystem path | **LocalVault** | no-op |
| `git+https://host/repo.git#branch` | **GitPullVault** | `git pull` (shallow clone first time) |
| `webdav+https://host/path` | **WebDavVault** | revalidate listing / ETags |
| `s3://bucket/prefix` | **S3Vault** | revalidate listing / ETags |

- **LocalVault** — direct filesystem reads. The only transport in local-stdio
  mode, and always the brain's transport. `refresh()` is a no-op because the OS
  already has the latest bytes.
- **GitPullVault** — the OSS default for HTTP mode. `refresh()` runs `git pull`
  (or a shallow clone on first use) into a cache dir under
  `DATA_DIR/source-cache/` on an interval, then `list`/`read` operate on the
  working tree.
- **WebDavVault / S3Vault** — read backends for hosted storage; `refresh()`
  revalidates listings and ETags.

The registry refreshes all source transports in parallel; a failure in one
source's `refresh()` is isolated and never takes down the others.

Switching a source from local to git-pull (or WebDAV/S3) is a **config change
only** — change the `SOURCE_VAULTS` entry's path; no code changes, and nothing
above the seam notices.

## Why read-only sources need no merge logic

This is the architectural payoff of the brain-vault decision.

Because the server **never writes to a source**, a source can only ever change
**upstream**. So `refresh()` reduces to: *fetch the latest snapshot and
re-index the diff.* That is a fast-forward, never a three-way merge:

- there is no local edit to reconcile,
- so there is no conflict,
- so there is no clobber.

Contrast this with the predecessor's bidirectional sync, where the same vault
was written by the human, a sync agent, and the server simultaneously — the
exact recipe for merge races and duplicated notes. By making sources read-only
and the brain the sole writer, periodic re-pull is **sufficient and correct**.

Indexing keys off content hash + ETag, so a re-pull only re-embeds files that
actually changed — cheap to run on a short interval.

## Allowlist interaction

Whatever the transport, the per-source **default-deny index allowlist** applies
to the vault-relative paths a transport yields (`name=path:glob1|glob2`), and
the hard-blocked segments `.obsidian` / `.sync` / `.trash` are denied
independently of any glob. See [`brain-vault.md`](./brain-vault.md#the-allowlist).
