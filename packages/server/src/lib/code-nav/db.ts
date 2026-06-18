import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { config } from '../../config.js';
import { logger } from '../logger.js';

/** Compute the fork-disambiguating origin id (sha1(git_origin)[:16]). */
export function computeGitOriginId(origin: string | null | undefined): string | null {
  if (!origin || origin.trim().length === 0) return null;
  return crypto.createHash('sha1').update(origin.trim()).digest('hex').slice(0, 16);
}

let db: BetterSqlite3.Database | null = null;

/** Get (lazily initialize) the per-machine code.db handle. */
export function getCodeDb(): BetterSqlite3.Database {
  if (db) return db;

  const dbPath = path.join(config.dataDir, 'code.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.pragma('foreign_keys = ON');

  handle.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id                TEXT PRIMARY KEY,
      slug              TEXT NOT NULL UNIQUE,
      git_origin        TEXT,
      first_commit_sha  TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repos_slug ON repos(slug);

    CREATE TABLE IF NOT EXISTS repo_paths (
      repo_id        TEXT NOT NULL,
      machine_id     TEXT NOT NULL,
      abs_path       TEXT NOT NULL,
      registered_at  INTEGER NOT NULL,
      last_seen_at   INTEGER NOT NULL,
      PRIMARY KEY (repo_id, machine_id),
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_repo_paths_machine ON repo_paths(machine_id);

    CREATE TABLE IF NOT EXISTS files (
      repo_id        TEXT NOT NULL,
      relative_path  TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      language       TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      indexed_at     INTEGER NOT NULL,
      PRIMARY KEY (repo_id, relative_path),
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);

    CREATE TABLE IF NOT EXISTS symbols (
      id              TEXT PRIMARY KEY,
      repo_id         TEXT NOT NULL,
      relative_path   TEXT NOT NULL,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      qualified_name  TEXT NOT NULL,
      signature       TEXT,
      docstring       TEXT,
      start_line      INTEGER NOT NULL,
      end_line        INTEGER NOT NULL,
      parent_id       TEXT,
      content_hash    TEXT NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES symbols(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_repo_path ON symbols(repo_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_qname     ON symbols(qualified_name);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, signature, docstring,
      content='symbols', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, signature, docstring)
      VALUES (new.rowid, new.name, new.signature, new.docstring);
    END;
    CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
      VALUES ('delete', old.rowid, old.name, old.signature, old.docstring);
    END;
    CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
      VALUES ('delete', old.rowid, old.name, old.signature, old.docstring);
      INSERT INTO symbols_fts(rowid, name, signature, docstring)
      VALUES (new.rowid, new.name, new.signature, new.docstring);
    END;

    CREATE TABLE IF NOT EXISTS calls (
      caller_id     TEXT NOT NULL,
      callee_name   TEXT NOT NULL,
      callee_id     TEXT,
      call_line     INTEGER NOT NULL,
      PRIMARY KEY (caller_id, callee_name, call_line),
      FOREIGN KEY (caller_id) REFERENCES symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (callee_id) REFERENCES symbols(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id);
    CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);

    CREATE TABLE IF NOT EXISTS file_imports (
      repo_id        TEXT NOT NULL,
      relative_path  TEXT NOT NULL,
      imported_name  TEXT NOT NULL,
      source_module  TEXT NOT NULL,
      resolved_repo  TEXT,
      PRIMARY KEY (repo_id, relative_path, imported_name),
      FOREIGN KEY (repo_id, relative_path) REFERENCES files(repo_id, relative_path) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_repo, imported_name);

    -- Per-ingest delta log. Powers code_detect_breaking_changes by retaining
    -- a history of removed and signature-changed symbols. Only changes that
    -- could break a downstream caller are captured ('removed' / 'sig_changed') —
    -- 'added' is not interesting for breakage analysis. AUTOINCREMENT keeps
    -- ids monotonic so consumers can scan since a known watermark.
    CREATE TABLE IF NOT EXISTS symbol_changes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id            TEXT NOT NULL,
      relative_path      TEXT NOT NULL,
      name               TEXT NOT NULL,
      kind               TEXT NOT NULL,
      change_kind        TEXT NOT NULL,
      before_symbol_id   TEXT,
      after_symbol_id    TEXT,
      before_signature   TEXT,
      after_signature    TEXT,
      captured_at        INTEGER NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_changes_repo_at
      ON symbol_changes(repo_id, captured_at DESC);

    -- Proxy-indexing work queue. When a code-nav query resolves to a repo whose
    -- only indexed checkout lives on a DIFFERENT machine than this server (the
    -- common remote/containerized case), the query handler enqueues a request
    -- here for the owning machine. The owning machine's long-lived hud-line
    -- daemon polls these (via code_index_requests_poll / GET
    -- /api/code-index-requests), re-indexes the checkout, and pushes fresh
    -- symbols back through code_ingest_repo — which marks the request 'done'.
    -- This closes the loop so stale/empty results self-heal instead of silently
    -- misleading the agent. Dedup is enforced by a partial unique index so a
    -- repo+machine has at most one outstanding (pending|claimed) request.
    CREATE TABLE IF NOT EXISTS index_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id       TEXT NOT NULL,
      machine_id    TEXT NOT NULL,
      abs_path      TEXT NOT NULL,
      reason        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      requested_at  INTEGER NOT NULL,
      claimed_at    INTEGER,
      completed_at  INTEGER,
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_index_requests_machine_status
      ON index_requests(machine_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_index_requests_outstanding
      ON index_requests(repo_id, machine_id)
      WHERE status IN ('pending', 'claimed');
  `);

  // Guarded ALTER for package_name (cross-repo workspace resolution without fs).
  try {
    handle.exec(`ALTER TABLE repos ADD COLUMN package_name TEXT`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(msg)) {
      logger.warn('ALTER TABLE repos ADD COLUMN package_name failed', { error: msg });
    }
  }
  handle.exec(`CREATE INDEX IF NOT EXISTS idx_repos_pkg_name ON repos(package_name)`);

  // Guarded ALTER for git_origin_id (fork-disambiguating identity: sha1(git_origin)[:16]).
  // Lets forks with shared first_commit_sha be distinct rows when origins differ.
  try {
    handle.exec(`ALTER TABLE repos ADD COLUMN git_origin_id TEXT`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(msg)) {
      logger.warn('ALTER TABLE repos ADD COLUMN git_origin_id failed', { error: msg });
    }
  }
  handle.exec(`CREATE INDEX IF NOT EXISTS idx_repos_git_origin_id ON repos(git_origin_id)`);

  // Backfill: any row with NULL git_origin_id but non-NULL git_origin gets it computed.
  try {
    const rows = handle
      .prepare(`SELECT id, git_origin FROM repos WHERE git_origin_id IS NULL AND git_origin IS NOT NULL AND git_origin <> ''`)
      .all() as Array<{ id: string; git_origin: string }>;
    if (rows.length > 0) {
      const update = handle.prepare(`UPDATE repos SET git_origin_id=? WHERE id=?`);
      const tx = handle.transaction(() => {
        for (const r of rows) {
          const oid = computeGitOriginId(r.git_origin);
          if (oid) update.run(oid, r.id);
        }
      });
      tx();
      logger.info('Backfilled git_origin_id', { count: rows.length });
    }
  } catch (err) {
    logger.warn('git_origin_id backfill failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Guarded ALTER for body_simhash (16-char lowercase hex, computed by the
  // Rust client at ingest time). NULL on rows from older clients that don't
  // send the field — `code_find_semantic_duplicates` mode=body filters those out.
  try {
    handle.exec(`ALTER TABLE symbols ADD COLUMN body_simhash TEXT`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(msg)) {
      logger.warn('ALTER TABLE symbols ADD COLUMN body_simhash failed', { error: msg });
    }
  }
  handle.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_body_simhash ON symbols(body_simhash) WHERE body_simhash IS NOT NULL`);

  logger.info('Code-nav DB initialized', { dbPath });
  db = handle;
  return db;
}

/**
 * Pull repo records from the vault registry into the local DB.
 * Called once on startup so a freshly-cloned data dir picks up
 * repos that were registered on another machine. Last-write-wins
 * on slug differences.
 */
export function loadVaultRegistryIntoDb(
  repos: Array<{
    id: string;
    slug: string;
    git_origin: string | null;
    first_commit_sha: string;
    created_at: number;
    package_name?: string | null;
  }>,
): { inserted: number; updated: number } {
  const handle = getCodeDb();
  const insert = handle.prepare(
    `INSERT OR IGNORE INTO repos (id, slug, git_origin, first_commit_sha, created_at, package_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateSlug = handle.prepare(`UPDATE repos SET slug=? WHERE id=? AND slug<>?`);
  const updateOrigin = handle.prepare(
    `UPDATE repos SET git_origin=? WHERE id=? AND (git_origin IS NULL OR git_origin='')`,
  );
  const updatePkgName = handle.prepare(
    `UPDATE repos SET package_name=? WHERE id=? AND (package_name IS NULL OR package_name='')`,
  );

  let inserted = 0;
  let updated = 0;
  const tx = handle.transaction(() => {
    for (const r of repos) {
      const pkgName = r.package_name ?? null;
      const result = insert.run(r.id, r.slug, r.git_origin, r.first_commit_sha, r.created_at, pkgName);
      if (result.changes > 0) {
        inserted++;
      } else {
        // Existed; try updating slug (last-write-wins) and origin/package_name if missing.
        const slugRes = updateSlug.run(r.slug, r.id, r.slug);
        const originRes = r.git_origin ? updateOrigin.run(r.git_origin, r.id) : { changes: 0 };
        const pkgRes = pkgName ? updatePkgName.run(pkgName, r.id) : { changes: 0 };
        if (slugRes.changes > 0 || originRes.changes > 0 || pkgRes.changes > 0) updated++;
      }
    }
  });
  tx();
  return { inserted, updated };
}

/** Test-only helper to close the DB. Not used in production. */
export function closeCodeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
