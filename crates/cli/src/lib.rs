//! Library surface for the cortexmd-cli crate. Tests link against
//! this; the binaries (`cortexmd` and the deprecated `obsidian-mcp-client`
//! alias) re-use the same entry point via [`run`] / [`run_with_args`].

pub mod auth;
pub mod cli;
pub mod contract;
pub mod git;
pub mod indexer;
pub mod init;
pub mod inspect;
pub mod lang;
pub mod local_db;
pub mod mcp;
pub mod sync;
pub mod oauth;
pub mod parser;
pub mod payload;
pub mod rewrite;
pub mod simhash;
pub mod walker;
pub mod workspace;

use anyhow::{Context, Result};
use clap::Parser;
use cli::{AuthCommand, Cli, Command, IndexArgs};
use payload::{sha1_hex, FilePayload, IngestPayload};
use std::ffi::OsString;
use std::io::{self, Write};

const DEFAULT_SERVER: &str = "http://localhost:3000";

/// Shared entry point for the `cortexmd` binary. Parses `std::env::args`
/// and dispatches to the appropriate subcommand. The deprecated
/// `obsidian-mcp-client` alias binary delegates here as well.
pub fn run() -> Result<()> {
    let cli = Cli::parse();
    dispatch(cli)
}

/// Like [`run`], but parses from an explicit argument vector (program name
/// first). Used by the alias binary so the parsed command behaves identically
/// regardless of which executable name was invoked.
pub fn run_with_args<I, T>(args: I) -> Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = Cli::parse_from(args);
    dispatch(cli)
}

fn dispatch(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Command::Auth(args)) => match args.command {
            AuthCommand::Login { server, api_key } => auth::cmd_login(&server, api_key),
            AuthCommand::Status => auth::cmd_status(),
            AuthCommand::Logout { yes } => auth::cmd_logout(yes),
            AuthCommand::ImportFromClaude { name, yes } => {
                auth::cmd_import_from_claude(name.as_deref(), yes)
            }
            AuthCommand::OauthLogin { server, no_browser } => {
                oauth::cmd_oauth_login(server.as_deref(), !no_browser)
            }
            AuthCommand::OauthStatus => oauth::cmd_oauth_status(),
            AuthCommand::OauthLogout { yes } => oauth::cmd_oauth_logout(yes),
        },
        Some(Command::Index(args)) => run_index(args),
        Some(Command::Status) => inspect::cmd_status(),
        Some(Command::Discover(args)) => inspect::cmd_discover(args),
        Some(Command::Scan(args)) => inspect::cmd_scan(args, run_index),
        Some(Command::Gain(args)) => inspect::cmd_gain(args),
        Some(Command::HudLine(args)) => inspect::cmd_hud_line(args),
        Some(Command::Recall(args)) => inspect::cmd_recall(args),
        Some(Command::StoreMemory(args)) => inspect::cmd_store_memory(args),
        Some(Command::RepoList(args)) => inspect::cmd_repo_list(args),
        Some(Command::CodeSearch(args)) => inspect::cmd_code_search(args),
        Some(Command::CodeGet(args)) => inspect::cmd_code_get(args),
        Some(Command::CodeImpact(args)) => inspect::cmd_code_impact(args),
        Some(Command::CodeOutline(args)) => inspect::cmd_code_outline(args),
        Some(Command::CodeFindDuplicates(args)) => inspect::cmd_code_find_duplicates(args),
        Some(Command::CodeChain(args)) => inspect::cmd_code_chain(args),
        Some(Command::Rewrite(args)) => rewrite::cmd_rewrite(args),
        Some(Command::Bench(args)) => inspect::cmd_bench(args),
        Some(Command::Pull(args)) => inspect::cmd_pull(args),
        Some(Command::Contract(args)) => contract::cmd_contract(args.command),
        Some(Command::Init(args)) => init::cmd_init(args),
        None => run_index(cli.index),
    }
}

