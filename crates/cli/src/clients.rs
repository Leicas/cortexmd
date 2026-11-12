//! MCP-server registration for agent clients (`cortexmd init`).
//!
//! Every function here is idempotent and non-destructive:
//! - an existing entry that already points at the same server (same base URL,
//!   or a `cortexmd mcp` stdio bridge) — under ANY name — is left alone, so a
//!   re-run never duplicates the tool list;
//! - an entry called `cortexmd` that points somewhere else is never
//!   overwritten (reported as a conflict with the command to fix it);
//! - files are backed up (`<file>.bak-cortexmd-<ts>`) and written via a
//!   temp file + rename; unrelated content (other servers, comments in TOML)
//!   is preserved.
//!
//! Claude Code: HTTP entry with `headersHelper = "cortexmd auth header"`, so
//! Claude Code reuses the CLI's token (OAuth refreshes included) instead of a
//! second OAuth round via `/mcp`. Registered with `claude mcp add-json …
//! --scope user` when the `claude` binary is on PATH, else written directly
//! to `~/.claude.json`.
//! Codex / Cursor / Gemini CLI: stdio entry `cortexmd mcp` (see bridge.rs) —
//! same token reuse, no client-side login.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Server name written into client configs.
pub const SERVER_NAME: &str = "cortexmd";
/// `headersHelper` command for Claude Code.
pub const HEADERS_HELPER: &str = "cortexmd auth header";
pub const MARK_START: &str = "<!-- cortexmd:start -->";
pub const MARK_END: &str = "<!-- cortexmd:end -->";

/// Codex `enabled_tools` default: the protocol set from the five rules.
/// Codex only calls tools listed in `tools/list` ∩ `enabled_tools`; the rest
/// stay reachable through `tool_search` + `tool_invoke` (servers that ship
/// the `tool_invoke` dispatcher).
pub const LEAN_TOOLS: &[&str] = &[
    "memory_wakeup", "memory_recall", "memory_store",
    "agent_diary_append", "agent_diary_read",
    "notes_search", "notes_get", "notes_upsert", "kg_query",
    "code_repo_list", "code_file_outline", "code_symbol_search", "code_symbol_get",
    "code_symbol_callers", "code_symbol_callees", "code_change_impact", "code_call_chain",
    "code_index_repo", "tool_search", "tool_invoke",
];

const AGENTS_TEMPLATE: &str = include_str!("../../../templates/codex/AGENTS.md");

/// Home directory used for client configs. `CORTEXMD_HOME` overrides it
/// (tests, sandboxes) — on Windows `dirs::home_dir()` ignores `%USERPROFILE%`.
pub fn home_dir() -> Result<PathBuf> {
    if let Ok(h) = std::env::var("CORTEXMD_HOME") {
        if !h.trim().is_empty() {
            return Ok(PathBuf::from(h.trim()));
        }
    }
    dirs::home_dir().context("could not determine HOME")
}

/// What happened for one client config.
#[derive(Debug, Default)]
pub struct Report {
    pub done: Vec<String>,
    pub warnings: Vec<String>,
    /// The one manual step left, if any.
    pub manual: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Added,
    /// Same server already registered under this name.
    Present(String),
    /// `cortexmd` exists but points elsewhere — untouched.
    Conflict(String),
}

// ── URL / entry matching ──────────────────────────────────────────────────

/// Comparable key for a server URL: lowercase, no trailing `/` or `/mcp`.
pub fn url_key(url: &str) -> String {
    crate::bridge::normalize_base(url).to_ascii_lowercase()
}

fn entry_url(v: &Value) -> Option<&str> {
    ["url", "httpUrl", "serverUrl"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|u| u.as_str()))
}

fn is_cortexmd_command(cmd: &str) -> bool {
    let base = cmd
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(cmd)
        .trim_matches('"')
        .to_ascii_lowercase();
    base == "cortexmd" || base == "cortexmd.exe"
}

/// Does this JSON MCP entry reach the cortexmd server at `base`?
pub fn json_entry_matches(v: &Value, base: Option<&str>) -> bool {
    if let (Some(u), Some(b)) = (entry_url(v), base) {
        if url_key(u) == url_key(b) {
            return true;
        }
    }
    let cmd = v.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let first_arg = v
        .get("args")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.as_str());
    is_cortexmd_command(cmd) && first_arg == Some("mcp")
}

