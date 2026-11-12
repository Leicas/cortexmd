//! `cortexmd wakeup` — fetch the session-start recap (`memory_wakeup`).
//!
//! The SessionStart hook calls this and injects the text as
//! `additionalContext`, so the model starts with its diary + hot memories
//! without spending a tool call (and without being told to make one).
//!
//! Transport: `POST /api/wakeup` (REST, one round-trip) when the server has
//! it; on 404 / non-JSON (servers without the route) falls back to MCP
//! `initialize` → `tools/call memory_wakeup` → `DELETE` (three round-trips).
//! `--timeout-ms` is an overall deadline shared by every round-trip so the
//! hook's own cap is never exceeded by a slow server.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

use crate::auth;
use crate::cli::WakeupArgs;
use crate::mcp;

/// Sanitised hostname, same rule as `machineId()` in `_mcp_rest.mjs`.
pub fn machine_id() -> String {
    let raw = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_default();
    raw.replace(['/', '\\'], "")
        .replace("..", "")
        .replace(['[', ']', '|', '#', '^'], "")
        .trim()
        .to_string()
}

/// `<client> (<host>)` — the diary agent name the hooks use.
pub fn default_agent_name(client: &str) -> String {
    let host = machine_id();
    if host.is_empty() { client.to_string() } else { format!("{} ({})", client, host) }
}

/// The `memory_wakeup` arguments for these CLI args.
pub fn wakeup_arguments(args: &WakeupArgs) -> Value {
    let mut m = Map::new();
    let agent = args
        .agent_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default_agent_name("Claude Code"));
    m.insert("agentName".into(), Value::String(agent));
    m.insert("preset".into(), Value::String(args.preset.clone()));
    if let Some(p) = args.project.as_deref().filter(|s| !s.trim().is_empty()) {
        m.insert("project".into(), Value::String(p.to_string()));
    }
    if let Some(mc) = args.machine.as_deref().filter(|s| !s.trim().is_empty()) {
        m.insert("machine".into(), Value::String(mc.to_string()));
    }
    Value::Object(m)
}

/// Concatenate every `{type:"text"}` item of a tools/call result.
pub fn tool_result_text(result: &Value) -> Option<String> {
    let items = result.get("content")?.as_array()?;
    let parts: Vec<&str> = items
        .iter()
        .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
        .collect();
    if parts.is_empty() { None } else { Some(parts.join("\n")) }
}

struct Deadline(Option<Instant>);

impl Deadline {
    /// Remaining budget, or an error when spent.
    fn left(&self) -> Result<Option<Duration>> {
        match self.0 {
            None => Ok(None),
            Some(end) => {
                let now = Instant::now();
                if now >= end {
                    Err(anyhow!("wakeup deadline exceeded"))
                } else {
                    Ok(Some(end - now))
                }
            }
        }
    }
}

fn with_timeout(
    req: ureq::RequestBuilder<ureq::typestate::WithBody>,
    t: Option<Duration>,
) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
    match t {
        Some(t) => req.config().timeout_global(Some(t)).build(),
        None => req,
    }
}

/// REST attempt. `Ok(None)` = the server has no such route (fall back).
fn try_rest(server: &str, key: &str, args: &Value, dl: &Deadline) -> Result<Option<String>> {
    let url = format!("{}/api/wakeup", server.trim_end_matches('/'));
    let body = serde_json::to_vec(args)?;
    let req = mcp::http_agent()
        .post(&url)
        .header("Authorization", &format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    let mut res = with_timeout(req, dl.left()?)
        .send(&body[..])
        .map_err(|e| anyhow!(e.to_string().replace(key, "***")))
        .with_context(|| format!("POST {}", url))?;
    let status = res.status().as_u16();
    if status == 404 || status == 405 {
        return Ok(None);
    }
    let text = res.body_mut().read_to_string().unwrap_or_default();
    if status >= 400 {
        anyhow::bail!("POST {} returned {}: {}", url, status, text.chars().take(200).collect::<String>());
    }
    // A server without the route may answer 200 with an HTML fallback page.
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Ok(v
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .or_else(|| tool_result_text(&v))),
        Err(_) => Ok(None),
    }
}

fn via_mcp(server: &str, key: &str, args: &Value, dl: &Deadline) -> Result<String> {
    dl.left()?;
    let (sid, _) = mcp::initialize(server, key)?;
    let result = (|| {
        let t = dl.left()?;
        mcp::tools_call_with_timeout(server, key, &sid, "memory_wakeup", args, t)
    })();
    let _ = mcp::delete_session(server, key, &sid);
    let result = result?;
    tool_result_text(&result).ok_or_else(|| anyhow!("memory_wakeup returned no text content"))
}

pub fn cmd_wakeup(args: WakeupArgs) -> Result<()> {
    let dl = Deadline(if args.timeout_ms > 0 {
        Some(Instant::now() + Duration::from_millis(args.timeout_ms))
    } else {
        None
    });
    let creds = auth::resolve_creds(args.server.as_deref(), args.api_key.as_deref())?
        .ok_or_else(|| anyhow!("{}", auth::no_creds_message()))?;
    let server = crate::bridge::normalize_base(&creds.server);
    let tool_args = wakeup_arguments(&args);

    let (text, via) = match try_rest(&server, &creds.api_key, &tool_args, &dl)? {
        Some(t) => (t, "rest"),
        None => (via_mcp(&server, &creds.api_key, &tool_args, &dl)?, "mcp"),
    };

    if args.format == "json" {
        println!(
            "{}",
            json!({
                "text": text,
                "agentName": tool_args["agentName"],
                "preset": args.preset,
                "via": via,
            })
        );
    } else {
        println!("{}", text.trim_end());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_skip_empty_optionals() {
        let a = WakeupArgs {
            agent_name: Some("Codex (box)".into()),
            preset: "tiny".into(),
            project: Some("".into()),
            machine: Some("box".into()),
            ..Default::default()
        };
        let v = wakeup_arguments(&a);
        assert_eq!(v["agentName"], "Codex (box)");
        assert_eq!(v["preset"], "tiny");
        assert!(v.get("project").is_none());
        assert_eq!(v["machine"], "box");
    }

    #[test]
    fn default_agent_name_is_machine_scoped() {
        let n = default_agent_name("Claude Code");
        assert!(n.starts_with("Claude Code"));
        assert!(!n.contains('['));
    }

    #[test]
    fn tool_text_joins_text_items() {
        let r = json!({"content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]});
        assert_eq!(tool_result_text(&r).as_deref(), Some("a\nb"));
        assert!(tool_result_text(&json!({"content": []})).is_none());
    }
}
