import { realpathSync, statSync, accessSync, constants } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, type SourceVault } from '../config.js';

/**
 * Runtime read-only source-vault store (Component B).
 *
 * Today source vaults come exclusively from the SOURCE_VAULTS env var, parsed
 * once into the FROZEN `config` arrays at boot. This module adds a mutable,
 * persisted layer on top: operators can add/remove source vaults at runtime via
 * the dashboard API without restarting the server.
 *
 * The effective ("dynamic") set is the MERGE of:
 *   1. immutable env-configured vaults (`config.sourceVaultConfigs`), and
 *   2. a persisted list at `${brainVault}/Ops/source-vaults.json`.
 *
 * Env entries are not editable via the API; persisted ones are. On a canonical
 * realpath conflict, the env entry wins (so an operator cannot shadow an
 * env-pinned vault through the API).
 *
 * Consumers that previously read the frozen `config.sourceVaultConfigs` /
 * `config.sourceVaults` arrays should call `listSourceVaults()` /
 * `listSourceVaultPaths()` instead so a newly-added vault is picked up. Writes
 * are NOT affected — the brain vault remains the sole write target.
 */

const SOURCE_VAULTS_PATH = path.join(config.brainVault, 'Ops', 'source-vaults.json');

/** Persisted entry shape, mirrors {@link SourceVault}. */
interface PersistedSourceVault {
  name: string;
  path: string;
  includeGlobs?: string[];
}

/** Typed error so callers (the API) can map failures to clean HTTP responses. */
export class SourceVaultError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_A_DIRECTORY'
      | 'NOT_READABLE'
      | 'INSIDE_BRAIN'
      | 'CONTAINS_BRAIN'
      | 'DUPLICATE'
      | 'INVALID_NAME'
      | 'DUPLICATE_NAME'
      | 'ENV_MANAGED'
      | 'PERSIST_FAILED',
  ) {
    super(message);
    this.name = 'SourceVaultError';
  }
}

/** In-memory cache of the persisted list (env entries are read from config). */
let persisted: PersistedSourceVault[] = loadPersisted();

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

/**
 * Register a callback fired after any persisted add/remove. Used by index.ts to
 * trigger a debounced reindex. Returns an unsubscribe function.
 */
