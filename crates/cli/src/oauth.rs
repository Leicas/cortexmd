//! OAuth 2.0 authorization-code + PKCE + Dynamic Client Registration client.
//!
//! Layer 4 of the auth stack. The deployed cortexmd server exposes:
//!
//! - `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata
//! - `POST /register` — RFC 7591 dynamic client registration
//! - `GET /authorize` — authorization endpoint (Authelia-protected upstream)
//! - `POST /token` — token endpoint (PKCE-validated)
//!
//! Flow:
//!   1. Bind a `127.0.0.1:<port>` listener (port reserved BEFORE registration).
//!   2. GET the discovery doc; fall back to `<server>/{authorize,token,register}`.
//!   3. POST `/register` with our redirect URI; capture `client_id` (and
//!      `client_secret`, even though we sent `token_endpoint_auth_method=none` —
//!      the server returns one anyway and we just ignore it for the token call).
//!   4. Generate `code_verifier` (43 chars from CSPRNG) + `state` nonce.
//!      `code_challenge = base64url(sha256(verifier))`.
//!   5. Build the authorize URL, open in the browser (or print).
//!   6. Block on the listener (5 minute timeout) until the callback fires;
//!      validate `state`.
//!   7. POST `/token` with `grant_type=authorization_code`, `code`, `code_verifier`,
//!      `redirect_uri`, `client_id`. The server JWT bears `expires_in` seconds.
//!   8. Persist `oauth-tokens.json` with atomic .tmp+rename, 0600 on Linux.
//!
//! Refresh: the deployed server does NOT issue refresh tokens (its `/token`
//! handler returns only `access_token`/`token_type`/`expires_in`/`scope`).
//! When the cached token is within 60s of expiry we surface a clear error
//! asking the user to re-run `auth oauth-login`. If the server later starts
//! returning a `refresh_token`, this module will use it automatically.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Walk env → persisted config → Claude Code config and return the first
/// usable MCP server URL. Used by `cmd_oauth_login` when --server is omitted.
/// Returns None if nothing resolves.
fn resolve_server_fallback() -> Option<String> {
    if let Ok(v) = std::env::var("MCP_URL") {
        if !v.trim().is_empty() {
            return Some(v);
        }
    }
    if let Ok(Some(cfg)) = crate::auth::load_config() {
        if let Some(s) = cfg.server {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    for path in crate::auth::claude_config_candidates() {
        if !path.exists() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(root) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(url) = first_http_url(&root) {
            return Some(url);
        }
    }
    None
}

fn first_http_url(root: &Value) -> Option<String> {
    fn try_map(m: &serde_json::Map<String, Value>) -> Option<String> {
        for (_k, v) in m {
            if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
        }
        None
    }
    if let Some(m) = root
        .get("mcpServers")
        .or_else(|| root.get("mcp_servers"))
        .and_then(|v| v.as_object())
    {
        if let Some(url) = try_map(m) {
            return Some(url);
        }
    }
    if let Some(projs) = root.get("projects").and_then(|v| v.as_object()) {
        for (_p, v) in projs {
            if let Some(m) = v
                .get("mcpServers")
                .or_else(|| v.get("mcp_servers"))
                .and_then(|v| v.as_object())
            {
                if let Some(url) = try_map(m) {
                    return Some(url);
                }
            }
        }
    }
    None
}

/// On-disk schema for the OAuth token cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub server: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix epoch milliseconds of expiry (issuance time + expires_in*1000).
    pub expires_at: u64,
    pub token_endpoint: String,
}

/// Discovered OAuth endpoint URLs (with sensible fallbacks if a field is absent).
#[derive(Debug, Clone)]
pub struct DiscoveredEndpoints {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: String,
}

/// Result of dynamic client registration.
#[derive(Debug, Clone)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// Path to the OAuth token cache. Sibling of `config.toml`.
pub fn token_file_path() -> Result<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| {
        anyhow!("could not determine config_dir for this platform — set HOME or XDG_CONFIG_HOME")
    })?;
    crate::auth::migrate_legacy_app_dir(&base);
    Ok(base
        .join(crate::auth::APP_DIR)
        .join("oauth-tokens.json"))
}

/// Load the token cache. Returns `Ok(None)` if absent.
pub fn load_tokens() -> Result<Option<OAuthTokens>> {
    let path = token_file_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let parsed: OAuthTokens = serde_json::from_str(&text)
        .with_context(|| format!("failed to parse JSON at {}", path.display()))?;
    Ok(Some(parsed))
}

