//! `cortexmd mcp` — stdio ↔ Streamable-HTTP MCP bridge.
//!
//! stdio MCP clients (Codex, Cursor, Gemini CLI — and any client on Windows
//! that only does stdio well) spawn `cortexmd mcp` and talk newline-delimited
//! JSON-RPC on stdin/stdout. Each message is POSTed to `<server>/mcp` with the
//! CLI's resolved bearer (`auth::resolve_creds`: env → OAuth cache with
//! auto-refresh → config file → Claude config), so the client needs no login
//! of its own.
//!
//! Streamable HTTP rules handled here:
//! - `initialize` is forwarded synchronously; the `mcp-session-id` response
//!   header is captured and sent on every later request, together with
//!   `MCP-Protocol-Version` (from the initialize result).
//! - A response is either `application/json` (one message) or
//!   `text/event-stream` (SSE events, each `data:` payload is one message —
//!   progress notifications first, then the response). Both are written to
//!   stdout as compact single-line JSON. `202 Accepted` (notifications,
//!   client responses) writes nothing.
//! - `401` → credentials are re-resolved once (OAuth refresh) and the request
//!   retried. `404` on a request carrying a session id → the session is gone
//!   (server restart / reaped): the bridge replays the original `initialize`
//!   and `notifications/initialized`, then retries once. The client never sees
//!   the restart.
//! - Requests other than `initialize` run on their own thread so a long tool
//!   call does not block a concurrent `ping` or `tools/list`.
//! - Any transport failure on a message that carries an `id` is answered with
//!   a JSON-RPC error so the client never hangs.
//! - On stdin EOF the bridge waits for in-flight requests and DELETEs the
//!   session (the server keeps per-session state; leaking them is costly).
//!
//! Not implemented: the optional GET SSE stream for unsolicited
//! server→client messages (cortexmd sends none the clients depend on).
//! Logs go to stderr only; stdout carries protocol messages exclusively.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use crate::auth;
use crate::cli::McpArgs;
use crate::mcp;

const ACCEPT: &str = "application/json, text/event-stream";

/// Shared bridge state.
struct Bridge {
    server: String,
    timeout: Duration,
    cli_server: Option<String>,
    cli_key: Option<String>,
    token: RwLock<String>,
    session: RwLock<Option<String>>,
    protocol_version: RwLock<Option<String>>,
    /// Raw `initialize` request + `notifications/initialized`, replayed when
    /// the server forgets the session.
    init_msgs: Mutex<Vec<Vec<u8>>>,
    /// Serialises re-initialisation so concurrent 404s re-init once.
    reinit: Mutex<()>,
    out: Mutex<io::Stdout>,
}

/// Outcome of one HTTP POST.
enum Posted {
    /// 202 / empty body.
    Accepted,
    /// Messages to write to stdout (already compact single-line JSON).
    Messages(Vec<String>),
    /// HTTP error status + body excerpt.
    Status(u16, String),
}

pub fn cmd_mcp(args: McpArgs) -> Result<()> {
    let creds = auth::resolve_creds(args.server.as_deref(), args.api_key.as_deref())?
        .ok_or_else(|| anyhow!("{}", auth::no_creds_message()))?;
    let server = normalize_base(&creds.server);
    eprintln!("[cortexmd mcp] bridging stdio → {}/mcp (auth: {})", server, creds.source.label());

    let bridge = Arc::new(Bridge {
        server,
        timeout: Duration::from_secs(args.timeout_secs.max(5)),
        cli_server: args.server.clone(),
        cli_key: args.api_key.clone(),
        token: RwLock::new(creds.api_key),
        session: RwLock::new(None),
        protocol_version: RwLock::new(None),
        init_msgs: Mutex::new(Vec::new()),
        reinit: Mutex::new(()),
        out: Mutex::new(io::stdout()),
    });

    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[cortexmd mcp] stdin read failed: {}", e);
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[cortexmd mcp] dropping non-JSON line: {}", e);
                bridge.write_line(&json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {}", e) }
                }).to_string());
                continue;
            }
        };
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let body = trimmed.as_bytes().to_vec();
        if method == "initialize" || method == "notifications/initialized" {
            // Order matters: the session id must exist before anything else.
            if let Ok(mut v) = bridge.init_msgs.lock() {
                if method == "initialize" {
                    v.clear();
                }
                v.push(body.clone());
            }
            bridge.handle(&msg, &body);
        } else {
            workers.retain(|h| !h.is_finished());
            let b = Arc::clone(&bridge);
            workers.push(thread::spawn(move || b.handle(&msg, &body)));
        }
    }

    for h in workers {
        let _ = h.join();
    }
    bridge.close_session();
    Ok(())
}

/// `https://host/mcp/` → `https://host`.
pub fn normalize_base(server: &str) -> String {
    let s = server.trim().trim_end_matches('/');
    s.strip_suffix("/mcp").unwrap_or(s).trim_end_matches('/').to_string()
}

