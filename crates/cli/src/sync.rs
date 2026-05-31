//! Bidirectional sync helpers between the local code DB and a cortexmd
//! server.
//!
//! Read-side entry points:
//! - `ensure_fresh_blocking_throttled_logged(slug, server, key, max_age_secs)` —
//!   synchronous since-filtered pull, but skipped when `sync_state.last_pulled_at`
//!   is within `max_age_secs` (default 60s) so consecutive read tools in a
//!   short window only pay one HTTP RTT. Replaces the older `_async` variant,
//!   which leaked because CLI process exit kills detached threads.
//! - `ensure_fresh_async(slug, server, key)` — DEPRECATED shim; calls the
//!   throttled blocking helper inline. Kept so older call sites compile
//!   while the migration finishes.
//! - `bootstrap_pull_blocking(slug, server, key)` — synchronous cold pull
//!   used when a tool sees zero local rows for a slug. Returns an error so
//!   the caller can decide whether to fall back to REST.
//!
//! Write-side entry points:
//! - `incremental_push_async(slug, server, key)` — fire-and-forget walk of
//!   the repo's local abs_path. Files with `mtime > last_indexed_at` are
//!   re-parsed and shipped to `code_ingest_repo` with `full_replace=false`,
//!   then the new server snapshot is pulled back so `last_indexed_at`
//!   advances. This is what makes "edits get re-indexed as files get
//!   touched" — every read tool call kicks off a background freshen.
//! - `push_local_savings(server, key)` — push accumulated local savings
//!   counters to the server's `code_savings_push` MCP tool, then mark them
//!   pushed. Throttled to once per `PUSH_INTERVAL_SECS`.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::indexer;
use crate::local_db;
use crate::mcp;
use crate::payload::{FilePayload, IngestPayload};
use crate::rewrite;
use crate::walker;

/// Don't push savings more often than this. Bumps land on every local-served
/// query; we batch them out at most once a minute to keep network noise down.
pub const PUSH_INTERVAL_SECS: i64 = 60;

/// Pull-side coalescing lock. Currently unused — the synchronous
/// throttled `ensure_fresh_blocking_throttled_logged` doesn't need a
/// thread-level lock since it serializes naturally. Kept for the future
/// hook-daemon mode where a long-lived process would benefit from
/// coalescing.
#[allow(dead_code)]
static SYNC_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Independent lock for the push-side. Push and pull don't directly conflict
/// (push walks the FS + ships, pull writes snapshots) so they get separate
/// flags — but we still want at most one push in flight to avoid duplicate
/// `code_ingest_repo` calls when reads come in fast.
///
/// Currently unused: the CLI invocation lifetime is too short for thread
/// coalescing to matter, and `incremental_push_blocking_logged` runs inline.
/// Kept for the future hook-daemon mode where a long-lived process *would*
/// benefit from coalescing.
#[allow(dead_code)]
static PUSH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Default freshness window for `ensure_fresh_blocking_throttled_logged`. Read
/// tools called within this window of the last successful pull skip the HTTP
/// RTT entirely. Tuned to keep tight loops (e.g. a hook firing on every
/// PreToolUse) under one server hit per minute per repo.
pub const ENSURE_FRESH_MAX_AGE_SECS: i64 = 60;

/// DEPRECATED shim for the previous `thread::spawn` flavor. Now runs inline
/// via the throttled blocking helper because detached threads die with the
/// CLI process. Kept so existing call sites compile during the migration —
/// new callers should reach for `ensure_fresh_blocking_throttled_logged`
/// directly.
pub fn ensure_fresh_async(slug: String, server: String, api_key: String) {
    ensure_fresh_blocking_throttled_logged(&slug, &server, &api_key, ENSURE_FRESH_MAX_AGE_SECS);
}

/// Synchronous since-filtered pull, throttled by `sync_state.last_pulled_at`
/// — calls within `max_age_secs` of the previous successful pull are
/// no-ops, so chatty tool sequences don't all pay the HTTP RTT.
///
/// This is the read-side counterpart to `incremental_push_blocking_logged`:
/// together they make sure every read tool call has both directions of
/// drift handled, *reliably*, without relying on threads that die with
/// the CLI process. Errors are logged to stderr (the caller serves
/// whatever the local DB has now).
pub fn ensure_fresh_blocking_throttled_logged(
    slug: &str,
    server: &str,
    api_key: &str,
    max_age_secs: i64,
) {
    match recently_pulled(slug, max_age_secs) {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => {
            eprintln!("[sync] freshness check for {} failed: {}", slug, e);
            // Fall through and try to pull anyway — better stale data than
            // a permanent miss.
        }
    }
    if let Err(e) = ensure_fresh_blocking(slug, server, api_key) {
        eprintln!("[sync] ensure_fresh for {} failed: {}", slug, e);
    }
}

