//! Bash-command rewrite engine — token-savior parity with rtk's `rtk rewrite`.
//!
//! Reads a shell command on stdin or argv, classifies each operator-split
//! segment against a small pattern registry, and emits the rewritten command
//! when a code-nav equivalent exists. Modeled on `rtk/src/discover/registry.rs`
//! but specialized for code-nav rather than output filtering.
//!
//! # Exit-code contract (matches rtk-rewrite.sh)
//!
//! | Code | Stdout | Meaning                                              |
//! |------|--------|------------------------------------------------------|
//! | 0    | Cmd    | Rewrite found, no permission rule → auto-allow      |
//! | 1    | (none) | No equivalent — pass through unchanged              |
//! | 2    | (none) | Deny rule matched — pass through (native deny wins) |
//! | 3    | Cmd    | Ask rule — rewrite but let agent prompt user        |
//!
//! # First-cut rule set
//!
//! All rules are gated on the target path being inside a registered repo on
//! THIS machine. Repo paths come from a 60-second-TTL JSON cache of
//! `/api/code-repo-list` at `${config_dir}/cortexmd/repo-paths.json`.
//!
//! - `cat | head | tail | bat <file>` on indexed source → `cortexmd
//!   code-outline --repo SLUG --path PATH`
//! - `grep | rg <pattern> [<path>]` (cwd or arg path inside indexed repo,
//!   pattern looks like a symbol — alphanumeric + underscore, ≥3 chars) →
//!   `cortexmd code-search --query PATTERN --repo SLUG`
//!
//! # Compound commands
//!
//! Splits on `&&`, `||`, `;`, `|`. Each segment is rewritten independently
//! EXCEPT the right side of a pipe (the consumer of the previous segment's
//! output — its input format must remain raw). This mirrors rtk's behavior.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::auth;
use crate::cli::RewriteArgs;

const REPO_PATHS_CACHE_TTL: Duration = Duration::from_secs(60);
const REPO_PATHS_CACHE_FILE: &str = "repo-paths.json";

const SOURCE_EXTS: &[&str] = &[
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".cpp",
    ".cc", ".cxx", ".c++", ".hpp", ".hxx", ".h++", ".h", ".c",
    ".java", ".kt", ".kts", ".rb", ".php", ".dart",
];

const REWRITE_BIN: &str = "cortexmd";