impl Bridge {
    fn mcp_url(&self) -> String {
        format!("{}/mcp", self.server)
    }

    fn token(&self) -> String {
        self.token.read().map(|t| t.clone()).unwrap_or_default()
    }

    fn write_line(&self, line: &str) {
        if let Ok(mut out) = self.out.lock() {
            let _ = out.write_all(line.as_bytes());
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
    }

    fn redact(&self, s: &str) -> String {
        let t = self.token();
        if t.is_empty() { s.to_string() } else { s.replace(&t, "***") }
    }

    /// Forward one client message; write whatever comes back.
    fn handle(&self, msg: &Value, body: &[u8]) {
        let id = msg.get("id").cloned();
        let is_request = msg.get("method").is_some() && id.is_some();
        let is_init = msg.get("method").and_then(|m| m.as_str()) == Some("initialize");

        let mut result = self.post(body, is_init, true);
        // 401 → refresh credentials once.
        if matches!(result, Ok(Posted::Status(401, _))) && self.refresh_token() {
            result = self.post(body, is_init, true);
        }
        // 404 with a session → server forgot it: re-initialise, retry once.
        if !is_init
            && matches!(result, Ok(Posted::Status(404, _)))
            && self.session_id().is_some()
            && self.reinitialize()
        {
            result = self.post(body, false, true);
        }

        match result {
            Ok(Posted::Accepted) => {}
            Ok(Posted::Messages(lines)) => {
                for l in lines {
                    self.write_line(&l);
                }
            }
            Ok(Posted::Status(code, text)) => {
                eprintln!("[cortexmd mcp] HTTP {}: {}", code, self.redact(&text));
                if is_request {
                    self.write_error(id, code, &format!("cortexmd server returned HTTP {}: {}", code, self.redact(&text)));
                }
            }
            Err(e) => {
                let m = self.redact(&e.to_string());
                eprintln!("[cortexmd mcp] request failed: {}", m);
                if is_request {
                    self.write_error(id, 0, &format!("cortexmd server unreachable ({}): {}", self.server, m));
                }
            }
        }
    }

    fn write_error(&self, id: Option<Value>, status: u16, message: &str) {
        let excerpt: String = message.chars().take(400).collect();
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": { "code": -32000, "message": excerpt, "data": { "httpStatus": status } }
        }).to_string());
    }

    fn session_id(&self) -> Option<String> {
        self.session.read().ok().and_then(|s| s.clone())
    }

    fn refresh_token(&self) -> bool {
        match auth::resolve_creds(self.cli_server.as_deref(), self.cli_key.as_deref()) {
            Ok(Some(c)) if c.api_key != self.token() => {
                if let Ok(mut t) = self.token.write() {
                    *t = c.api_key;
                }
                true
            }
            _ => false,
        }
    }

    /// Replay `initialize` (+ `initialized`) to obtain a fresh session id.
    fn reinitialize(&self) -> bool {
        let stale = self.session_id();
        let _g = match self.reinit.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if self.session_id() != stale {
            return true; // another thread already re-initialised
        }
        let msgs = self.init_msgs.lock().map(|v| v.clone()).unwrap_or_default();
        if msgs.is_empty() {
            return false;
        }
        if let Ok(mut s) = self.session.write() {
            *s = None;
        }
        eprintln!("[cortexmd mcp] session expired on the server — re-initialising");
        for (i, m) in msgs.iter().enumerate() {
            match self.post(m, i == 0, false) {
                Ok(Posted::Status(code, _)) if i == 0 => {
                    eprintln!("[cortexmd mcp] re-initialise failed: HTTP {}", code);
                    return false;
                }
                Err(e) if i == 0 => {
                    eprintln!("[cortexmd mcp] re-initialise failed: {}", self.redact(&e.to_string()));
                    return false;
                }
                _ => {} // initialize response is swallowed: the client already has one
            }
        }
        self.session_id().is_some()
    }

    fn close_session(&self) {
        if let Some(sid) = self.session_id() {
            let _ = mcp::delete_session(&self.server, &self.token(), &sid);
        }
    }

    /// POST one message. For `initialize`, captures the session id and the
    /// negotiated protocol version. `emit = false` drops the response (used
    /// when replaying `initialize` after a server-side session loss).
    fn post(&self, body: &[u8], is_init: bool, emit: bool) -> Result<Posted> {
        let url = self.mcp_url();
        let token = self.token();
        let mut req = mcp::http_agent()
            .post(&url)
            .config()
            .timeout_global(Some(self.timeout))
            .build()
            .header("Authorization", &format!("Bearer {}", token))
            .header("Accept", ACCEPT)
            .header("Content-Type", "application/json");
        if !is_init {
            if let Some(sid) = self.session_id() {
                req = req.header("mcp-session-id", &sid);
            }
            if let Some(v) = self.protocol_version.read().ok().and_then(|v| v.clone()) {
                req = req.header("MCP-Protocol-Version", &v);
            }
        }
        let mut res = req.send(body).map_err(|e| anyhow!(e.to_string()))?;
        let status = res.status().as_u16();
        if is_init && status < 400 {
            if let Some(sid) = res.headers().get("mcp-session-id").and_then(|h| h.to_str().ok()) {
                if let Ok(mut s) = self.session.write() {
                    *s = Some(sid.to_string());
                }
            }
        }
        if status >= 400 {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            return Ok(Posted::Status(status, text.chars().take(400).collect()));
        }
        if status == 202 || status == 204 {
            return Ok(Posted::Accepted);
        }
        let ctype = res
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let lines = if ctype.contains("text/event-stream") {
            // Stream SSE events to stdout as they arrive (progress
            // notifications must not wait for the final response). During a
            // silent re-initialise the events are consumed and dropped.
            let reader = BufReader::new(res.body_mut().as_reader());
            for msg in sse_messages(reader) {
                self.note_init_result(is_init, &msg);
                if emit {
                    self.write_line(&msg);
                }
            }
            return Ok(Posted::Messages(Vec::new()));
        } else {
            let text = res.body_mut().read_to_string()?;
            compact_json_lines(&text)
        };
        for l in &lines {
            self.note_init_result(is_init, l);
        }
        if lines.is_empty() || !emit {
            return Ok(Posted::Accepted);
        }
        Ok(Posted::Messages(lines))
    }

    fn note_init_result(&self, is_init: bool, line: &str) {
        if !is_init {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(pv) = v.pointer("/result/protocolVersion").and_then(|p| p.as_str()) {
                if let Ok(mut w) = self.protocol_version.write() {
                    *w = Some(pv.to_string());
                }
            }
        }
    }
}

