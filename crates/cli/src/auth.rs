//! Auth UX: per-user config persistence + Claude Code config auto-discovery.
//!
//! Resolution order (highest first; first non-empty wins):
//! 1. CLI flags (`--server`, `--api-key`)
//! 2. Env vars (`MCP_URL`, `MCP_API_KEY`) — handled at the clap layer
//! 3. OAuth token cache (`${config_dir}/cortexmd/oauth-tokens.json`)
//!    — preferred over static api_key when present.  Auto-refreshes if the
//!    server issued a refresh token; otherwise surfaces a clear "re-login"
//!    error when the cached access token has expired.
//! 4. Per-user config file at `${config_dir}/cortexmd/config.toml`
//! 5. Claude Code's MCP config (`~/.claude.json` or platform Desktop config)
//!
//! On Linux the config file is chmod'd 0600 after every write. On Windows the
//! permission tightening is skipped (no chmod equivalent without an ACL crate).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// On-disk schema for the per-user config file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthConfig {
    /// MCP server base URL (e.g. `https://mcp.example.com`).
    pub server: Option<String>,
    /// Bearer token. Never logged.
    pub api_key: Option<String>,
}

/// Resolved (server, api_key) pair returned by the resolution chain.
#[derive(Debug, Clone)]
pub struct ResolvedCreds {
    pub server: String,
    pub api_key: String,
    /// Where the credential pair came from (for `--verbose` / status output).
    pub source: CredsSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredsSource {
    CliOrEnv,
    OAuthCache,
    ConfigFile,
    ClaudeConfig,
}

impl CredsSource {
    pub fn label(&self) -> &'static str {
        match self {
            CredsSource::CliOrEnv => "cli/env",
            CredsSource::OAuthCache => "oauth-cache",
            CredsSource::ConfigFile => "config-file",
            CredsSource::ClaudeConfig => "claude-config",
        }
    }
}

/// Redacts an api key for display: `***1234` (last 4 chars), or `***` if too short.
pub fn redact_key(key: &str) -> String {
    let n = key.chars().count();
    if n <= 4 {
        "***".to_string()
    } else {
        let tail: String = key.chars().skip(n - 4).collect();
        format!("***{}", tail)
    }
}

/// Per-platform app dir name. Renamed to `cortexmd` for the OSS release; the
/// two pre-rename names are kept as fallbacks for one release so machines that
/// already have data under `obsidian-mcp-client`/`obsidian-mcp-indexer` keep
/// working (lazy migration on first use).
pub const APP_DIR: &str = "cortexmd";
const LEGACY_APP_DIRS: &[&str] = &["obsidian-mcp-client", "obsidian-mcp-indexer"];

/// Best-effort, idempotent migration: if a legacy dir exists and the new one
/// doesn't, rename the first match. Called by every dir-resolving helper so the
/// move happens lazily on first use after upgrading. fs::rename is atomic on the
/// same filesystem (Windows + POSIX).
pub fn migrate_legacy_app_dir(base: &std::path::Path) {
    let new_dir = base.join(APP_DIR);
    if new_dir.exists() {
        return;
    }
    for legacy in LEGACY_APP_DIRS {
        let old_dir = base.join(legacy);
        if !old_dir.exists() {
            continue;
        }
        match fs::rename(&old_dir, &new_dir) {
            Ok(_) => {
                eprintln!(
                    "[client] migrated legacy app dir: {} → {}",
                    old_dir.display(),
                    new_dir.display()
                );
            }
            Err(e) => {
                eprintln!(
                    "[client] WARN: legacy app dir at {} could not be auto-migrated: {} (please move it manually to {})",
                    old_dir.display(),
                    e,
                    new_dir.display()
                );
            }
        }
        return;
    }
}

/// Returns the full path to the per-user config file (does not check existence).
pub fn config_file_path() -> Result<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| {
        anyhow!("could not determine config_dir for this platform — set HOME or XDG_CONFIG_HOME")
    })?;
    migrate_legacy_app_dir(&base);
    Ok(base.join(APP_DIR).join("config.toml"))
}