/// Cached subset of `/api/code-repo-list` — just what we need for path lookup.
#[derive(Debug, Serialize, Deserialize)]
struct RepoPathsCache {
    cached_at: u64,
    repos: Vec<CachedRepo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CachedRepo {
    slug: String,
    paths: Vec<CachedRepoPath>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CachedRepoPath {
    abs_path: String,
}

/// Public entrypoint — wired into clap via main.rs.
pub fn cmd_rewrite(args: RewriteArgs) -> Result<()> {
    if args.hook {
        // Hook mode: parse Claude PreToolUse event, dispatch, emit JSON. All
        // errors silently exit 0 with no output so the hook never blocks.
        let _ = run_as_hook(args.explain);
        return Ok(());
    }

    let cmd_input = read_command(&args)?;
    let outcome = compute_rewrite(&cmd_input, args.explain);
    match outcome {
        RewriteOutcome::Rewrite(s) => {
            println!("{}", s);
            std::process::exit(0);
        }
        RewriteOutcome::Ask(s) => {
            println!("{}", s);
            std::process::exit(3);
        }
        RewriteOutcome::Deny => std::process::exit(2),
        RewriteOutcome::None => std::process::exit(1),
    }
}

#[derive(Debug)]
enum RewriteOutcome {
    Rewrite(String),
    #[allow(dead_code)]
    Ask(String),
    #[allow(dead_code)]
    Deny,
    None,
}

/// Core rewrite logic, factored out so `cmd_rewrite` (CLI) and `run_as_hook`
/// (Claude Code PreToolUse) can share it.
fn compute_rewrite(cmd_input: &str, explain: bool) -> RewriteOutcome {
    if cmd_input.trim().is_empty() {
        return RewriteOutcome::None;
    }
    // Already routed through us? Pass through (no rewrite-on-rewrite loop).
    if cmd_input.trim_start().starts_with(REWRITE_BIN) {
        return RewriteOutcome::None;
    }

    let repos = match load_repo_paths() {
        Ok(r) => r,
        Err(e) => {
            if explain {
                eprintln!("[cortexmd rewrite] repo list unavailable: {}", e);
            }
            return RewriteOutcome::None;
        }
    };

    let segments = split_on_operators(cmd_input);
    let mut out_segments: Vec<String> = Vec::with_capacity(segments.len());
    let mut any_rewrite = false;

    for (i, seg) in segments.iter().enumerate() {
        // Pipe consumer (right side of `|`) — never rewritten. Its input
        // format must remain raw for the consumer.
        let is_pipe_consumer = i > 0 && segments[i - 1].sep_after.as_deref() == Some("|");
        let body = seg.body.trim();
        let rewritten = if is_pipe_consumer {
            None
        } else {
            classify_and_rewrite(body, &repos, explain)
        };
        if let Some(new_body) = rewritten {
            any_rewrite = true;
            out_segments.push(new_body);
        } else {
            out_segments.push(seg.body.clone());
        }
    }

    if !any_rewrite {
        return RewriteOutcome::None;
    }

    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        out.push_str(out_segments[i].trim());
        if let Some(sep) = &seg.sep_after {
            out.push(' ');
            out.push_str(sep);
            out.push(' ');
        }
    }
    RewriteOutcome::Rewrite(out.trim().to_string())
}

/// Hook-mode: read PreToolUse JSON event from stdin, run rewrite, emit
/// Claude Code's `hookSpecificOutput` response. Always exits the process
/// with code 0 — a failing hook must NEVER block the agent's command.
fn run_as_hook(explain: bool) -> Result<()> {
    use std::io::Read;
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() {
        return Ok(());
    }
    let event: serde_json::Value = match serde_json::from_str(&buf) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let cmd = event
        .get("tool_input")
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if cmd.is_empty() {
        return Ok(());
    }
    let outcome = compute_rewrite(cmd, explain);
    let rewritten = match outcome {
        RewriteOutcome::Rewrite(s) => s,
        RewriteOutcome::Ask(s) => s,
        _ => return Ok(()),
    };
    if rewritten == cmd {
        return Ok(());
    }
    // Emit Claude's hookSpecificOutput.updatedInput response. The auto-allow
    // permissionDecision plus reason mirrors rtk's pattern.
    let response = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "cortexmd code-nav rewrite",
            "updatedInput": { "command": rewritten },
        }
    });
    println!("{}", serde_json::to_string(&response).unwrap_or_default());
    Ok(())
}

fn read_command(args: &RewriteArgs) -> Result<String> {
    if let Some(c) = &args.command {
        if c == "-" {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("read command from stdin")?;
            Ok(buf)
        } else {
            Ok(c.clone())
        }
    } else {
        // No positional arg → read from stdin.
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("read command from stdin")?;
        Ok(buf)
    }
}

#[derive(Debug)]
struct Segment {
    body: String,
    sep_after: Option<String>,
}

