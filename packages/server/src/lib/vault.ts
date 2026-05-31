import { readFile, writeFile, mkdir, lstat, realpath, access, unlink, rename } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { config } from '../config.js';
import { listSourceVaultPaths } from './source-vaults.js';
import { computeEtag } from './hash.js';

/**
 * The dynamic READ containment set: the brain vault plus the runtime-merged
 * source vaults (env + persisted). Reads may resolve into any of these. WRITES
 * are unaffected — they always resolve only to `config.brainVault` (see the
 * `requireWrite` branches below), so a runtime-added source vault is readable
 * but never writable. This replaces the frozen `config.allVaults` for read
 * containment so a vault added at runtime becomes readable immediately.
 */
function readVaults(): string[] {
  return [config.brainVault, ...listSourceVaultPaths()];
}

/**
 * Validate that a path only targets allowed file types for note operations.
 * Allows .md files and paths without extensions (directories / vault roots).
 */
function validateFileExtension(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  // Allow no extension (directory paths) or .md
  if (ext && ext !== '.md') {
    throw new Error(
      `Only .md files are allowed for note operations, got "${ext}": ${filePath}`,
    );
  }
}

/**
 * Resolve the real (symlink-followed) path of `target`. If the leaf does not
 * exist yet (e.g. a not-yet-created file on a write), walk up to the nearest
 * existing ancestor, realpath that, and re-append the un-resolved tail. This
 * lets us detect a symlinked *parent directory* that escapes the vault even
 * when the final file does not exist.
 */
function realpathAllowingMissingLeaf(target: string): string {
  let prefix = target;
  const tail: string[] = [];
  // Walk up until we hit a path component that exists on disk.
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      const parent = path.dirname(prefix);
      if (parent === prefix) {
        // Reached the filesystem root without finding an existing ancestor.
        return target;
      }
      tail.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
}

/**
 * Assert that `resolved` — after following symlinks (including symlinked parent
 * directories) — still lives inside `vault`. Throws if it escapes. Uses
 * realpath rather than string-prefix containment so a symlink inside the vault
 * cannot smuggle a write outside it.
 */
function assertRealpathWithinVault(resolved: string, vault: string): void {
  const realResolved = realpathAllowingMissingLeaf(resolved).replace(/\\/g, '/');
  // The vault root itself may be a symlink; resolve it too for a fair compare.
  let realVault: string;
  try {
    realVault = realpathSync(vault).replace(/\\/g, '/');
  } catch {
    realVault = vault.replace(/\\/g, '/');
  }
  if (
    realResolved !== realVault &&
    !realResolved.startsWith(realVault + '/')
  ) {
    throw new Error(
      `Write access denied: path escapes the brain vault (${vault}) via symlink: ${resolved} -> ${realResolved}`,
    );
  }
}

/**
 * Resolve a vault-relative path to an absolute path, enforcing allowlist and
 * denied-segment rules, with hardened path-traversal protections.
 */
