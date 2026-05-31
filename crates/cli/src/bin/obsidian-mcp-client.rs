//! Deprecated alias for the `cortexmd` binary.
//!
//! Users who still invoke the legacy `obsidian-mcp-client` command get a
//! one-line deprecation warning on stderr, then identical behavior: this
//! binary delegates straight to `cortexmd_cli::run_with_args` with the real
//! arguments. Behavior (including the legacy data-dir migration) is unchanged.
//!
//! This shim is intended to live for one release only.

use anyhow::Result;

fn main() -> Result<()> {
    eprintln!("warning: 'obsidian-mcp-client' is deprecated; use 'cortexmd'");
    cortexmd_cli::run_with_args(std::env::args_os())
}
