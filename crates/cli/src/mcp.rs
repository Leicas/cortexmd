//! MCP streamable-HTTP client.
//! Mirrors `bin/mcp-client.mjs`: initialize → capture mcp-session-id → tools/call
//! → DELETE /mcp. Synchronous via `ureq`, no tokio runtime.
//!
//! Wire format: every request body is **compact** JSON (`serde_json::to_vec`).
//! `ureq`'s `send_json` serializes with `to_vec_pretty`, which doubles a large
//! `code_ingest_repo` payload (6.6 MB → 12.8 MB) and trips the server's 10 MB
//! body limit — so we never use it here.
//!
//! All requests share one [`ureq::Agent`] with a 3 s connect timeout and a
//! 30 s global timeout; long-running tool calls (ingest) pass a per-request
//! override via [`tools_call_with_timeout`].

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const COMMON_ACCEPT: &str = "application/json, text/event-stream";

/// TCP connect timeout for every request.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Whole-request timeout (connect + send + receive) for ordinary calls.
pub const GLOBAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Whole-request timeout for `code_ingest_repo` (multi-MB upload + server-side
/// SQLite write of thousands of symbols).
pub const INGEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Process-wide HTTP agent: connection pool + default timeouts. HTTP error
/// statuses are returned as responses (not `Err`) so callers can read the
/// server's error body and treat specific codes (404, 413) deliberately.
pub fn http_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_global(Some(GLOBAL_TIMEOUT))
            .http_status_as_error(false)
            .build()
            .new_agent()
    })
}

/// Build the JSON-RPC envelope for a `tools/call`.
pub fn tools_call_body(tool_name: &str, arguments: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": tool_name, "arguments": arguments }
    })
}

/// Serialize a request body exactly as it goes on the wire (compact JSON).
/// The returned length is the `Content-Length` the server will see.
pub fn encode_body(body: &Value) -> Result<Vec<u8>> {
    serde_json::to_vec(body).context("serialize MCP request body")
}

fn mcp_url(server_url: &str) -> String {
    format!("{}/mcp", server_url.trim_end_matches('/'))
}

/// Initialize an MCP session. Returns the session id from the response header.
pub fn initialize(server_url: &str, api_key: &str) -> Result<(String, Value)> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "cortexmd", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let bytes = encode_body(&body)?;
    let url = mcp_url(server_url);
    let res = http_agent()
        .post(&url)
        .header("Authorization", &format!("Bearer {}", api_key))
        .header("Accept", COMMON_ACCEPT)
        .header("Content-Type", "application/json")
        .send(&bytes[..]);
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

