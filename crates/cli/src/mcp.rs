//! MCP streamable-HTTP client.
//! Mirrors `bin/mcp-client.mjs`: initialize → capture mcp-session-id → tools/call.
//! Synchronous via `ureq`, no tokio runtime.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

const COMMON_ACCEPT: &str = "application/json, text/event-stream";

/// Initialize an MCP session. Returns the session id from the response header.
pub fn initialize(server_url: &str, api_key: &str) -> Result<(String, Value)> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "cortexmd", "version": "0.2.0" }
        }
    });
    let url = format!("{}/mcp", server_url.trim_end_matches('/'));
    let res = ureq::post(&url)
        .header("Authorization", &format!("Bearer {}", api_key))
        .header("Accept", COMMON_ACCEPT)
        .header("Content-Type", "application/json")
        .send_json(&body);
    let mut res = redact_send_err(res, api_key)?;

    if res.status().as_u16() >= 400 {
        let status = res.status();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        anyhow::bail!(
            "MCP initialize failed: HTTP {} — {}",
            status,
            redact(&text, api_key)
                .chars()
                .take(400)
                .collect::<String>()
        );
    }

    // Extract session id BEFORE consuming the body.
    let session_id = res
        .headers()
        .get("mcp-session-id")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            anyhow!("MCP initialize succeeded but no mcp-session-id header was returned")
        })?;

    let parsed = parse_mcp_response(res, api_key)?;
    if let Some(err) = parsed.get("error") {
        anyhow::bail!(
            "MCP initialize error: {}",
            redact(&err.to_string(), api_key)
        );
    }
    let result = parsed
        .get("result")
        .cloned()
        .unwrap_or(Value::Null);
    Ok((session_id, result))
}

/// Call a tool on an open MCP session.
pub fn tools_call(
    server_url: &str,
    api_key: &str,
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": tool_name, "arguments": arguments }
    });
    let url = format!("{}/mcp", server_url.trim_end_matches('/'));
    let res = ureq::post(&url)
        .header("Authorization", &format!("Bearer {}", api_key))
        .header("Accept", COMMON_ACCEPT)
        .header("Content-Type", "application/json")
        .header("mcp-session-id", session_id)
        .send_json(&body);
    let mut res = redact_send_err(res, api_key)?;

    if res.status().as_u16() >= 400 {
        let status = res.status();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        anyhow::bail!(
            "MCP tools/call failed: HTTP {} — {}",
            status,
            redact(&text, api_key)
                .chars()
                .take(400)
                .collect::<String>()
        );
    }

    let parsed = parse_mcp_response(res, api_key)?;
    if let Some(err) = parsed.get("error") {
        anyhow::bail!("Tool error: {}", redact(&err.to_string(), api_key));
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

/// Parse a streamable-HTTP MCP body — JSON or SSE-style `data:` lines.
fn parse_mcp_response(mut res: ureq::http::Response<ureq::Body>, api_key: &str) -> Result<Value> {
    let ctype = res
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = res
        .body_mut()
        .read_to_string()
        .context("failed to read MCP response body")?;

    if ctype.contains("text/event-stream") {
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                let trimmed = rest.trim();
                if trimmed.is_empty() || trimmed == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                    if v.get("result").is_some()
                        || v.get("error").is_some()
                        || v.get("jsonrpc").is_some()
                    {
                        return Ok(v);
                    }
                }
            }
        }
        anyhow::bail!(
            "MCP SSE response had no JSON-RPC payload: {}",
            redact(&text, api_key).chars().take(200).collect::<String>()
        );
    }

    serde_json::from_str::<Value>(&text).map_err(|e| {
        anyhow!(
            "MCP response was not JSON ({}): {} ({})",
            ctype,
            redact(&text, api_key).chars().take(200).collect::<String>(),
            e
        )
    })
}

fn redact_send_err(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    api_key: &str,
) -> Result<ureq::http::Response<ureq::Body>> {
    res.map_err(|e| anyhow!(redact(&e.to_string(), api_key)))
}

fn redact(input: &str, api_key: &str) -> String {
    if api_key.is_empty() {
        input.to_string()
    } else {
        input.replace(api_key, "***")
    }
}