export function onSourceVaultsChanged(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emitChange(): void {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

function loadPersisted(): PersistedSourceVault[] {
  try {
    const raw = JSON.parse(readFileSync(SOURCE_VAULTS_PATH, 'utf-8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is PersistedSourceVault =>
          !!e && typeof e === 'object' && typeof (e as any).name === 'string' && typeof (e as any).path === 'string',
      )
      .map((e) => ({
        name: e.name,
        path: e.path,
        includeGlobs: Array.isArray(e.includeGlobs) ? e.includeGlobs.filter((g): g is string => typeof g === 'string') : [],
      }));
  } catch {
    return [];
  }
}

function savePersisted(): void {
  try {
    mkdirSync(path.dirname(SOURCE_VAULTS_PATH), { recursive: true });
    writeFileSync(SOURCE_VAULTS_PATH, JSON.stringify(persisted, null, 2), 'utf-8');
  } catch (err) {
    throw new SourceVaultError(
      `Failed to persist source-vaults list (${SOURCE_VAULTS_PATH}): ${err instanceof Error ? err.message : String(err)}`,
      'PERSIST_FAILED',
    );
  }
}

/** Canonicalize a path for dedupe comparison. Falls back to a normalized form. */
function canonical(p: string): string {
  try {
    return realpathSync(p).replace(/\\/g, '/');
  } catch {
    return path.resolve(p).replace(/\\/g, '/');
  }
}

/**
 * The MERGED, deduped set of effective source vaults. Env entries
 * (`config.sourceVaultConfigs`) take precedence over persisted ones on a
 * canonical realpath conflict. Order: env first, then persisted.
 */
export function listSourceVaults(): SourceVault[] {
  const out: SourceVault[] = [];
  const seen = new Set<string>();

  for (const v of config.sourceVaultConfigs) {
    const key = canonical(v.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: v.name, path: v.path, includeGlobs: [...v.includeGlobs] });
  }
  for (const v of persisted) {
    const key = canonical(v.path);
    if (seen.has(key)) continue; // env wins
    seen.add(key);
    out.push({ name: v.name, path: v.path, includeGlobs: [...(v.includeGlobs ?? [])] });
  }
  return out;
}

/** Just the absolute paths of the merged source vaults (dynamic equivalent of `config.sourceVaults`). */
export function listSourceVaultPaths(): string[] {
  return listSourceVaults().map((v) => v.path);
}

/** Resolve the effective source-vault name for an absolute vault root, or undefined. */
export function sourceNameForVaultPath(vaultPath: string): string | undefined {
  const key = canonical(vaultPath);
  return listSourceVaults().find((v) => canonical(v.path) === key)?.name;
}

/** True if the given vault name corresponds to an env-configured (immutable) vault. */
function isEnvManaged(name: string): boolean {
  return config.sourceVaultConfigs.some((v) => v.name === name);
}

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

function isInside(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, '/');
  const p = parent.replace(/\\/g, '/');
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

export interface AddSourceVaultInput {
  path: string;
  name?: string;
  includeGlobs?: string[];
}

/**
 * Validate and persist a new (runtime) source vault. The path must resolve to
 * an existing, readable directory that is neither inside the brain vault nor a
 * parent of it, and must not duplicate an existing vault. The name defaults to
 * the directory basename and must be unique + filesystem-safe.
 *
 * Returns the added entry. Throws {@link SourceVaultError} on any failure.
 */
export function addSourceVault(input: AddSourceVaultInput): SourceVault {
  const absInput = path.resolve(input.path);

  // Must EXIST and be a DIRECTORY.
  let realPath: string;
  try {
    realPath = realpathSync(absInput);
  } catch {
    throw new SourceVaultError(`Source vault path does not exist: ${input.path}`, 'NOT_FOUND');
  }
  let st;
  try {
    st = statSync(realPath);
  } catch {
    throw new SourceVaultError(`Source vault path does not exist: ${input.path}`, 'NOT_FOUND');
  }
  if (!st.isDirectory()) {
    throw new SourceVaultError(`Source vault path is not a directory: ${input.path}`, 'NOT_A_DIRECTORY');
  }

  // Must be READABLE.
  try {
    accessSync(realPath, constants.R_OK);
  } catch {
    throw new SourceVaultError(`Source vault path is not readable: ${input.path}`, 'NOT_READABLE');
  }

  // Must NOT overlap the brain vault in either direction.
  const realBrain = canonical(config.brainVault);
  const realCanonical = realPath.replace(/\\/g, '/');
  if (isInside(realCanonical, realBrain)) {
    throw new SourceVaultError(
      `Source vault path must not be inside the brain vault (${config.brainVault}): ${input.path}`,
      'INSIDE_BRAIN',
    );
  }
  if (isInside(realBrain, realCanonical)) {
    throw new SourceVaultError(
      `Source vault path must not contain the brain vault (${config.brainVault}): ${input.path}`,
      'CONTAINS_BRAIN',
    );
  }

  // Must not duplicate an existing (env or persisted) vault.
  const existing = listSourceVaults();
  if (existing.some((v) => canonical(v.path) === realCanonical)) {
    throw new SourceVaultError(`Source vault already registered: ${input.path}`, 'DUPLICATE');
  }

  // Name: default to basename, validate, ensure uniqueness.
  const name = (input.name ?? path.basename(realPath)).trim();
  if (!name || !VALID_NAME.test(name)) {
    throw new SourceVaultError(
      `Invalid source vault name "${name}" (allowed: letters, digits, '.', '_', '-')`,
      'INVALID_NAME',
    );
  }
  if (existing.some((v) => v.name === name)) {
    throw new SourceVaultError(`A source vault named "${name}" already exists`, 'DUPLICATE_NAME');
  }

  const includeGlobs = (input.includeGlobs ?? []).filter((g) => typeof g === 'string' && g.trim().length > 0);

  // Persist the un-canonicalized realpath so it survives restarts cleanly.
  const entry: PersistedSourceVault = { name, path: realPath, includeGlobs };
  persisted.push(entry);
  savePersisted();
  emitChange();

  return { name, path: realPath, includeGlobs: [...includeGlobs] };
}

/**
 * Remove a PERSISTED source vault by name. Refuses to remove an env-configured
 * vault (those are immutable). Throws {@link SourceVaultError} if not found or
 * env-managed.
 */
export function removeSourceVault(name: string): void {
  if (isEnvManaged(name)) {
    throw new SourceVaultError(
      `Source vault "${name}" is env-managed (SOURCE_VAULTS) and cannot be removed at runtime`,
      'ENV_MANAGED',
    );
  }
  const idx = persisted.findIndex((v) => v.name === name);
  if (idx === -1) {
    throw new SourceVaultError(`No persisted source vault named "${name}"`, 'NOT_FOUND');
  }
  persisted.splice(idx, 1);
  savePersisted();
  emitChange();
}

/** Test-only: reset the in-memory persisted cache from disk. */
export function _reloadForTests(): void {
  persisted = loadPersisted();
}