/// Split a shell command on top-level operators (`&&`, `||`, `;`, `|`),
/// quote-aware. Returns segments + the separator that followed each one
/// (None on the last segment). Does not handle subshells/heredocs.
fn split_on_operators(cmd: &str) -> Vec<Segment> {
    let mut segs: Vec<Segment> = Vec::new();
    let mut cur = String::new();
    let bytes = cmd.as_bytes();
    let mut i = 0;
    let mut quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];

        // Toggle quote state.
        if let Some(q) = quote {
            cur.push(b as char);
            if b == q && (i == 0 || bytes[i - 1] != b'\\') {
                quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'"' || b == b'\'' || b == b'`' {
            quote = Some(b);
            cur.push(b as char);
            i += 1;
            continue;
        }

        // Two-char operators: && ||
        if i + 1 < bytes.len() {
            let two = &bytes[i..i + 2];
            if two == b"&&" || two == b"||" {
                let sep = std::str::from_utf8(two).unwrap().to_string();
                segs.push(Segment {
                    body: std::mem::take(&mut cur),
                    sep_after: Some(sep),
                });
                i += 2;
                continue;
            }
        }
        // Single-char operators: ; |  (skip & for background — not interesting)
        if b == b';' || b == b'|' {
            let sep = (b as char).to_string();
            segs.push(Segment {
                body: std::mem::take(&mut cur),
                sep_after: Some(sep),
            });
            i += 1;
            continue;
        }

        cur.push(b as char);
        i += 1;
    }

    if !cur.is_empty() {
        segs.push(Segment {
            body: cur,
            sep_after: None,
        });
    }
    segs
}

/// Try to rewrite a single segment. Returns the rewritten command on hit.
fn classify_and_rewrite(
    seg: &str,
    repos: &[CachedRepo],
    explain: bool,
) -> Option<String> {
    let tokens = shell_tokenize(seg);
    if tokens.is_empty() {
        return None;
    }

    // Strip env-prefix (FOO=bar cmd ...) — TODO if needed; for now just check
    // leading non-assignment token.
    let first_real_idx = tokens.iter().position(|t| !is_env_assign(t))?;
    let rest = &tokens[first_real_idx..];
    let cmd0 = rest[0].as_str();

    let result = match cmd0 {
        "cat" | "bat" => rewrite_file_view(rest, repos),
        "head" | "tail" => rewrite_head_tail(rest, repos),
        "grep" | "rg" | "ag" | "ack" => rewrite_grep_like(rest, repos),
        _ => None,
    };

    if explain {
        match &result {
            Some(r) => eprintln!("[cortexmd rewrite] {} → {}", seg.trim(), r),
            None => eprintln!("[cortexmd rewrite] no rule for: {}", seg.trim()),
        }
    }
    result
}

fn is_env_assign(t: &str) -> bool {
    let bytes = t.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_uppercase() {
        return false;
    }
    let eq = match t.find('=') {
        Some(p) => p,
        None => return false,
    };
    bytes[..eq]
        .iter()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// Cheap shell tokenizer — splits on whitespace, respects quotes, strips them.
fn shell_tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == q && (i == 0 || bytes[i - 1] != b'\\') {
                quote = None;
            } else {
                cur.push(b as char);
            }
            i += 1;
            continue;
        }
        if b == b'"' || b == b'\'' {
            quote = Some(b);
            i += 1;
            continue;
        }
        if (b as char).is_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            i += 1;
            continue;
        }
        cur.push(b as char);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `cat foo.ts` → outline rewrite if `foo.ts` is in an indexed repo.
fn rewrite_file_view(rest: &[String], repos: &[CachedRepo]) -> Option<String> {
    // Skip flags like `-n` (cat) or `--paging=never` (bat) — first non-flag
    // token is the file.
    let file_arg = rest.iter().skip(1).find(|t| !t.starts_with('-'))?;
    let (slug, rel) = match_indexed_path(file_arg, repos)?;
    if !is_source_path(&rel) {
        return None;
    }
    Some(format!(
        "{} code-outline --repo {} --path {}",
        REWRITE_BIN,
        shell_escape(&slug),
        shell_escape(&rel),
    ))
}