/// Every `(scope, name)` in a JSON config whose entry reaches `base`:
/// top-level `mcpServers` and (Claude Code) `projects.<path>.mcpServers`.
pub fn find_json_matches(root: &Value, base: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut scan = |scope: &str, map: Option<&serde_json::Map<String, Value>>| {
        if let Some(m) = map {
            for (name, v) in m {
                if json_entry_matches(v, base) {
                    out.push((scope.to_string(), name.clone()));
                }
            }
        }
    };
    scan("user", root.get("mcpServers").and_then(|v| v.as_object()));
    if let Some(projects) = root.get("projects").and_then(|v| v.as_object()) {
        for (path, p) in projects {
            scan(&format!("project {}", path), p.get("mcpServers").and_then(|v| v.as_object()));
        }
    }
    out
}

/// Insert `entry` as `mcpServers.cortexmd` unless the same server is already
/// registered (any name, user scope) or the name is taken.
pub fn merge_json_server(root: &mut Value, entry: Value, base: Option<&str>) -> Outcome {
    if !root.is_object() {
        *root = json!({});
    }
    let servers = root
        .as_object_mut()
        .expect("object")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    let map = servers.as_object_mut().expect("object");
    if let Some((name, _)) = map.iter().find(|(_, v)| json_entry_matches(v, base)) {
        return Outcome::Present(name.clone());
    }
    if let Some(existing) = map.get(SERVER_NAME) {
        let what = entry_url(existing)
            .map(str::to_string)
            .or_else(|| existing.get("command").and_then(|c| c.as_str()).map(str::to_string))
            .unwrap_or_else(|| "another server".into());
        return Outcome::Conflict(what);
    }
    map.insert(SERVER_NAME.to_string(), entry);
    Outcome::Added
}

// ── file helpers ──────────────────────────────────────────────────────────

fn read_json(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).with_context(|| format!("parse JSON {}", path.display()))
}

fn backup(path: &Path) -> Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let b = path.with_file_name(format!("{}.bak-cortexmd-{}", name, crate::init::timestamp_tag()));
    fs::copy(path, &b).with_context(|| format!("backup {}", path.display()))?;
    Ok(Some(b))
}

/// Backup + temp-file write + rename.
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    backup(path)?;
    let tmp = path.with_extension("cortexmd-tmp");
    fs::write(&tmp, content).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("rename {} → {}", tmp.display(), path.display()))?;
    Ok(())
}

fn write_json(path: &Path, root: &Value) -> Result<()> {
    let mut s = serde_json::to_string_pretty(root).context("serialize JSON")?;
    s.push('\n');
    write_atomic(path, &s)
}

