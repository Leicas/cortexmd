//! Local SQLite mirror of cortexmd's `code.db`.
//!
//! Lives at `${data_dir}/cortexmd/code.db`
//! (Windows: `%APPDATA%\Roaming\cortexmd\code.db`,
//! Linux: `~/.local/share/cortexmd/code.db`,
//! macOS: `~/Library/Application Support/cortexmd/code.db`).
//!
//! Schema mirrors the server's `src/lib/code-nav/db.ts` so a `code_sync_pull`
//! payload upserts row-for-row. fts5 triggers are added so local
//! `code_symbol_search` queries can run without a server round-trip.
//!
//! `apply_snapshot()` consumes the JSON returned by `code_sync_pull` and
//! upserts files/symbols/calls/imports inside a single transaction. When
//! `full_replace` is true (the default — set by `cmd_pull` whenever `since`
//! was not specified), files in the local DB that are absent from the
//! snapshot are pruned, matching the server's `code_ingest_repo` semantics.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Resolve the local code DB path. Creates the parent directory on first call.
pub fn db_path() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| anyhow!("could not resolve a data dir for the local code DB"))?;
    crate::auth::migrate_legacy_app_dir(&base);
    let dir = base.join(crate::auth::APP_DIR);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create local DB dir {}", dir.display()))?;
    Ok(dir.join("code.db"))
}

/// Open (and on first use, initialize) the local code DB. Idempotent.
pub fn open() -> Result<Connection> {
    open_at(&db_path()?)
}

/// Open at an explicit path — used by tests.
pub fn open_at(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("open sqlite {}", path.display()))?;
    conn.pragma_update(None, "journal_mode", &"WAL")?;
    conn.pragma_update(None, "synchronous", &"NORMAL")?;
    conn.pragma_update(None, "foreign_keys", &"ON")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS repos (
          id                TEXT PRIMARY KEY,
          slug              TEXT NOT NULL UNIQUE,
          git_origin        TEXT,
          first_commit_sha  TEXT NOT NULL,
          created_at        INTEGER NOT NULL,
          package_name      TEXT,
          git_origin_id     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_repos_slug ON repos(slug);
        CREATE INDEX IF NOT EXISTS idx_repos_pkg_name ON repos(package_name);
        CREATE INDEX IF NOT EXISTS idx_repos_git_origin_id ON repos(git_origin_id);

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

        CREATE TABLE IF NOT EXISTS sync_state (
          repo_id        TEXT PRIMARY KEY,
          last_pulled_at TEXT NOT NULL,
          last_indexed_at INTEGER NOT NULL,
          FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );
        "#,
    )?;
    Ok(())
}

