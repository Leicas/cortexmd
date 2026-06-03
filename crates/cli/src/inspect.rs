//! RTK-style introspection subcommands: `status`, `discover`, `scan`, `gain`.
//!
//! All four reach the same MCP server using the credentials resolved by
//! `auth::resolve_creds`, so they pick up an OAuth token first and fall
//! back to a static api_key from config / Claude. They never crash on a
//! missing `code_nav_stats` tool — older servers just see a graceful
//! "savings stats not available" message.
//!
//! All output goes to stdout; errors and progress hints go to stderr.
//! Exit codes are standardized via the wrapping `Result` propagation in
//! main.rs (0 success, anyhow → non-zero).

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::auth;
use crate::cli::{
    BenchArgs, CodeChainArgs, CodeFindDuplicatesArgs, CodeGetArgs, CodeImpactArgs,
    CodeOutlineArgs, CodeSearchArgs, DiscoverArgs, GainArgs, HudLineArgs, IndexArgs, PullArgs,
    RecallArgs, RepoListArgs, ScanArgs, StoreMemoryArgs,
};
use crate::git;
use crate::local_db;
use crate::mcp;
use crate::oauth;
use crate::payload::sha1_hex;
use crate::rewrite;
use crate::sync;

/// Fork-aware repo_id: sha1(git_origin)[:16] when a remote exists, else
/// first_commit_sha[:16]. Mirrors main.rs `run_index`.
fn compute_repo_id(origin: Option<&str>, first_sha: Option<&str>) -> Option<String> {
    if let Some(o) = origin.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(sha1_hex(o)[..16].to_string());
    }
    first_sha
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(16).collect())
}

// ── shared helpers ──────────────────────────────────────────────────────────

/// Same SKIP_DIRS as walker.rs, kept in sync manually — discovery doesn't
/// recurse into these even when looking for `.git/`.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    ".git",
    ".next",
    "build",
    "out",
    "target",
    "__pycache__",
    "venv",
    ".venv",
    "vendor",
    ".history",
];

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn humanize_secs(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m == 0 {
            format!("{}h", h)
        } else {
            format!("{}h {}m", h, m)
        }
    } else {
        let d = secs / 86_400;
        let h = (secs % 86_400) / 3600;
        if h == 0 {
            format!("{}d", d)
        } else {
            format!("{}d {}h", d, h)
        }
    }
}

fn humanize_count(n: i64) -> String {
    let s = n.abs().to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(b as char);
    }
    if n < 0 {
        format!("-{}", out)
    } else {
        out
    }
}

/// Resolve credentials or return an actionable error.
fn resolve_or_bail(server_flag: Option<&str>, key_flag: Option<&str>) -> Result<(String, String, String)> {
    let r = auth::resolve_creds(server_flag, key_flag)?
        .ok_or_else(|| anyhow!("{}", auth::no_creds_message()))?;
    let source = r.source.label().to_string();
    Ok((r.server, r.api_key, source))
}

/// Detect the current machine id (mirrors the indexer's logic).
fn detect_machine_id() -> String {
    if let Ok(v) = std::env::var("MACHINE_ID") {
        if !v.trim().is_empty() {
            return v;
        }
    }
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Open a session and return (server_url, api_key, session_id, source_label).
fn open_session(
    server_flag: Option<&str>,
    key_flag: Option<&str>,
) -> Result<(String, String, String, String)> {
    let (server, key, source) = resolve_or_bail(server_flag, key_flag)?;
    let (session_id, _init) = mcp::initialize(&server, &key)
        .with_context(|| format!("MCP initialize failed against {}", server))?;
    Ok((server, key, session_id, source))
}

/// Extract the inner JSON-RPC text content from a tools/call response shape.
/// MCP wraps tool output as `{ content: [{ type: "text", text: "<json>" }] }`.
fn unwrap_tool_text(result: &Value) -> Option<Value> {
    let item = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())?;
    if item.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    let text = item.get("text").and_then(|t| t.as_str())?;
    serde_json::from_str::<Value>(text).ok()
}

/// Report whether a tools/call returned a "tool not found" error rather than
/// a real failure. cortexmd's tool registry returns a 404-ish JSON-RPC
/// error for unknown tools; we detect that via substring match.
fn is_unknown_tool_error(err: &anyhow::Error) -> bool {
    let s = err.to_string().to_ascii_lowercase();
    s.contains("unknown tool")
        || s.contains("not found")
        || s.contains("does not exist")
        || s.contains("no such tool")
        || s.contains("invalid_params")
        || s.contains("-32601") // Method not found
        || s.contains("-32602") // Invalid params (some servers map missing tool here)
}

// ── status ─────────────────────────────────────────────────────────────────

pub fn cmd_status() -> Result<()> {
    let (server, key, session_id, source) = open_session(None, None)?;
    println!("Server  {}  (auth: {}{})", server, source, oauth_expiry_suffix());
    println!("Machine {} (override via MACHINE_ID)", detect_machine_id());
    println!();

    // Repo list — required.
    let repos_result = mcp::tools_call(&server, &key, &session_id, "code_repo_list", &Value::Object(Default::default()));
    match repos_result {
        Ok(v) => {
            if let Some(payload) = unwrap_tool_text(&v) {
                print_repos_table(&payload);
            } else {
                eprintln!("[status] could not parse code_repo_list response");
            }
        }
        Err(e) => {
            eprintln!("[status] code_repo_list failed: {}", e);
        }
    }

    println!();
    // Savings — optional. Older servers don't expose this.
    let savings_result = mcp::tools_call(&server, &key, &session_id, "code_nav_stats", &Value::Object(Default::default()));
    match savings_result {
        Ok(v) => {
            if let Some(payload) = unwrap_tool_text(&v) {
                print_savings_block(&payload, None);
            } else {
                println!("Token savings (from server)  (response shape unrecognized)");
            }
        }
        Err(e) if is_unknown_tool_error(&e) => {
            println!("Token savings (from server)");
            println!("  Server doesn't expose code_nav_stats yet.");
            println!("  Update cortexmd to a recent main, then `docker compose up --build -d`.");
        }
        Err(e) => {
            println!("Token savings (from server)");
            println!("  query failed: {}", e);
        }
    }

    Ok(())
}

/// Returns ", token expires in 29d 4h" or ", token EXPIRED — re-run auth oauth-login"
/// when the OAuth cache is in use; empty string otherwise.
fn oauth_expiry_suffix() -> String {
    let Ok(Some(t)) = oauth::load_tokens() else {
        return String::new();
    };
    let now_ms_v = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if t.expires_at > now_ms_v {
        let remaining = (t.expires_at - now_ms_v) / 1000;
        format!(", token expires in {}", humanize_secs(remaining))
    } else {
        ", token EXPIRED — re-run `auth oauth-login`".to_string()
    }
}

fn print_repos_table(payload: &Value) {
    let repos = payload.get("repos").and_then(|r| r.as_array());
    let count = repos.map(|r| r.len()).unwrap_or(0);
    println!("Repos ({})", count);
    let Some(repos) = repos else {
        return;
    };
    if repos.is_empty() {
        if let Some(hint) = payload.get("hint").and_then(|h| h.as_str()) {
            println!("  {}", hint);
        }
        return;
    }
    // Compute column width for slug.
    let slug_w = repos
        .iter()
        .map(|r| r.get("slug").and_then(|s| s.as_str()).unwrap_or("(?)").len())
        .max()
        .unwrap_or(8)
        .max(8);
    let now = (now_secs() as i64) * 1000; // server stores ms.
    for r in repos {
        let slug = r.get("slug").and_then(|s| s.as_str()).unwrap_or("(?)");
        let files = r.get("fileCount").and_then(|n| n.as_i64()).unwrap_or(0);
        let symbols = r.get("symbolCount").and_then(|n| n.as_i64()).unwrap_or(0);
        let calls = r
            .get("callCount")
            .and_then(|n| n.as_i64())
            .unwrap_or(-1);
        let last_indexed = r.get("lastIndexedAt").and_then(|n| n.as_i64()).unwrap_or(0);
        let last_str = if last_indexed > 0 {
            let secs = ((now - last_indexed).max(0) / 1000) as u64;
            format!("last indexed {} ago", humanize_secs(secs))
        } else {
            "never indexed".to_string()
        };
        let calls_part = if calls >= 0 {
            format!(" / {} calls", humanize_count(calls))
        } else {
            String::new()
        };
        println!(
            "  {:<slug_w$}   {} files / {} symbols{}   {}",
            slug,
            humanize_count(files),
            humanize_count(symbols),
            calls_part,
            last_str,
            slug_w = slug_w,
        );
    }
}