/// Atomic write: `.tmp` then rename. Sets 0600 on Linux/macOS.
pub fn save_tokens(tokens: &OAuthTokens) -> Result<PathBuf> {
    let path = token_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let serialized =
        serde_json::to_string_pretty(tokens).context("serialize oauth tokens")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serialized.as_bytes())
        .with_context(|| format!("failed to write {}", tmp.display()))?;
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

/// Delete the token cache. Returns `Ok(false)` if it didn't exist.
pub fn delete_tokens() -> Result<(PathBuf, bool)> {
    let path = token_file_path()?;
    if !path.exists() {
        return Ok((path, false));
    }
    fs::remove_file(&path)
        .with_context(|| format!("failed to remove {}", path.display()))?;
    Ok((path, true))
}

/// Trim trailing slash and a trailing `/mcp` segment so callers can pass either
/// the bare host URL (`https://mcp.example.com`) or the MCP endpoint
/// (`https://mcp.example.com/mcp`). OAuth discovery lives at the root.
pub fn normalize_server_base(server: &str) -> String {
    let s = server.trim().trim_end_matches('/');
    if let Some(stripped) = s.strip_suffix("/mcp") {
        stripped.trim_end_matches('/').to_string()
    } else {
        s.to_string()
    }
}

/// `GET ${base}/.well-known/oauth-authorization-server`. Falls back to default
/// endpoint paths if any field is missing or the document fails to parse.
pub fn discover(base: &str) -> Result<DiscoveredEndpoints> {
    let url = format!("{}/.well-known/oauth-authorization-server", base);
    let mut authz = format!("{}/authorize", base);
    let mut token = format!("{}/token", base);
    let mut reg = format!("{}/register", base);

    match ureq::get(&url).call() {
        Ok(mut res) => {
            if res.status().as_u16() < 400 {
                let text = res.body_mut().read_to_string().unwrap_or_default();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(s) = v.get("authorization_endpoint").and_then(|x| x.as_str()) {
                        authz = s.to_string();
                    }
                    if let Some(s) = v.get("token_endpoint").and_then(|x| x.as_str()) {
                        token = s.to_string();
                    }
                    if let Some(s) = v.get("registration_endpoint").and_then(|x| x.as_str()) {
                        reg = s.to_string();
                    }
                }
            }
        }
        Err(_) => {
            // Network/TLS failure — fall through with defaults; later calls will surface.
        }
    }

    Ok(DiscoveredEndpoints {
        authorization_endpoint: authz,
        token_endpoint: token,
        registration_endpoint: reg,
    })
}