/// Call a tool on an open MCP session with the default 30 s timeout.
pub fn tools_call(
    server_url: &str,
    api_key: &str,
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value> {
    tools_call_with_timeout(server_url, api_key, session_id, tool_name, arguments, None)
}

/// Call a tool on an open MCP session, optionally overriding the whole-request
/// timeout (e.g. [`INGEST_TIMEOUT`] for `code_ingest_repo`).
pub fn tools_call_with_timeout(
    server_url: &str,
    api_key: &str,
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
    timeout: Option<Duration>,
) -> Result<Value> {
    let bytes = encode_body(&tools_call_body(tool_name, arguments))?;
    tools_call_bytes(server_url, api_key, session_id, &bytes, timeout)
}

/// Send a pre-encoded `tools/call` body (from [`tools_call_body`] +
/// [`encode_body`]). Lets the caller measure the exact wire size before
/// opening a session, without serializing the payload twice.
pub fn tools_call_bytes(
    server_url: &str,
    api_key: &str,
    session_id: &str,
    body: &[u8],
    timeout: Option<Duration>,
) -> Result<Value> {
    let url = mcp_url(server_url);
    let req = http_agent().post(&url);
    let req = match timeout {
        Some(t) => req.config().timeout_global(Some(t)).build(),
        None => req,
    };
    let res = req
        .header("Authorization", &format!("Bearer {}", api_key))
        .header("Accept", COMMON_ACCEPT)
        .header("Content-Type", "application/json")
        .header("mcp-session-id", session_id)
        .send(body);
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

/// Close an MCP session (`DELETE /mcp` with `mcp-session-id`). Best-effort:
/// callers ignore the result; the server reaps idle sessions anyway, but an
/// explicit close keeps its session map (and persisted sessions) small.
pub fn delete_session(server_url: &str, api_key: &str, session_id: &str) -> Result<()> {
    let url = mcp_url(server_url);
    let send = || {
        http_agent()
            .delete(&url)
            .header("Authorization", &format!("Bearer {}", api_key))
            .header("mcp-session-id", session_id)
            .call()
    };
    // DELETE is idempotent: retry once when a pooled keep-alive connection
    // turns out to have been closed by the peer between requests.
    let res = match send() {
        Err(ureq::Error::Io(_)) => send(),
        other => other,
    };
    let res = redact_send_err(res, api_key)?;
    let status = res.status().as_u16();
    // 404 = already gone (server restarted / session reaped) — not an error.
    if status >= 400 && status != 404 {
        anyhow::bail!("MCP session delete failed: HTTP {}", status);
    }
    Ok(())
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
                    if v.get("result").is_some() || v.get("error").is_some() {
                        return Ok(v);
                    }
                }
            }
        }
        anyhow::bail!(
            "MCP SSE stream contained no JSON-RPC result: {}",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative `code_ingest_repo` argument: nested objects + arrays,
    /// the shapes that `to_vec_pretty` inflates the most.
    fn sample_args() -> Value {
        let files: Vec<Value> = (0..50)
            .map(|i| {
                json!({
                    "path": format!("src/mod_{i}.rs"),
                    "hash": format!("{:040x}", i),
                    "symbols": [
                        { "name": format!("fn_{i}"), "kind": "function", "line": i, "signature": format!("fn fn_{i}(x: u32) -> u32") },
                        { "name": format!("Struct{i}"), "kind": "struct", "line": i + 10 }
                    ],
                    "calls": [[format!("fn_{i}"), "helper"]],
                    "imports": ["std::fmt", "serde_json"]
                })
            })
            .collect();
        json!({
            "slug": "demo",
            "repo_id": "abc123",
            "machine_id": "test-machine",
            "abs_path": "D:/dev/demo",
            "full_replace": true,
            "files": files
        })
    }

    #[test]
    fn tools_call_body_is_compact_on_the_wire() {
        let args = sample_args();
        let body = tools_call_body("code_ingest_repo", &args);
        let bytes = encode_body(&body).expect("encode");
        let text = std::str::from_utf8(&bytes).expect("utf8");

        // No pretty-printing artifacts: no newline+indent, no ": " / ", " spacing.
        assert!(!text.contains("\n  "), "body contains pretty indentation");
        assert!(!text.contains('\n'), "body contains newlines");
        assert!(!text.contains("\": "), "body contains key/value spacing");

        // Byte-for-byte what serde's compact serializer produces.
        assert_eq!(bytes.len(), serde_json::to_vec(&body).unwrap().len());
        assert_eq!(bytes, serde_json::to_vec(&body).unwrap());

        // And strictly smaller than what ureq's send_json would have sent.
        let pretty = serde_json::to_vec_pretty(&body).unwrap();
        assert!(
            pretty.len() > bytes.len() + bytes.len() / 2,
            "pretty ({}) should be far larger than compact ({})",
            pretty.len(),
            bytes.len()
        );

        // Envelope shape survives the round trip.
        let back: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back["method"], "tools/call");
        assert_eq!(back["params"]["name"], "code_ingest_repo");
        assert_eq!(back["params"]["arguments"]["files"].as_array().unwrap().len(), 50);
    }

    #[test]
    fn client_info_version_matches_cargo() {
        // `initialize` embeds env!("CARGO_PKG_VERSION"); make sure the constant
        // is a real semver triple and not the old hard-coded "0.2.0" literal.
        let v = env!("CARGO_PKG_VERSION");
        assert_eq!(v.split('.').count(), 3, "CARGO_PKG_VERSION={v}");
    }
}