fn print_savings_block(payload: &Value, days_filter: Option<u32>) {
    let total_saved = payload
        .get("totalSaved")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);
    let total_calls = payload
        .get("totalCalls")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);
    // Cost estimate: Claude Sonnet output ≈ $3 / MTok, but most token-saved
    // tonnage is INPUT savings (≈ $3 / MTok input as well at current pricing).
    // We mirror the spec's "$0.43 saved at Claude Sonnet pricing" by using
    // $3 / 1M tokens — adjustable when Anthropic prices change.
    let dollars = (total_saved as f64) * 3.0 / 1_000_000.0;
    println!("Token savings (from server)");
    println!(
        "  total       {}  ({} calls, ${:.2} saved at Claude Sonnet pricing)",
        humanize_count(total_saved),
        humanize_count(total_calls),
        dollars
    );

    if let Some(by_tool) = payload.get("savedByTool").and_then(|m| m.as_object()) {
        if !by_tool.is_empty() {
            println!("  by tool:");
            // Sort by tokensSaved desc.
            let mut rows: Vec<(&String, &Value)> = by_tool.iter().collect();
            rows.sort_by(|a, b| {
                b.1.get("tokensSaved")
                    .and_then(|n| n.as_i64())
                    .unwrap_or(0)
                    .cmp(&a.1.get("tokensSaved").and_then(|n| n.as_i64()).unwrap_or(0))
            });
            let name_w = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(20).max(20);
            for (name, m) in rows {
                let calls = m.get("calls").and_then(|n| n.as_i64()).unwrap_or(0);
                let saved = m.get("tokensSaved").and_then(|n| n.as_i64()).unwrap_or(0);
                let avg = m.get("avgSaved").and_then(|n| n.as_i64()).unwrap_or(0);
                println!(
                    "    {:<name_w$}  {} calls · {} saved · {} avg",
                    name,
                    humanize_count(calls),
                    humanize_count(saved),
                    humanize_count(avg),
                    name_w = name_w,
                );
            }
        }
    }

    // History sparkline (last N days if asked).
    if let Some(history) = payload.get("history").and_then(|h| h.as_array()) {
        let cutoff_ms = days_filter
            .map(|d| {
                let now_ms_v = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|x| x.as_millis() as u64)
                    .unwrap_or(0);
                now_ms_v.saturating_sub((d as u64) * 86_400 * 1000)
            })
            .unwrap_or(0);
        let filtered: Vec<i64> = history
            .iter()
            .filter_map(|h| {
                let ts = h.get("ts").and_then(|n| n.as_u64()).unwrap_or(0);
                if ts < cutoff_ms {
                    return None;
                }
                h.get("cumulativeSaved").and_then(|n| n.as_i64())
            })
            .collect();
        if filtered.len() >= 2 {
            println!("  history:    {}", sparkline(&filtered));
        }
    }
}

/// Tiny ASCII sparkline using block-character buckets. Robust to negative or
/// zero ranges (degenerates to a flat line).
fn sparkline(values: &[i64]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let min = *values.iter().min().unwrap();
    let max = *values.iter().max().unwrap();
    let span = (max - min).max(1);
    let mut out = String::with_capacity(values.len() * 3);
    for v in values {
        let idx = ((v - min) as f64 / span as f64 * (chars.len() as f64 - 1.0)).round() as usize;
        out.push(chars[idx.min(chars.len() - 1)]);
    }
    out
}

// ── discover ───────────────────────────────────────────────────────────────

pub fn cmd_discover(args: DiscoverArgs) -> Result<()> {
    let root = resolve_root(args.root.as_deref())?;
    let depth = args.depth;
    let repos = bfs_git_repos(&root, depth);

    // Try to read the registered set from the server. If that fails, we
    // still print discovery results — just without status badges.
    let registry: Registry = match fetch_registry() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[discover] WARN: could not fetch registered repos ({}). Showing discovery only.", e);
            Registry::default()
        }
    };

    println!(
        "Discovered {} git repos under {} (depth {})",
        repos.len(),
        display_path(&root),
        depth
    );
    let path_strs: Vec<String> = repos.iter().map(|p| display_path(p)).collect();
    let path_w = path_strs
        .iter()
        .map(|s| s.len())
        .max()
        .unwrap_or(20)
        .min(60);

    let mut unregistered = 0usize;
    let now_ms_v = (now_secs() as i64) * 1000;
    for (i, repo) in repos.iter().enumerate() {
        let origin = git::git_origin(repo);
        let first_sha = git::first_commit_sha(repo).ok();
        let repo_id = compute_repo_id(origin.as_deref(), first_sha.as_deref());
        let info = registry.lookup(
            repo_id.as_deref(),
            Some(repo.as_path()),
            origin.as_deref(),
            first_sha.as_deref(),
        );
        let (badge, suffix) = match info {
            Some(r) => {
                let last = if r.last_indexed_at > 0 {
                    let secs = ((now_ms_v - r.last_indexed_at).max(0) / 1000) as u64;
                    format!("registered, last indexed {} ago", humanize_secs(secs))
                } else {
                    "registered (never indexed)".to_string()
                };
                ("[x]", last)
            }
            None => {
                unregistered += 1;
                let cmd = format!(
                    "UNREGISTERED, run: cortexmd {}",
                    display_path(repo)
                );
                ("[ ]", cmd)
            }
        };
        println!(
            "  {} {:<path_w$}  — {}",
            badge,
            path_strs[i],
            suffix,
            path_w = path_w
        );
    }
    if unregistered > 0 {
        println!();
        println!(
            "{} unregistered repos. Run `cortexmd scan {}` to index them all.",
            unregistered,
            display_path(&root)
        );
    }
    Ok(())
}

/// Render a path nicely for display: strip Windows `\\?\` extended-length
/// prefix and use forward slashes on Windows for readability.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    let trimmed = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    if cfg!(windows) {
        trimmed.replace('\\', "/")
    } else {
        trimmed
    }
}

#[derive(Debug, Clone)]
struct RegInfo {
    last_indexed_at: i64,
}

/// Server-side registry, indexed by every key we might want to match on:
/// repo_id (most reliable under the fork-aware scheme), canonicalized
/// abs_path (per machine), git_origin, and first_commit_sha (legacy).
/// We populate whichever keys the server returns.
#[derive(Debug, Default)]
struct Registry {
    by_id: HashMap<String, RegInfo>,
    by_abs: HashMap<String, RegInfo>,
    by_origin: HashMap<String, RegInfo>,
    by_first_sha: HashMap<String, RegInfo>,
}

impl Registry {
    /// Match priority:
    ///   1. `id` (fork-aware, most reliable)
    ///   2. canonical abs_path (when the discovered repo lives at a path
    ///      already registered on this machine — works against old servers
    ///      that only return a single abs_path field, and against new servers
    ///      that return paths[] for *any* machine)
    ///   3. git_origin (legacy/no-id servers)
    ///   4. first_commit_sha (legacy data with no origin recorded)
    fn lookup(
        &self,
        repo_id: Option<&str>,
        abs: Option<&Path>,
        origin: Option<&str>,
        first_sha: Option<&str>,
    ) -> Option<&RegInfo> {
        if let Some(id) = repo_id {
            if let Some(v) = self.by_id.get(id) {
                return Some(v);
            }
        }
        if let Some(p) = abs {
            let k = canonical_key(p);
            if let Some(v) = self.by_abs.get(&k) {
                return Some(v);
            }
        }
        if let Some(o) = origin {
            if let Some(v) = self.by_origin.get(&normalize_origin(o)) {
                return Some(v);
            }
        }
        if let Some(s) = first_sha {
            if let Some(v) = self.by_first_sha.get(s) {
                return Some(v);
            }
        }
        None
    }
}

/// Pull registered-repo identifiers from the server. Indexes by every
/// available key (id, abs_path, git_origin, first_commit_sha) so cross-machine
/// matching works even when this machine never registered an `abs_path`.
///
/// Walks the new `paths[]` array (server feature) when present — each entry
/// is a `(machine_id, abs_path)` tuple registered by some indexer run. Falls
/// back to the older single `abs_path` field when running against a server
/// that hasn't been updated yet.
fn fetch_registry() -> Result<Registry> {
    let (server, key, session_id, _source) = open_session(None, None)?;
    let result = mcp::tools_call(&server, &key, &session_id, "code_repo_list", &Value::Object(Default::default()))?;
    let Some(payload) = unwrap_tool_text(&result) else {
        return Ok(Registry::default());
    };
    let mut reg = Registry::default();
    if let Some(repos) = payload.get("repos").and_then(|r| r.as_array()) {
        for r in repos {
            let id = r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
            let abs_top = r.get("abs_path").and_then(|v| v.as_str()).map(|s| s.to_string());
            let origin = r.get("git_origin").and_then(|v| v.as_str()).map(|s| s.to_string());
            let first_sha = r
                .get("first_commit_sha")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let last_indexed_at = r
                .get("lastIndexedAt")
                .and_then(|n| n.as_i64())
                .unwrap_or(0);
            let info = RegInfo { last_indexed_at };
            if let Some(i) = id.as_deref() {
                if !i.is_empty() {
                    reg.by_id.insert(i.to_string(), info.clone());
                }
            }
            // New shape: paths[] array of {machine_id, abs_path, ...}.
            if let Some(paths) = r.get("paths").and_then(|p| p.as_array()) {
                for p in paths {
                    if let Some(a) = p.get("abs_path").and_then(|v| v.as_str()) {
                        if !a.is_empty() {
                            reg.by_abs.insert(canonical_key(Path::new(a)), info.clone());
                        }
                    }
                }
            }
            // Legacy shape: top-level abs_path. Always honor it when present
            // (older deployments) — graceful degradation.
            if let Some(a) = abs_top.as_deref() {
                if !a.is_empty() {
                    reg.by_abs.insert(canonical_key(Path::new(a)), info.clone());
                }
            }
            if let Some(o) = origin.as_deref() {
                if !o.is_empty() {
                    reg.by_origin.insert(normalize_origin(o), info.clone());
                }
            }
            if let Some(s) = first_sha.as_deref() {
                if !s.is_empty() {
                    reg.by_first_sha.insert(s.to_string(), info);
                }
            }
        }
    }
    Ok(reg)
}