/// `POST ${registration_endpoint}` with the client's metadata.
pub fn register(registration_endpoint: &str, redirect_uri: &str) -> Result<RegisteredClient> {
    let body = serde_json::json!({
        "client_name": "cortexmd-cli",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });

    let res = ureq::post(registration_endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .send_json(&body);

    let mut res = match res {
        Ok(r) => r,
        Err(e) => {
            bail!(
                "POST {} failed: {} — the server may not expose Dynamic Client \
                 Registration; you'll need a static client_id (not yet supported \
                 by `auth oauth-login`).",
                registration_endpoint,
                e
            );
        }
    };

    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    if status >= 400 {
        bail!(
            "Dynamic Client Registration failed: HTTP {} — {}",
            status,
            text.chars().take(400).collect::<String>()
        );
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("DCR response was not JSON: {}", text.chars().take(200).collect::<String>()))?;
    let client_id = v
        .get("client_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow!("DCR response missing client_id"))?
        .to_string();
    let client_secret = v
        .get("client_secret")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(RegisteredClient {
        client_id,
        client_secret,
    })
}

/// Random URL-safe alphanumeric string (CSPRNG via `rand::rng()` + `OsRng`).
fn random_token(len: usize) -> String {
    use rand::RngExt;
    const ALPHA: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| {
            let i = rng.random_range(0..ALPHA.len());
            ALPHA[i] as char
        })
        .collect()
}

/// PKCE: base64url(sha256(verifier)), no padding.
fn s256_challenge(verifier: &str) -> String {
    let digest = sha2::Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// Bind a TCP listener on `127.0.0.1` (any free port).  Port is "reserved" by
/// holding the listener open for the rest of the flow.
pub fn bind_local_listener() -> Result<(TcpListener, u16)> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .context("failed to bind 127.0.0.1:0 — no free localhost port?")?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Spawn a thread that accepts the OAuth callback on `listener`.  Sends back
/// `(code, state)` on `tx` once the redirect comes in.  The thread responds
/// to the browser with a friendly HTML page.
///
/// The thread runs `accept()` in a loop, ignoring non-`/callback` requests,
/// until a callback arrives or the listener is closed by the main thread
/// timing out.
fn spawn_callback_listener(
    listener: TcpListener,
    tx: mpsc::Sender<Result<(String, String)>>,
) {
    thread::spawn(move || {
        // Set a short read timeout so a slow/malicious client can't pin a worker thread.
        for incoming in listener.incoming() {
            let mut stream = match incoming {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Err(anyhow!("listener accept failed: {}", e)));
                    return;
                }
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

            // Read at most 8 KiB of the request — we only need the request line.
            let mut buf = [0u8; 8192];
            let n = match stream.read(&mut buf) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let raw = String::from_utf8_lossy(&buf[..n]);
            let first_line = raw.lines().next().unwrap_or("");
            // First line: "GET /callback?code=...&state=... HTTP/1.1"
            let mut parts = first_line.split_whitespace();
            let _method = parts.next().unwrap_or("");
            let target = parts.next().unwrap_or("");

            // Anything that isn't a callback path: respond 404 and keep listening.
            let path_and_query = target;
            if !path_and_query.starts_with("/callback") {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                continue;
            }

            let query = path_and_query.split_once('?').map(|(_, q)| q).unwrap_or("");
            let mut code: Option<String> = None;
            let mut state: Option<String> = None;
            let mut error_param: Option<String> = None;
            for pair in query.split('&') {
                let (k, v) = match pair.split_once('=') {
                    Some(kv) => kv,
                    None => continue,
                };
                let v = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string());
                match k {
                    "code" => code = Some(v),
                    "state" => state = Some(v),
                    "error" => error_param = Some(v),
                    _ => {}
                }
            }

            let body = if error_param.is_some() {
                "<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem\">\
                 <h1>Authorization failed</h1>\
                 <p>You can close this window and check the client's terminal.</p>\
                 </body></html>"
            } else {
                "<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem\">\
                 <h1>cortexmd: signed in</h1>\
                 <p>You can close this window. Tokens are being persisted by the CLI.</p>\
                 </body></html>"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());

            if let Some(err) = error_param {
                let _ = tx.send(Err(anyhow!("authorization server returned error: {}", err)));
                return;
            }
            match (code, state) {
                (Some(c), Some(s)) => {
                    let _ = tx.send(Ok((c, s)));
                    return;
                }
                _ => {
                    let _ = tx.send(Err(anyhow!(
                        "callback was missing `code` or `state` query parameter"
                    )));
                    return;
                }
            }
        }
    });
}

/// Build the `/authorize` URL with PKCE.
pub fn build_authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
    scope: &str,
) -> String {
    let q = format!(
        "response_type=code&client_id={}&redirect_uri={}&scope={}&state={}\
         &code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(state),
        urlencoding::encode(code_challenge),
    );
    let sep = if authorization_endpoint.contains('?') { '&' } else { '?' };
    format!("{}{}{}", authorization_endpoint, sep, q)
}

/// `POST ${token_endpoint}` form-encoded with the authorization-code grant.
pub fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> Result<TokenResponse> {
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
        ("client_id", client_id),
    ];
    if let Some(cs) = client_secret {
        form.push(("client_secret", cs));
    }
    post_form_token(token_endpoint, &form)
}