/// Load the on-disk config. Returns `Ok(None)` if the file does not exist.
pub fn load_config() -> Result<Option<AuthConfig>> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let parsed: AuthConfig = toml::from_str(&text)
        .with_context(|| format!("failed to parse TOML at {}", path.display()))?;
    Ok(Some(parsed))
}

/// Atomic-ish write: write `.tmp` then rename. Sets 0600 on Linux/macOS.
pub fn save_config(cfg: &AuthConfig) -> Result<PathBuf> {
    let path = config_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let serialized = toml::to_string_pretty(cfg).context("serialize auth config")?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, serialized.as_bytes())
        .with_context(|| format!("failed to write {}", tmp.display()))?;
    // Best-effort tighten perms before rename (Linux/macOS only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&tmp, perms);
    }
    fs::rename(&tmp, &path)
        .with_context(|| format!("failed to rename {} → {}", tmp.display(), path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&path, perms);
    }
    Ok(path)
}

/// Delete the config file. Returns `Ok(false)` if it didn't exist.
pub fn delete_config() -> Result<(PathBuf, bool)> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok((path, false));
    }
    fs::remove_file(&path)
        .with_context(|| format!("failed to remove {}", path.display()))?;
    Ok((path, true))
}

/// Candidate Claude Code config file paths, in probe order.
pub fn claude_config_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".claude.json"));
    }
    // Desktop app locations (per platform).
    if cfg!(target_os = "windows") {
        if let Some(appdata) = dirs::config_dir() {
            // On Windows dirs::config_dir() == %APPDATA%
            out.push(appdata.join("Claude").join("claude_desktop_config.json"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = dirs::home_dir() {
            out.push(
                home.join("Library")
                    .join("Application Support")
                    .join("Claude")
                    .join("claude_desktop_config.json"),
            );
        }
    } else {
        // Linux / other unix
        if let Some(cfg) = dirs::config_dir() {
            out.push(cfg.join("Claude").join("claude_desktop_config.json"));
        }
    }
    out
}

/// Result of a Claude-config discovery probe.
#[derive(Debug, Clone)]
pub struct ClaudeDiscovery {
    pub source_path: PathBuf,
    pub server_name: String,
    pub server_url: String,
    pub api_key: String,
}

/// Find an HTTP MCP entry in Claude Code's config. If `name` is provided the
/// matching entry is returned; otherwise we require exactly one HTTP entry.
///
/// Returns `Ok(None)` when no candidate file exists. Returns `Err` when a file
/// exists but the desired entry can't be resolved (bad shape, no bearer, etc.).
pub fn auto_discover_from_claude(name: Option<&str>) -> Result<Option<ClaudeDiscovery>> {
    let candidates = claude_config_candidates();
    let mut found_path: Option<PathBuf> = None;
    for c in &candidates {
        if c.exists() {
            found_path = Some(c.clone());
            break;
        }
    }
    let path = match found_path {
        Some(p) => p,
        None => return Ok(None),
    };

    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let root: Value = serde_json::from_str(&text)
        .with_context(|| format!("failed to parse JSON at {}", path.display()))?;

    // Claude Code's `~/.claude.json` stores `mcpServers` either at the top
    // level (Desktop config) OR per-project under `projects.<path>.mcpServers`.
    // Walk both shapes and dedupe by entry name.
    let mut http_entries: Vec<(String, Value)> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    let collect_from_map = |map: &serde_json::Map<String, Value>,
                            out: &mut Vec<(String, Value)>,
                            seen: &mut std::collections::HashSet<String>| {
        for (k, v) in map {
            if !is_http_entry(v) {
                continue;
            }
            if seen.insert(k.clone()) {
                out.push((k.clone(), v.clone()));
            }
        }
    };

    if let Some(top) = root
        .get("mcpServers")
        .or_else(|| root.get("mcp_servers"))
        .and_then(|v| v.as_object())
    {
        collect_from_map(top, &mut http_entries, &mut seen_names);
    }
    if let Some(projects) = root.get("projects").and_then(|v| v.as_object()) {
        for (_proj_path, proj_val) in projects {
            if let Some(servers) = proj_val
                .get("mcpServers")
                .or_else(|| proj_val.get("mcp_servers"))
                .and_then(|v| v.as_object())
            {
                collect_from_map(servers, &mut http_entries, &mut seen_names);
            }
        }
    }

    if http_entries.is_empty() {
        anyhow::bail!(
            "{} contains no HTTP MCP entries (only stdio entries are present, or no `mcpServers` map at top level or under `projects.*`)",
            path.display()
        );
    }

    let (picked_name, picked_value) = if let Some(want) = name {
        http_entries
            .into_iter()
            .find(|(k, _)| k == want)
            .ok_or_else(|| {
                anyhow!(
                    "no HTTP MCP entry named `{}` in {}",
                    want,
                    path.display()
                )
            })?
    } else if http_entries.len() == 1 {
        http_entries.into_iter().next().unwrap()
    } else {
        let names: Vec<String> = http_entries.iter().map(|(k, _)| k.clone()).collect();
        anyhow::bail!(
            "multiple HTTP MCP servers configured in {} ({}). Pass --name <NAME> to pick one.",
            path.display(),
            names.join(", ")
        );
    };

    let url = picked_value
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            anyhow!(
                "MCP entry `{}` in {} has no `url` field",
                picked_name,
                path.display()
            )
        })?
        .to_string();

    let bearer = extract_bearer(&picked_value).ok_or_else(|| {
        anyhow!(
            "MCP entry `{}` (URL: {}) in {} has no `Authorization: Bearer …` header. \
             Claude Code may be storing the bearer in its OAuth token cache, which \
             this importer cannot read. Run `cortexmd auth login \
             --server {} --api-key <KEY>` to provide the key manually.",
            picked_name,
            url,
            path.display(),
            url
        )
    })?;

    Ok(Some(ClaudeDiscovery {
        source_path: path,
        server_name: picked_name,
        server_url: url,
        api_key: bearer,
    }))
}