/// Normalize a git URL so `git@host:path.git` and `https://host/path` and
/// trailing-slash variants compare equal.
fn normalize_origin(s: &str) -> String {
    let mut t = s.trim().trim_end_matches('/').to_ascii_lowercase();
    if let Some(rest) = t.strip_suffix(".git") {
        t = rest.to_string();
    }
    // Convert SSH form `git@host:owner/repo` to `host/owner/repo` so it
    // matches the equivalent HTTPS URL post-host.
    if let Some(rest) = t.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("{}/{}", host, path);
        }
    }
    // Strip protocol prefixes for symmetry.
    for proto in &["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = t.strip_prefix(proto) {
            t = rest.to_string();
            break;
        }
    }
    t
}

/// Normalize a path for cross-machine comparison: canonicalize when possible,
/// else lower-case-on-Windows the lossy string representation.
fn canonical_key(p: &Path) -> String {
    let s = p
        .canonicalize()
        .ok()
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned());
    // Strip Windows extended-length prefix if present.
    let trimmed = s.strip_prefix(r"\\?\").unwrap_or(&s);
    if cfg!(windows) {
        trimmed.replace('\\', "/").to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Resolve the root directory for discovery.
/// Priority: explicit arg → parent of cwd → `D:/dev` (Windows) / `~/code` (unix).
fn resolve_root(arg: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = arg {
        let canon = p
            .canonicalize()
            .with_context(|| format!("root path does not exist: {}", p.display()))?;
        return Ok(canon);
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(parent) = cwd.parent() {
            if let Ok(canon) = parent.canonicalize() {
                return Ok(canon);
            }
        }
    }
    if cfg!(windows) {
        let p = PathBuf::from("D:/dev");
        if p.exists() {
            return Ok(p);
        }
    } else if let Some(home) = dirs::home_dir() {
        let p = home.join("code");
        if p.exists() {
            return Ok(p);
        }
    }
    anyhow::bail!("could not determine a default root — pass <root-path> explicitly")
}

/// BFS for git repos. Stops descending into a repo once `.git/` is found
/// (matches the server's behaviour). Skips SKIP_DIRS by name.
fn bfs_git_repos(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((p, d)) = queue.pop() {
        let entries = match std::fs::read_dir(&p) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut subdirs: Vec<PathBuf> = Vec::new();
        let mut has_git = false;
        for entry in entries.flatten() {
            let Ok(ftype) = entry.file_type() else {
                continue;
            };
            if !ftype.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" {
                has_git = true;
                continue;
            }
            if SKIP_DIRS.iter().any(|s| *s == name) {
                continue;
            }
            subdirs.push(entry.path());
        }
        if has_git {
            found.push(p);
            continue;
        }
        if d >= depth {
            continue;
        }
        for sd in subdirs {
            queue.push((sd, d + 1));
        }
    }
    found.sort();
    found
}

// ── scan ───────────────────────────────────────────────────────────────────

/// Outcome of a single scan-prompt confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptChoice {
    Yes,
    No,
    All,
    None_,
    Quit,
}

fn read_choice(prompt: &str) -> PromptChoice {
    eprint!("{}", prompt);
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return PromptChoice::Yes;
    }
    match line.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" | "" => PromptChoice::Yes,
        "n" | "no" => PromptChoice::No,
        "a" | "all" => PromptChoice::All,
        "none" => PromptChoice::None_,
        "q" | "quit" => PromptChoice::Quit,
        _ => PromptChoice::No,
    }
}

pub fn cmd_scan(
    args: ScanArgs,
    run_index: impl Fn(IndexArgs) -> Result<()>,
) -> Result<()> {
    let root = resolve_root(args.root.as_deref())?;
    let repos = bfs_git_repos(&root, args.depth);
    let registry = fetch_registry().unwrap_or_default();

    let unregistered: Vec<PathBuf> = repos
        .into_iter()
        .filter(|r| {
            let origin = git::git_origin(r);
            let first_sha = git::first_commit_sha(r).ok();
            let repo_id = compute_repo_id(origin.as_deref(), first_sha.as_deref());
            registry
                .lookup(
                    repo_id.as_deref(),
                    Some(r.as_path()),
                    origin.as_deref(),
                    first_sha.as_deref(),
                )
                .is_none()
        })
        .collect();

    if unregistered.is_empty() {
        println!(
            "All discovered repos under {} (depth {}) are already registered. Nothing to do.",
            display_path(&root),
            args.depth
        );
        return Ok(());
    }

    println!(
        "Found {} unregistered git repos under {} (depth {}).",
        unregistered.len(),
        display_path(&root),
        args.depth
    );

    let auto_yes = args.yes || !std::io::stdin().is_terminal();
    let mut force_all = auto_yes;
    let mut indexed = 0usize;
    let mut indexed_paths: Vec<PathBuf> = Vec::new();
    let start = Instant::now();

    for repo in &unregistered {
        let proceed = if force_all {
            true
        } else {
            match read_choice(&format!(
                "Index {}? [Y/n/all/none/q] ",
                display_path(repo)
            )) {
                PromptChoice::Yes => true,
                PromptChoice::No => false,
                PromptChoice::All => {
                    force_all = true;
                    true
                }
                PromptChoice::None_ => break,
                PromptChoice::Quit => break,
            }
        };
        if !proceed {
            continue;
        }
        println!("indexing {}…", display_path(repo));
        let index_args = IndexArgs {
            repo_path: Some(repo.clone()),
            ..Default::default()
        };
        match run_index(index_args) {
            Ok(()) => {
                indexed += 1;
                indexed_paths.push(repo.clone());
            }
            Err(e) => {
                eprintln!("  failed: {}", e);
            }
        }
    }

    let elapsed = start.elapsed().as_secs_f64();

    // Tally aggregate file/symbol/call counts for the repos we just
    // indexed by re-reading code_repo_list once. Best-effort.
    let (total_files, total_symbols, total_calls) = if indexed_paths.is_empty() {
        (0i64, 0i64, 0i64)
    } else {
        sum_indexed_counts(&indexed_paths).unwrap_or((0, 0, 0))
    };

    println!();
    println!(
        "indexed {} repos, {} files, {} symbols, {} calls in {:.1}s",
        indexed,
        humanize_count(total_files),
        humanize_count(total_symbols),
        humanize_count(total_calls),
        elapsed
    );
    Ok(())
}