/// `head -n 50 foo.ts` / `head foo.ts` / `tail -F foo.log` — we only rewrite
/// when the file is indexed source. The line-count flag is dropped (outline
/// returns symbols, not lines).
fn rewrite_head_tail(rest: &[String], repos: &[CachedRepo]) -> Option<String> {
    // Skip flags + their values where appropriate.
    let mut iter = rest.iter().skip(1).peekable();
    let mut file_arg: Option<&String> = None;
    while let Some(t) = iter.next() {
        // Two-token flags taking a value: -n N, --lines N
        if t == "-n" || t == "--lines" {
            iter.next();
            continue;
        }
        // --lines=N
        if t.starts_with("--") {
            continue;
        }
        // Other one-token short flags (-c, -F, -50 numeric, -n50 embedded).
        if t.starts_with('-') {
            continue;
        }
        file_arg = Some(t);
        break;
    }
    let file_arg = file_arg?;
    let (slug, rel) = match_indexed_path(file_arg, repos)?;
    if !is_source_path(&rel) {
        return None;
    }
    Some(format!(
        "{} code-outline --repo {} --path {}",
        REWRITE_BIN,
        shell_escape(&slug),
        shell_escape(&rel),
    ))
}

/// `grep PATTERN PATH` / `rg PATTERN PATH` — only rewrite when the pattern is
/// symbol-shaped (alnum + underscores, ≥3 chars) AND the path lives inside
/// an indexed repo. Regex-looking patterns and free-text searches are left
/// alone — `grep` stays right for those.
fn rewrite_grep_like(rest: &[String], repos: &[CachedRepo]) -> Option<String> {
    let mut pattern: Option<&str> = None;
    let mut path_arg: Option<&str> = None;

    let mut iter = rest.iter().skip(1).peekable();
    while let Some(t) = iter.next() {
        if t.starts_with('-') {
            // Skip flags. -e takes a value (the pattern).
            if t == "-e" || t == "--regexp" {
                if let Some(v) = iter.next() {
                    pattern = Some(v);
                }
                continue;
            }
            if t == "-t" || t == "--type" || t == "-g" || t == "--glob" {
                iter.next();
                continue;
            }
            // -A 5 / -B 5 / -C 5 numeric flags
            if matches!(t.as_str(), "-A" | "-B" | "-C") {
                iter.next();
                continue;
            }
            continue;
        }
        if pattern.is_none() {
            pattern = Some(t);
        } else if path_arg.is_none() {
            path_arg = Some(t);
        }
    }

    let pat = pattern?;
    let normalized_query = symbolish_or_alternation(pat)?;

    // If a path was given, it must be inside an indexed repo. Otherwise we
    // need the cwd to be inside one.
    let (slug, _) = match path_arg {
        Some(p) => match_indexed_path(p, repos)?,
        None => match_cwd_to_repo(repos)?,
    };

    Some(format!(
        "{} code-search --query {} --repo {}",
        REWRITE_BIN,
        shell_escape(&normalized_query),
        shell_escape(&slug),
    ))
}

/// Accept either a single symbol-shaped pattern OR a BRE alternation of them
/// (`foo\|bar\|baz`). Returns the FTS5 query to pass to `code-search` —
/// either the bare term or `term1 OR term2 OR …` (FTS5 default operator is
/// AND, so explicit `OR` is required).
fn symbolish_or_alternation(pat: &str) -> Option<String> {
    let trimmed = pat.trim_matches(|c: char| c == '"' || c == '\'');
    if is_symbolish(trimmed) {
        return Some(trimmed.to_string());
    }
    if trimmed.contains("\\|") {
        let terms: Vec<&str> = trimmed.split("\\|").map(str::trim).collect();
        if terms.len() >= 2 && terms.iter().all(|t| is_symbolish(t)) {
            return Some(terms.join(" OR "));
        }
    }
    None
}