/// Apply a `code_sync_pull` JSON payload to the local DB.
///
/// `full_replace` controls per-repo file pruning — pass `true` when the
/// snapshot covers the whole repo (no `since` filter on the wire). When
/// `since` was used, pass `false` so files absent from the delta aren't
/// dropped.
///
/// Returns counts: (added, updated, unchanged, removed).
pub fn apply_snapshot(
    conn: &mut Connection,
    payload: &Value,
    full_replace: bool,
) -> Result<SnapshotApplyStats> {
    let repo_id = payload
        .get("repo_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("snapshot missing repo_id"))?
        .to_string();
    let slug = payload
        .get("slug")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("snapshot missing slug"))?
        .to_string();
    let git_origin = payload
        .get("git_origin")
        .and_then(|v| if v.is_null() { None } else { v.as_str() })
        .map(|s| s.to_string());
    let first_commit_sha = payload
        .get("first_commit_sha")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("snapshot missing first_commit_sha"))?
        .to_string();
    let package_name = payload
        .get("package_name")
        .and_then(|v| if v.is_null() { None } else { v.as_str() })
        .map(|s| s.to_string());

    let files = payload
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or_else(|| anyhow!("snapshot missing files[]"))?;

    let now_ms: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let git_origin_id = git_origin
        .as_deref()
        .map(|o| {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(o.trim().as_bytes());
            hex::encode(h.finalize())[..16].to_string()
        });

    let mut stats = SnapshotApplyStats::default();

    let tx = conn.transaction()?;

    // 1. Upsert repo row.
    tx.execute(
        "INSERT INTO repos (id, slug, git_origin, first_commit_sha, created_at, package_name, git_origin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           git_origin = COALESCE(excluded.git_origin, repos.git_origin),
           first_commit_sha = excluded.first_commit_sha,
           package_name = excluded.package_name,
           git_origin_id = COALESCE(excluded.git_origin_id, repos.git_origin_id)",
        params![
            repo_id,
            slug,
            git_origin,
            first_commit_sha,
            now_ms,
            package_name,
            git_origin_id,
        ],
    )?;

    // 2. Per-file upsert. Skip work when content_hash matches; otherwise
    //    delete-and-reinsert symbols/imports for that file. Calls cascade
    //    via FK on symbols(id).
    let mut seen_paths: Vec<String> = Vec::with_capacity(files.len());
    let mut max_indexed_at: i64 = 0;

    for f in files {
        let rel = f
            .get("relative_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("file missing relative_path"))?
            .to_string();
        let lang = f
            .get("language")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("file missing language"))?
            .to_string();
        let content_hash = f
            .get("content_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("file missing content_hash"))?
            .to_string();
        let size_bytes = f
            .get("size_bytes")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let indexed_at = f
            .get("indexed_at")
            .and_then(|v| v.as_i64())
            .unwrap_or(now_ms);
        if indexed_at > max_indexed_at {
            max_indexed_at = indexed_at;
        }
        seen_paths.push(rel.clone());

        let existing_hash: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM files WHERE repo_id = ? AND relative_path = ?",
                params![repo_id, rel],
                |r| r.get::<_, String>(0),
            )
            .optional()?;

        let had_file = existing_hash.is_some();
        if existing_hash.as_deref() == Some(content_hash.as_str()) {
            tx.execute(
                "UPDATE files SET indexed_at = ? WHERE repo_id = ? AND relative_path = ?",
                params![indexed_at, repo_id, rel],
            )?;
            stats.unchanged += 1;
            continue;
        }

        // Delete prior symbols (cascades to calls.caller_id) and imports for this file.
        tx.execute(
            "DELETE FROM symbols WHERE repo_id = ? AND relative_path = ?",
            params![repo_id, rel],
        )?;
        tx.execute(
            "DELETE FROM file_imports WHERE repo_id = ? AND relative_path = ?",
            params![repo_id, rel],
        )?;

        tx.execute(
            "INSERT INTO files (repo_id, relative_path, content_hash, language, size_bytes, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, relative_path) DO UPDATE SET
               content_hash = excluded.content_hash,
               language = excluded.language,
               size_bytes = excluded.size_bytes,
               indexed_at = excluded.indexed_at",
            params![repo_id, rel, content_hash, lang, size_bytes, indexed_at],
        )?;

        // Insert symbols.
        let empty: Vec<Value> = Vec::new();
        let symbols = f.get("symbols").and_then(|v| v.as_array()).unwrap_or(&empty);
        for s in symbols {
            tx.execute(
                "INSERT INTO symbols
                  (id, repo_id, relative_path, name, kind, qualified_name, signature, docstring,
                   start_line, end_line, parent_id, content_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   relative_path = excluded.relative_path,
                   name = excluded.name,
                   kind = excluded.kind,
                   qualified_name = excluded.qualified_name,
                   signature = excluded.signature,
                   docstring = excluded.docstring,
                   start_line = excluded.start_line,
                   end_line = excluded.end_line,
                   parent_id = excluded.parent_id,
                   content_hash = excluded.content_hash",
                params![
                    s.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    repo_id,
                    rel,
                    s.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    s.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                    s.get("qualified_name").and_then(|v| v.as_str()).unwrap_or(""),
                    s.get("signature").and_then(|v| if v.is_null() { None } else { v.as_str() }),
                    s.get("docstring").and_then(|v| if v.is_null() { None } else { v.as_str() }),
                    s.get("start_line").and_then(|v| v.as_i64()).unwrap_or(0),
                    s.get("end_line").and_then(|v| v.as_i64()).unwrap_or(0),
                    s.get("parent_id").and_then(|v| if v.is_null() { None } else { v.as_str() }),
                    s.get("content_hash").and_then(|v| v.as_str()).unwrap_or(""),
                ],
            )?;
        }

        // Insert calls.
        let calls = f.get("calls").and_then(|v| v.as_array()).unwrap_or(&empty);
        for c in calls {
            tx.execute(
                "INSERT OR IGNORE INTO calls (caller_id, callee_name, call_line) VALUES (?, ?, ?)",
                params![
                    c.get("caller_id").and_then(|v| v.as_str()).unwrap_or(""),
                    c.get("callee_name").and_then(|v| v.as_str()).unwrap_or(""),
                    c.get("call_line").and_then(|v| v.as_i64()).unwrap_or(0),
                ],
            )?;
        }

        // Insert imports.
        let imports = f.get("imports").and_then(|v| v.as_array()).unwrap_or(&empty);
        for i in imports {
            tx.execute(
                "INSERT OR REPLACE INTO file_imports (repo_id, relative_path, imported_name, source_module)
                 VALUES (?, ?, ?, ?)",
                params![
                    repo_id,
                    rel,
                    i.get("imported_name").and_then(|v| v.as_str()).unwrap_or(""),
                    i.get("source_module").and_then(|v| v.as_str()).unwrap_or(""),
                ],
            )?;
        }

        if had_file {
            stats.updated += 1;
        } else {
            stats.added += 1;
        }
    }

    // 3. Optional full-replace prune: drop files we have locally that aren't in the snapshot.
    if full_replace {
        let mut to_remove: Vec<String> = Vec::new();
        {
            let mut sel = tx.prepare("SELECT relative_path FROM files WHERE repo_id = ?")?;
            let rows = sel.query_map(params![repo_id], |r| r.get::<_, String>(0))?;
            let seen: std::collections::HashSet<&str> =
                seen_paths.iter().map(|s| s.as_str()).collect();
            for row in rows {
                let p = row?;
                if !seen.contains(p.as_str()) {
                    to_remove.push(p);
                }
            }
        }
        for p in &to_remove {
            tx.execute(
                "DELETE FROM symbols WHERE repo_id = ? AND relative_path = ?",
                params![repo_id, p],
            )?;
            tx.execute(
                "DELETE FROM file_imports WHERE repo_id = ? AND relative_path = ?",
                params![repo_id, p],
            )?;
            tx.execute(
                "DELETE FROM files WHERE repo_id = ? AND relative_path = ?",
                params![repo_id, p],
            )?;
            stats.removed += 1;
        }
    }

    // 4. Update sync_state.
    tx.execute(
        "INSERT INTO sync_state (repo_id, last_pulled_at, last_indexed_at)
         VALUES (?, datetime('now'), ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           last_pulled_at = excluded.last_pulled_at,
           last_indexed_at = MAX(sync_state.last_indexed_at, excluded.last_indexed_at)",
        params![repo_id, max_indexed_at],
    )?;

    tx.commit()?;
    Ok(stats)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SnapshotApplyStats {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
}

/// Highest `indexed_at` we've seen for `repo_id`, or `None` when no rows yet.
/// Drives the `since=` argument on subsequent `code_sync_pull` calls.
pub fn last_indexed_at(conn: &Connection, repo_id: &str) -> Result<Option<i64>> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT last_indexed_at FROM sync_state WHERE repo_id = ?",
            params![repo_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(v)
}

/// Resolve a repo by slug → (id, last_indexed_at). None when not registered.
pub fn resolve_repo_by_slug(conn: &Connection, slug: &str) -> Result<Option<(String, Option<i64>)>> {
    let row: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT r.id,
                    (SELECT last_indexed_at FROM sync_state WHERE repo_id = r.id)
             FROM repos r WHERE r.slug = ?",
            params![slug],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    Ok(row)
}

/// Has the local DB seen any symbols for this repo? Used to decide
/// whether a local-first lookup can be served at all.
pub fn repo_has_symbols(conn: &Connection, repo_id: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM symbols WHERE repo_id = ? LIMIT 1",
        params![repo_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(n > 0)
}

#[derive(Debug, serde::Serialize)]
pub struct LocalSymbolHit {
    pub id: String,
    pub repo: String,
    pub repo_id: String,
    pub relative_path: String,
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub start_line: i64,
    pub end_line: i64,
}

/// FTS-backed symbol search across local DB. `repo_filter` is the repo slug
/// (None = all repos), `kind_filter` filters by symbol kind.
pub fn local_symbol_search(
    conn: &Connection,
    query: &str,
    repo_filter: Option<&str>,
    kind_filter: Option<&str>,
    limit: u32,
) -> Result<Vec<LocalSymbolHit>> {
    let mut sql = String::from(
        "SELECT s.id, r.slug, s.repo_id, s.relative_path, s.name, s.kind,
                s.qualified_name, s.signature, s.docstring, s.start_line, s.end_line
         FROM symbols_fts f
         JOIN symbols s ON f.rowid = s.rowid
         JOIN repos r ON s.repo_id = r.id
         WHERE symbols_fts MATCH ?",
    );
    if repo_filter.is_some() {
        sql.push_str(" AND r.slug = ?");
    }
    if kind_filter.is_some() {
        sql.push_str(" AND s.kind = ?");
    }
    sql.push_str(" ORDER BY rank LIMIT ?");

    let mut stmt = conn.prepare(&sql)?;
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    bound.push(Box::new(query.to_string()));
    if let Some(r) = repo_filter {
        bound.push(Box::new(r.to_string()));
    }
    if let Some(k) = kind_filter {
        bound.push(Box::new(k.to_string()));
    }
    bound.push(Box::new(limit as i64));
    let bound_refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows = stmt.query_map(bound_refs.as_slice(), |row| {
        Ok(LocalSymbolHit {
            id: row.get(0)?,
            repo: row.get(1)?,
            repo_id: row.get(2)?,
            relative_path: row.get(3)?,
            name: row.get(4)?,
            kind: row.get(5)?,
            qualified_name: row.get(6)?,
            signature: row.get(7)?,
            docstring: row.get(8)?,
            start_line: row.get(9)?,
            end_line: row.get(10)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Single-symbol metadata lookup by 16-char id. Returns None if unknown locally.
/// Body content is NOT included — file content isn't mirrored, so callers must
/// fall back to REST when they need the body.
pub fn local_symbol_get(conn: &Connection, id: &str) -> Result<Option<LocalSymbolHit>> {
    let row = conn
        .query_row(
            "SELECT s.id, r.slug, s.repo_id, s.relative_path, s.name, s.kind,
                    s.qualified_name, s.signature, s.docstring, s.start_line, s.end_line
             FROM symbols s JOIN repos r ON s.repo_id = r.id WHERE s.id = ?",
            params![id],
            |row| {
                Ok(LocalSymbolHit {
                    id: row.get(0)?,
                    repo: row.get(1)?,
                    repo_id: row.get(2)?,
                    relative_path: row.get(3)?,
                    name: row.get(4)?,
                    kind: row.get(5)?,
                    qualified_name: row.get(6)?,
                    signature: row.get(7)?,
                    docstring: row.get(8)?,
                    start_line: row.get(9)?,
                    end_line: row.get(10)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

#[derive(Debug, serde::Serialize)]
pub struct LocalImpactHit {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
    pub relative_path: String,
    pub repo: String,
    pub depth: i64,
}

/// Transitive caller graph for `id` via recursive-CTE BFS over `calls` —
/// mirrors the server's `code_change_impact`. Returns each caller with its
/// distance from the root.
pub fn local_change_impact(
    conn: &Connection,
    id: &str,
    depth: u32,
    limit: u32,
) -> Result<Vec<LocalImpactHit>> {
    let depth_i = depth as i64;
    let limit_i = limit as i64;
    let mut stmt = conn.prepare(
        "WITH RECURSIVE callers(id, depth) AS (
            SELECT caller_id, 1 FROM calls WHERE callee_id = ?
            UNION
            SELECT c.caller_id, callers.depth + 1
              FROM calls c JOIN callers ON c.callee_id = callers.id
              WHERE callers.depth < ?
         )
         SELECT s.id, s.name, s.kind, s.qualified_name, s.relative_path,
                r.slug, MIN(callers.depth)
         FROM callers
         JOIN symbols s ON s.id = callers.id
         JOIN repos r ON s.repo_id = r.id
         GROUP BY s.id
         ORDER BY MIN(callers.depth), s.name
         LIMIT ?",
    )?;
    let rows = stmt.query_map(params![id, depth_i, limit_i], |row| {
        Ok(LocalImpactHit {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            qualified_name: row.get(3)?,
            relative_path: row.get(4)?,
            repo: row.get(5)?,
            depth: row.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ── savings counters (slice 4) ─────────────────────────────────────────────

/// Bump local savings counters for a tool. Idempotent upsert.
pub fn bump_local_savings(
    conn: &Connection,
    tool_name: &str,
    calls: u32,
    tokens_saved: u64,
) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_savings (
           tool_name      TEXT PRIMARY KEY,
           calls          INTEGER NOT NULL DEFAULT 0,
           tokens_saved   INTEGER NOT NULL DEFAULT 0,
           last_pushed_at INTEGER NOT NULL DEFAULT 0
         )",
        [],
    )?;
    conn.execute(
        "INSERT INTO local_savings (tool_name, calls, tokens_saved, last_pushed_at)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(tool_name) DO UPDATE SET
           calls = local_savings.calls + excluded.calls,
           tokens_saved = local_savings.tokens_saved + excluded.tokens_saved",
        params![tool_name, calls as i64, tokens_saved as i64],
    )?;
    Ok(())
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct LocalSavingsRow {
    pub tool_name: String,
    pub calls: i64,
    pub tokens_saved: i64,
    pub last_pushed_at: i64,
}

/// Read all local savings rows. Returns empty Vec when the table doesn't
/// exist yet (no local-served tool calls have happened).
pub fn read_local_savings(conn: &Connection) -> Result<Vec<LocalSavingsRow>> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_savings'",
        [],
        |r| r.get::<_, i64>(0),
    )?;
    if exists == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT tool_name, calls, tokens_saved, last_pushed_at FROM local_savings")?;
    let rows = stmt.query_map([], |row| {
        Ok(LocalSavingsRow {
            tool_name: row.get(0)?,
            calls: row.get(1)?,
            tokens_saved: row.get(2)?,
            last_pushed_at: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Subtract the just-pushed `(tool_name, calls, tokens_saved)` triples from
/// the local rows and stamp `last_pushed_at = now_ms`. Counters are clamped
/// at zero — concurrent bumps that landed *during* the push window are
/// preserved as positive remainder. Without this subtraction, every push
/// re-sends the lifetime cumulative and the server (which adds deltas)
/// quadratically over-counts.
pub fn subtract_pushed_savings(
    conn: &Connection,
    pushed: &[(String, i64, i64)],
    now_ms: i64,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (tool_name, calls, tokens_saved) in pushed {
        tx.execute(
            "UPDATE local_savings
                SET calls          = MAX(0, calls - ?),
                    tokens_saved   = MAX(0, tokens_saved - ?),
                    last_pushed_at = ?
              WHERE tool_name = ?",
            params![calls, tokens_saved, now_ms, tool_name],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Upsert a repo registry row received from the server's `code_repos_sync`.
pub fn upsert_repo_registry_row(
    conn: &Connection,
    id: &str,
    slug: &str,
    git_origin: Option<&str>,
    first_commit_sha: &str,
    package_name: Option<&str>,
    git_origin_id: Option<&str>,
    created_at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO repos (id, slug, git_origin, first_commit_sha, created_at, package_name, git_origin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           git_origin = COALESCE(excluded.git_origin, repos.git_origin),
           first_commit_sha = excluded.first_commit_sha,
           package_name = COALESCE(excluded.package_name, repos.package_name),
           git_origin_id = COALESCE(excluded.git_origin_id, repos.git_origin_id)",
        params![id, slug, git_origin, first_commit_sha, created_at, package_name, git_origin_id],
    )?;
    Ok(())
}
