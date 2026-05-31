//! cortexmd — local CLI for a cortexmd server.
//!
//! Default action walks a repo, parses with tree-sitter, and ships
//! symbol/call/import payloads to a cortexmd server's `code_ingest_repo`
//! tool. Subcommands cover auth bootstrap, code-nav queries, hook daemons,
//! memory recall, benchmarks, and editor integration via `init`.
//!
//! All dispatch logic lives in `cortexmd_cli::run` so the deprecated
//! `obsidian-mcp-client` alias binary can share the exact same behavior.

use anyhow::Result;

fn main() -> Result<()> {
    cortexmd_cli::run()
}