/// True if the input looks like a symbol name candidate — alnum/underscore
/// only, ≥3 chars, no regex metacharacters.
fn is_symbolish(s: &str) -> bool {
    let s = s.trim_matches(|c: char| c == '"' || c == '\'');
    if s.len() < 3 || s.len() > 80 {
        return false;
    }
    s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

fn is_source_path(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    SOURCE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// Resolve a (possibly relative) path-like argument to (slug, repo-relative
/// posix path) IFF the absolute form is inside a registered repo's abs_path
/// on this machine.
fn match_indexed_path(
    arg: &str,
    repos: &[CachedRepo],
) -> Option<(String, String)> {
    let stripped = arg.trim_matches(|c: char| c == '"' || c == '\'');
    let cwd = std::env::current_dir().ok()?;
    let abs = if Path::new(stripped).is_absolute() {
        PathBuf::from(stripped)
    } else {
        cwd.join(stripped)
    };
    let canonical = abs
        .canonicalize()
        .unwrap_or(abs)
        .to_string_lossy()
        .to_string();
    let target = normalize_path(&canonical);

    let mut best: Option<(String, String, usize)> = None;
    for repo in repos {
        for rp in &repo.paths {
            let abs_norm = normalize_path(&rp.abs_path);
            if target == abs_norm || target.starts_with(&format!("{}/", abs_norm)) {
                let rel = if target == abs_norm {
                    String::new()
                } else {
                    target[abs_norm.len() + 1..].to_string()
                };
                if best.as_ref().map(|b| b.2).unwrap_or(0) < abs_norm.len() {
                    best = Some((repo.slug.clone(), rel, abs_norm.len()));
                }
            }
        }
    }
    best.map(|(slug, rel, _)| (slug, rel))
}

/// Try to find a repo whose abs_path contains the cwd. Returns (slug, "").
fn match_cwd_to_repo(repos: &[CachedRepo]) -> Option<(String, String)> {
    let cwd = std::env::current_dir().ok()?;
    let target = normalize_path(&cwd.to_string_lossy());
    let mut best: Option<(String, String, usize)> = None;
    for repo in repos {
        for rp in &repo.paths {
            let abs_norm = normalize_path(&rp.abs_path);
            if target == abs_norm || target.starts_with(&format!("{}/", abs_norm)) {
                if best.as_ref().map(|b| b.2).unwrap_or(0) < abs_norm.len() {
                    best = Some((repo.slug.clone(), String::new(), abs_norm.len()));
                }
            }
        }
    }
    best.map(|(slug, rel, _)| (slug, rel))
}

/// Lowercase + forward-slash + strip the Windows extended-length `\\?\` prefix.
fn normalize_path(p: &str) -> String {
    let s = p.trim();
    let stripped = s.strip_prefix("\\\\?\\").unwrap_or(s);
    stripped.replace('\\', "/").to_lowercase()
}

/// Quote a path/slug for safe inclusion in a shell command. Single-quote
/// everything except whitespace-free alphanumeric+`-/.`-only strings.
fn shell_escape(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '/')
    {
        return s.to_string();
    }
    // Use double quotes (Windows-friendlier than single quotes).
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Best-effort: resolve a repo slug to a local abs_path on this machine.
/// Hits the same 60s repo-paths cache the rewrite engine uses, so consecutive
/// callers (e.g. code-get falling back to a local body slice) share the
/// result. Returns the first cached abs_path that actually exists on disk —
/// the server may report multiple paths (one per machine), and only the
/// current host's entry is usable here. `None` when the cache is unreachable
/// or no path resolves locally.
pub fn lookup_repo_abs_path(slug: &str) -> Option<PathBuf> {
    let repos = load_repo_paths().ok()?;
    let repo = repos.iter().find(|r| r.slug == slug)?;
    for p in &repo.paths {
        let candidate = PathBuf::from(&p.abs_path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

// ── repo-paths cache ─────────────────────────────────────────────────────────

fn cache_path() -> Result<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| anyhow::anyhow!("no config dir"))?;
    crate::auth::migrate_legacy_app_dir(&base);
    let dir = base.join(crate::auth::APP_DIR);
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join(REPO_PATHS_CACHE_FILE))
}

fn load_repo_paths() -> Result<Vec<CachedRepo>> {
    let path = cache_path()?;
    if let Some(cache) = read_fresh_cache(&path) {
        return Ok(cache.repos);
    }
    // Cache stale or missing — refresh from server.
    let fresh = fetch_repo_paths_from_server()?;
    write_cache(&path, &fresh).ok();
    Ok(fresh)
}

fn read_fresh_cache(path: &Path) -> Option<RepoPathsCache> {
    let bytes = std::fs::read(path).ok()?;
    let cache: RepoPathsCache = serde_json::from_slice(&bytes).ok()?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();
    if now.saturating_sub(cache.cached_at) <= REPO_PATHS_CACHE_TTL.as_secs() {
        Some(cache)
    } else {
        None
    }
}

fn write_cache(path: &Path, repos: &[CachedRepo]) -> Result<()> {
    let cached_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_secs();
    let cache = RepoPathsCache {
        cached_at,
        repos: repos.to_vec(),
    };
    let bytes = serde_json::to_vec(&cache)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

fn fetch_repo_paths_from_server() -> Result<Vec<CachedRepo>> {
    let creds = auth::resolve_creds(None, None)?
        .ok_or_else(|| anyhow::anyhow!("no credentials configured"))?;
    let url = format!(
        "{}/api/code-repo-list",
        creds.server.trim_end_matches('/'),
    );
    let mut resp = ureq::post(&url)
        .header("Authorization", format!("Bearer {}", creds.api_key))
        .header("Content-Type", "application/json")
        .send("{}")
        .with_context(|| format!("POST {} failed", url))?;
    let status = resp.status();
    let text = resp
        .body_mut()
        .read_to_string()
        .with_context(|| format!("read body {}", url))?;
    if status.as_u16() >= 400 {
        anyhow::bail!("POST {} returned {}: {}", url, status, text);
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)?;
    let repos = parsed
        .get("repos")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("no `repos` field"))?;
    let mut out = Vec::with_capacity(repos.len());
    for r in repos {
        let slug = match r.get("slug").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mut paths = Vec::new();
        if let Some(arr) = r.get("paths").and_then(|v| v.as_array()) {
            for p in arr {
                if let Some(abs) = p.get("abs_path").and_then(|v| v.as_str()) {
                    paths.push(CachedRepoPath {
                        abs_path: abs.to_string(),
                    });
                }
            }
        }
        if !paths.is_empty() {
            out.push(CachedRepo { slug, paths });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Absolute fixture root that is valid on the host OS: `D:/...` is only an
    // absolute path on Windows (match_indexed_path joins cwd otherwise), so the
    // Unix variant uses a POSIX-absolute root. Keeps these unit tests honest on
    // the whole CI matrix.
    #[cfg(windows)]
    const BASE: &str = "D:/dev";
    #[cfg(not(windows))]
    const BASE: &str = "/dev";

    fn repos() -> Vec<CachedRepo> {
        vec![
            CachedRepo {
                slug: "demo".to_string(),
                paths: vec![CachedRepoPath {
                    abs_path: format!("{BASE}/demo"),
                }],
            },
        ]
    }

    #[test]
    fn split_simple() {
        let segs = split_on_operators("git status");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].body, "git status");
        assert!(segs[0].sep_after.is_none());
    }

    #[test]
    fn split_compound() {
        let segs = split_on_operators("cargo build && cargo test || echo bad");
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].sep_after.as_deref(), Some("&&"));
        assert_eq!(segs[1].sep_after.as_deref(), Some("||"));
        assert!(segs[2].sep_after.is_none());
    }

    #[test]
    fn split_pipe() {
        let segs = split_on_operators("grep foo bar.ts | wc -l");
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].sep_after.as_deref(), Some("|"));
    }

    #[test]
    fn split_respects_quotes() {
        let segs = split_on_operators(r#"echo "hello && world""#);
        assert_eq!(segs.len(), 1);
    }

    #[test]
    fn shell_tokenize_simple() {
        let toks = shell_tokenize("grep foo bar.ts");
        assert_eq!(toks, vec!["grep", "foo", "bar.ts"]);
    }

    #[test]
    fn shell_tokenize_quoted() {
        let toks = shell_tokenize(r#"grep "hello world" file.ts"#);
        assert_eq!(toks, vec!["grep", "hello world", "file.ts"]);
    }

    #[test]
    fn symbolish_accepts_identifiers() {
        assert!(is_symbolish("fooBarBaz"));
        assert!(is_symbolish("snake_case_123"));
    }

    #[test]
    fn symbolish_rejects_regex() {
        assert!(!is_symbolish("foo.*bar"));
        assert!(!is_symbolish("^Greeter"));
        assert!(!is_symbolish("[abc]"));
    }

    #[test]
    fn symbolish_rejects_too_short() {
        assert!(!is_symbolish("ab"));
        assert!(!is_symbolish(""));
    }

    #[test]
    fn rewrite_grep_with_indexed_path_matches() {
        let toks: Vec<String> =
            vec!["grep".into(), "fooBar".into(), format!("{BASE}/demo/src")];
        let r = rewrite_grep_like(&toks, &repos());
        assert!(r.is_some());
        let s = r.unwrap();
        assert!(s.contains("code-search"));
        assert!(s.contains("--query fooBar"));
        assert!(s.contains("--repo demo"));
    }

    #[test]
    fn rewrite_grep_regex_pattern_skipped() {
        let toks: Vec<String> =
            vec!["grep".into(), "foo.*".into(), format!("{BASE}/demo/src")];
        assert!(rewrite_grep_like(&toks, &repos()).is_none());
    }

    #[test]
    fn rewrite_grep_bre_alternation_emits_or_query() {
        let toks: Vec<String> = vec![
            "grep".into(),
            "speech\\|tts\\|speak".into(),
            format!("{BASE}/demo/src"),
        ];
        let r = rewrite_grep_like(&toks, &repos());
        assert!(r.is_some(), "alternation should rewrite");
        let s = r.unwrap();
        assert!(s.contains("code-search"));
        assert!(
            s.contains("speech OR tts OR speak"),
            "expected OR-joined query, got: {}",
            s
        );
    }

    #[test]
    fn rewrite_grep_alternation_with_regex_term_skipped() {
        // One alternation arm has a regex meta — whole thing must fall through.
        let toks: Vec<String> = vec![
            "grep".into(),
            "speech\\|foo.*".into(),
            format!("{BASE}/demo/src"),
        ];
        assert!(rewrite_grep_like(&toks, &repos()).is_none());
    }

    #[test]
    fn rewrite_grep_unindexed_path_skipped() {
        let toks: Vec<String> = vec![
            "grep".into(),
            "fooBar".into(),
            format!("{BASE}/somewhere-else"),
        ];
        assert!(rewrite_grep_like(&toks, &repos()).is_none());
    }

    #[test]
    fn rewrite_cat_indexed_source_matches() {
        let toks: Vec<String> = vec!["cat".into(), format!("{BASE}/demo/src/foo.ts")];
        let r = rewrite_file_view(&toks, &repos());
        assert!(r.is_some());
        assert!(r.unwrap().contains("code-outline"));
    }

    #[test]
    fn rewrite_cat_non_source_skipped() {
        let toks: Vec<String> = vec!["cat".into(), format!("{BASE}/demo/README.md")];
        assert!(rewrite_file_view(&toks, &repos()).is_none());
    }

    #[test]
    fn rewrite_head_with_n_flag_strips_it() {
        let toks: Vec<String> = vec![
            "head".into(),
            "-n".into(),
            "50".into(),
            format!("{BASE}/demo/src/foo.ts"),
        ];
        let r = rewrite_head_tail(&toks, &repos());
        assert!(r.is_some());
        assert!(r.unwrap().contains("code-outline"));
    }
}