/// True iff `sync_state.last_pulled_at` for `slug` is within `max_age_secs`
/// of now. Returns `Ok(false)` when the repo has no sync_state row (cold).
fn recently_pulled(slug: &str, max_age_secs: i64) -> Result<bool> {
    use rusqlite::OptionalExtension;
    let conn = local_db::open()?;
    let secs_ago: Option<i64> = conn
        .query_row(
            "SELECT CAST((julianday('now') - julianday(ss.last_pulled_at)) * 86400 AS INTEGER)
             FROM sync_state ss
             JOIN repos r ON ss.repo_id = r.id
             WHERE r.slug = ?",
            rusqlite::params![slug],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(matches!(secs_ago, Some(s) if s >= 0 && s < max_age_secs))
}

fn ensure_fresh_blocking(slug: &str, server: &str, api_key: &str) -> Result<()> {
    let conn = local_db::open()?;
    let (repo_id, last) = match local_db::resolve_repo_by_slug(&conn, slug)? {
        Some(t) => t,
        None => {
            // Local DB doesn't know this repo yet → cold pull (no `since`).
            return cold_pull(slug, server, api_key);
        }
    };
    let mut args = serde_json::Map::new();
    args.insert("slug".into(), Value::String(slug.to_string()));
    if let Some(t) = last {
        args.insert(
            "since_indexed_at".into(),
            Value::Number(serde_json::Number::from(t)),
        );
    }
    let payload = call_pull(server, api_key, &Value::Object(args))?;
    let files_returned = payload
        .get("meta")
        .and_then(|m| m.get("files_returned"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if files_returned == 0 {
        return Ok(());
    }
    drop(conn);
    let mut conn2 = local_db::open()?;
    let _stats = local_db::apply_snapshot(&mut conn2, &payload, last.is_none())?;
    let _ = repo_id;
    Ok(())
}

fn cold_pull(slug: &str, server: &str, api_key: &str) -> Result<()> {
    let mut args = serde_json::Map::new();
    args.insert("slug".into(), Value::String(slug.to_string()));
    let payload = call_pull(server, api_key, &Value::Object(args))?;
    let mut conn = local_db::open()?;
    local_db::apply_snapshot(&mut conn, &payload, true)?;
    Ok(())
}

/// Synchronous cold pull used when a tool sees zero local rows for `slug`.
/// Doesn't touch `SYNC_IN_FLIGHT` — the caller is on the user's path and
/// can't yield to a background pull. Errors are returned, not swallowed,
/// so the caller decides how to recover (typically: log + fall back to REST).
pub fn bootstrap_pull_blocking(slug: &str, server: &str, api_key: &str) -> Result<()> {
    cold_pull(slug, server, api_key)
}

fn call_pull(server: &str, api_key: &str, args: &Value) -> Result<Value> {
    let (session_id, _init) = mcp::initialize(server, api_key)?;
    let result = mcp::tools_call(server, api_key, &session_id, "code_sync_pull", args)?;
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text").and_then(|t| t.as_str()).map(str::to_string))
        .ok_or_else(|| anyhow::anyhow!("code_sync_pull returned no text content"))?;
    serde_json::from_str(&text).context("parse code_sync_pull payload as JSON")
}

/// Push accumulated local savings to the server, then mark them pushed.
/// Returns `Ok(false)` when the throttle window is still open (no-op).
pub fn push_local_savings(server: &str, api_key: &str) -> Result<bool> {
    let conn = local_db::open()?;
    let rows = local_db::read_local_savings(&conn)?;
    if rows.is_empty() {
        return Ok(false);
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let oldest_push = rows.iter().map(|r| r.last_pushed_at).min().unwrap_or(0);
    if now_ms - oldest_push < PUSH_INTERVAL_SECS * 1000 && oldest_push > 0 {
        return Ok(false);
    }

    // Skip rows that have already been fully drained — nothing to push.
    let pushable: Vec<&local_db::LocalSavingsRow> = rows
        .iter()
        .filter(|r| r.calls > 0 || r.tokens_saved > 0)
        .collect();
    if pushable.is_empty() {
        return Ok(false);
    }

    let entries: Vec<Value> = pushable
        .iter()
        .map(|r| {
            json!({
                "tool_name": r.tool_name,
                "calls": r.calls,
                "tokens_saved": r.tokens_saved,
            })
        })
        .collect();
    let args = json!({ "entries": entries });

    let (session_id, _init) = mcp::initialize(server, api_key)?;
    let _result = mcp::tools_call(server, api_key, &session_id, "code_savings_push", &args)?;

    // Subtract what we just sent so we don't re-push it next time. Concurrent
    // bumps that arrived during the push window remain as a positive remainder.
    let pushed_snapshot: Vec<(String, i64, i64)> = pushable
        .iter()
        .map(|r| (r.tool_name.clone(), r.calls, r.tokens_saved))
        .collect();
    local_db::subtract_pushed_savings(&conn, &pushed_snapshot, now_ms)?;
    Ok(true)
}

/// Spawn a background savings push. Failures are isolated.
pub fn push_local_savings_async(server: String, api_key: String) {
    thread::spawn(move || {
        if let Err(e) = push_local_savings(&server, &api_key) {
            eprintln!("[sync] bg savings push failed: {}", e);
        }
    });
}

/// Synchronous incremental re-index push for `slug`. Walks the local
/// abs_path, picks files with `mtime > last_indexed_at`, parses them, and
/// ships a `code_ingest_repo` call with `full_replace=false`. After a
/// successful push, re-pulls the canonical snapshot so `last_indexed_at`
/// advances locally.
///
/// Designed to be called inline from every read tool: the mtime walk is
/// O(num source files) and finishes in a few ms on small repos, so the
/// fast path (no stale files) adds negligible latency. Only the rare
/// "right after editing a file" call pays the parse+push cost.
///
/// We avoid `thread::spawn` here because a CLI process exits as soon as
/// `main()` returns and detached threads die with it — the previous
/// `_async` version effectively no-op'd on a CLI invocation. Going
/// synchronous trades a few-ms walk per call for actual transparency.
///
/// `PUSH_IN_FLIGHT` is left for future callers (e.g. a long-lived hook
/// daemon) — within a single CLI invocation it doesn't gate anything.
///
/// No-ops silently when:
/// - the repo isn't in the local DB yet (let bootstrap_pull handle cold start),
/// - the repo's abs_path isn't resolvable on this machine (we're not the
///   indexing host),
/// - or no files are stale.
pub fn incremental_push_async(slug: String, server: String, api_key: String) {
    incremental_push_blocking_logged(&slug, &server, &api_key);
}

/// Same body as the public entrypoint but tolerates errors (logs to stderr,
/// never panics). Convenient when the caller wants to `?` no errors back.
pub fn incremental_push_blocking_logged(slug: &str, server: &str, api_key: &str) {
    if let Err(e) = incremental_push_blocking(slug, server, api_key) {
        eprintln!("[sync] incremental push for {} failed: {}", slug, e);
    }
}

fn incremental_push_blocking(slug: &str, server: &str, api_key: &str) -> Result<()> {
    let conn = local_db::open()?;
    let (repo_id, last_indexed_at) = match local_db::resolve_repo_by_slug(&conn, slug)? {
        Some(t) => t,
        None => return Ok(()),
    };
    drop(conn);
    let last_ms = last_indexed_at.unwrap_or(0);

    let abs_path = match rewrite::lookup_repo_abs_path(slug) {
        Some(p) => p,
        None => return Ok(()), // not the indexing host
    };

    // 1. Walk the repo and keep only files newer than last_indexed_at.
    let mut staged: Vec<(String, crate::payload::Language)> = Vec::new();
    for rel in walker::walk_repo(&abs_path) {
        let lang = match walker::language_for_path(&rel) {
            Some(l) => l,
            None => continue,
        };
        let abs_file = walker::abs_from_rel(&abs_path, &rel);
        let meta = match std::fs::metadata(&abs_file) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms: i64 = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if mtime_ms > last_ms {
            staged.push((rel, lang));
        }
    }
    if staged.is_empty() {
        return Ok(());
    }

    // 2. Parse the changed files into FilePayloads.
    let mut files: Vec<FilePayload> = Vec::with_capacity(staged.len());
    for (rel, lang) in &staged {
        let abs_file = walker::abs_from_rel(&abs_path, rel);
        match indexer::process_file(&repo_id, rel, *lang, &abs_file, false) {
            Ok(Some(fp)) => files.push(fp),
            Ok(None) => continue,
            Err(_) => continue,
        }
    }
    if files.is_empty() {
        return Ok(());
    }

    // 3. Build the partial ingest payload (full_replace=false so the server
    //    keeps the rest of the snapshot untouched).
    let sha = crate::git::first_commit_sha(&abs_path).context("read first_commit_sha")?;
    let origin = crate::git::git_origin(&abs_path);
    let machine_id = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());
    let pkg_ws = crate::workspace::collect_workspaces(&abs_path);
    let payload = IngestPayload {
        repo_id: repo_id.clone(),
        slug: slug.to_string(),
        git_origin: origin,
        first_commit_sha: sha,
        machine_id,
        abs_path: abs_path.to_string_lossy().to_string(),
        package_workspaces: if pkg_ws.is_empty() { None } else { Some(pkg_ws) },
        files,
        full_replace: false,
    };
    let payload_value = serde_json::to_value(&payload).context("serialize ingest payload")?;

    let (session_id, _init) = mcp::initialize(server, api_key)?;
    let _result = mcp::tools_call(
        server,
        api_key,
        &session_id,
        "code_ingest_repo",
        &payload_value,
    )?;

    // 4. Pull back the canonical snapshot so `last_indexed_at` advances
    //    locally — otherwise the next call sees the same files as still
    //    stale and we'd push them again.
    ensure_fresh_blocking(slug, server, api_key)?;

    eprintln!(
        "[sync] re-indexed {} file(s) in {} after local edits",
        staged.len(),
        slug
    );
    Ok(())
}