/// `POST ${token_endpoint}` form-encoded with the refresh-token grant.
pub fn exchange_refresh(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<TokenResponse> {
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(cs) = client_secret {
        form.push(("client_secret", cs));
    }
    post_form_token(token_endpoint, &form)
}

fn post_form_token(endpoint: &str, form: &[(&str, &str)]) -> Result<TokenResponse> {
    // Hand-roll the body so we don't pull in an extra dep for form encoding.
    let body: String = form
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let res = ureq::post(endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body.as_bytes());

    let mut res = res.map_err(|e| anyhow!("POST {} failed: {}", endpoint, e))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    if status >= 400 {
        bail!(
            "token endpoint returned HTTP {}: {}",
            status,
            text.chars().take(400).collect::<String>()
        );
    }
    let parsed: TokenResponse = serde_json::from_str(&text).with_context(|| {
        format!(
            "token endpoint response was not JSON: {}",
            text.chars().take(200).collect::<String>()
        )
    })?;
    if parsed.access_token.is_empty() {
        bail!("token endpoint returned empty access_token");
    }
    Ok(parsed)
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Compose an `OAuthTokens` struct from a `TokenResponse` (rolling forward
/// the existing refresh token if the response didn't include one — some
/// servers omit it when refreshing).
pub fn tokens_from_response(
    server: &str,
    client_id: &str,
    client_secret: Option<&str>,
    token_endpoint: &str,
    resp: TokenResponse,
    prior_refresh_token: Option<&str>,
) -> OAuthTokens {
    let expires_in = resp.expires_in.unwrap_or(3600);
    OAuthTokens {
        server: server.to_string(),
        client_id: client_id.to_string(),
        client_secret: client_secret.map(|s| s.to_string()),
        access_token: resp.access_token,
        refresh_token: resp
            .refresh_token
            .or_else(|| prior_refresh_token.map(|s| s.to_string())),
        expires_at: now_ms().saturating_add(expires_in.saturating_mul(1000)),
        token_endpoint: token_endpoint.to_string(),
    }
}

/// Returns `Ok(token)` if the cache has a usable bearer (refreshing if needed
/// and possible), `Ok(None)` if no cache file exists, or `Err` if the cache
/// exists but is unusable (expired with no refresh path).
pub fn get_valid_access_token(skew_secs: u64) -> Result<Option<(String, String)>> {
    let mut tokens = match load_tokens()? {
        Some(t) => t,
        None => return Ok(None),
    };
    let now = now_ms();
    let skew_ms = skew_secs.saturating_mul(1000);
    if tokens.expires_at > now.saturating_add(skew_ms) {
        return Ok(Some((tokens.server.clone(), tokens.access_token)));
    }
    // Try refresh if we have a refresh token.
    if let Some(rt) = tokens.refresh_token.clone() {
        match exchange_refresh(
            &tokens.token_endpoint,
            &tokens.client_id,
            tokens.client_secret.as_deref(),
            &rt,
        ) {
            Ok(resp) => {
                let updated = tokens_from_response(
                    &tokens.server,
                    &tokens.client_id,
                    tokens.client_secret.as_deref(),
                    &tokens.token_endpoint,
                    resp,
                    Some(&rt),
                );
                save_tokens(&updated)?;
                tokens = updated;
                return Ok(Some((tokens.server.clone(), tokens.access_token)));
            }
            Err(e) => {
                bail!(
                    "OAuth token expired and refresh failed ({}). \
                     Run `cortexmd auth oauth-login` to re-authenticate.",
                    e
                );
            }
        }
    }
    bail!(
        "OAuth token expired (no refresh token available). \
         Run `cortexmd auth oauth-login` to re-authenticate."
    )
}

/// End-to-end login flow.  Drives all of the steps above and persists the
/// resulting tokens.  When `open_browser` is false the URL is printed
/// instead of opened (--no-browser mode).
pub fn cmd_oauth_login(server: Option<&str>, open_browser: bool) -> Result<()> {
    let resolved = match server {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => resolve_server_fallback().ok_or_else(|| {
            anyhow!(
                "no MCP server URL provided. Pass --server, set MCP_URL, run `auth login`, \
                 or have an HTTP MCP entry in ~/.claude.json"
            )
        })?,
    };
    let base = normalize_server_base(&resolved);
    if base.is_empty() {
        bail!("resolved server URL is empty");
    }
    println!("[client] OAuth: discovering endpoints at {}", base);
    let endpoints = discover(&base)?;
    println!(
        "[client] OAuth: authorization_endpoint = {}",
        endpoints.authorization_endpoint
    );
    println!(
        "[client] OAuth: token_endpoint         = {}",
        endpoints.token_endpoint
    );
    println!(
        "[client] OAuth: registration_endpoint  = {}",
        endpoints.registration_endpoint
    );

    // Bind the listener BEFORE registration so we know the port.
    let (listener, port) = bind_local_listener()?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
    println!("[client] OAuth: local callback listener bound on {}", redirect_uri);

    // DCR.
    let registered = register(&endpoints.registration_endpoint, &redirect_uri)?;
    println!(
        "[client] OAuth: registered client_id = {} (client_secret returned: {})",
        registered.client_id,
        registered.client_secret.is_some()
    );

    // PKCE + state nonce.
    let verifier = random_token(43);
    let challenge = s256_challenge(&verifier);
    let state = random_token(32);

    let scope = "mcp:tools";
    let url = build_authorize_url(
        &endpoints.authorization_endpoint,
        &registered.client_id,
        &redirect_uri,
        &state,
        &challenge,
        scope,
    );

    if open_browser {
        match webbrowser::open(&url) {
            Ok(_) => println!("[client] OAuth: opened browser"),
            Err(e) => {
                eprintln!(
                    "[client] OAuth: failed to open browser ({}). Open this URL manually:",
                    e
                );
                println!("{}", url);
            }
        }
    } else {
        println!("[client] OAuth: --no-browser; open this URL in any browser:");
        println!("{}", url);
    }

    // Spawn the listener thread; wait up to 5 minutes.
    let (tx, rx) = mpsc::channel::<Result<(String, String)>>();
    spawn_callback_listener(listener, tx);

    println!("[client] OAuth: waiting for callback on {} (5 min timeout)", redirect_uri);
    let received = rx
        .recv_timeout(Duration::from_secs(300))
        .map_err(|_| anyhow!("timed out after 5 minutes waiting for OAuth callback on {}", redirect_uri))?;
    let (code, returned_state) = received?;

    if returned_state != state {
        bail!(
            "OAuth state mismatch — expected `{}`, got `{}`. Aborting (possible CSRF).",
            state,
            returned_state
        );
    }
    println!("[client] OAuth: callback received, exchanging code for token");

    let token = exchange_code(
        &endpoints.token_endpoint,
        &registered.client_id,
        registered.client_secret.as_deref(),
        &redirect_uri,
        &code,
        &verifier,
    )?;

    let tokens = tokens_from_response(
        &base,
        &registered.client_id,
        registered.client_secret.as_deref(),
        &endpoints.token_endpoint,
        token,
        None,
    );
    let path = save_tokens(&tokens)?;
    println!(
        "[client] OAuth: tokens persisted to {} (expires in {} s)",
        path.display(),
        (tokens.expires_at.saturating_sub(now_ms())) / 1000
    );
    Ok(())
}

/// `auth oauth-status` — prints cache path + redacted summary.  Never the token.
pub fn cmd_oauth_status() -> Result<()> {
    let path = token_file_path()?;
    println!("[client] OAuth token cache: {}", path.display());
    match load_tokens()? {
        None => {
            println!("[client] OAuth: no token cache present");
        }
        Some(t) => {
            println!("[client] OAuth: server         = {}", t.server);
            println!("[client] OAuth: client_id      = {}", t.client_id);
            println!(
                "[client] OAuth: client_secret  = {}",
                if t.client_secret.is_some() { "present" } else { "(none)" }
            );
            println!("[client] OAuth: token_endpoint = {}", t.token_endpoint);
            println!(
                "[client] OAuth: refresh_token  = {}",
                if t.refresh_token.is_some() { "present" } else { "(none)" }
            );
            let now = now_ms();
            let label = if t.expires_at > now {
                let remaining_secs = (t.expires_at - now) / 1000;
                format!("in {} (epoch_ms {})", humanize_secs(remaining_secs), t.expires_at)
            } else {
                let elapsed = (now - t.expires_at) / 1000;
                format!("EXPIRED {} ago (epoch_ms {})", humanize_secs(elapsed), t.expires_at)
            };
            println!("[client] OAuth: expires_at     = {}", label);
        }
    }
    Ok(())
}

/// `auth oauth-logout` — deletes the token cache (no prompt; same UX as having a `--yes` default).
pub fn cmd_oauth_logout(yes: bool) -> Result<()> {
    let path = token_file_path()?;
    if !path.exists() {
        println!("[client] OAuth: no token cache at {} (nothing to remove)", path.display());
        return Ok(());
    }
    if !yes {
        eprint!("Delete OAuth token cache at {} ? [y/N] ", path.display());
        use std::io::{BufRead, Write};
        let _ = std::io::stderr().flush();
        let stdin = std::io::stdin();
        let mut line = String::new();
        stdin.lock().read_line(&mut line)?;
        if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("[client] OAuth: aborted");
            return Ok(());
        }
    }
    let (path, removed) = delete_tokens()?;
    if removed {
        println!("[client] OAuth: removed {}", path.display());
    }
    Ok(())
}

fn humanize_secs(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else if secs < 86_400 {
        format!("{}h{}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d{}h", secs / 86_400, (secs % 86_400) / 3600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_known_vector() {
        // RFC 7636 Appendix B test vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(s256_challenge(verifier), expected);
    }

    #[test]
    fn normalize_strips_mcp_suffix() {
        assert_eq!(normalize_server_base("https://x.example/mcp"), "https://x.example");
        assert_eq!(normalize_server_base("https://x.example/mcp/"), "https://x.example");
        assert_eq!(normalize_server_base("https://x.example/"), "https://x.example");
        assert_eq!(normalize_server_base("https://x.example"), "https://x.example");
    }

    #[test]
    fn random_token_length() {
        assert_eq!(random_token(43).chars().count(), 43);
        assert_ne!(random_token(43), random_token(43));
    }
}
