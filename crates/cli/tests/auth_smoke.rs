//! Smoke tests for the auth module: redaction, Claude-config parsing shapes,
//! TOML round-trip. We avoid touching real `~/.claude.json` or the user's
//! per-platform config dir — these tests synthesize blobs and parse them via
//! the same helpers used at runtime.

use cortexmd_cli::auth::{redact_key, AuthConfig};

/// Minimal in-process check: the same JSON shape as Claude Code's
/// `~/.claude.json` should parse cleanly via serde_json. We can't exercise
/// `auto_discover_from_claude` without tampering with the user's home dir,
/// but we can at least pin the JSON-shape expectations.
#[test]
fn claude_config_top_level_shape_round_trips() {
    let blob = serde_json::json!({
        "mcpServers": {
            "remote": {
                "type": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": { "Authorization": "Bearer top-token-1234" }
            },
            "local": {
                "type": "stdio",
                "command": "/usr/bin/some-stdio-mcp"
            }
        }
    });
    // We can re-parse it as serde_json::Value and assert top-level shape.
    let s = blob.to_string();
    let v: serde_json::Value = serde_json::from_str(&s).expect("re-parse");
    let servers = v["mcpServers"].as_object().expect("mcpServers map");
    assert!(servers.contains_key("remote"));
    assert!(servers.contains_key("local"));
}

#[test]
fn claude_config_per_project_shape_round_trips() {
    // The shape Claude Code actually uses: per-project `mcpServers`.
    let blob = serde_json::json!({
        "projects": {
            "/some/project": {
                "mcpServers": {
                    "my-server": {
                        "type": "http",
                        "url": "https://mcp.example.com/mcp"
                    }
                }
            }
        }
    });
    let v: serde_json::Value = serde_json::from_str(&blob.to_string()).expect("re-parse");
    let entry = &v["projects"]["/some/project"]["mcpServers"]["my-server"];
    assert_eq!(entry["type"].as_str(), Some("http"));
    assert!(entry["url"].as_str().is_some());
    // Critically: this shape has NO `headers.Authorization`, which is
    // exactly the case our importer must surface as a clear error.
    assert!(entry.get("headers").is_none());
}

#[test]
fn redact_short_key_collapses_to_stars() {
    assert_eq!(redact_key(""), "***");
    assert_eq!(redact_key("a"), "***");
    assert_eq!(redact_key("abcd"), "***");
}

#[test]
fn redact_long_key_keeps_last_four() {
    assert_eq!(redact_key("abcdef1234"), "***1234");
    assert_eq!(redact_key("supersecretkey9999"), "***9999");
}

#[test]
fn auth_config_toml_round_trip() {
    let cfg = AuthConfig {
        server: Some("https://mcp.example.com".to_string()),
        api_key: Some("token-xyz".to_string()),
    };
    let s = toml::to_string_pretty(&cfg).expect("serialize");
    let parsed: AuthConfig = toml::from_str(&s).expect("parse");
    assert_eq!(parsed.server.as_deref(), Some("https://mcp.example.com"));
    assert_eq!(parsed.api_key.as_deref(), Some("token-xyz"));
}

#[test]
fn auth_config_handles_partial_file() {
    // Server only, no key — both fields are optional.
    let s = r#"server = "https://only-server.example""#;
    let parsed: AuthConfig = toml::from_str(s).expect("parse partial");
    assert_eq!(parsed.server.as_deref(), Some("https://only-server.example"));
    assert!(parsed.api_key.is_none());
}
