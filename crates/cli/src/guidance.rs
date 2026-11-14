//! `cortexmd guidance <list|add|sync|remove|search|get>` — guidance packs.
//!
//! Guidance packs are curated third-party best-practice packs (for example
//! GoogleChrome/modern-web-guidance) that the cortexmd SERVER fetches and
//! serves next to personal memory. This command only talks to the server's
//! REST endpoints (`/api/guidance/*`, same bearer as `/api/recall`); it never
//! clones or executes anything locally.
//!
//! `add` / `sync` / `remove` hit the admin endpoints: the server only accepts
//! HTTPS git URLs on its host allowlist (`GUIDANCE_PACK_HOSTS`, default
//! `github.com`) and can disable them entirely (`GUIDANCE_PACKS_ADMIN=off`).

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

use crate::auth;
use crate::cli::{GuidanceArgs, GuidanceCommand};
use crate::mcp;

/// A pack fetch (shallow clone + index) can take a while on a slow link.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(300);

/// `path?k=v&…` with percent-encoded values; empty values are skipped.
pub fn with_query(path: &str, params: &[(&str, String)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect();
    if parts.is_empty() {
        path.to_string()
    } else {
        format!("{}?{}", path, parts.join("&"))
    }
}

/// The JSON body for `POST /api/guidance/packs`.
#[allow(clippy::too_many_arguments)]
pub fn add_body(
    name: &str,
    source: &str,
    git_ref: Option<&str>,
    commit: Option<&str>,
    include: &[String],
    refresh: Option<&str>,
    no_sync: bool,
) -> Value {
    let mut body = json!({ "name": name, "source": source });
    if let Some(r) = git_ref.filter(|s| !s.trim().is_empty()) {
        body["ref"] = json!(r);
    }
    if let Some(c) = commit.filter(|s| !s.trim().is_empty()) {
        body["commit"] = json!(c);
    }
    if !include.is_empty() {
        body["include"] = json!(include);
    }
    if let Some(r) = refresh.filter(|s| !s.trim().is_empty()) {
        body["refresh"] = json!(r);
    }
    if no_sync {
        body["sync"] = json!(false);
    }
    body
}

fn short(v: &Value, key: &str, n: usize) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(n).collect())
        .unwrap_or_else(|| "-".to_string())
}

/// One line per pack for `guidance list`.
pub fn format_packs(resp: &Value) -> String {
    let empty = Vec::new();
    let packs = resp.get("packs").and_then(|p| p.as_array()).unwrap_or(&empty);
    if packs.is_empty() {
        return "No guidance packs. Add one: cortexmd guidance add modern-web-guidance https://github.com/GoogleChrome/modern-web-guidance".to_string();
    }
    let mut out = Vec::new();
    for p in packs {
        let installed = p.get("installed").and_then(|b| b.as_bool()).unwrap_or(false);
        out.push(format!(
            "{}  {}  commit {}  licence {}  {} entries  synced {}  {}",
            short(p, "name", 64),
            if installed { "installed" } else { "not synced" },
            short(p, "commit", 12),
            short(p, "license", 24),
            p.get("entries").and_then(|n| n.as_u64()).unwrap_or(0),
            short(p, "syncedAt", 16),
            short(p, "source", 200),
        ));
    }
    out.join("\n")
}

/// `pack/id — description` lines for `guidance search`.
pub fn format_results(resp: &Value) -> String {
    let empty = Vec::new();
    let results = resp.get("results").and_then(|p| p.as_array()).unwrap_or(&empty);
    if results.is_empty() {
        return "No matching guide.".to_string();
    }
    results
        .iter()
        .map(|r| format!("{}/{} — {}", short(r, "pack", 64), short(r, "id", 200), short(r, "description", 400)))
        .collect::<Vec<_>>()
        .join("\n")
}

enum Method {
    Get,
    Post(Value),
    Delete,
}

fn request(server: &str, key: &str, path: &str, method: Method, timeout: Option<Duration>) -> Result<Value> {
    let url = format!("{}{}", server.trim_end_matches('/'), path);
    let bearer = format!("Bearer {}", key);
    let redact = |e: ureq::Error| anyhow!(e.to_string().replace(key, "***"));
    let (verb, mut resp) = match method {
        Method::Get => {
            let req = mcp::http_agent().get(&url).header("Authorization", &bearer).header("Accept", "application/json");
            let req = match timeout {
                Some(t) => req.config().timeout_global(Some(t)).build(),
                None => req,
            };
            ("GET", req.call().map_err(redact).with_context(|| format!("GET {} failed", url))?)
        }
        Method::Delete => {
            let req = mcp::http_agent().delete(&url).header("Authorization", &bearer).header("Accept", "application/json");
            ("DELETE", req.call().map_err(redact).with_context(|| format!("DELETE {} failed", url))?)
        }
        Method::Post(body) => {
            let bytes = serde_json::to_vec(&body).context("serialize payload")?;
            let req = mcp::http_agent()
                .post(&url)
                .header("Authorization", &bearer)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json");
            let req = match timeout {
                Some(t) => req.config().timeout_global(Some(t)).build(),
                None => req,
            };
            ("POST", req.send(&bytes[..]).map_err(redact).with_context(|| format!("POST {} failed", url))?)
        }
    };
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&text).ok();
    if status >= 400 {
        let msg = parsed
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| text.chars().take(200).collect());
        if status == 404 && parsed.is_none() {
            anyhow::bail!("{} {} returned 404 — this server has no guidance-pack support (upgrade cortexmd)", verb, url);
        }
        anyhow::bail!("{} {} returned {}: {}", verb, url, status, msg);
    }
    parsed.ok_or_else(|| anyhow!("{} {} returned a non-JSON body", verb, url))
}