fn run_index(args: IndexArgs) -> Result<()> {
    let repo_path_arg = args
        .repo_path
        .as_ref()
        .context("missing <repo-path>. Usage: cortexmd <repo-path> [flags] (or `auth …`)")?;
    let repo_path = repo_path_arg
        .canonicalize()
        .with_context(|| format!("path does not exist: {}", repo_path_arg.display()))?;

    let slug = args
        .slug
        .clone()
        .unwrap_or_else(|| {
            repo_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "repo".to_string())
        })
        .trim()
        .to_string();

    // Resolve credentials via the priority chain.
    // For --dry-run we tolerate missing creds (fall back to defaults).
    let resolved = auth::resolve_creds(args.server.as_deref(), args.api_key.as_deref())?;

    let (server_url, api_key) = if let Some(r) = resolved {
        if args.verbose {
            println!("[client] credentials source: {}", r.source.label());
        }
        (r.server, r.api_key)
    } else if args.dry_run {
        (
            args.server
                .clone()
                .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
            args.api_key.clone().unwrap_or_default(),
        )
    } else {
        anyhow::bail!("{}", auth::no_creds_message());
    };

    if !args.dry_run && api_key.is_empty() {
        anyhow::bail!("{}", auth::no_creds_message());
    }

    let machine_id = args.machine_id.clone().unwrap_or_else(|| {
        hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "unknown".to_string())
    });

    if !repo_path.join(".git").exists() {
        anyhow::bail!("not a git repo (no .git/): {}", repo_path.display());
    }

    println!("[client] repo: {}", repo_path.display());
    println!("[client] slug: {}", slug);
    println!("[client] machine_id: {}", machine_id);

    let sha = git::first_commit_sha(&repo_path)?;
    let origin = git::git_origin(&repo_path);
    // Fork-aware: hash the remote URL when present so two repos that share a
    // first_commit_sha (a fork and its parent) get distinct repo_ids. Fall
    // back to first_commit_sha for repos with no remote.
    let (repo_id, repo_id_source) = match origin.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(o) => (sha1_hex(o)[..16].to_string(), "from git_origin"),
        None => (sha[..16].to_string(), "from first_commit_sha — no remote"),
    };
    println!("[client] first_commit_sha: {}", sha);
    println!("[client] repo_id: {}  ({})", repo_id, repo_id_source);
    println!(
        "[client] git_origin: {}",
        origin.as_deref().unwrap_or("(none)")
    );

    // Workspace expansion (optional — only present for npm-style repos).
    let pkg_ws = workspace::collect_workspaces(&repo_path);
    if let Some(name) = &pkg_ws.name {
        println!("[client] package_name: {}", name);
    }
    if let Some(wp) = &pkg_ws.workspace_packages {
        println!("[client] workspace_packages: {}", wp.len());
    }

    let rel_paths = walker::walk_repo(&repo_path);
    println!("[client] discovered {} candidate files", rel_paths.len());

    let mut files: Vec<FilePayload> = Vec::new();
    let mut parsed_count = 0usize;
    let mut skipped = 0usize;

    for (i, rel) in rel_paths.iter().enumerate() {
        let lang = match walker::language_for_path(rel) {
            Some(l) => l,
            None => {
                skipped += 1;
                continue;
            }
        };
        let abs = walker::abs_from_rel(&repo_path, rel);
        match indexer::process_file(&repo_id, rel, lang, &abs, args.verbose) {
            Ok(Some(fp)) => {
                files.push(fp);
                parsed_count += 1;
            }
            Ok(None) => {
                skipped += 1;
            }
            Err(err) => {
                if args.verbose {
                    eprintln!("[client] skip {} ({})", rel, err);
                }
                skipped += 1;
            }
        }

        if (i + 1) % 50 == 0 {
            let _ = write!(
                io::stderr(),
                "\r[client] parsed {}/{}",
                parsed_count,
                rel_paths.len()
            );
            let _ = io::stderr().flush();
        }
    }
    let _ = writeln!(
        io::stderr(),
        "\r[client] parsed {}/{}",
        parsed_count,
        rel_paths.len()
    );
    if skipped > 0 {
        println!(
            "[client] skipped {} (unsupported / unreadable / unparseable / oversized / binary)",
            skipped
        );
    }

    let total_symbols: usize = files.iter().map(|f| f.symbols.len()).sum();
    let total_calls: usize = files.iter().map(|f| f.calls.len()).sum();
    let total_imports: usize = files.iter().map(|f| f.imports.len()).sum();

    let payload = IngestPayload {
        repo_id: repo_id.clone(),
        slug: slug.clone(),
        git_origin: origin,
        first_commit_sha: sha,
        machine_id,
        abs_path: repo_path.to_string_lossy().to_string(),
        package_workspaces: if pkg_ws.is_empty() { None } else { Some(pkg_ws) },
        files,
        full_replace: args.full_replace,
    };

    let payload_json = serde_json::to_string(&payload).context("serialize payload")?;
    let payload_kb = payload_json.len() as f64 / 1024.0;
    let payload_mb = payload_kb / 1024.0;
    println!(
        "[client] files={} symbols={} calls={} imports={}",
        payload.files.len(),
        total_symbols,
        total_calls,
        total_imports
    );
    println!(
        "[client] payload size: {:.1} KB ({:.2} MB)",
        payload_kb, payload_mb
    );

    if args.dry_run {
        println!("[client] --dry-run: not contacting server.");
        println!("[client] full_replace={}", args.full_replace);
        println!(
            "[client] would POST to {}/mcp (tool: code_ingest_repo)",
            server_url.trim_end_matches('/')
        );
        return Ok(());
    }

    if payload_json.len() > (9.5 * 1024.0 * 1024.0) as usize {
        eprintln!(
            "[client] WARN: payload {:.1} KB approaches the server's 10 MB body limit. Consider chunking.",
            payload_kb
        );
    }

    println!("[client] connecting to {} ...", server_url);
    let (session_id, _init_result) = mcp::initialize(&server_url, &api_key)?;
    println!(
        "[client] session opened: {}…",
        &session_id[..session_id.len().min(8)]
    );

    let payload_value: serde_json::Value =
        serde_json::from_str(&payload_json).context("re-parse payload to Value for MCP send")?;
    let result = mcp::tools_call(
        &server_url,
        &api_key,
        &session_id,
        "code_ingest_repo",
        &payload_value,
    )?;
    let pretty = if let Some(text) = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
    {
        serde_json::from_str::<serde_json::Value>(text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or_else(|_| text.to_string()))
            .unwrap_or_else(|_| text.to_string())
    } else {
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string())
    };
    println!("[client] ingest result: {}", pretty);
    Ok(())
}