export function resolveSafePath(
  vaultRelativePath: string,
  requireWrite = false,
  allowBinary = false,
): string {
  // --- Null-byte rejection ---
  if (vaultRelativePath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  // --- Max path length ---
  if (vaultRelativePath.length > config.maxPathLength) {
    throw new Error(
      `Path exceeds maximum length of ${config.maxPathLength} characters`,
    );
  }

  // --- Normalize separators and collapse traversal sequences ---
  // Convert backslashes, collapse multiple slashes
  let cleaned = vaultRelativePath.replace(/\\/g, '/');
  cleaned = cleaned.replace(/\/+/g, '/');
  // Remove trailing slash
  cleaned = cleaned.replace(/\/+$/, '');

  // If the path is an exact vault root (absolute), return it directly
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    if (cleaned === normalizedVault) {
      if (requireWrite && vault !== config.brainVault) {
        throw new Error(
          `Write access denied: path must be within the brain vault (${config.brainVault}): ${vaultRelativePath}`,
        );
      }
      return vault;
    }
  }

  // If the path starts with an absolute vault root, strip it to make relative.
  // For writes, an absolute path under a NON-brain (source) vault is rejected
  // outright rather than silently redirected into the brain — a write must
  // explicitly target the brain vault.
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    if (cleaned.startsWith(normalizedVault + '/')) {
      if (requireWrite && vault !== config.brainVault) {
        throw new Error(
          `Write access denied: path must be within the brain vault (${config.brainVault}): ${vaultRelativePath}`,
        );
      }
      cleaned = cleaned.slice(normalizedVault.length).replace(/^\/+/, '');
      break;
    }
  }

  // Strip leading slashes so join works correctly
  cleaned = cleaned.replace(/^\/+/, '');

  // If the path starts with a vault basename, strip that too
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    const vaultBase = path.basename(normalizedVault);
    if (
      cleaned.startsWith(vaultBase + '/') ||
      cleaned === vaultBase
    ) {
      cleaned = cleaned.slice(vaultBase.length).replace(/^\/+/, '');
      break;
    }
  }

  // --- Check denied segments (case-insensitive) ---
  const segments = cleaned.split('/');
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    if (
      (config.deniedSegments as readonly string[]).some(
        (d) => d.toLowerCase() === segLower,
      )
    ) {
      throw new Error(
        `Path contains denied segment "${seg}": ${vaultRelativePath}`,
      );
    }
  }

  // --- File extension validation ---
  if (!allowBinary) {
    validateFileExtension(cleaned);
  }

  // Try to find the file in one of the allowed vaults
  // If requireWrite, only the brainVault is acceptable
  const candidateVaults = requireWrite ? [config.brainVault] : readVaults();

  // For write operations, resolve to the first valid vault (brainVault)
  // For read operations, return candidates for existence checking
  const validPaths: string[] = [];
  for (const vault of candidateVaults) {
    const resolved = path.resolve(vault, cleaned);
    const normalizedResolved = resolved.replace(/\\/g, '/');
    const normalizedVault = vault.replace(/\\/g, '/');

    if (
      !normalizedResolved.startsWith(normalizedVault + '/') &&
      normalizedResolved !== normalizedVault
    ) {
      continue; // path escapes this vault
    }

    if (requireWrite) {
      // Hardened containment: string-prefix above is necessary but not
      // sufficient — a symlinked component inside the brain could escape.
      // Re-check against the realpath before allowing the write.
      assertRealpathWithinVault(resolved, vault);
      return resolved; // write always targets brainVault
    }
    validPaths.push(resolved);
  }

  if (validPaths.length === 0) {
    if (requireWrite) {
      throw new Error(
        `Write access denied: path must be within the brain vault (${config.brainVault}): ${vaultRelativePath}`,
      );
    }
    throw new Error(
      `Path is not within any allowed vault: ${vaultRelativePath}`,
    );
  }

  // For reads: return first path (will be checked async by resolveSafePathForRead)
  return validPaths[0];
}

/**
 * Resolve a vault-relative path for reading by checking which vault actually
 * contains the file. Falls back to the first valid vault path if none exist
 * (lets downstream code produce a clear ENOENT).
 */
export async function resolveSafePathForRead(
  vaultRelativePath: string,
  allowBinary = false,
): Promise<string> {
  // If the path is an exact vault root, return it directly
  const normalizedInput = vaultRelativePath.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    if (normalizedInput === normalizedVault) {
      return vault;
    }
  }

  // Try two cleaned variants: without basename stripping first (preserves
  // paths like "Perso/Companies/CSA.md" that are vault-relative but happen
  // to start with a vault basename), then with basename stripping as fallback.
  const cleanedRaw = _cleanPath(vaultRelativePath, allowBinary, false);
  const cleanedStripped = _cleanPath(vaultRelativePath, allowBinary, true);
  const candidates = [cleanedRaw];
  if (cleanedStripped !== cleanedRaw) {
    candidates.push(cleanedStripped);
  }

  for (const cleaned of candidates) {
    for (const vault of readVaults()) {
      const resolved = path.resolve(vault, cleaned);
      const normalizedResolved = resolved.replace(/\\/g, '/');
      const normalizedVault = vault.replace(/\\/g, '/');

      if (
        !normalizedResolved.startsWith(normalizedVault + '/') &&
        normalizedResolved !== normalizedVault
      ) {
        continue;
      }

      try {
        await access(resolved, constants.R_OK);
        return resolved;
      } catch {
        continue; // file doesn't exist in this vault
      }
    }
  }

  // Fall back to sync resolution (will ENOENT on read)
  return resolveSafePath(vaultRelativePath, false, allowBinary);
}