pub fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Run a command with a timeout; `Ok(true)` on exit 0.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(bool, String)> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let out = child.wait_with_output()?;
            let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if msg.is_empty() {
                msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
            }
            return Ok((status.success(), msg));
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Ok((false, "timed out".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ── Claude Code ───────────────────────────────────────────────────────────

pub fn claude_http_entry(base: &str) -> Value {
    json!({
        "type": "http",
        "url": format!("{}/mcp", crate::bridge::normalize_base(base)),
        "headersHelper": HEADERS_HELPER,
    })
}

/// Same-server registrations Claude Code would load twice: the plugin and
/// claude.ai connectors (only their names are stored locally, so this is a
/// name heuristic).
pub fn claude_duplicate_warnings(claude_json: &Value, user_settings: &Value) -> Vec<String> {
    let mut w = Vec::new();
    if let Some(p) = user_settings.get("enabledPlugins").and_then(|v| v.as_object()) {
        for (k, v) in p {
            if k.starts_with("cortexmd@") && v.as_bool() == Some(true) {
                w.push(format!(
                    "the `{}` plugin is enabled and registers the same server — every tool is listed twice. Keep one: `claude plugin disable {}` or remove the user entry.",
                    k, k
                ));
            }
        }
    }
    if let Some(list) = claude_json.get("claudeAiMcpEverConnected").and_then(|v| v.as_array()) {
        for n in list.iter().filter_map(|v| v.as_str()) {
            let l = n.to_ascii_lowercase();
            if l.contains("cortexmd") || l.contains("obsidian") || l.contains("brain") {
                w.push(format!(
                    "claude.ai connector `{}` looks like the same server — if it is, Claude Code lists every tool twice; disable it for Claude Code (/mcp) or skip registration with `--no-mcp`.",
                    n
                ));
            }
        }
    }
    w
}

/// Register cortexmd with Claude Code (user scope).
pub fn register_claude(home: &Path, base: &str, try_cli: bool) -> Result<Report> {
    let mut r = Report::default();
    let claude_json_path = home.join(".claude.json");
    let root = read_json(&claude_json_path).unwrap_or_else(|_| json!({}));
    let settings = read_json(&home.join(".claude").join("settings.json")).unwrap_or_else(|_| json!({}));
    r.warnings.extend(claude_duplicate_warnings(&root, &settings));

    let matches = find_json_matches(&root, Some(base));
    if matches.len() > 1 {
        r.warnings.push(format!(
            "the same server is registered {} times ({}) — tools may be listed twice; keep one.",
            matches.len(),
            matches.iter().map(|(s, n)| format!("`{}` [{}]", n, s)).collect::<Vec<_>>().join(", ")
        ));
    }
    if let Some((scope, name)) = matches.first() {
        r.done.push(format!("MCP server already registered in Claude Code as `{}` ({}) — left unchanged", name, scope));
        return Ok(r);
    }
    if let Some(existing) = root.pointer(&format!("/mcpServers/{}", SERVER_NAME)) {
        let what = entry_url(existing).unwrap_or("another server");
        r.warnings.push(format!("Claude Code already has `{}` → {} — left untouched.", SERVER_NAME, what));
        r.manual = Some(format!("`claude mcp remove {} -s user`, then re-run `cortexmd init -g`", SERVER_NAME));
        return Ok(r);
    }
    let entry = claude_http_entry(base);

    if try_cli {
        let bin = if cfg!(windows) { find_on_path(&["claude.exe"]) } else { find_on_path(&["claude"]) };
        if let Some(bin) = bin {
            let mut cmd = Command::new(&bin);
            cmd.args(["mcp", "add-json", SERVER_NAME, &entry.to_string(), "--scope", "user"]);
            match run_with_timeout(cmd, Duration::from_secs(30)) {
                Ok((true, _)) => {
                    r.done.push(format!(
                        "registered MCP server `{}` → {} (user scope, `claude mcp add-json`; auth via `{}`)",
                        SERVER_NAME, entry["url"].as_str().unwrap_or(""), HEADERS_HELPER
                    ));
                    return Ok(r);
                }
                Ok((false, msg)) if msg.to_ascii_lowercase().contains("already exists") => {
                    r.warnings.push(format!(
                        "Claude Code already has a server named `{}` (another scope) — left untouched.",
                        SERVER_NAME
                    ));
                    r.manual = Some(format!("`claude mcp remove {}`, then re-run `cortexmd init -g`", SERVER_NAME));
                    return Ok(r);
                }
                Ok((false, msg)) => r.warnings.push(format!(
                    "`claude mcp add-json` failed ({}); writing {} directly",
                    msg.lines().next().unwrap_or(""),
                    claude_json_path.display()
                )),
                Err(e) => r.warnings.push(format!("could not run `claude` ({}); writing {} directly", e, claude_json_path.display())),
            }
        }
    }

    let mut root = root;
    match merge_json_server(&mut root, entry.clone(), Some(base)) {
        Outcome::Added => {
            write_json(&claude_json_path, &root)?;
            r.done.push(format!(
                "registered MCP server `{}` → {} in {} (user scope; auth via `{}`)",
                SERVER_NAME,
                entry["url"].as_str().unwrap_or(""),
                claude_json_path.display(),
                HEADERS_HELPER
            ));
        }
        Outcome::Present(n) => r.done.push(format!("MCP server already registered as `{}` — left unchanged", n)),
        Outcome::Conflict(what) => {
            r.warnings.push(format!(
                "Claude Code already has `{}` → {} — left untouched.",
                SERVER_NAME, what
            ));
            r.manual = Some(format!("`claude mcp remove {} -s user`, then re-run `cortexmd init -g`", SERVER_NAME));
        }
    }
    Ok(r)
}

// ── stdio clients (Cursor, Gemini CLI) ────────────────────────────────────

pub fn stdio_entry() -> Value {
    json!({ "command": "cortexmd", "args": ["mcp"] })
}

/// Merge the stdio bridge entry into a JSON config with a top-level
/// `mcpServers` map (`~/.cursor/mcp.json`, `~/.gemini/settings.json`).
pub fn register_json_stdio(path: &Path, base: Option<&str>, label: &str) -> Result<Report> {
    let mut r = Report::default();
    let mut root = read_json(path)?;
    let others: Vec<(String, String)> = find_json_matches(&root, base);
    match merge_json_server(&mut root, stdio_entry(), base) {
        Outcome::Added => {
            write_json(path, &root)?;
            r.done.push(format!("registered MCP server `{}` (stdio: `cortexmd mcp`) in {}", SERVER_NAME, path.display()));
        }
        Outcome::Present(n) => {
            r.done.push(format!("{}: MCP server already registered as `{}` in {} — left unchanged", label, n, path.display()));
            if others.len() > 1 {
                r.warnings.push(format!("{} registers the same server {} times — tools may be listed twice", path.display(), others.len()));
            }
        }
        Outcome::Conflict(what) => {
            r.warnings.push(format!("{} already has `{}` → {} — left untouched", path.display(), SERVER_NAME, what));
            r.manual = Some(format!("remove `mcpServers.{}` from {} and re-run", SERVER_NAME, path.display()));
        }
    }
    Ok(r)
}

// ── instruction blocks (AGENTS.md / GEMINI.md) ────────────────────────────

/// The cortexmd block (markers included) from the Codex AGENTS.md template,
/// with `<hostname>` resolved and the client label swapped in.
pub fn instruction_block(client: &str, source: &str, host: &str) -> String {
    let start = AGENTS_TEMPLATE.find(MARK_START).unwrap_or(0);
    let end = AGENTS_TEMPLATE
        .find(MARK_END)
        .map(|i| i + MARK_END.len())
        .unwrap_or(AGENTS_TEMPLATE.len());
    let host = if host.is_empty() { "<hostname>" } else { host };
    AGENTS_TEMPLATE[start..end]
        .replace("Codex (<hostname>)", &format!("{} ({})", client, host))
        .replace("machine=<hostname>", &format!("machine={}", host))
        .replace("source=\"codex\"", &format!("source=\"{}\"", source))
        .replace("<hostname>", host)
}

/// Replace the marked block in `existing`, or append it. Idempotent.
pub fn upsert_marked_block(existing: &str, block: &str) -> String {
    if let (Some(s), Some(e)) = (existing.find(MARK_START), existing.find(MARK_END)) {
        if e > s {
            let mut out = String::with_capacity(existing.len() + block.len());
            out.push_str(&existing[..s]);
            out.push_str(block);
            out.push_str(&existing[e + MARK_END.len()..]);
            return out;
        }
    }
    let mut out = existing.to_string();
    if !out.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out.push_str(block);
    out.push('\n');
    out
}

/// Write/refresh the marked block in an instruction file. Returns a line for
/// the report, or `None` when the file was already up to date.
pub fn install_instruction_block(path: &Path, block: &str) -> Result<Option<String>> {
    let existing = if path.exists() {
        fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?
    } else {
        String::new()
    };
    let new = upsert_marked_block(&existing, block);
    if new == existing {
        return Ok(None);
    }
    write_atomic(path, &new)?;
    Ok(Some(format!("installed cortexmd instruction block in {}", path.display())))
}

// ── Codex ─────────────────────────────────────────────────────────────────

pub fn codex_home(home: &Path) -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(h) if !h.trim().is_empty() => PathBuf::from(h.trim()),
        _ => home.join(".codex"),
    }
}

