import path from 'node:path';
import { config } from '../../config.js';
import { sourceNameForVault } from '../index-allowlist.js';
import { listSourceVaultPaths } from '../source-vaults.js';
import type { IVault } from './ivault.js';
import { LocalVault } from './local-vault.js';
import { GitPullVault, isGitSpec } from './git-pull-vault.js';
import { WebDavVault, isWebDavSpec } from './webdav-vault.js';
import { S3Vault, isS3Spec } from './s3-vault.js';

/**
 * Vault registry / factory.
 *
 * Builds one IVault per configured vault root: a LocalVault for the brain
 * vault, and per source vault either a LocalVault (a filesystem path) or a
 * GitPullVault (a `git+https://host/repo.git#branch` spec). The registry is
 * the single place transports are selected; readers never care which one
 * they got.
 *
 * Vaults are keyed by their `path` as it appears in `config.sourceVaults`
 * (an absolute filesystem path for local, or the raw git spec for git-pull)
 * so callers iterating `config.allVaults` can look up the corresponding
 * transport directly.
 */

/** Cache dir for git-pull source clones, one subdir per vault. */
function gitCacheRoot(): string {
  return path.join(config.dataDir, 'source-cache');
}

/** Build the IVault transport for a single source-vault root. */
function buildSourceTransport(vaultRoot: string): IVault {
  const name = sourceNameForVault(vaultRoot) ?? vaultRoot;
  if (isGitSpec(vaultRoot)) {
    return new GitPullVault(name, vaultRoot, gitCacheRoot());
  } else if (isWebDavSpec(vaultRoot)) {
    return new WebDavVault(name, vaultRoot);
  } else if (isS3Spec(vaultRoot)) {
    return new S3Vault(name, vaultRoot);
  }
  return new LocalVault(name, vaultRoot);
}

/**
 * Registry of vault transports, keyed by vault root. The brain vault is always
 * present. Source-vault transports are created lazily (and cached) on first
 * access so a runtime-added source vault (see lib/source-vaults.ts) transparently
 * gets a transport without a server restart. Transport selection is by the scheme
 * of the configured path — git+http(s):// → GitPullVault, webdav+http(s):// →
 * WebDavVault, s3:// → S3Vault, else a plain filesystem LocalVault.
 */
const registry = new Map<string, IVault>();
// Brain vault: always local, sole write target (writes bypass this seam).
registry.set(config.brainVault, new LocalVault('brain', config.brainVault));

/**
 * Return the IVault transport for an absolute vault root. For the brain vault
 * and any source vault in the dynamic set (`listSourceVaultPaths()`), creates
 * and caches a transport on first access. Returns undefined for unknown roots.
 */
export function getVault(vaultRoot: string): IVault | undefined {
  const cached = registry.get(vaultRoot);
  if (cached) return cached;
  if (listSourceVaultPaths().includes(vaultRoot)) {
    const transport = buildSourceTransport(vaultRoot);
    registry.set(vaultRoot, transport);
    return transport;
  }
  return undefined;
}

/** All current vault transports (brain + the dynamic source set). */
export function allVaultTransports(): IVault[] {
  const out: IVault[] = [registry.get(config.brainVault)!];
  out.push(...sourceVaultTransports());
  return out;
}

/** Source-vault transports for the dynamic source set (everything except the brain vault). */
export function sourceVaultTransports(): IVault[] {
  return listSourceVaultPaths()
    .map((root) => getVault(root))
    .filter((v): v is IVault => v !== undefined);
}

/**
 * Drop cached transports for source vaults that are no longer in the dynamic
 * set (e.g. after a removeSourceVault). The brain vault is never evicted.
 */
export function pruneStaleVaultTransports(): void {
  const live = new Set([config.brainVault, ...listSourceVaultPaths()]);
  for (const key of [...registry.keys()]) {
    if (!live.has(key)) registry.delete(key);
  }
}

/**
 * Refresh every source vault (no-op for LocalVault; git pull for GitPullVault).
 * Runs refreshes in parallel; per-vault errors are isolated by each transport's
 * own refresh() and never reject this aggregate.
 */
export async function refreshSourceVaults(): Promise<void> {
  await Promise.all(sourceVaultTransports().map((v) => v.refresh()));
}
