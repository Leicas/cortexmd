import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from './logger.js';
import { extractWikilinks } from './markdown.js';
import { classifyPath } from './collections.js';
import { detectEntities } from './entity-detector.js';

let db: BetterSqlite3.Database | null = null;

function getDb(): BetterSqlite3.Database {
  if (!db) throw new Error('Knowledge graph not initialized — call initKnowledgeGraph() first');
  return db;
}

function tripleId(subject: string, predicate: string, object: string): string {
  return createHash('md5').update(subject + predicate + object).digest('hex');
}

function nowISO(): string {
  return new Date().toISOString();
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function initKnowledgeGraph(): void {
  const dbPath = path.join(config.dataDir, 'knowledge-graph.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      name    TEXT PRIMARY KEY,
      type    TEXT NOT NULL DEFAULT 'unknown',
      properties TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triples (
      id         TEXT PRIMARY KEY,
      subject    TEXT NOT NULL,
      predicate  TEXT NOT NULL,
      object     TEXT NOT NULL,
      valid_from TEXT,
      valid_to   TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      source     TEXT,
      created    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
    CREATE INDEX IF NOT EXISTS idx_triples_object  ON triples(object);
    CREATE INDEX IF NOT EXISTS idx_triples_validity ON triples(valid_from, valid_to);
  `);

  migrateBitemporalColumns(db);

  logger.info('Knowledge graph initialized', { dbPath });
}

/**
 * Bitemporal KG migration (additive, idempotent). Adds TRANSACTION-time columns
 * (recorded_at / invalidated_at) and the supersession links (superseded_by /
 * supersedes) to the existing EVENT-time columns (valid_from / valid_to).
 *
 * Safety: purely additive ALTER TABLE ADD COLUMN guarded against re-run; never
 * drops or hard-deletes. On a DB that already has the columns this is a no-op.
 * With the BITEMPORAL_KG flag off, the columns simply stay at their backfilled
 * defaults (recorded_at = created, everything else NULL) and no code writes them.
 */
function migrateBitemporalColumns(d: BetterSqlite3.Database): void {
  const cols = new Set(
    (d.prepare('PRAGMA table_info(triples)').all() as Array<{ name: string }>).map((c) => c.name),
  );

  const addColumn = (name: string, decl: string): void => {
    if (cols.has(name)) return;
    d.exec(`ALTER TABLE triples ADD COLUMN ${name} ${decl}`);
    cols.add(name);
  };

  addColumn('recorded_at', 'TEXT');
  addColumn('invalidated_at', 'TEXT');
  addColumn('superseded_by', 'TEXT');
  addColumn('supersedes', 'TEXT');

  // Backfill transaction-time for pre-existing rows so `recorded_at` is never
  // NULL going forward (it defaults to the row's original creation timestamp).
  d.exec('UPDATE triples SET recorded_at = created WHERE recorded_at IS NULL');

  d.exec('CREATE INDEX IF NOT EXISTS idx_triples_sp  ON triples(subject, predicate)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_triples_txn ON triples(invalidated_at)');
}

export function shutdownKG(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Knowledge graph closed');
  }
}

function ensureEntity(name: string): void {
  const d = getDb();
  const now = nowISO();
  d.prepare(
    `INSERT INTO entities (name, created, updated) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET updated = excluded.updated`,
  ).run(name, now, now);
}

export interface AddTripleOpts {
  validFrom?: string;
  confidence?: number;
  source?: string;
}

export function kgAddTriple(
  subject: string,
  predicate: string,
  object: string,
  opts?: AddTripleOpts,
): { id: string; created: boolean } {
  const d = getDb();
  const id = tripleId(subject, predicate, object);
  const now = nowISO();
  const validFrom = opts?.validFrom ?? todayISO();
  const confidence = opts?.confidence ?? 1.0;
  const source = opts?.source ?? null;

  // Auto-create entities
  ensureEntity(subject);
  ensureEntity(object);

  // Upsert: if triple already exists, update validity/confidence/source but keep created timestamp
  const existing = d.prepare('SELECT id FROM triples WHERE id = ?').get(id) as { id: string } | undefined;

  if (existing) {
    // Re-opening an existing triple clears any prior transaction-time closure so
    // the row is live again (invalidated_at = NULL). superseded_by/supersedes are
    // left untouched — they are managed exclusively by kgSupersede.
    d.prepare(
      `UPDATE triples SET valid_from = ?, valid_to = NULL, confidence = ?, source = ?, invalidated_at = NULL WHERE id = ?`,
    ).run(validFrom, confidence, source, id);
    return { id, created: false };
  }

  d.prepare(
    `INSERT INTO triples (id, subject, predicate, object, valid_from, confidence, source, created, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, subject, predicate, object, validFrom, confidence, source, now, now);

  return { id, created: true };
}

export function kgInvalidateTriple(
  subject: string,
  predicate: string,
  object: string,
  ended?: string,
): boolean {
  const d = getDb();
  const id = tripleId(subject, predicate, object);
  const validTo = ended ?? todayISO();
  const now = nowISO();

  // Close the fact's EVENT-time window (valid_to) and stamp its TRANSACTION-time
  // closure (invalidated_at). Additive: existing callers are unaffected — the
  // return contract (did we close a live triple?) is identical to before.
  const result = d
    .prepare('UPDATE triples SET valid_to = ?, invalidated_at = ? WHERE id = ? AND valid_to IS NULL')
    .run(validTo, now, id);
  return result.changes > 0;
}

/**
 * Bitemporal supersession primitive (close-and-link, never delete).
 *
 * When a new single-valued fact (subject, predicate, newObject) arrives with
 * EVENT time `eventTime`, any transaction-active rival with the same
 * (subject, predicate) but a different object is CLOSED:
 *   - valid_to        = eventTime   (event-time window ends when the new fact begins)
 *   - invalidated_at  = now         (transaction-time closure)
 *   - superseded_by   = newId       (forward link to the replacement)
 * and the new triple is inserted/re-opened with `supersedes` pointing back at
 * the first rival it replaced. History is preserved: superseded rows remain
 * SELECT-able, just marked closed and linked.
 *
 * Caller (bitemporal.ts, owner B) is responsible for gating this behind
 * config.bitemporalKg and for restricting `predicate` to single-valued
 * relations. This function itself performs no flag check — it is a pure KG
 * write primitive.
 */
export function kgSupersede(
  subject: string,
  predicate: string,
  newObject: string,
  eventTime: string,
  opts?: { source?: string; confidence?: number },
): { newId: string; supersededIds: string[] } {
  const d = getDb();
  const newId = tripleId(subject, predicate, newObject);
  const now = nowISO();
  const confidence = opts?.confidence ?? 1.0;
  const source = opts?.source ?? null;

  const runTxn = d.transaction((): { newId: string; supersededIds: string[] } => {
    ensureEntity(subject);
    ensureEntity(newObject);

    // 1. Find transaction-active rivals: same (subject, predicate), different
    //    object, not already closed.
    const rivals = d
      .prepare(
        `SELECT id FROM triples
         WHERE subject = ? AND predicate = ? AND object != ? AND invalidated_at IS NULL`,
      )
      .all(subject, predicate, newObject) as Array<{ id: string }>;
    const supersededIds = rivals.map((r) => r.id);
    const firstRival = supersededIds.length > 0 ? supersededIds[0] : null;

    // 2. Insert or re-open the new (superseding) triple.
    const existing = d.prepare('SELECT id FROM triples WHERE id = ?').get(newId) as
      | { id: string }
      | undefined;
    if (existing) {
      d.prepare(
        `UPDATE triples
         SET valid_from = ?, valid_to = NULL, confidence = ?, source = ?,
             invalidated_at = NULL, supersedes = COALESCE(?, supersedes)
         WHERE id = ?`,
      ).run(eventTime, confidence, source, firstRival, newId);
    } else {
      d.prepare(
        `INSERT INTO triples
           (id, subject, predicate, object, valid_from, confidence, source, created, recorded_at, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, subject, predicate, newObject, eventTime, confidence, source, now, now, firstRival);
    }

    // 3. Close each rival. Only stamp valid_to when it is still open so a
    //    manually-ended fact isn't clobbered; always link superseded_by and
    //    stamp the transaction-time closure.
    const closeRival = d.prepare(
      `UPDATE triples
       SET valid_to = COALESCE(valid_to, ?), invalidated_at = ?, superseded_by = ?
       WHERE id = ?`,
    );
    for (const id of supersededIds) {
      closeRival.run(eventTime, now, newId, id);
    }

    return { newId, supersededIds };
  });

  return runTxn();
}

export interface TripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  invalidated_at: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  confidence: number;
  source: string | null;
  created: string;
}

export interface EntityRow {
  name: string;
  type: string;
  properties: string;
  created: string;
  updated: string;
}

export function kgQueryEntity(
  entity: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both',
  asOf?: string,
): { entity: EntityRow | null; triples: TripleRow[] } {
  const d = getDb();

  const entityRow = d.prepare('SELECT * FROM entities WHERE name = ?').get(entity) as EntityRow | undefined;

  let triples: TripleRow[] = [];

  if (asOf) {
    // Return triples valid at the given date
    if (direction === 'outgoing' || direction === 'both') {
      const rows = d.prepare(
        `SELECT * FROM triples
         WHERE subject = ?
           AND (valid_from IS NULL OR valid_from <= ?)
           AND (valid_to IS NULL OR valid_to > ?)`,
      ).all(entity, asOf, asOf) as TripleRow[];
      triples.push(...rows);
    }
    if (direction === 'incoming' || direction === 'both') {
      const rows = d.prepare(
        `SELECT * FROM triples
         WHERE object = ?
           AND (valid_from IS NULL OR valid_from <= ?)
           AND (valid_to IS NULL OR valid_to > ?)`,
      ).all(entity, asOf, asOf) as TripleRow[];
      triples.push(...rows);
    }
  } else {
    // Return all triples (including expired) for full history
    if (direction === 'outgoing' || direction === 'both') {
      const rows = d.prepare('SELECT * FROM triples WHERE subject = ?').all(entity) as TripleRow[];
      triples.push(...rows);
    }
    if (direction === 'incoming' || direction === 'both') {
      const rows = d.prepare('SELECT * FROM triples WHERE object = ?').all(entity) as TripleRow[];
      triples.push(...rows);
    }
  }

  // Deduplicate in case both directions picked up the same triple (self-referencing)
  const seen = new Set<string>();
  triples = triples.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return { entity: entityRow ?? null, triples };
}

export function kgTimeline(entity?: string): TripleRow[] {
  const d = getDb();

  if (entity) {
    return d.prepare(
      `SELECT * FROM triples
       WHERE subject = ? OR object = ?
       ORDER BY COALESCE(valid_from, created) ASC`,
    ).all(entity, entity) as TripleRow[];
  }

  return d.prepare(
    'SELECT * FROM triples ORDER BY COALESCE(valid_from, created) ASC',
  ).all() as TripleRow[];
}

export function isKgInitialized(): boolean {
  return db !== null;
}

export function kgStats(): {
  entityCount: number;
  tripleCount: number;
  activeTriples: number;
  expiredTriples: number;
  topEntities: Array<{ name: string; connections: number }>;
  topPredicates: Array<{ name: string; count: number }>;
} {
  const d = getDb();

  const entityCount = (d.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
  const tripleCount = (d.prepare('SELECT COUNT(*) AS c FROM triples').get() as { c: number }).c;
  const activeTriples = (d.prepare('SELECT COUNT(*) AS c FROM triples WHERE valid_to IS NULL').get() as { c: number }).c;
  const expiredTriples = tripleCount - activeTriples;

  const topEntities = d.prepare(
    `SELECT name, SUM(cnt) AS connections FROM (
       SELECT subject AS name, COUNT(*) AS cnt FROM triples GROUP BY subject
       UNION ALL
       SELECT object AS name, COUNT(*) AS cnt FROM triples GROUP BY object
     )
     GROUP BY name
     ORDER BY connections DESC
     LIMIT 10`,
  ).all() as Array<{ name: string; connections: number }>;

  const topPredicates = d.prepare(
    `SELECT predicate AS name, COUNT(*) AS count FROM triples
     WHERE valid_to IS NULL
     GROUP BY predicate
     ORDER BY count DESC
     LIMIT 10`,
  ).all() as Array<{ name: string; count: number }>;

  return { entityCount, tripleCount, activeTriples, expiredTriples, topEntities, topPredicates };
}

export function kgSearch(query: string, limit = 20): TripleRow[] {
  const d = getDb();
  const escaped = query.replace(/[%_\\]/g, '\\$&');
  const pattern = `%${escaped}%`;

  return d.prepare(
    `SELECT * FROM triples
     WHERE subject LIKE ? ESCAPE '\\' OR predicate LIKE ? ESCAPE '\\' OR object LIKE ? ESCAPE '\\'
     ORDER BY created DESC
     LIMIT ?`,
  ).all(pattern, pattern, pattern, limit) as TripleRow[];
}

/**
 * Repair the knowledge graph database.
 * Runs PRAGMA integrity_check; if corrupt, backs up and recreates.
 */
export function kgRepair(): { status: 'ok' | 'repaired' | 'error'; detail: string } {
  const dbPath = path.join(config.dataDir, 'knowledge-graph.sqlite');

  if (!fs.existsSync(dbPath)) {
    initKnowledgeGraph();
    return { status: 'ok', detail: 'No existing database, initialized fresh' };
  }

  try {
    const testDb = new Database(dbPath, { readonly: true });
    const result = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const ok = result.length === 1 && result[0].integrity_check === 'ok';
    testDb.close();

    if (ok) {
      const d = getDb();
      const entityCount = (d.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c;
      const tripleCount = (d.prepare('SELECT COUNT(*) as c FROM triples').get() as any).c;
      return { status: 'ok', detail: `Integrity check passed: ${tripleCount} triples, ${entityCount} entities` };
    }

    throw new Error('Integrity check failed');
  } catch (err) {
    const timestamp = Date.now();
    const backupPath = `${dbPath}.corrupt.${timestamp}`;
    try {
      fs.copyFileSync(dbPath, backupPath);
      fs.unlinkSync(dbPath);
      logger.warn('KG database corrupt, backed up and recreating', { backupPath });
    } catch (backupErr) {
      logger.error('Failed to backup corrupt KG database', {
        error: backupErr instanceof Error ? backupErr.message : String(backupErr),
      });
    }

    // Reinitialize
    shutdownKG();
    initKnowledgeGraph();

    return {
      status: 'repaired',
      detail: `Database was corrupt (${err instanceof Error ? err.message : String(err)}), backed up to ${backupPath} and recreated`,
    };
  }
}

/**
 * Bootstrap the knowledge graph from existing indexed notes.
 * Scans all docMeta entries and seeds the KG with:
 * - Wiki-link relationships (links_to triples)
 * - Collection membership (in_collection triples)
 * - Detected entities from note content (person/project/org entities)
 * - Frontmatter relationships (people_links, org_links, project_links)
 *
 * Idempotent: uses kgAddTriple which upserts, so safe to re-run.
 */
export function kgBootstrap(
  docMeta: ReadonlyMap<string, { title: string; content: string; collection: string; tags: string[] }>,
): { entities: number; triples: number; duration_ms: number } {
  if (!isKgInitialized()) {
    throw new Error('Knowledge graph not initialized');
  }

  const start = Date.now();
  let entityCount = 0;
  let tripleCount = 0;

  const d = getDb();
  // Use a transaction for batch performance
  const runBatch = d.transaction(() => {
    for (const [notePath, meta] of docMeta) {
      const noteTitle = meta.title || notePath.replace(/\.md$/, '').split('/').pop() || notePath;
      const collection = meta.collection ?? classifyPath(notePath);

      // 1. Collection membership
      const added1 = kgAddTriple(noteTitle, 'in_collection', collection, {
        source: `bootstrap:${notePath}`,
        confidence: 1.0,
      });
      if (added1.created) tripleCount++;

      // 2. Wiki-link relationships
      const links = extractWikilinks(meta.content);
      for (const target of links) {
        const targetName = target.replace(/\.md$/, '').split('/').pop() || target;
        const added = kgAddTriple(noteTitle, 'links_to', targetName, {
          source: `bootstrap:${notePath}`,
          confidence: 0.8,
        });
        if (added.created) tripleCount++;
      }

      // 3. Tag relationships
      for (const tag of meta.tags) {
        const cleanTag = tag.startsWith('#') ? tag.slice(1) : tag;
        if (cleanTag.length > 1) {
          const added = kgAddTriple(noteTitle, 'tagged', cleanTag, {
            source: `bootstrap:${notePath}`,
            confidence: 1.0,
          });
          if (added.created) tripleCount++;
        }
      }

      // 4. Entity detection from content (limit to first 5000 chars for performance)
      const snippet = meta.content.slice(0, 5000);
      const entities = detectEntities(snippet);
      for (const entity of entities) {
        entityCount++;
        const predicate = entity.type === 'person' ? 'mentions_person'
          : entity.type === 'organization' ? 'mentions_org'
          : 'mentions_project';
        const added = kgAddTriple(noteTitle, predicate, entity.name, {
          source: `bootstrap:entity-detect:${notePath}`,
          confidence: entity.confidence,
        });
        if (added.created) tripleCount++;
      }
    }
  });

  runBatch();

  const stats = kgStats();
  logger.info('KG bootstrap complete', {
    entities: stats.entityCount,
    triples: stats.tripleCount,
    newTriples: tripleCount,
    detectedEntities: entityCount,
    duration_ms: Date.now() - start,
  });

  return {
    entities: stats.entityCount,
    triples: stats.tripleCount,
    duration_ms: Date.now() - start,
  };
}