/**
 * Internal: clean and validate a vault-relative path, returning the cleaned
 * relative path string. Shared between resolveSafePath and resolveSafePathForRead.
 */
function _cleanPath(vaultRelativePath: string, allowBinary = false, stripBasenames = true): string {
  if (vaultRelativePath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }
  if (vaultRelativePath.length > config.maxPathLength) {
    throw new Error(
      `Path exceeds maximum length of ${config.maxPathLength} characters`,
    );
  }

  let cleaned = vaultRelativePath.replace(/\\/g, '/');
  cleaned = cleaned.replace(/\/+/g, '/');
  cleaned = cleaned.replace(/\/+$/, '');

  // Strip absolute vault prefixes
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    if (cleaned === normalizedVault) return '';
    if (cleaned.startsWith(normalizedVault + '/')) {
      cleaned = cleaned.slice(normalizedVault.length).replace(/^\/+/, '');
      break;
    }
  }

  cleaned = cleaned.replace(/^\/+/, '');

  // Strip vault basename prefixes (optional — skipped when checking raw paths
  // so that vault-relative paths starting with a vault basename are preserved)
  if (stripBasenames) {
    for (const vault of readVaults()) {
      const normalizedVault = vault.replace(/\\/g, '/');
      const vaultBase = path.basename(normalizedVault);
      if (cleaned.startsWith(vaultBase + '/') || cleaned === vaultBase) {
        cleaned = cleaned.slice(vaultBase.length).replace(/^\/+/, '');
        break;
      }
    }
  }

  // Denied segments
  const segments = cleaned.split('/');
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    if (
      (config.deniedSegments as readonly string[]).some(
        (d) => d.toLowerCase() === segLower,
      )
    ) {
      throw new Error(
        `Path contains denied segment "${seg}": ${vaultRelativePath}`,
      );
    }
  }

  if (!allowBinary) {
    validateFileExtension(cleaned);
  }

  return cleaned;
}

/**
 * Check that the resolved path, after following symlinks, still resides within
 * the given vault boundary.  Throws if the symlink escapes.
 */
async function assertNoSymlinkEscape(
  resolvedPath: string,
  vault: string,
): Promise<void> {
  try {
    const stats = await lstat(resolvedPath);
    if (stats.isSymbolicLink()) {
      const real = await realpath(resolvedPath);
      const normalizedReal = real.replace(/\\/g, '/');
      const normalizedVault = vault.replace(/\\/g, '/');
      if (
        !normalizedReal.startsWith(normalizedVault + '/') &&
        normalizedReal !== normalizedVault
      ) {
        throw new Error(
          `Symlink escapes vault boundary: ${resolvedPath} -> ${real}`,
        );
      }
    }
  } catch (err: any) {
    // ENOENT is fine — file doesn't exist yet (e.g. before a write)
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Determine which vault root a resolved path belongs to.
 */
function findVaultRoot(resolvedPath: string): string {
  const normalized = resolvedPath.replace(/\\/g, '/');
  for (const vault of readVaults()) {
    const normalizedVault = vault.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedVault)) {
      return vault;
    }
  }
  return '';
}

/**
 * Read a note and return its content together with an ETag.
 */
export async function readNote(
  notePath: string,
): Promise<{ content: string; etag: string }> {
  const resolved = await resolveSafePathForRead(notePath);

  // Symlink escape check
  const vault = findVaultRoot(resolved);
  if (vault) {
    await assertNoSymlinkEscape(resolved, vault);
  }

  const content = await readFile(resolved, 'utf-8');
  const etag = computeEtag(content);
  return { content, etag };
}

/**
 * Write a note with optional optimistic-concurrency check (If-Match).
 */