/// Re-read code_repo_list and sum file/symbol/call counts for the given paths.
/// Matches by repo_id (fork-aware), canonical abs_path (top-level or any
/// entry in paths[]), git_origin, or first_commit_sha so it works against
/// both new (paths[]) and old (single abs_path) servers.
fn sum_indexed_counts(paths: &[PathBuf]) -> Result<(i64, i64, i64)> {
    let (server, key, sid, _) = open_session(None, None)?;
    let v = mcp::tools_call(
        &server,
        &key,
        &sid,
        "code_repo_list",
        &Value::Object(Default::default()),
    )?;
    let payload = unwrap_tool_text(&v)
        .ok_or_else(|| anyhow!("code_repo_list returned an unrecognized response shape"))?;
    let repos = payload
        .get("repos")
        .and_then(|r| r.as_array())
        .ok_or_else(|| anyhow!("code_repo_list missing repos[]"))?;
    // Build the wanted-set keyed by every key we can compute locally.
    let mut wanted_ids: Vec<String> = Vec::new();
    let mut wanted_paths: Vec<String> = Vec::new();
    let mut wanted_origins: Vec<String> = Vec::new();
    let mut wanted_shas: Vec<String> = Vec::new();
    for p in paths {
        wanted_paths.push(canonical_key(p));
        let origin = git::git_origin(p);
        let first_sha = git::first_commit_sha(p).ok();
        if let Some(o) = origin.as_deref() {
            wanted_origins.push(normalize_origin(o));
        }
        if let Some(s) = first_sha.as_deref() {
            wanted_shas.push(s.to_string());
        }
        if let Some(id) = compute_repo_id(origin.as_deref(), first_sha.as_deref()) {
            wanted_ids.push(id);
        }
    }
    let mut files = 0i64;
    let mut symbols = 0i64;
    let mut calls = 0i64;
    for r in repos {
        let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let abs = r.get("abs_path").and_then(|v| v.as_str()).unwrap_or("");
        let origin = r.get("git_origin").and_then(|v| v.as_str()).unwrap_or("");
        let sha = r.get("first_commit_sha").and_then(|v| v.as_str()).unwrap_or("");
        let id_match = !id.is_empty() && wanted_ids.iter().any(|w| w == id);
        let abs_match = (!abs.is_empty()
            && wanted_paths.iter().any(|w| w == &canonical_key(Path::new(abs))))
            || r.get("paths")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter().any(|p| {
                        p.get("abs_path")
                            .and_then(|v| v.as_str())
                            .map(|a| {
                                !a.is_empty()
                                    && wanted_paths.iter().any(|w| w == &canonical_key(Path::new(a)))
                            })
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
        let origin_match =
            !origin.is_empty() && wanted_origins.iter().any(|w| w == &normalize_origin(origin));
        let sha_match = !sha.is_empty() && wanted_shas.iter().any(|w| w == sha);
        if id_match || abs_match || origin_match || sha_match {
            files += r.get("fileCount").and_then(|n| n.as_i64()).unwrap_or(0);
            symbols += r.get("symbolCount").and_then(|n| n.as_i64()).unwrap_or(0);
            calls += r.get("callCount").and_then(|n| n.as_i64()).unwrap_or(0);
        }
    }
    Ok((files, symbols, calls))
}

// ── hud-line ───────────────────────────────────────────────────────────────

/// Heartbeat file the daemon touches on every loop tick. `--ensure-daemon`
/// uses the file's mtime as the liveness signal: fresh → already running,
/// stale/missing → spawn a fresh daemon. Avoids needing a PID-aliveness
/// syscall (libc::kill on Unix, OpenProcess on Windows).
fn hud_heartbeat_path() -> Option<PathBuf> {
    let dir = dirs::cache_dir().or_else(dirs::data_dir)?;
    crate::auth::migrate_legacy_app_dir(&dir);
    Some(dir.join(crate::auth::APP_DIR).join("hud-line.heartbeat"))
}

/// Touch the heartbeat file with the current Unix-seconds timestamp.
/// Best-effort: a write failure is logged but doesn't kill the daemon.
fn touch_hud_heartbeat() {
    let Some(path) = hud_heartbeat_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = std::fs::write(&path, now.to_string()) {
        eprintln!("[hud-line] heartbeat write failed: {}", e);
    }
}

/// Returns true when the heartbeat file exists and was touched within the
/// staleness window. The window should be at least 2× the daemon's polling
/// interval so a slow tick doesn't trigger a spurious respawn.
fn hud_daemon_is_fresh(stale_after: std::time::Duration) -> bool {
    let Some(path) = hud_heartbeat_path() else { return false };
    let Ok(meta) = std::fs::metadata(&path) else { return false };
    let Ok(modified) = meta.modified() else { return false };
    let Ok(age) = SystemTime::now().duration_since(modified) else { return false };
    age <= stale_after
}

/// Re-spawn ourselves as a detached background process running the regular
/// daemon loop. Strips the launcher-only `--ensure-daemon` flag so the child
/// runs the actual poll, and forwards every other arg.
///
/// Detachment is platform-specific:
///   - Unix: `process_group(0)` so the child isn't killed when the launcher
///     exits or its terminal is closed.
///   - Windows: `creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS |
///     CREATE_NEW_PROCESS_GROUP)` so no console window flashes and the
///     child survives parent exit.
fn spawn_hud_daemon(args: &crate::cli::HudLineArgs) -> Result<u32> {
    let exe = std::env::current_exe().context("locate current_exe for daemon spawn")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("hud-line")
        .arg("--interval").arg(args.interval.to_string())
        .arg("--max-len").arg(args.max_len.to_string());
    if let Some(p) = &args.hud_config {
        cmd.arg("--hud-config").arg(p);
    }
    if let Some(s) = &args.server {
        cmd.arg("--server").arg(s);
    }
    if let Some(k) = &args.api_key {
        cmd.arg("--api-key").arg(k);
    }
    // Detach stdio so the child has no controlling terminal.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // CREATE_NO_WINDOW (0x08000000) | DETACHED_PROCESS (0x00000008)
        // | CREATE_NEW_PROCESS_GROUP (0x00000200)
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd.spawn().context("spawn detached hud-line daemon")?;
    Ok(child.id())
}

/// Probe the conventional claude-hud config locations. Returns the first
/// existing path. We probe the main install path and the marketplaces path
/// (claude-code's plugin layout).
fn probe_claude_hud_config(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        if p.exists() {
            return Some(p.to_path_buf());
        }
        return None;
    }
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".claude/plugins/claude-hud/config.json"),
        home.join(".claude/plugins/marketplaces/claude-hud/config.json"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Format a thousands-grouped count, no decimals.
fn fmt_count_short(n: i64) -> String {
    let abs = n.unsigned_abs();
    if abs >= 1_000_000 {
        format!("{:.1}M", abs as f64 / 1_000_000.0)
    } else if abs >= 1_000 {
        format!("{:.1}KT", abs as f64 / 1_000.0)
    } else {
        abs.to_string()
    }
}

fn render_hud_line(stats: &Value, max_len: usize) -> String {
    let saved = stats.get("tokensSaved").and_then(|v| v.as_i64()).unwrap_or(0);
    let calls = stats
        .get("codeNavCalls")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let enabled = stats
        .get("mcpToolEnabled")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let total = stats
        .get("mcpToolTotal")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let hot = stats
        .get("memoryTemperature")
        .and_then(|v| v.get("hot"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let p95 = stats
        .get("aggregateP95Ms")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let profile = stats
        .get("profile")
        .and_then(|v| v.as_str())
        .unwrap_or("full");

    let saved_str = if saved >= 1000 {
        format!("+{}", fmt_count_short(saved))
    } else {
        format!("+{}", saved)
    };
    let line = format!(
        "💰 {} ({} calls) │ ⚡ {}/{} mcp [{}] │ 🔥 {} hot │ p95 {}ms",
        saved_str, calls, enabled, total, profile, hot, p95,
    );
    if line.chars().count() <= max_len {
        return line;
    }
    // Fallback: drop emoji decorations, keep the numbers.
    let plain = format!(
        "+{} sav · {}/{} {} · {}h · p95 {}ms",
        fmt_count_short(saved),
        enabled,
        total,
        profile,
        hot,
        p95,
    );
    if plain.chars().count() <= max_len {
        return plain;
    }
    plain.chars().take(max_len).collect()
}

/// Atomically rewrite the `display.customLine` field of a JSON config file.
/// Reads → parses → mutates → writes `.tmp` → renames. Returns Ok on success.
fn write_custom_line(config_path: &Path, new_line: &str) -> Result<()> {
    let raw = std::fs::read_to_string(config_path)
        .with_context(|| format!("read {}", config_path.display()))?;
    let mut json: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse json {}", config_path.display()))?;

    // Ensure `display` object exists, then write `customLine`.
    if !json.is_object() {
        anyhow::bail!("config root is not a JSON object: {}", config_path.display());
    }
    let obj = json.as_object_mut().unwrap();
    let display = obj
        .entry("display")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !display.is_object() {
        anyhow::bail!("display field is not an object in {}", config_path.display());
    }
    display
        .as_object_mut()
        .unwrap()
        .insert("customLine".into(), Value::String(new_line.to_string()));

    let serialized = serde_json::to_string_pretty(&json).context("re-serialize hud config")?;
    let tmp = config_path.with_extension("json.tmp");
    std::fs::write(&tmp, serialized.as_bytes())
        .with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, config_path)
        .with_context(|| format!("rename {} → {}", tmp.display(), config_path.display()))?;
    Ok(())
}

fn fetch_hud_stats(server: &str, api_key: &str) -> Result<Value> {
    let url = format!("{}/api/hud-stats", server.trim_end_matches('/'));
    let req = ureq::get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Accept", "application/json");
    let mut resp = req
        .call()
        .with_context(|| format!("GET {} failed", url))?;
    let status = resp.status();
    if status.as_u16() >= 400 {
        anyhow::bail!("GET {} returned {}", url, status);
    }
    let text: String = resp
        .body_mut()
        .read_to_string()
        .with_context(|| format!("read body {}", url))?;
    serde_json::from_str::<Value>(&text)
        .with_context(|| format!("parse JSON from {}", url))
}

pub fn cmd_hud_line(args: HudLineArgs) -> Result<()> {
    // Idempotent launcher mode: spawn-if-not-running and exit. Stale window
    // is 2.5× the polling interval so a slow tick doesn't trigger a respawn.
    if args.ensure_daemon {
        let stale_after = std::time::Duration::from_secs((args.interval.max(1) * 5) / 2);
        if hud_daemon_is_fresh(stale_after) {
            eprintln!("[hud-line] daemon already running (heartbeat fresh) — nothing to do.");
            return Ok(());
        }
        match spawn_hud_daemon(&args) {
            Ok(pid) => {
                // Touch the heartbeat now so a racing session-start that fires
                // before the child's first poll sees it fresh.
                touch_hud_heartbeat();
                eprintln!("[hud-line] spawned detached daemon (pid {})", pid);
            }
            Err(e) => {
                eprintln!("[hud-line] daemon spawn failed: {}", e);
                return Err(e);
            }
        }
        return Ok(());
    }

    let hud_config = match probe_claude_hud_config(args.hud_config.as_deref()) {
        Some(p) => p,
        None => {
            eprintln!(
                "[hud-line] claude-hud config.json not found at the standard locations.\n\
                 Install it via `/claude-hud:setup` first, or pass --hud-config <path>."
            );
            // No-op rather than fail, per Slice 12 spec.
            return Ok(());
        }
    };
    eprintln!("[hud-line] using hud config: {}", hud_config.display());

    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    eprintln!("[hud-line] polling {} every {}s", server, args.interval);

    // Stamp heartbeat at startup so a session-start firing before the first
    // poll completes sees the daemon as alive and skips respawning.
    if !args.once {
        touch_hud_heartbeat();
    }

    let mut last_line = String::new();
    let interval = std::time::Duration::from_secs(args.interval.max(1));

    loop {
        match fetch_hud_stats(&server, &key) {
            Ok(stats) => {
                let line = render_hud_line(&stats, args.max_len);
                if line != last_line {
                    if let Err(e) = write_custom_line(&hud_config, &line) {
                        eprintln!("[hud-line] write failed: {}", e);
                    } else {
                        last_line = line.clone();
                    }
                }
                if args.print {
                    println!("{}", line);
                }
            }
            Err(e) => {
                eprintln!("[hud-line] fetch failed: {}", e);
            }
        }
        // Touch heartbeat unconditionally — it signals "process alive", not
        // "fetch succeeded". A long server outage shouldn't trigger a duplicate
        // daemon on the next session-start.
        if !args.once {
            touch_hud_heartbeat();
        }
        if args.once {
            break;
        }
        std::thread::sleep(interval);
    }
    Ok(())
}

// ── recall / store-memory (Claude Code hook bridge) ───────────────────────

fn post_json_simple(server: &str, path: &str, key: &str, payload: &Value) -> Result<Value> {
    let url = format!("{}{}", server.trim_end_matches('/'), path);
    let body = serde_json::to_string(payload).context("serialize payload")?;
    let mut resp = ureq::post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .send(body.as_bytes())
        .with_context(|| format!("POST {} failed", url))?;
    let status = resp.status();
    let text = resp
        .body_mut()
        .read_to_string()
        .with_context(|| format!("read body {}", url))?;
    if status.as_u16() >= 400 {
        anyhow::bail!("POST {} returned {}: {}", url, status, text);
    }
    if text.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str::<Value>(&text)
        .with_context(|| format!("parse JSON from {}", url))
}

fn render_memory_block(
    memories: &[Value],
    notes: &[Value],
    header: &str,
    max_chars: usize,
) -> String {
    let mut picks: Vec<String> = Vec::new();
    for m in memories {
        let path = m.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let cat = m
            .get("category")
            .and_then(|v| v.as_str())
            .map(|c| format!(" [{}]", c))
            .unwrap_or_default();
        let temp = m
            .get("temperature")
            .and_then(|v| v.as_str())
            .map(|t| format!(" {}", t))
            .unwrap_or_default();
        let snip = m
            .get("snippet")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace(['\n', '\r', '\t'], " ");
        let snip: String = snip.split_whitespace().collect::<Vec<_>>().join(" ");
        let snip: String = snip.chars().take(160).collect();
        picks.push(format!("- [[{}]]{}{}: {}", path, cat, temp, snip));
    }
    for n in notes {
        if picks.len() >= 5 {
            break;
        }
        let path = n.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let snip = n
            .get("snippet")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace(['\n', '\r', '\t'], " ");
        let snip: String = snip.split_whitespace().collect::<Vec<_>>().join(" ");
        let snip: String = snip.chars().take(160).collect();
        picks.push(format!("- [[{}]]: {}", path, snip));
    }
    if picks.is_empty() {
        return String::new();
    }
    let mut body = format!("{}:\n{}", header, picks.join("\n"));
    if body.chars().count() > max_chars {
        let truncated: String = body.chars().take(max_chars.saturating_sub(3)).collect();
        body = format!("{}...", truncated);
    }
    body
}

pub fn cmd_recall(args: RecallArgs) -> Result<()> {
    if args.hook {
        // Hook mode: read Claude's UserPromptSubmit JSON from stdin, derive a
        // query from the prompt, and emit a markdown block on stdout (which
        // Claude treats as additional context). All errors are swallowed —
        // a failing hook must never block the user's prompt.
        // Thread the resolved server/key (from --server/--api-key or the
        // MCP_URL/MCP_API_KEY env clap parsed) into the stdin pipeline so a
        // self-hosted setup's hook targets the configured server, not just the
        // OAuth cache.
        let _ = recall_from_stdin(args.server.as_deref(), args.api_key.as_deref());
        return Ok(());
    }
    if args.query.trim().is_empty() {
        anyhow::bail!("--query is required and cannot be empty");
    }
    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    let payload = serde_json::json!({
        "query": args.query,
        "limit": args.limit,
        "kinds": args.kinds,
    });
    let resp = post_json_simple(&server, "/api/recall", &key, &payload)?;

    match args.format.as_str() {
        "block" => {
            let empty: Vec<Value> = Vec::new();
            let memories = resp
                .get("memories")
                .and_then(|v| v.as_array())
                .unwrap_or(&empty);
            let notes = resp
                .get("notes")
                .and_then(|v| v.as_array())
                .unwrap_or(&empty);
            let block = render_memory_block(memories, notes, &args.header, args.max_chars);
            if !block.is_empty() {
                println!("{}", block);
            }
        }
        _ => {
            // json (default)
            println!("{}", serde_json::to_string(&resp)?);
        }
    }
    Ok(())
}

pub fn cmd_repo_list(args: RepoListArgs) -> Result<()> {
    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    // POST with empty body — the server endpoint accepts {}.
    let resp = post_json_simple(&server, "/api/code-repo-list", &key, &Value::Object(Default::default()))?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

pub fn cmd_store_memory(args: StoreMemoryArgs) -> Result<()> {
    if args.hook {
        // Hook mode: read PostToolUse JSON from stdin, gate on high-signal
        // Bash invocations, and store a memory silently. Exits 0 on any
        // error so the hook never blocks Claude.
        let _ = store_from_stdin(args.server.as_deref(), args.api_key.as_deref());
        return Ok(());
    }
    let mut content = args.content.clone();
    if content == "-" {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("read content from stdin")?;
        content = buf;
    }
    if content.trim().is_empty() {
        anyhow::bail!("--content is required and cannot be empty");
    }

    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    let mut payload = serde_json::Map::new();
    payload.insert("content".into(), Value::String(content));
    payload.insert("category".into(), Value::String(args.category.clone()));
    if let Some(t) = args.title.clone() {
        payload.insert("title".into(), Value::String(t));
    }
    if !args.tags.is_empty() {
        payload.insert(
            "tags".into(),
            Value::Array(args.tags.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(s) = args.source.clone() {
        payload.insert("source".into(), Value::String(s));
    }
    let resp = post_json_simple(&server, "/api/store-memory", &key, &Value::Object(payload))?;

    match args.format.as_str() {
        "path" => {
            let path = resp
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !path.is_empty() {
                println!("{}", path);
            }
        }
        _ => println!("{}", serde_json::to_string(&resp)?),
    }
    Ok(())
}

// ── recall / store-memory hook helpers ────────────────────────────────────
//
// `--hook` modes wrap the regular subcommand pipelines but read the Claude
// Code hook event from stdin and never propagate errors (a flaky server
// must NOT block the user's prompt or a tool call).

fn recall_from_stdin(server: Option<&str>, key: Option<&str>) -> Result<()> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok();
    if buf.trim().is_empty() {
        return Ok(());
    }
    let event: Value = match serde_json::from_str(&buf) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let prompt = event
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    // Skip very short prompts — recall on "yes" / "go" wastes a round trip
    // and the result is rarely relevant.
    if prompt.chars().count() < 20 {
        return Ok(());
    }
    let mut args = RecallArgs::default();
    args.query = prompt.to_string();
    args.limit = 5;
    args.kinds = "both".to_string();
    args.format = "block".to_string();
    args.max_chars = 800;
    args.header = "📌 Relevant memory".to_string();
    args.server = server.map(str::to_string);
    args.api_key = key.map(str::to_string);
    args.hook = false;
    cmd_recall(args)
}

fn store_from_stdin(server: Option<&str>, key: Option<&str>) -> Result<()> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok();
    if buf.trim().is_empty() {
        return Ok(());
    }
    let event: Value = match serde_json::from_str(&buf) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let tool_name = event
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if tool_name != "Bash" {
        return Ok(());
    }
    let cmd_str = event
        .get("tool_input")
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if cmd_str.is_empty() || !is_high_signal_bash(cmd_str) {
        return Ok(());
    }
    let response = event.get("tool_response");
    let exit_code = response
        .and_then(|r| r.get("exit_code").or_else(|| r.get("exitCode")))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if exit_code != 0 {
        return Ok(());
    }
    let stdout_snip = response
        .and_then(|r| {
            r.get("content")
                .or_else(|| r.get("stdout"))
                .or_else(|| r.get("output"))
        })
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .lines()
        .take(20)
        .collect::<Vec<_>>()
        .join("\n");
    let cmd_head: String = cmd_str.lines().take(5).collect::<Vec<_>>().join("\n");

    // Anchor the memory to its repo so it doesn't land as an orphan: derive the
    // repo name from cwd, emit a leading `[[repo]]` wiki-link, and build a human
    // title from the command (instead of letting the server title it "```sh").
    let cwd = event.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let repo: String = cwd
        .trim_end_matches(|c| c == '/' || c == '\\')
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let cmd_first = cmd_str.lines().next().unwrap_or("").trim();
    let title = {
        let head: String = cmd_first.chars().take(70).collect();
        if repo.is_empty() { head } else { format!("{}: {}", repo, head) }
    };
    let anchor = if repo.is_empty() {
        String::new()
    } else {
        format!("[[{}]] — ", repo)
    };
    let summary = format!("{}`{}`", anchor, cmd_first);
    let content = if stdout_snip.is_empty() {
        format!("{}\n\n```sh\n$ {}\n```", summary, cmd_head)
    } else {
        format!("{}\n\n```sh\n$ {}\n```\n\n{}", summary, cmd_head, stdout_snip)
    };

    let mut args = StoreMemoryArgs::default();
    args.content = content;
    args.category = "observation".to_string();
    args.title = Some(title);
    args.tags = vec!["hook".to_string(), "PostToolUse".to_string(), "Bash".to_string()];
    if !repo.is_empty() {
        args.tags.push(format!("repo:{}", repo));
    }
    args.source = Some("hook:PostToolUse:Bash".to_string());
    args.format = "json".to_string();
    args.server = server.map(str::to_string);
    args.api_key = key.map(str::to_string);
    args.hook = false;
    cmd_store_memory(args)
}

/// Conservative allow-list of Bash command prefixes worth auto-capturing.
/// Matches both standalone (`docker run ...`) and chained (`cd /tmp && docker ps`)
/// invocations. Errs on the side of capturing too little — false positives
/// would clutter memory faster than they help.
fn is_high_signal_bash(cmd: &str) -> bool {
    const HIGH_SIGNAL: &[&str] = &[
        "systemctl ",
        "docker ",
        "kubectl ",
        "terraform ",
        "helm ",
        "ansible ",
        "ansible-playbook ",
        "make deploy",
        "make release",
        "git push ",
        "git tag ",
        "git revert ",
        "git reset ",
        "npm publish",
        "cargo publish",
        "rm -rf ",
    ];
    let lower = cmd.to_lowercase();
    HIGH_SIGNAL
        .iter()
        .any(|p| lower.starts_with(p) || lower.contains(&format!(" {}", p)))
}

// ── code-search / code-get / code-impact ──────────────────────────────────
//
// Thin wrappers around the server's `/api/code-*` REST endpoints. They mirror
// the eponymous MCP tools but skip the JSON-RPC handshake — useful in shell
// pipelines and benchmarks. All three use the same auth/server resolution as
// `recall` and `store-memory`.

pub fn cmd_code_search(args: CodeSearchArgs) -> Result<()> {
    if args.query.trim().is_empty() {
        anyhow::bail!("--query is required and cannot be empty");
    }
    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;

    // Transparent sync: if a repo filter was given, decide cold vs warm.
    // - Cold (no rows locally): synchronous bootstrap pull so we can serve
    //   locally on this very call instead of falling back to REST.
    // - Warm: kick off background pull (server→local) AND background push
    //   (local edits→server) so the next call reflects both directions of
    //   drift without paying any latency now.
    if let Some(slug) = args.repo.clone() {
        let known_local = {
            let conn = local_db::open()?;
            match local_db::resolve_repo_by_slug(&conn, &slug)? {
                Some((repo_id, _)) => local_db::repo_has_symbols(&conn, &repo_id).unwrap_or(false),
                None => false,
            }
        };
        if known_local {
            sync::ensure_fresh_async(slug.clone(), server.clone(), key.clone());
            sync::incremental_push_async(slug, server.clone(), key.clone());
        } else if let Err(e) = sync::bootstrap_pull_blocking(&slug, &server, &key) {
            eprintln!("[code-search] bootstrap pull for {} failed: {}", slug, e);
        }
    }

    // Slice 3: try local FTS first. Fall back to REST when the local DB
    // can't serve (no rows for the requested filter).
    let conn = local_db::open()?;
    let local_hits = local_db::local_symbol_search(
        &conn,
        &args.query,
        args.repo.as_deref(),
        args.kind.as_deref(),
        args.limit,
    );
    let served_local = match local_hits {
        Ok(hits) if !hits.is_empty() => {
            // Slice 4: bump local savings + async push (REST cost ~ 600 tokens).
            // Server baseline for code_symbol_search is 800 tokens; local
            // response sits around 200, so net saving ≈ 600 per call.
            let _ = local_db::bump_local_savings(&conn, "code_symbol_search", 1, 600);
            sync::push_local_savings_async(server.clone(), key.clone());
            let payload = serde_json::json!({
                "source": "local",
                "results": hits,
                "served_from": local_db::db_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
            });
            println!("{}", serde_json::to_string(&payload)?);
            true
        }
        Ok(_) => false,
        Err(e) => {
            eprintln!("[code-search] local DB error ({}); falling back to REST", e);
            false
        }
    };

    if !served_local {
        let mut payload = serde_json::Map::new();
        payload.insert("query".into(), Value::String(args.query.clone()));
        payload.insert("limit".into(), Value::Number(args.limit.into()));
        if let Some(repo) = args.repo.clone() {
            payload.insert("repo".into(), Value::String(repo));
        }
        if let Some(kind) = args.kind.clone() {
            payload.insert("kind".into(), Value::String(kind));
        }
        let resp =
            post_json_simple(&server, "/api/code-symbol-search", &key, &Value::Object(payload))?;
        println!("{}", serde_json::to_string(&resp)?);
    }
    Ok(())
}

pub fn cmd_code_get(args: CodeGetArgs) -> Result<()> {
    if args.id.trim().is_empty() {
        anyhow::bail!("--id is required and cannot be empty");
    }
    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;

    // Local DB has metadata only — but the source tree lives on this machine
    // when the same machine ran the indexer. Try to slice the body locally
    // before falling back to REST: cheaper, and works even when the server
    // (e.g. a Docker MCP without the dev tree mounted) returns the
    // "<repo path not registered on this machine>" stub for the body.
    let conn = local_db::open()?;
    if let Ok(Some(hit)) = local_db::local_symbol_get(&conn, &args.id) {
        if args.max_body_lines == 0 {
            // Baseline 4000; metadata-only local response ≈ 200 tokens.
            let _ = local_db::bump_local_savings(&conn, "code_symbol_get", 1, 3800);
            sync::push_local_savings_async(server.clone(), key.clone());
            sync::ensure_fresh_async(hit.repo.clone(), server.clone(), key.clone());
            sync::incremental_push_async(hit.repo.clone(), server.clone(), key.clone());
            let payload = serde_json::json!({ "source": "local", "result": hit });
            println!("{}", serde_json::to_string(&payload)?);
            return Ok(());
        }
        if let Some(body) = read_local_body(&hit, args.max_body_lines) {
            // Baseline 4000; metadata + sliced body served entirely locally.
            let _ = local_db::bump_local_savings(&conn, "code_symbol_get", 1, 3800);
            sync::push_local_savings_async(server.clone(), key.clone());
            sync::ensure_fresh_async(hit.repo.clone(), server.clone(), key.clone());
            sync::incremental_push_async(hit.repo.clone(), server.clone(), key.clone());
            let payload = serde_json::json!({
                "source": "local",
                "result": {
                    "id": hit.id,
                    "repo": hit.repo,
                    "relative_path": hit.relative_path,
                    "name": hit.name,
                    "kind": hit.kind,
                    "qualified_name": hit.qualified_name,
                    "signature": hit.signature,
                    "docstring": hit.docstring,
                    "start_line": hit.start_line,
                    "end_line": hit.end_line,
                    "body": body,
                },
            });
            println!("{}", serde_json::to_string(&payload)?);
            return Ok(());
        }
        // Couldn't read locally (no abs_path cached, file missing, etc.) —
        // background-refresh the snapshot and fall through to REST.
        sync::ensure_fresh_async(hit.repo.clone(), server.clone(), key.clone());
        sync::incremental_push_async(hit.repo.clone(), server.clone(), key.clone());
    }

    let payload = serde_json::json!({
        "id": args.id,
        "max_body_lines": args.max_body_lines,
    });
    let resp = post_json_simple(&server, "/api/code-symbol-get", &key, &payload)?;
    // Print the REST result first so the user-visible latency stays
    // unchanged. The synchronous sync work below is the convergence step
    // for the *next* call (local DB seeded with this repo's snapshot).
    println!("{}", serde_json::to_string(&resp)?);
    if let Some(repo) = resp.get("repo").and_then(|v| v.as_str()) {
        let slug = repo.to_string();
        let known_local = {
            let conn = local_db::open()?;
            local_db::resolve_repo_by_slug(&conn, &slug)
                .ok()
                .and_then(|opt| opt.map(|(rid, _)| local_db::repo_has_symbols(&conn, &rid).unwrap_or(false)))
                .unwrap_or(false)
        };
        if known_local {
            sync::ensure_fresh_blocking_throttled_logged(
                &slug,
                &server,
                &key,
                sync::ENSURE_FRESH_MAX_AGE_SECS,
            );
            sync::incremental_push_blocking_logged(&slug, &server, &key);
        } else if let Err(e) = sync::bootstrap_pull_blocking(&slug, &server, &key) {
            eprintln!("[code-get] bootstrap pull for {} failed: {}", slug, e);
        }
    }
    Ok(())
}

/// Slice `[start_line, end_line]` (1-indexed, inclusive) from
/// `<abs_path>/<relative_path>` and return up to `max_body_lines` lines.
/// Returns `None` when the abs_path isn't cached, the file isn't readable,
/// or the line range falls outside the file.
fn read_local_body(hit: &local_db::LocalSymbolHit, max_body_lines: u32) -> Option<String> {
    let abs = rewrite::lookup_repo_abs_path(&hit.repo)?;
    let full = abs.join(&hit.relative_path);
    let text = std::fs::read_to_string(&full).ok()?;
    let start = hit.start_line.max(1) as usize;
    let end = hit.end_line.max(hit.start_line) as usize;
    let cap = max_body_lines as usize;
    let mut out = String::new();
    let mut emitted = 0usize;
    for (i, line) in text.lines().enumerate() {
        let ln = i + 1;
        if ln < start {
            continue;
        }
        if ln > end || emitted >= cap {
            break;
        }
        if emitted > 0 {
            out.push('\n');
        }
        out.push_str(line);
        emitted += 1;
    }
    if emitted == 0 {
        return None;
    }
    Some(out)
}

pub fn cmd_code_impact(args: CodeImpactArgs) -> Result<()> {
    if args.id.trim().is_empty() {
        anyhow::bail!("--id is required and cannot be empty");
    }
    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;

    let conn = local_db::open()?;
    let local_hits = local_db::local_change_impact(&conn, &args.id, args.depth, args.limit);
    let served_local = match local_hits {
        Ok(hits) if !hits.is_empty() => {
            // Baseline 15000; local response a few hundred tokens.
            let _ = local_db::bump_local_savings(&conn, "code_change_impact", 1, 14000);
            sync::push_local_savings_async(server.clone(), key.clone());
            // Refresh whichever repo the root symbol lives in.
            if let Some(slug) = local_db::local_symbol_get(&conn, &args.id)
                .ok()
                .flatten()
                .map(|h| h.repo)
            {
                sync::ensure_fresh_async(slug.clone(), server.clone(), key.clone());
                sync::incremental_push_async(slug, server.clone(), key.clone());
            }
            let payload = serde_json::json!({
                "source": "local",
                "results": hits,
            });
            println!("{}", serde_json::to_string(&payload)?);
            true
        }
        Ok(_) => false,
        Err(e) => {
            eprintln!("[code-impact] local DB error ({}); falling back to REST", e);
            false
        }
    };

    if !served_local {
        let payload = serde_json::json!({
            "id": args.id,
            "depth": args.depth,
            "limit": args.limit,
        });
        let resp = post_json_simple(&server, "/api/code-change-impact", &key, &payload)?;
        println!("{}", serde_json::to_string(&resp)?);
    }
    Ok(())
}

pub fn cmd_code_outline(args: CodeOutlineArgs) -> Result<()> {
    if args.repo.trim().is_empty() {
        anyhow::bail!("--repo is required and cannot be empty");
    }
    if args.path.trim().is_empty() {
        anyhow::bail!("--path is required and cannot be empty");
    }
    let (server, key, _source) =
        resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    let payload = serde_json::json!({
        "repo": args.repo,
        "path": args.path,
    });
    let resp = post_json_simple(&server, "/api/code-file-outline", &key, &payload)?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

pub fn cmd_code_find_duplicates(args: CodeFindDuplicatesArgs) -> Result<()> {
    if args.repo.trim().is_empty() {
        anyhow::bail!("--repo is required and cannot be empty");
    }
    let mode = args.mode.trim().to_ascii_lowercase();
    if mode != "body" && mode != "signature" && mode != "exact" && mode != "structural" {
        anyhow::bail!(
            "--mode must be 'body', 'signature', 'exact', or 'structural' (got '{}')",
            args.mode,
        );
    }
    let (server, key, _source) =
        resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    let payload = serde_json::json!({
        "repo": args.repo,
        "mode": mode,
        "limit": args.limit,
    });
    let resp = post_or_mcp_fallback(
        &server,
        &key,
        "/api/code-find-semantic-duplicates",
        "code_find_semantic_duplicates",
        &payload,
    )?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

pub fn cmd_code_chain(args: CodeChainArgs) -> Result<()> {
    if args.source.trim().is_empty() {
        anyhow::bail!("--from is required and cannot be empty");
    }
    if args.target.trim().is_empty() {
        anyhow::bail!("--to is required and cannot be empty");
    }
    let (server, key, _source) =
        resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;
    let payload = serde_json::json!({
        "source": args.source,
        "target": args.target,
        "max_depth": args.max_depth,
    });
    let resp = post_or_mcp_fallback(
        &server,
        &key,
        "/api/code-call-chain",
        "code_call_chain",
        &payload,
    )?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

/// Try a `/api/code-*` REST endpoint first; on HTTP 404 fall back to a raw
/// MCP `tools/call`, unwrapping the `{content:[{type:"text", text}]}` envelope
/// so the user-visible shape matches the REST path either way. Used by code-*
/// passthrough subcommands when a deployed server may pre-date the REST shim.
fn post_or_mcp_fallback(
    server: &str,
    key: &str,
    rest_path: &str,
    mcp_tool: &str,
    payload: &Value,
) -> Result<Value> {
    match post_json_simple(server, rest_path, key, payload) {
        Ok(v) => Ok(v),
        Err(e) if is_http_404(&e) => {
            let (session_id, _) = mcp::initialize(server, key)?;
            let raw = mcp::tools_call(server, key, &session_id, mcp_tool, payload)?;
            Ok(unwrap_mcp_text_content(raw))
        }
        Err(e) => Err(e),
    }
}

fn is_http_404(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|e| {
            let s = e.to_string();
            s.contains("http status: 404") || s.contains("returned 404")
        })
}

/// Unwrap MCP's `{content:[{type:"text", text:"<json>"}]}` envelope into the
/// inner JSON value. Returns the raw response unchanged if the shape doesn't
/// match (so callers still see a usable payload).
fn unwrap_mcp_text_content(raw: Value) -> Value {
    let text = raw
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        });
    match text {
        Some(t) => serde_json::from_str::<Value>(t).unwrap_or(raw),
        None => raw,
    }
}

// ── bench (single-binary, no Node) ─────────────────────────────────────────

pub fn cmd_bench(args: BenchArgs) -> Result<()> {
    use std::process::Command as ProcessCommand;
    use std::time::Instant;

    let (server, key, _source) = resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;

    // 1. Resolve the local checkout path. Either user-supplied --repo-path,
    //    or a fresh shallow clone into $TEMP/cortexmd-bench/<basename>.
    let repo_path: PathBuf = if let Some(p) = args.repo_path.clone() {
        p.canonicalize()
            .with_context(|| format!("path does not exist: {}", p.display()))?
    } else if let Some(url) = args.clone_url.clone() {
        let basename = url
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("repo")
            .trim_end_matches(".git")
            .to_string();
        let temp_root = std::env::var_os("TEMP")
            .or_else(|| std::env::var_os("TMPDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        let dest = temp_root.join("cortexmd-bench").join(&basename);
        if !dest.exists() {
            std::fs::create_dir_all(dest.parent().unwrap())
                .with_context(|| format!("create {}", dest.parent().unwrap().display()))?;
            eprintln!("[bench] cloning {} (shallow) → {}", url, dest.display());
            let st = ProcessCommand::new("git")
                .args(["clone", "--depth=1", "--single-branch", &url])
                .arg(&dest)
                .status()
                .context("spawn git clone")?;
            if !st.success() {
                anyhow::bail!("git clone failed (status {:?})", st.code());
            }
        } else {
            eprintln!("[bench] reusing existing clone at {}", dest.display());
        }
        dest.canonicalize()
            .with_context(|| format!("canonicalize clone path {}", dest.display()))?
    } else {
        anyhow::bail!("either --repo-path or --clone-url is required");
    };

    let slug = args
        .repo_slug
        .clone()
        .unwrap_or_else(|| {
            repo_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string()
        });

    // 2. Time cold + warm indexing by re-spawning ourselves with the bare
    //    positional repo path (which falls through to run_index in main.rs).
    //    Using current_exe() rather than the PATH-resolved binary so a fresh
    //    `cargo build` is benched without `cargo install`.
    let mut cold_seconds: f64 = 0.0;
    let mut warm_seconds: f64 = 0.0;
    if !args.skip_index {
        let exe = std::env::current_exe().context("locate current executable")?;

        eprintln!("[bench] {}: cold-indexing ...", slug);
        let t = Instant::now();
        let st = ProcessCommand::new(&exe)
            .arg(&repo_path)
            .status()
            .context("spawn cold index")?;
        cold_seconds = t.elapsed().as_secs_f64();
        if !st.success() {
            anyhow::bail!("cold index exited {:?}", st.code());
        }
        eprintln!("[bench] {} cold index: {:.3} s", slug, cold_seconds);

        eprintln!("[bench] {}: warm-indexing ...", slug);
        let t = Instant::now();
        let st = ProcessCommand::new(&exe)
            .arg(&repo_path)
            .status()
            .context("spawn warm index")?;
        warm_seconds = t.elapsed().as_secs_f64();
        if !st.success() {
            eprintln!(
                "[bench] warm index exited {:?} (continuing — may not affect query phase)",
                st.code()
            );
        }
        eprintln!("[bench] {} warm index: {:.3} s", slug, warm_seconds);
    }

    // 3. Probe + sample symbols. Reuse post_json_simple in-process — no Node,
    //    no per-query subprocess.
    let mut sampled: usize = 0;
    let mut search_samples: Vec<f64> = Vec::new();
    let mut get_samples: Vec<f64> = Vec::new();
    let mut impact_samples: Vec<f64> = Vec::new();

    let mut error_msg: Option<String> = None;

    if !args.skip_query {
        let probe_payload = serde_json::json!({
            "query": "a",
            "repo": slug,
            "limit": 100,
        });
        let probe = post_json_simple(&server, "/api/code-symbol-search", &key, &probe_payload);
        match probe {
            Ok(v) => {
                let candidates: Vec<&Value> = v
                    .get("results")
                    .and_then(|r| r.as_array())
                    .map(|a| a.iter().collect())
                    .unwrap_or_default();
                eprintln!(
                    "[bench] {}: {} symbols available for sampling",
                    slug,
                    candidates.len()
                );

                if candidates.is_empty() {
                    eprintln!("[bench] no symbols indexed under repo \"{}\"", slug);
                } else {
                    let n = (args.samples as usize).min(candidates.len());
                    let sample: Vec<&Value> = deterministic_sample(&candidates, n, args.seed);
                    sampled = sample.len();

                    // 3a. Search by name.
                    for s in &sample {
                        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let p = serde_json::json!({
                            "query": name,
                            "repo": slug,
                            "limit": 10,
                        });
                        let t = Instant::now();
                        let _ = post_json_simple(&server, "/api/code-symbol-search", &key, &p)?;
                        search_samples.push(t.elapsed().as_secs_f64() * 1000.0);
                    }

                    // 3b. Get by id.
                    for s in &sample {
                        let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let p = serde_json::json!({ "id": id, "max_body_lines": 200 });
                        let t = Instant::now();
                        let _ = post_json_simple(&server, "/api/code-symbol-get", &key, &p)?;
                        get_samples.push(t.elapsed().as_secs_f64() * 1000.0);
                    }

                    // 3c. Change impact.
                    for s in &sample {
                        let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let p =
                            serde_json::json!({ "id": id, "depth": 3, "limit": 100 });
                        let t = Instant::now();
                        let _ = post_json_simple(&server, "/api/code-change-impact", &key, &p)?;
                        impact_samples.push(t.elapsed().as_secs_f64() * 1000.0);
                    }
                }
            }
            Err(e) => {
                eprintln!("[bench] query phase probe failed: {}", e);
                error_msg = Some(format!("{}", e));
            }
        }
    }

    let stats = |samples: &[f64]| -> (Option<f64>, Option<f64>) {
        if samples.is_empty() {
            return (None, None);
        }
        let mut sorted: Vec<f64> = samples.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let avg = sorted.iter().sum::<f64>() / (sorted.len() as f64);
        let p95_idx = ((sorted.len() as f64) * 0.95) as usize;
        let p95_idx = p95_idx.min(sorted.len() - 1);
        let p95 = sorted[p95_idx];
        (Some(avg), Some(p95))
    };

    let (search_avg, search_p95) = stats(&search_samples);
    let (get_avg, get_p95) = stats(&get_samples);
    let (impact_avg, impact_p95) = stats(&impact_samples);

    let result = serde_json::json!({
        "schema_version": 1,
        "bench": "cortexmd bench (single-binary, no Node)",
        "repo": { "slug": slug, "path": repo_path.display().to_string() },
        "cold_index_seconds": round3(cold_seconds),
        "warm_index_seconds": round3(warm_seconds),
        "queries": {
            "sampled": sampled,
            "sample_seed": args.seed,
            "code_symbol_search": {
                "samples_ms": search_samples,
                "avg_ms": search_avg.map(round3),
                "p95_ms": search_p95.map(round3),
            },
            "code_symbol_get": {
                "samples_ms": get_samples,
                "avg_ms": get_avg.map(round3),
                "p95_ms": get_p95.map(round3),
            },
            "code_change_impact": {
                "samples_ms": impact_samples,
                "avg_ms": impact_avg.map(round3),
                "p95_ms": impact_p95.map(round3),
            },
            "error": error_msg,
        },
    });

    if args.format == "json" {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        let fmt_ms = |v: Option<f64>| -> String {
            v.map(|x| format!("{:.3} ms", x))
                .unwrap_or_else(|| "N/A".to_string())
        };
        println!(
            "# cortexmd bench\n\nRepo: `{}` @ `{}`\n\n## Indexing\n\n| Metric | Value |\n|---|---|\n| Cold index time | {:.3} s |\n| Warm index time | {:.3} s |\n\n## Query latency (in-process HTTP, no subprocess)\n\nSampled {} symbols (seed {}).\n\n| Tool | avg | p95 |\n|---|---|---|\n| `code_symbol_search` | {} | {} |\n| `code_symbol_get` | {} | {} |\n| `code_change_impact` | {} | {} |\n",
            slug,
            repo_path.display(),
            cold_seconds,
            warm_seconds,
            sampled,
            args.seed,
            fmt_ms(search_avg),
            fmt_ms(search_p95),
            fmt_ms(get_avg),
            fmt_ms(get_p95),
            fmt_ms(impact_avg),
            fmt_ms(impact_p95),
        );
        if let Some(e) = &error_msg {
            println!("\n> ⚠ query phase error: {}\n", e);
        }
    }

    Ok(())
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Deterministic random sampling without replacement (mulberry32 over the
/// candidate index space). Mirrors the JS bench harness's `mulberry32` helper
/// so seeds line up across the two implementations.
fn deterministic_sample<'a>(candidates: &'a [&'a Value], n: usize, seed: u64) -> Vec<&'a Value> {
    let mut a: u32 = (seed & 0xffff_ffff) as u32;
    let mut next = || -> u32 {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    };

    let len = candidates.len();
    let want = n.min(len);
    let mut chosen: Vec<&Value> = Vec::with_capacity(want);
    let mut used = std::collections::HashSet::<usize>::new();
    while chosen.len() < want && used.len() < len {
        let r = next();
        let idx = (r as usize) % len;
        if used.insert(idx) {
            chosen.push(candidates[idx]);
        }
    }
    chosen
}

// ── gain ───────────────────────────────────────────────────────────────────

pub fn cmd_gain(args: GainArgs) -> Result<()> {
    let (server, key, session_id, _source) = open_session(None, None)?;
    let result = mcp::tools_call(
        &server,
        &key,
        &session_id,
        "code_nav_stats",
        &Value::Object(Default::default()),
    );
    match result {
        Ok(v) => {
            let payload = unwrap_tool_text(&v)
                .ok_or_else(|| anyhow!("code_nav_stats returned an unrecognized response shape"))?;
            print_savings_block(&payload, args.days);
            Ok(())
        }
        Err(e) if is_unknown_tool_error(&e) => {
            eprintln!(
                "Server doesn't expose code_nav_stats yet. Update cortexmd to a recent main, then `docker compose up --build -d`."
            );
            std::process::exit(2);
        }
        Err(e) => Err(e),
    }
}

// ── pull (sync from server) ────────────────────────────────────────────────

pub fn cmd_pull(args: PullArgs) -> Result<()> {
    if args.slug.is_none() && args.repo_id.is_none() {
        anyhow::bail!("provide --slug or --repo-id");
    }

    let (server, key, _source) =
        resolve_or_bail(args.server.as_deref(), args.api_key.as_deref())?;

    let mut tool_args = serde_json::Map::new();
    if let Some(s) = args.slug.as_deref() {
        tool_args.insert("slug".into(), Value::String(s.to_string()));
    }
    if let Some(r) = args.repo_id.as_deref() {
        tool_args.insert("repo_id".into(), Value::String(r.to_string()));
    }
    if let Some(since) = args.since {
        tool_args.insert("since_indexed_at".into(), Value::Number(since.into()));
    }

    let (session_id, _init_result) = mcp::initialize(&server, &key)?;
    let result = mcp::tools_call(
        &server,
        &key,
        &session_id,
        "code_sync_pull",
        &Value::Object(tool_args),
    )?;

    let payload_text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        })
        .ok_or_else(|| anyhow!("code_sync_pull returned no text content"))?;

    let parsed: Value = serde_json::from_str(&payload_text)
        .with_context(|| "code_sync_pull payload was not valid JSON")?;

    let resolved_slug = parsed
        .get("slug")
        .and_then(|v| v.as_str())
        .or(args.slug.as_deref())
        .unwrap_or("repo")
        .to_string();

    let out_path = match args.out {
        Some(p) => p,
        None => default_cache_path(&resolved_slug)?,
    };

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create parent dir {}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&parsed)
        .unwrap_or_else(|_| payload_text.clone());
    std::fs::write(&out_path, &pretty)
        .with_context(|| format!("write {}", out_path.display()))?;

    // Apply snapshot to local SQLite DB. full_replace is on iff `since` was
    // not used — a since-filtered pull is by definition a delta.
    let mut conn = local_db::open()?;
    let full_replace = args.since.is_none();
    let stats = local_db::apply_snapshot(&mut conn, &parsed, full_replace)?;

    let files_returned = parsed
        .get("meta")
        .and_then(|m| m.get("files_returned"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let files_total = parsed
        .get("meta")
        .and_then(|m| m.get("files_total"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    eprintln!(
        "[pull] repo={} files={}/{} db=+{} ~{} ={} -{} → {} (json: {})",
        resolved_slug,
        files_returned,
        files_total,
        stats.added,
        stats.updated,
        stats.unchanged,
        stats.removed,
        local_db::db_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<no data dir>".into()),
        out_path.display()
    );

    if args.print {
        println!("{}", pretty);
    }
    Ok(())
}

fn default_cache_path(slug: &str) -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve a config dir for the cache output"))?;
    crate::auth::migrate_legacy_app_dir(&base);
    Ok(base
        .join(crate::auth::APP_DIR)
        .join("cache")
        .join(format!("{}.json", slug)))
}