/// Re-encode a JSON body as one compact line (empty body → nothing).
fn compact_json_lines(text: &str) -> Vec<String> {
    let t = text.trim();
    if t.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(t) {
        Ok(v) => vec![v.to_string()],
        Err(_) => vec![t.replace(['\r', '\n'], " ")],
    }
}

/// Parse an SSE stream into the JSON payloads of its events (multi-line
/// `data:` fields are joined with `\n` per the SSE spec, then re-encoded as
/// one compact line). Non-JSON payloads are skipped.
fn sse_messages<R: BufRead>(reader: R) -> impl Iterator<Item = String> {
    let mut data: Vec<String> = Vec::new();
    let mut lines = reader.lines();
    let mut done = false;
    std::iter::from_fn(move || loop {
        if done {
            return None;
        }
        let line = match lines.next() {
            Some(Ok(l)) => Some(l),
            _ => None,
        };
        let flush = |data: &mut Vec<String>| -> Option<String> {
            if data.is_empty() {
                return None;
            }
            let payload = data.join("\n");
            data.clear();
            serde_json::from_str::<Value>(payload.trim()).ok().map(|v| v.to_string())
        };
        match line {
            None => {
                done = true;
                return flush(&mut data);
            }
            Some(l) => {
                let l = l.trim_end_matches('\r');
                if l.is_empty() {
                    if let Some(m) = flush(&mut data) {
                        return Some(m);
                    }
                } else if let Some(rest) = l.strip_prefix("data:") {
                    data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                }
                // `event:`, `id:`, `retry:` and `:` comments are ignored.
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_strips_mcp_suffix() {
        assert_eq!(normalize_base("https://h.example/mcp"), "https://h.example");
        assert_eq!(normalize_base("https://h.example/mcp/"), "https://h.example");
        assert_eq!(normalize_base("http://localhost:3000/"), "http://localhost:3000");
        assert_eq!(normalize_base(" http://x "), "http://x");
    }

    #[test]
    fn sse_events_become_compact_lines() {
        let stream = "event: message\r\nid: 1\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\r\ndata:  \"params\":{}}\r\n\r\n: keep-alive\n\ndata: {\"jsonrpc\": \"2.0\", \"id\": 7, \"result\": {}}\n\ndata: not json\n\n";
        let got: Vec<String> = sse_messages(BufReader::new(stream.as_bytes())).collect();
        assert_eq!(got.len(), 2, "{:?}", got);
        assert!(got[0].contains("notifications/progress"));
        let resp: Value = serde_json::from_str(&got[1]).unwrap();
        assert_eq!(resp["id"], 7);
        assert!(!got[1].contains('\n'));
    }

    #[test]
    fn sse_without_trailing_blank_line_still_flushes() {
        let got: Vec<String> = sse_messages(BufReader::new("data: {\"id\":1}".as_bytes())).collect();
        assert_eq!(got, vec![r#"{"id":1}"#.to_string()]);
    }

    #[test]
    fn json_body_is_one_line() {
        assert_eq!(compact_json_lines("{\n  \"a\": 1\n}\n"), vec![r#"{"a":1}"#.to_string()]);
        assert!(compact_json_lines("  ").is_empty());
    }
}
