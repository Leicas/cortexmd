/**
 * Persistent entity registry backed by a JSON file.
 *
 * Stores confirmed, detected, and suggested entities with aliases.
 * File location: {config.dataDir}/entity-registry.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

export type EntityTier = 'confirmed' | 'detected' | 'suggested';

export interface RegistryEntity {
  name: string;
  type: 'person' | 'project' | 'organization';
  aliases: string[];
  firstSeen: string; // ISO 8601 date
  lastSeen: string;  // ISO 8601 date
  notePath?: string;
  confirmed: boolean;
  tier: EntityTier;
  occurrences: number;
}

interface RegistryData {
  version: number;
  entities: RegistryEntity[];
}

const REGISTRY_VERSION = 1;
let registryPath: string = '';
let entities: RegistryEntity[] = [];
let loaded = false;

function getRegistryPath(): string {
  if (!registryPath) {
    registryPath = path.join(config.dataDir, 'entity-registry.json');
  }
  return registryPath;
}

/**
 * Normalize a name for comparison: lowercase, collapse whitespace, trim.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Load the entity registry from disk. Creates an empty registry if none exists.
 */
export function loadRegistry(): RegistryEntity[] {
  const filePath = getRegistryPath();

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });

    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf-8');
      const data: RegistryData = JSON.parse(raw);
      entities = data.entities ?? [];
      loaded = true;
      logger.debug('Entity registry loaded', { count: entities.length });
    } else {
      entities = [];
      loaded = true;
      logger.debug('Entity registry initialized (empty)');
    }
  } catch (err) {
    logger.warn('Failed to load entity registry, starting empty', {
      error: err instanceof Error ? err.message : String(err),
    });
    entities = [];
    loaded = true;
  }

  return entities;
}

/**
 * Save the current entity registry to disk.
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a debounced save (coalesces rapid registrations). */
function debouncedSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveRegistry();
  }, 500);
}

export function saveRegistry(): void {
  const filePath = getRegistryPath();

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });

    const data: RegistryData = {
      version: REGISTRY_VERSION,
      entities,
    };

    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');

    // Atomic rename
    renameSync(tmpPath, filePath);

    logger.debug('Entity registry saved', { count: entities.length });
  } catch (err) {
    logger.error('Failed to save entity registry', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Register a new entity or update an existing one.
 * Returns the entity (created or updated).
 */
export function registerEntity(
  name: string,
  type: 'person' | 'project' | 'organization',
  opts: {
    tier?: EntityTier;
    notePath?: string;
    aliases?: string[];
  } = {},
): RegistryEntity {
  if (!loaded) loadRegistry();

  const normalized = normalizeName(name);
  const today = new Date().toISOString().slice(0, 10);
  const tier = opts.tier ?? 'suggested';

  // Check if entity already exists (by normalized name or alias)
  const existing = findEntityInternal(normalized);

  if (existing) {
    // Update existing entity
    existing.lastSeen = today;
    existing.occurrences++;

    // Promote tier if higher
    const tierOrder: EntityTier[] = ['suggested', 'detected', 'confirmed'];
    const existingIdx = tierOrder.indexOf(existing.tier);
    const newIdx = tierOrder.indexOf(tier);
    if (newIdx > existingIdx) {
      existing.tier = tier;
      existing.confirmed = tier === 'confirmed';
    }

    // Add aliases
    if (opts.aliases) {
      for (const alias of opts.aliases) {
        const normalizedAlias = normalizeName(alias);
        if (!existing.aliases.some(a => normalizeName(a) === normalizedAlias)) {
          existing.aliases.push(alias);
        }
      }
    }

    // Update notePath if provided
    if (opts.notePath && !existing.notePath) {
      existing.notePath = opts.notePath;
    }

    debouncedSave();
    return existing;
  }

  // Create new entity
  const entity: RegistryEntity = {
    name,
    type,
    aliases: opts.aliases ?? [],
    firstSeen: today,
    lastSeen: today,
    notePath: opts.notePath,
    confirmed: tier === 'confirmed',
    tier,
    occurrences: 1,
  };

  entities.push(entity);
  debouncedSave();
  return entity;
}

/**
 * Internal find by normalized name, checking both name and aliases.
 */
function findEntityInternal(normalizedQuery: string): RegistryEntity | undefined {
  return entities.find(e => {
    if (normalizeName(e.name) === normalizedQuery) return true;
    return e.aliases.some(a => normalizeName(a) === normalizedQuery);
  });
}

/**
 * Find an entity by name (exact or alias match, case-insensitive).
 */
export function findEntity(query: string): RegistryEntity | undefined {
  if (!loaded) loadRegistry();
  return findEntityInternal(normalizeName(query));
}

/**
 * List all entities, optionally filtered by type and/or tier.
 */
export function listEntities(
  opts: {
    type?: 'person' | 'project' | 'organization';
    tier?: EntityTier;
  } = {},
): RegistryEntity[] {
  if (!loaded) loadRegistry();

  return entities.filter(e => {
    if (opts.type && e.type !== opts.type) return false;
    if (opts.tier && e.tier !== opts.tier) return false;
    return true;
  });
}
