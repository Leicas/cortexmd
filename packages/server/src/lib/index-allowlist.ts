import { minimatch } from 'minimatch';
import { config } from '../config.js';
import { listSourceVaults } from './source-vaults.js';

/**
 * Per-source-vault, default-deny index allowlist (a privacy control).
 *
 * Each source vault may declare an include-glob allowlist via SOURCE_VAULTS
 * (`name=path:glob1|glob2`, parsed in config.ts). When a source vault has a
 * non-empty allowlist, ONLY vault-relative paths matching one of its globs are
 * walked / indexed / embedded. A source vault with an empty allowlist is fully
 * indexable (opt-out / legacy behavior).
 *
 * The brain vault is always fully indexable — the allowlist is a source-vault
 * privacy gate only.
 *
 * Hard-blocked segments (`.obsidian`, `.sync`, `.trash`) are denied
 * independently of the allowlist and can never be indexed, even if an explicit
 * glob would otherwise match them.
 */
export function isPathIndexable(sourceName: string, relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');

  // Hard-blocked segments always lose, regardless of any allowlist.
  const segments = normalized.split('/');
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    if ((config.deniedSegments as readonly string[]).some((d) => d.toLowerCase() === segLower)) {
      return false;
    }
  }

  const source = listSourceVaults().find((s) => s.name === sourceName);
  // Unknown source name (e.g. the brain vault) — no allowlist gate.
  if (!source) return true;
  // Empty allowlist means the whole vault is indexable.
  if (source.includeGlobs.length === 0) return true;

  return source.includeGlobs.some((glob) =>
    minimatch(normalized, glob, { dot: false, nocase: false }),
  );
}

/**
 * Resolve the configured source-vault name for an absolute vault root path.
 * Returns undefined when the path is not a known source vault (e.g. the brain
 * vault), in which case no allowlist applies.
 */
export function sourceNameForVault(vaultPath: string): string | undefined {
  const normalized = vaultPath.replace(/\\/g, '/');
  return listSourceVaults().find(
    (s) => s.path.replace(/\\/g, '/') === normalized,
  )?.name;
}