export async function writeNote(
  notePath: string,
  content: string,
  ifMatch?: string,
): Promise<{ etag: string }> {
  // --- Max note size enforcement ---
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > config.maxNoteSize) {
    throw new Error(
      `Note content exceeds maximum size of ${config.maxNoteSize} bytes (got ${byteLength})`,
    );
  }

  const resolved = resolveSafePath(notePath, true);

  // Symlink escape check
  const vault = findVaultRoot(resolved);
  if (vault) {
    await assertNoSymlinkEscape(resolved, vault);
  }

  // Optimistic concurrency check
  if (ifMatch) {
    try {
      const existing = await readFile(resolved, 'utf-8');
      const existingEtag = computeEtag(existing);
      if (existingEtag !== ifMatch) {
        throw Object.assign(
          new Error(
            `ETag mismatch: expected ${ifMatch}, got ${existingEtag}. The file has been modified.`,
          ),
          { code: 'CONFLICT', status: 409 },
        );
      }
    } catch (err: any) {
      if (err.code === 'CONFLICT') throw err;
      // File doesn't exist yet — that's fine for a new write, but ifMatch
      // implies the caller expected it to exist.
      if (err.code === 'ENOENT') {
        throw Object.assign(
          new Error(
            `File does not exist, but an If-Match ETag was provided: ${notePath}`,
          ),
          { code: 'CONFLICT', status: 409 },
        );
      }
      throw err;
    }
  }

  // Ensure parent directories exist
  await mkdir(path.dirname(resolved), { recursive: true });

  await writeFile(resolved, content, 'utf-8');
  const etag = computeEtag(content);
  return { etag };
}

/**
 * Atomically move a note within the RW vault. Both source and destination
 * must resolve into the read-write vault — read-only vault files cannot be
 * moved. Uses an intermediate .tmp+rename to keep the destination half-write
 * resistant: the file is fully written to dest+'.tmp', then atomically
 * renamed to dest, then the source is unlinked.
 *
 * Strategy:
 *   1. Read source content (so we can write through the .tmp guard).
 *   2. Ensure destination parent directory exists.
 *   3. Write content to dest+'.tmp'.
 *   4. Atomically rename .tmp → dest.
 *   5. Unlink source.
 */
export async function moveNote(srcPath: string, dstPath: string): Promise<void> {
  const srcResolved = resolveSafePath(srcPath, true);
  const dstResolved = resolveSafePath(dstPath, true);

  // Symlink escape checks on both sides
  const srcVault = findVaultRoot(srcResolved);
  if (srcVault) await assertNoSymlinkEscape(srcResolved, srcVault);
  const dstVault = findVaultRoot(dstResolved);
  if (dstVault) await assertNoSymlinkEscape(dstResolved, dstVault);

  // Source must exist
  await access(srcResolved, constants.F_OK);

  const content = await readFile(srcResolved);

  await mkdir(path.dirname(dstResolved), { recursive: true });
  const tmp = dstResolved + '.tmp';
  await writeFile(tmp, content);
  await rename(tmp, dstResolved);
  await unlink(srcResolved);
}

/**
 * Permanently delete a note from the RW vault.
 * Only targets the read-write vault — read-only vault files cannot be deleted.
 */
export async function deleteNote(notePath: string): Promise<void> {
  const resolved = resolveSafePath(notePath, true); // requireWrite = true

  const vault = findVaultRoot(resolved);
  if (vault) {
    await assertNoSymlinkEscape(resolved, vault);
  }

  // Verify the file exists before attempting delete
  await access(resolved, constants.F_OK);
  await unlink(resolved);
}

/**
 * Write a binary file (image, audio, etc.) to the RW vault from base64 content.
 */
export async function writeBinaryFile(
  filePath: string,
  base64Content: string,
): Promise<void> {
  const resolved = resolveSafePath(filePath, true, true);

  const vault = findVaultRoot(resolved);
  if (vault) {
    await assertNoSymlinkEscape(resolved, vault);
  }

  const buffer = Buffer.from(base64Content, 'base64');
  if (buffer.length > config.maxNoteSize) {
    throw new Error(
      `File exceeds maximum size of ${config.maxNoteSize} bytes (got ${buffer.length})`,
    );
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, buffer);
}

/**
 * List .md files under a base path using a glob pattern.
 */
export async function listFiles(
  basePath: string,
  pattern = '**/*.md',
): Promise<string[]> {
  const resolved = await resolveSafePathForRead(basePath);

  // Determine which vault root this resolved path belongs to
  const vaultRoot = findVaultRoot(resolved);

  const matches = await glob(pattern, {
    cwd: resolved,
    nodir: true,
    posix: true,
  });

  // Return paths relative to the vault root
  if (vaultRoot) {
    const relBase = path.relative(vaultRoot, resolved).replace(/\\/g, '/');
    return matches.map((m) => (relBase ? `${relBase}/${m}` : m));
  }
  return matches;
}