pub fn cmd_guidance(args: GuidanceArgs) -> Result<()> {
    let creds = auth::resolve_creds(args.server.as_deref(), args.api_key.as_deref())?
        .ok_or_else(|| anyhow!("{}", auth::no_creds_message()))?;
    let (server, key) = (creds.server, creds.api_key);
    let print = |v: &Value, text: String| {
        if args.json {
            println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
        } else {
            println!("{}", text);
        }
    };
    match args.command {
        GuidanceCommand::List => {
            let resp = request(&server, &key, "/api/guidance/packs", Method::Get, None)?;
            print(&resp, format_packs(&resp));
        }
        GuidanceCommand::Add { name, source, git_ref, commit, include, refresh, no_sync } => {
            let body = add_body(&name, &source, git_ref.as_deref(), commit.as_deref(), &include, refresh.as_deref(), no_sync);
            let resp = request(&server, &key, "/api/guidance/packs", Method::Post(body), Some(ADMIN_TIMEOUT))?;
            let m = resp.get("manifest").cloned().unwrap_or(Value::Null);
            let text = if m.is_null() {
                format!("Declared pack {} (not synced yet: cortexmd guidance sync {})", name, name)
            } else {
                format!(
                    "Added pack {}: {} entries, commit {}, licence {}",
                    name,
                    m.get("entries").and_then(|n| n.as_u64()).unwrap_or(0),
                    short(&m, "commit", 12),
                    m.get("license").map(|l| short(l, "spdx", 24)).unwrap_or_else(|| "-".into()),
                )
            };
            print(&resp, text);
        }
        GuidanceCommand::Sync { name } => {
            let path = format!("/api/guidance/packs/{}/sync", urlencoding::encode(&name));
            let resp = request(&server, &key, &path, Method::Post(json!({})), Some(ADMIN_TIMEOUT))?;
            let m = resp.get("manifest").cloned().unwrap_or(Value::Null);
            let text = format!(
                "Synced pack {}: {} entries, commit {}",
                name,
                m.get("entries").and_then(|n| n.as_u64()).unwrap_or(0),
                short(&m, "commit", 12)
            );
            print(&resp, text);
        }
        GuidanceCommand::Remove { name } => {
            let path = format!("/api/guidance/packs/{}", urlencoding::encode(&name));
            let resp = request(&server, &key, &path, Method::Delete, None)?;
            let env = resp.get("stillDeclaredInEnv").and_then(|b| b.as_bool()).unwrap_or(false);
            let text = if env {
                format!("Removed the files of pack {} (it is still declared in the server's GUIDANCE_PACKS)", name)
            } else {
                format!("Removed pack {}", name)
            };
            print(&resp, text);
        }
        GuidanceCommand::Search { query, pack, limit } => {
            let q = query.join(" ");
            if q.trim().is_empty() {
                anyhow::bail!("a query is required");
            }
            let path = with_query(
                "/api/guidance/search",
                &[("q", q), ("pack", pack.unwrap_or_default()), ("limit", limit.map(|n| n.to_string()).unwrap_or_default())],
            );
            let resp = request(&server, &key, &path, Method::Get, None)?;
            print(&resp, format_results(&resp));
        }
        GuidanceCommand::Get { ids, pack, section, max_tokens } => {
            let path = with_query(
                "/api/guidance/get",
                &[
                    ("id", ids.join(",")),
                    ("pack", pack.unwrap_or_default()),
                    ("section", section.unwrap_or_default()),
                    ("maxTokens", max_tokens.map(|n| n.to_string()).unwrap_or_default()),
                ],
            );
            let resp = request(&server, &key, &path, Method::Get, None)?;
            let text = resp.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string();
            print(&resp, text);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_string_encodes_and_skips_empty() {
        assert_eq!(with_query("/api/guidance/search", &[("q", "light dismiss dialog".into()), ("pack", "".into())]), "/api/guidance/search?q=light%20dismiss%20dialog");
        assert_eq!(with_query("/x", &[("q", "a&b=c".into()), ("limit", "3".into())]), "/x?q=a%26b%3Dc&limit=3");
        assert_eq!(with_query("/x", &[("q", " ".into())]), "/x");
    }

    #[test]
    fn add_body_only_carries_set_fields() {
        let b = add_body("web", "https://github.com/a/b", None, None, &[], None, false);
        assert_eq!(b, json!({ "name": "web", "source": "https://github.com/a/b" }));
        let b = add_body("web", "https://github.com/a/b", Some("main"), Some("abc"), &["skills/**".to_string()], Some("7d"), true);
        assert_eq!(
            b,
            json!({ "name": "web", "source": "https://github.com/a/b", "ref": "main", "commit": "abc", "include": ["skills/**"], "refresh": "7d", "sync": false })
        );
    }

    #[test]
    fn formats_lists_and_results() {
        assert!(format_packs(&json!({ "packs": [] })).starts_with("No guidance packs."));
        let line = format_packs(&json!({ "packs": [{ "name": "web", "installed": true, "commit": "0123456789abcdef", "license": "Apache-2.0", "entries": 232, "syncedAt": "2026-11-14T18:10:12.538Z", "source": "https://github.com/a/b" }] }));
        assert_eq!(line, "web  installed  commit 0123456789ab  licence Apache-2.0  232 entries  synced 2026-11-14T18:10  https://github.com/a/b");
        assert_eq!(format_results(&json!({ "results": [] })), "No matching guide.");
        assert_eq!(
            format_results(&json!({ "results": [{ "pack": "web", "id": "dialog", "description": "Build a dialog." }] })),
            "web/dialog — Build a dialog."
        );
    }
}