fn is_http_entry(v: &Value) -> bool {
    let transport = v
        .get("type")
        .or_else(|| v.get("transport"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_ascii_lowercase());
    if let Some(t) = transport {
        if matches!(t.as_str(), "http" | "streamable-http" | "sse") {
            return true;
        }
    }
    // Fall back: presence of `url` implies HTTP-ish (stdio entries use `command`).
    v.get("url").and_then(|u| u.as_str()).is_some()
}

fn extract_bearer(v: &Value) -> Option<String> {
    let headers = v.get("headers").and_then(|h| h.as_object())?;
    // Header name lookup: case-insensitive on "authorization".
    for (name, val) in headers {
        if name.eq_ignore_ascii_case("Authorization") {
            let s = val.as_str()?;
            // Strip "Bearer " prefix, case-insensitive.
            if let Some(rest) = strip_prefix_ci(s, "Bearer ") {
                let token = rest.trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
        }
    }
    None
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() < prefix.len() {
        return None;
    }
    let (head, tail) = s.split_at(prefix.len());
    if head.eq_ignore_ascii_case(prefix) {
        Some(tail)
    } else {
        None
    }
}

/// Resolve credentials using the priority chain described at the top of the
/// module. `cli_server` / `cli_api_key` carry the merged CLI-or-env value
/// (clap with `env =` already merges those two layers for us).
pub fn resolve_creds(
    cli_server: Option<&str>,
    cli_api_key: Option<&str>,
) -> Result<Option<ResolvedCreds>> {
    let cli_server = cli_server.map(str::trim).filter(|s| !s.is_empty());
    let cli_api_key = cli_api_key.map(str::trim).filter(|s| !s.is_empty());

    // Layer 1+2 (clap merges them).
    if let (Some(s), Some(k)) = (cli_server, cli_api_key) {
        return Ok(Some(ResolvedCreds {
            server: s.to_string(),
            api_key: k.to_string(),
            source: CredsSource::CliOrEnv,
        }));
    }

    // Layer 3: OAuth token cache — preferred over static api_key when present.
    // `get_valid_access_token` refreshes if needed (server permitting); errors
    // here mean the cache exists but is unusable, in which case we surface
    // immediately rather than silently fall through to a stale api_key.
    match crate::oauth::get_valid_access_token(60) {
        Ok(Some((cache_server, token))) => {
            // CLI/env --server overrides the cached server (useful when the
            // user passes an explicit MCP endpoint URL like ".../mcp" while
            // the OAuth cache stores the bare base host).
            let server = cli_server.map(str::to_string).unwrap_or(cache_server);
            return Ok(Some(ResolvedCreds {
                server,
                api_key: token,
                source: CredsSource::OAuthCache,
            }));
        }
        Ok(None) => {
            // No OAuth cache file — fall through.
        }
        Err(e) => return Err(e),
    }

    // Layer 4: persisted config file.
    let from_file = load_config().ok().flatten();
    let file_server = from_file
        .as_ref()
        .and_then(|c| c.server.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let file_key = from_file
        .as_ref()
        .and_then(|c| c.api_key.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let server = cli_server.or(file_server);
    let key = cli_api_key.or(file_key);

    if let (Some(s), Some(k)) = (server, key) {
        // If both layers contributed (one CLI/env, one file) we still surface
        // ConfigFile as the source — it's the layer that actually filled the gap.
        let source = if cli_server.is_some() && cli_api_key.is_some() {
            CredsSource::CliOrEnv
        } else {
            CredsSource::ConfigFile
        };
        return Ok(Some(ResolvedCreds {
            server: s.to_string(),
            api_key: k.to_string(),
            source,
        }));
    }

    // Layer 5: Claude Code config (silent — no prompt). Suppress errors here:
    // partial / mis-shaped Claude config should not block fallback to a clear
    // "no creds found" message at the call site.
    if let Ok(Some(disc)) = auto_discover_from_claude(None) {
        let s = cli_server.unwrap_or(disc.server_url.as_str());
        let k = cli_api_key.unwrap_or(disc.api_key.as_str());
        return Ok(Some(ResolvedCreds {
            server: s.to_string(),
            api_key: k.to_string(),
            source: CredsSource::ClaudeConfig,
        }));
    }

    Ok(None)
}

/// Standard error message pointing the user at the bootstrap subcommands.
pub fn no_creds_message() -> String {
    "No credentials found. Run `cortexmd auth oauth-login --server URL` for the \
     zero-key OAuth flow (recommended), or `cortexmd auth login --server URL \
     --api-key KEY` to persist a static bearer, or `cortexmd auth \
     import-from-claude` to lift creds from Claude Code, or pass --server / --api-key \
     (or set $MCP_URL / $MCP_API_KEY)."
        .to_string()
}

// ---------------------------------------------------------------------------
// Side-effecting subcommand handlers (called from main.rs).
// ---------------------------------------------------------------------------

/// Read api key from stdin without echoing (rpassword). Falls back to plain
/// stdin readline with a warning if rpassword fails (e.g. non-tty).
pub fn prompt_api_key(prompt: &str) -> Result<String> {
    match rpassword::prompt_password(prompt) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) => {
            eprintln!("[client] WARN: secure prompt unavailable, reading plain stdin (input may be echoed).");
            use std::io::{BufRead, Write};
            let mut out = std::io::stderr();
            let _ = write!(out, "{}", prompt);
            let _ = out.flush();
            let stdin = std::io::stdin();
            let mut line = String::new();
            stdin.lock().read_line(&mut line)?;
            Ok(line.trim().to_string())
        }
    }
}

/// `auth login` handler.
pub fn cmd_login(server: &str, api_key: Option<String>) -> Result<()> {
    let server = server.trim().to_string();
    if server.is_empty() {
        anyhow::bail!("--server URL is required");
    }
    let api_key = match api_key {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => prompt_api_key("API key (input hidden): ")?,
    };
    if api_key.is_empty() {
        anyhow::bail!("api key cannot be empty");
    }
    let cfg = AuthConfig {
        server: Some(server.clone()),
        api_key: Some(api_key.clone()),
    };
    let path = save_config(&cfg)?;
    println!(
        "[client] wrote credentials to {} (api_key: {})",
        path.display(),
        redact_key(&api_key)
    );
    Ok(())
}

/// `auth status` handler — prints redacted summary, never the raw key.
pub fn cmd_status() -> Result<()> {
    // Surface OAuth cache presence first — it has highest priority in the chain.
    match crate::oauth::load_tokens() {
        Ok(Some(t)) => {
            let expiry = oauth_expiry_one_line(&t);
            println!(
                "[client] OAuth: token cache present (server `{}`, client_id `{}`, {})",
                t.server, t.client_id, expiry
            );
        }
        Ok(None) => {
            println!("[client] OAuth: no token cache (use `auth oauth-login --server URL`)");
        }
        Err(e) => {
            println!("[client] OAuth: token cache probe failed: {}", e);
        }
    }
    let path = config_file_path()?;
    println!("[client] config file: {}", path.display());
    match load_config()? {
        None => {
            println!("[client] no config file present");
            // Also surface what auto-discovery would pick.
            match auto_discover_from_claude(None) {
                Ok(Some(d)) => {
                    println!(
                        "[client] would auto-discover from {} (server `{}`: {} → {})",
                        d.source_path.display(),
                        d.server_name,
                        d.server_url,
                        redact_key(&d.api_key)
                    );
                }
                Ok(None) => println!("[client] no Claude Code config found either"),
                Err(e) => println!("[client] Claude Code config probe failed: {}", e),
            }
        }
        Some(cfg) => {
            println!(
                "[client] server : {}",
                cfg.server.as_deref().unwrap_or("(unset)")
            );
            println!(
                "[client] api_key: {}",
                cfg.api_key
                    .as_deref()
                    .map(redact_key)
                    .unwrap_or_else(|| "(unset)".to_string())
            );
        }
    }
    Ok(())
}

/// `auth logout` handler. Confirms unless `yes` is true.
pub fn cmd_logout(yes: bool) -> Result<()> {
    let path = config_file_path()?;
    if !path.exists() {
        println!("[client] no config file at {} (nothing to do)", path.display());
        return Ok(());
    }
    if !yes {
        eprint!("Delete {} ? [y/N] ", path.display());
        use std::io::{BufRead, Write};
        let _ = std::io::stderr().flush();
        let stdin = std::io::stdin();
        let mut line = String::new();
        stdin.lock().read_line(&mut line)?;
        if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("[client] aborted");
            return Ok(());
        }
    }
    let (path, removed) = delete_config()?;
    if removed {
        println!("[client] removed {}", path.display());
    }
    Ok(())
}

/// `auth import-from-claude` handler.
pub fn cmd_import_from_claude(name: Option<&str>, yes: bool) -> Result<()> {
    let disc = auto_discover_from_claude(name)?
        .ok_or_else(|| anyhow!("no Claude Code config found in any candidate path: {}",
            claude_config_candidates()
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")))?;
    println!("[client] picked entry `{}` from {}", disc.server_name, disc.source_path.display());
    println!("[client] server : {}", disc.server_url);
    println!("[client] api_key: {}", redact_key(&disc.api_key));
    if !yes {
        eprint!("Write to per-user config? [y/N] ");
        use std::io::{BufRead, Write};
        let _ = std::io::stderr().flush();
        let stdin = std::io::stdin();
        let mut line = String::new();
        stdin.lock().read_line(&mut line)?;
        if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("[client] aborted");
            return Ok(());
        }
    }
    let cfg = AuthConfig {
        server: Some(disc.server_url),
        api_key: Some(disc.api_key),
    };
    let written = save_config(&cfg)?;
    println!("[client] wrote credentials to {}", written.display());
    Ok(())
}

/// One-line OAuth token expiry summary, e.g. "expires in 29d 4h" or
/// "EXPIRED — re-run `auth oauth-login`". Reused by `auth status` and the
/// inspect module so the look stays consistent.
fn oauth_expiry_one_line(t: &crate::oauth::OAuthTokens) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if t.expires_at > now_ms {
        let secs = (t.expires_at - now_ms) / 1000;
        format!("expires in {}", humanize_secs_short(secs))
    } else {
        "EXPIRED — re-run `auth oauth-login`".to_string()
    }
}

fn humanize_secs_short(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m == 0 { format!("{}h", h) } else { format!("{}h {}m", h, m) }
    } else {
        let d = secs / 86_400;
        let h = (secs % 86_400) / 3600;
        if h == 0 { format!("{}d", d) } else { format!("{}d {}h", d, h) }
    }
}