fn toml_entry_matches(t: &dyn toml_edit::TableLike, base: Option<&str>) -> bool {
    if let (Some(u), Some(b)) = (t.get("url").and_then(|v| v.as_str()), base) {
        if url_key(u) == url_key(b) {
            return true;
        }
    }
    let cmd = t.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let first = t
        .get("args")
        .and_then(|v| v.as_array())
        .and_then(|a| a.get(0))
        .and_then(|v| v.as_str());
    is_cortexmd_command(cmd) && first == Some("mcp")
}

/// Merge `[mcp_servers.cortexmd]` (stdio bridge + lean `enabled_tools`) and,
/// when `hooks`, `[features] hooks = true` into a Codex config.toml.
/// Returns the new text and the outcome; comments and other tables survive.
pub fn merge_codex_config(text: &str, base: Option<&str>, hooks: bool) -> Result<(String, Outcome)> {
    use toml_edit::{value, Array, DocumentMut, Item, Table};
    let mut doc: DocumentMut = text.parse().context("parse Codex config.toml")?;

    let mut outcome = Outcome::Added;
    if let Some(servers) = doc.get("mcp_servers").and_then(|i| i.as_table_like()) {
        for (name, item) in servers.iter() {
            if let Some(t) = item.as_table_like() {
                if toml_entry_matches(t, base) {
                    outcome = Outcome::Present(name.to_string());
                    break;
                }
            }
        }
        if outcome == Outcome::Added {
            if let Some(t) = servers.get(SERVER_NAME).and_then(|i| i.as_table_like()) {
                let what = t
                    .get("url")
                    .or_else(|| t.get("command"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("another server")
                    .to_string();
                outcome = Outcome::Conflict(what);
            }
        }
    }

    if outcome == Outcome::Added {
        if doc.get("mcp_servers").is_none() {
            let mut t = Table::new();
            t.set_implicit(true);
            doc.insert("mcp_servers", Item::Table(t));
        }
        let servers = doc["mcp_servers"]
            .as_table_mut()
            .context("`mcp_servers` in config.toml is not a table")?;
        let mut t = Table::new();
        t.decor_mut().set_prefix(
            "\n# cortexmd (written by `cortexmd init --client codex`): stdio bridge that reuses the\n\
             # `cortexmd auth` login — no `codex mcp login` needed. HTTP alternative:\n\
             # url = \"<server>/mcp\" + `codex mcp login cortexmd` (see docs/integrations.md).\n",
        );
        t.insert("command", value("cortexmd"));
        let mut args = Array::new();
        args.push("mcp");
        t.insert("args", value(args));
        t.insert("startup_timeout_sec", value(20));
        t.insert("tool_timeout_sec", value(120));
        let mut tools = Array::new();
        for name in LEAN_TOOLS {
            let mut v = toml_edit::Value::from(*name);
            v.decor_mut().set_prefix("\n  ");
            tools.push_formatted(v);
        }
        tools.set_trailing_comma(true);
        tools.set_trailing("\n");
        let mut item = value(tools);
        if let Some(v) = item.as_value_mut() {
            v.decor_mut().set_suffix(
                "  # lean protocol set; other tools via tool_search + tool_invoke — delete the key to expose all",
            );
        }
        t.insert("enabled_tools", item);
        servers.insert(SERVER_NAME, Item::Table(t));
    }

    if hooks {
        if doc.get("features").is_none() {
            doc.insert("features", Item::Table(Table::new()));
        }
        if let Some(f) = doc["features"].as_table_like_mut() {
            if f.get("hooks").is_none() {
                f.insert("hooks", value(true));
            }
        }
    }
    Ok((doc.to_string(), outcome))
}

/// Merge the Codex MCP block into `<codex_home>/config.toml`.
pub fn register_codex(codex_home: &Path, base: Option<&str>, hooks: bool) -> Result<Report> {
    let mut r = Report::default();
    let path = codex_home.join("config.toml");
    let text = if path.exists() {
        fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?
    } else {
        String::new()
    };
    let (new, outcome) = merge_codex_config(&text, base, hooks)?;
    if new != text {
        write_atomic(&path, &new)?;
    }
    match outcome {
        Outcome::Added => r.done.push(format!(
            "added [mcp_servers.{}] (stdio `cortexmd mcp`, lean enabled_tools) to {}",
            SERVER_NAME,
            path.display()
        )),
        Outcome::Present(n) => r.done.push(format!(
            "Codex already has the server as [mcp_servers.{}] in {} — left unchanged",
            n,
            path.display()
        )),
        Outcome::Conflict(what) => {
            r.warnings.push(format!("[mcp_servers.{}] in {} points to {} — left untouched", SERVER_NAME, path.display(), what));
            r.manual = Some(format!("remove [mcp_servers.{}] from {} and re-run", SERVER_NAME, path.display()));
        }
    }
    if hooks && new != text {
        r.done.push(format!("ensured [features] hooks = true in {}", path.display()));
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "cortexmd-clients-{}-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst),
                tag
            ));
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const BASE: &str = "https://brain.example.com";

    #[test]
    fn url_key_ignores_mcp_suffix_case_and_slash() {
        assert_eq!(url_key("https://Brain.example.com/mcp/"), url_key(BASE));
        assert_ne!(url_key("https://other.example.com/mcp"), url_key(BASE));
    }

    #[test]
    fn json_merge_adds_once_and_detects_same_url_under_other_name() {
        let mut root = json!({"mcpServers": {"other": {"command": "x"}}, "theme": "dark"});
        assert_eq!(merge_json_server(&mut root, claude_http_entry(BASE), Some(BASE)), Outcome::Added);
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["mcpServers"]["other"]["command"], "x");
        assert_eq!(root["mcpServers"]["cortexmd"]["headersHelper"], HEADERS_HELPER);
        assert_eq!(root["mcpServers"]["cortexmd"]["url"], format!("{}/mcp", BASE));
        // Idempotent.
        assert_eq!(
            merge_json_server(&mut root, claude_http_entry(BASE), Some(BASE)),
            Outcome::Present("cortexmd".into())
        );
        // Same URL under another name → never duplicated.
        let mut root2 = json!({"mcpServers": {"my-brain": {"type": "http", "url": "https://brain.example.com/mcp"}}});
        assert_eq!(
            merge_json_server(&mut root2, claude_http_entry(BASE), Some(BASE)),
            Outcome::Present("my-brain".into())
        );
        assert!(root2["mcpServers"].get("cortexmd").is_none());
    }

    #[test]
    fn json_merge_never_overwrites_a_foreign_cortexmd_entry() {
        let mut root = json!({"mcpServers": {"cortexmd": {"url": "https://elsewhere/mcp"}}});
        assert!(matches!(merge_json_server(&mut root, claude_http_entry(BASE), Some(BASE)), Outcome::Conflict(_)));
        assert_eq!(root["mcpServers"]["cortexmd"]["url"], "https://elsewhere/mcp");
    }

    #[test]
    fn stdio_bridge_entries_match_without_a_url() {
        assert!(json_entry_matches(&json!({"command": "C:\\bin\\cortexmd.exe", "args": ["mcp"]}), None));
        assert!(!json_entry_matches(&json!({"command": "cortexmd", "args": ["status"]}), None));
    }

    #[test]
    fn find_matches_scans_project_scopes() {
        let root = json!({
            "mcpServers": {"a": {"url": "https://brain.example.com/mcp"}},
            "projects": {"D:/x": {"mcpServers": {"b": {"url": "https://brain.example.com"}}}}
        });
        assert_eq!(find_json_matches(&root, Some(BASE)).len(), 2);
    }

    #[test]
    fn register_claude_direct_write_is_idempotent_and_warns_on_duplicates() {
        let t = Tmp::new("claude");
        fs::create_dir_all(t.0.join(".claude")).unwrap();
        fs::write(t.0.join(".claude.json"), r#"{"numStartups": 3, "claudeAiMcpEverConnected": ["claude.ai obsidian brain", "claude.ai Gmail"]}"#).unwrap();
        fs::write(t.0.join(".claude/settings.json"), r#"{"enabledPlugins": {"cortexmd@cortexmd": true, "x@y": true}}"#).unwrap();

        let r = register_claude(&t.0, BASE, false).unwrap();
        assert_eq!(r.done.len(), 1, "{:?}", r);
        assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
        assert!(r.manual.is_none());
        let root: Value = serde_json::from_str(&fs::read_to_string(t.0.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(root["numStartups"], 3, "unrelated keys survive");
        assert_eq!(root["mcpServers"]["cortexmd"]["type"], "http");
        let backups = fs::read_dir(&t.0).unwrap().filter(|e| {
            e.as_ref().unwrap().file_name().to_string_lossy().starts_with(".claude.json.bak-cortexmd-")
        }).count();
        assert_eq!(backups, 1);

        let r2 = register_claude(&t.0, &format!("{}/mcp", BASE), false).unwrap();
        assert!(r2.done[0].contains("already registered"), "{:?}", r2);
        let root2: Value = serde_json::from_str(&fs::read_to_string(t.0.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(root2["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn register_json_stdio_for_cursor() {
        let t = Tmp::new("cursor");
        let p = t.0.join(".cursor/mcp.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, r#"{"mcpServers":{"gh":{"url":"https://api.github.com/mcp"}}}"#).unwrap();
        let r = register_json_stdio(&p, Some(BASE), "Cursor").unwrap();
        assert!(r.done[0].contains("registered"));
        let r2 = register_json_stdio(&p, Some(BASE), "Cursor").unwrap();
        assert!(r2.done[0].contains("already registered"));
        let root: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(root["mcpServers"].as_object().unwrap().len(), 2);
        assert_eq!(root["mcpServers"]["cortexmd"]["args"][0], "mcp");
    }

    #[test]
    fn codex_merge_preserves_comments_and_is_idempotent() {
        let original = "# my codex config\nmodel = \"gpt-5\"  # keep me\n\n[mcp_servers.github]\nurl = \"https://api.github.com/mcp\"\n\n[features]\nweb_search = true\n";
        let (once, out) = merge_codex_config(original, Some(BASE), true).unwrap();
        assert_eq!(out, Outcome::Added);
        assert!(once.contains("# my codex config"));
        assert!(once.contains("model = \"gpt-5\"  # keep me"));
        assert!(once.contains("[mcp_servers.github]"));
        assert!(once.contains("[mcp_servers.cortexmd]"));
        assert!(once.contains("web_search = true"));
        let parsed: toml::Table = toml::from_str(&once).unwrap();
        let c = &parsed["mcp_servers"]["cortexmd"];
        assert_eq!(c["command"].as_str(), Some("cortexmd"));
        assert_eq!(c["args"].as_array().unwrap()[0].as_str(), Some("mcp"));
        assert_eq!(c["enabled_tools"].as_array().unwrap().len(), LEAN_TOOLS.len());
        assert_eq!(parsed["features"]["hooks"].as_bool(), Some(true));

        let (twice, out2) = merge_codex_config(&once, Some(BASE), true).unwrap();
        assert_eq!(out2, Outcome::Present("cortexmd".into()));
        assert_eq!(twice, once, "second run is a no-op");
    }

    #[test]
    fn codex_merge_respects_existing_url_entry_and_windows_no_hooks() {
        let original = "[mcp_servers.brain]\nurl = \"https://brain.example.com/mcp\"\n";
        let (new, out) = merge_codex_config(original, Some(BASE), false).unwrap();
        assert_eq!(out, Outcome::Present("brain".into()));
        assert_eq!(new, original);
        let (fresh, _) = merge_codex_config("", None, false).unwrap();
        assert!(!fresh.contains("[features]"));
        assert!(fresh.contains("[mcp_servers.cortexmd]"));
        assert!(!fresh.contains("\n[mcp_servers]\n"), "parent table stays implicit: {}", fresh);
    }

    #[test]
    fn codex_merge_flags_a_foreign_cortexmd_table() {
        let original = "[mcp_servers.cortexmd]\nurl = \"https://elsewhere/mcp\"\n";
        let (new, out) = merge_codex_config(original, Some(BASE), false).unwrap();
        assert!(matches!(out, Outcome::Conflict(_)));
        assert_eq!(new, original);
    }

    #[test]
    fn marked_block_upsert_is_idempotent_and_replaces_in_place() {
        let block = instruction_block("Codex", "codex", "box");
        assert!(block.starts_with(MARK_START) && block.ends_with(MARK_END));
        assert!(block.contains("Codex (box)"));
        assert!(!block.contains("<hostname>"));
        let user = "# My agents\n\nBe terse.\n";
        let once = upsert_marked_block(user, &block);
        assert!(once.starts_with(user));
        assert_eq!(upsert_marked_block(&once, &block), once);
        let older = once.replace("Codex (box)", "Codex (old)");
        assert_eq!(upsert_marked_block(&older, &block), once, "stale block replaced in place");
        let gem = instruction_block("Gemini CLI", "gemini", "box");
        assert!(gem.contains("Gemini CLI (box)") && gem.contains("source=\"gemini\""));
    }

    #[test]
    fn install_instruction_block_writes_once() {
        let t = Tmp::new("agents");
        let p = t.0.join("AGENTS.md");
        let b = instruction_block("Codex", "codex", "box");
        assert!(install_instruction_block(&p, &b).unwrap().is_some());
        assert!(install_instruction_block(&p, &b).unwrap().is_none());
    }
}
