import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { getCodeDb } from './db.js';

const REGISTRY_VAULT_PATH = 'Ops/code-repos.json';
const REGISTRY_VERSION = 1;

export interface VaultRegistryEntry {
  id: string;
  slug: string;
  git_origin: string | null;
  first_commit_sha: string;
  created_at: number;
  package_name: string | null;
}

export interface VaultRegistryDoc {
  version: number;
  updatedAt: number;
  repos: VaultRegistryEntry[];
}

/** Absolute path of the registry file inside the RW vault. */
function registryAbsPath(): string {
  return path.resolve(config.brainVault, REGISTRY_VAULT_PATH);
}

/**
 * Read the vault registry. Returns null when the file is missing or unparseable.
 * (Missing is the common case on a fresh data dir.)
 */
export async function readVaultRegistry(): Promise<VaultRegistryDoc | null> {
  const abs = registryAbsPath();
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VaultRegistryDoc>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.repos)) return null;
    return {
      version: parsed.version ?? REGISTRY_VERSION,
      updatedAt: parsed.updatedAt ?? 0,
      repos: parsed.repos.map((r) => ({
        id: String(r.id),
        slug: String(r.slug),
        git_origin: r.git_origin ?? null,
        first_commit_sha: String(r.first_commit_sha),
        created_at: Number(r.created_at) || 0,
        package_name: r.package_name ?? null,
      })),
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    logger.warn('Failed to read vault registry', {
      path: abs,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Rewrite the vault registry file from the current local DB state.
 * Atomic via .tmp + rename. Best-effort — failures are logged, not thrown.
 */
export async function writeVaultRegistry(): Promise<void> {
  try {
    const db = getCodeDb();
    const rows = db
      .prepare(
        `SELECT id, slug, git_origin, first_commit_sha, created_at, package_name FROM repos ORDER BY slug`,
      )
      .all() as VaultRegistryEntry[];

    const doc: VaultRegistryDoc = {
      version: REGISTRY_VERSION,
      updatedAt: Date.now(),
      repos: rows,
    };

    const abs = registryAbsPath();
    const tmp = `${abs}.tmp`;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
    await fs.rename(tmp, abs);
  } catch (err) {
    logger.error('Failed to write vault registry', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
