//! CLI argument schema. Two top-level shapes:
//!
//! 1. The default ("index") shape: `cortexmd <repo-path> [flags]`
//!    is preserved for backwards compatibility — the bootstrap behaviour is
//!    unchanged for anyone already wired up.
//! 2. Subcommands: `auth`, `init`, `status`, `discover`, `scan`, `gain`,
//!    `hud-line`, `recall`, `store-memory`, `repo-list`, `code-search`,
//!    `code-get`, `code-impact`, `code-outline`, `code-find-duplicates`,
//!    `code-chain`, `bench`, `pull`.
//!
//! The `clap` setup uses an `Option<Subcommand>` plus a flattened `IndexArgs`
//! so the bare positional repo path keeps working without an explicit `index`
//! verb.
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "cortexmd",
    version,
    about = "cortexmd CLI: index repos, query code-nav, drive session hooks, integrate with Claude Code.",
    long_about = "cortexmd — local CLI for a cortexmd server.\n\
\n\
Index:    cortexmd <repo>            (default action)\n\
          cortexmd scan <root>       (auto-index every repo)\n\
\n\
Inspect:  cortexmd status            (server + repos + savings)\n\
          cortexmd discover [<root>] (list repos under <root>)\n\
          cortexmd gain [--days N]   (token-savings analytics)\n\
\n\
Auth:     cortexmd auth oauth-login --server URL\n\
          cortexmd auth status\n\
\n\
Editor:   cortexmd init -g           (install hook + CORTEXMD.md)\n\
          cortexmd init --show       (show current installation)",
    args_conflicts_with_subcommands = true
)]
pub struct Cli {
    /// Subcommand. When absent, the default action is to index `repo_path`.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Default-action arguments (only used when no subcommand is given).
    #[command(flatten)]
    pub index: IndexArgs,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    // ── index ────────────────────────────────────────────────────────────
    /// Explicitly run the indexing action (same as the bare positional form).
    Index(IndexArgs),
    /// Discover git repos under <root> and auto-index any that aren't yet
    /// registered with the server.
    Scan(ScanArgs),

    // ── inspect ──────────────────────────────────────────────────────────
    /// Show server URL, auth method+expiry, registered repos, and token
    /// savings (when the server exposes `code_nav_stats`).
    Status,
    /// List git repos under a root and mark which ones are registered.
    Discover(DiscoverArgs),
    /// Print token-savings stats fetched from the server's `code_nav_stats`
    /// MCP tool. Pass `--days N` to filter the history window.
    Gain(GainArgs),

    /// Bridge daemon: poll cortexmd's `/api/hud-stats` and rewrite
    /// claude-hud's `display.customLine` so the in-session statusline shows
    /// server-side savings, p95 latency, hot-memory count, and tool-profile
    /// usage. Defaults to 5s polling. `--once` performs a single update and
    /// exits. No-op when claude-hud's config.json isn't found.
    HudLine(HudLineArgs),

    /// Hybrid recall: hit `/api/recall` for memories + notes matching a
    /// query. Prints JSON by default; `--format block` emits a ready-to-paste
    /// markdown block. Used by Claude Code hooks.
    Recall(RecallArgs),

    /// Append a memory via `/api/store-memory`. Used by the PostToolUse hook
    /// for deterministic auto-capture of high-signal commands.
    StoreMemory(StoreMemoryArgs),

    /// Minimal repo list for hook-driven cwd→repo lookup. Hits
    /// `/api/code-repo-list` and prints `{machineId, repos:[{slug, paths:[{abs_path}]}]}`
    /// as JSON. The PreToolUse code-nav advisory uses this to decide when to
    /// nudge an agent toward the cheaper `code_*` MCP tools.
    RepoList(RepoListArgs),

    /// Search code symbols (FTS over name/signature/docstring). Hits
    /// `/api/code-symbol-search`. Mirrors the `code_symbol_search` MCP tool —
    /// useful for shell pipelines and the bench harness.
    CodeSearch(CodeSearchArgs),

    /// Fetch a single symbol's metadata + body by ID. Hits
    /// `/api/code-symbol-get`. Mirrors the `code_symbol_get` MCP tool.
    CodeGet(CodeGetArgs),

    /// Transitive caller graph for a symbol — "who depends on this if I
    /// change it?". Hits `/api/code-change-impact`. Mirrors the
    /// `code_change_impact` MCP tool.
    CodeImpact(CodeImpactArgs),

    /// Symbol outline for a single file in a registered repo (kind, name,
    /// signature, lines — no body). Hits `/api/code-file-outline`. Used as
    /// the rewrite target for `cat|head|tail` on indexed source files.
    CodeOutline(CodeOutlineArgs),

    /// Semantic-duplicate detection across a repo (copy-paste finder via body
    /// SimHash or signature shape). Hits `/api/code-find-semantic-duplicates`.
    /// Mirrors the `code_find_semantic_duplicates` MCP tool. Closes the bench
    /// gap on TASK-018 where the agent could only Bash-grep for repeated
    /// names — see the 2026-05-02 tsbench Run C gap analysis.
    CodeFindDuplicates(CodeFindDuplicatesArgs),

    /// Find a call path from `--from` to `--to` — the ordered list of symbols
    /// where each calls the next, ending at the target. Hits
    /// `/api/code-call-chain`. Mirrors the `code_call_chain` MCP tool. Closes
    /// the bench gap on TASK-029 where the agent returned CANNOT_ANSWER —
    /// see the 2026-05-02 tsbench Run C gap analysis (Gap 1.2).
    CodeChain(CodeChainArgs),

    /// Token-saving rewrite engine. Reads a Bash command on the CLI and
    /// emits the rtk-equivalent (or nothing). Modeled on `rtk rewrite`.
    /// Exit 0+stdout = rewrite (auto-allow); 1 = no equivalent (passthrough);
    /// 2 = deny rule matched (passthrough); 3+stdout = ask (rewrite + prompt).
    Rewrite(RewriteArgs),

    /// Single-binary code-nav benchmark: clones (or reuses) a target repo,
    /// times cold + warm indexing of the client itself against the deployed
    /// server, samples N symbols, and times the three primitive queries
    /// (`code_symbol_search` / `code_symbol_get` / `code_change_impact`) via
    /// in-process HTTP. No Node, no per-query subprocess spawn — strictly
    /// faster than the equivalent `benchmarks/run_code_nav_bench.mjs` path.
    Bench(BenchArgs),

    /// Pull a repo's symbol/call/import snapshot from the server (via the
    /// `code_sync_pull` MCP tool) and cache it locally as JSON. Used to mirror
    /// what other clients have indexed against the same repo. Output path
    /// defaults to `${config_dir}/cortexmd/cache/<slug>.json`.
    Pull(PullArgs),

    // ── auth ─────────────────────────────────────────────────────────────
    /// Manage persisted credentials.
    Auth(AuthArgs),

    /// Golden-fixture support: walk a directory (no git/server required) with
    /// the production parser pipeline and emit the canonical symbol-id payload
    /// to stdout. Used to (re)generate `contract/fixtures/expected-symbol-ids.json`
    /// and as the Rust side of the cross-parser parity check. See
    /// `contract/symbol-id.md`.
    Contract(ContractArgs),

    // ── editor integration ───────────────────────────────────────────────
    /// Install cortexmd hooks and instructions for Claude Code (or
    /// other agents). Modeled on `rtk init`: writes `CORTEXMD.md`,
    /// registers an `@CORTEXMD.md` reference in `CLAUDE.md`, and
    /// idempotently patches `settings.json` with the SessionStart hook that
    /// keeps the HUD-line daemon alive.
    Init(InitArgs),
}

#[derive(clap::Args, Debug, Default)]
pub struct InitArgs {
    /// Install into the user's global Claude config dir (~/.claude/) rather
    /// than the project-local .claude/.
    #[arg(short = 'g', long)]
    pub global: bool,
    /// Show the current installation state and exit.
    #[arg(long)]
    pub show: bool,
    /// Remove all cortexmd artifacts written by `init` (settings.json
    /// hook entry, CORTEXMD.md, the CLAUDE.md reference).
    #[arg(long)]
    pub uninstall: bool,
    /// Patch settings.json without prompting (default: ask y/N when changes
    /// are needed).
    #[arg(long, conflicts_with = "no_patch")]
    pub auto_patch: bool,
    /// Skip settings.json patching; print the manual instructions instead.
    #[arg(long)]
    pub no_patch: bool,
    /// Patch settings.json + CLAUDE.md ref but skip writing CORTEXMD.md.
    #[arg(long)]
    pub hook_only: bool,
    /// Verbosity (-v, -vv).
    #[arg(short, long, action = clap::ArgAction::Count)]
    pub verbose: u8,
}

#[derive(clap::Args, Debug, Default)]
pub struct PullArgs {
    /// Repo slug to pull (mutually exclusive with --repo-id).
    #[arg(long, conflicts_with = "repo_id")]
    pub slug: Option<String>,
    /// 16-char hex repo id to pull (mutually exclusive with --slug).
    #[arg(long, conflicts_with = "slug")]
    pub repo_id: Option<String>,
    /// Only return files re-indexed at or after this epoch-ms timestamp.
    /// Omit to fetch the full snapshot.
    #[arg(long)]
    pub since: Option<u64>,
    /// Override the cache output path. Default:
    /// `${config_dir}/cortexmd/cache/<slug>.json`.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Print the full payload to stdout in addition to writing it.
    #[arg(long)]
    pub print: bool,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct DiscoverArgs {
    /// Root directory to scan (defaults to parent of cwd, falling back to
    /// `D:/dev` on Windows or `~/code` elsewhere).
    pub root: Option<PathBuf>,
    /// BFS depth limit (default 3).
    #[arg(long, default_value_t = 3)]
    pub depth: usize,
}

#[derive(clap::Args, Debug, Default)]
pub struct ScanArgs {
    /// Root directory to scan (defaults to parent of cwd, falling back to
    /// `D:/dev` on Windows or `~/code` elsewhere).
    pub root: Option<PathBuf>,
    /// BFS depth limit (default 3).
    #[arg(long, default_value_t = 3)]
    pub depth: usize,
    /// Skip the per-repo confirmation prompt (also implied when stdin is
    /// not a TTY).
    #[arg(long)]
    pub yes: bool,
}

#[derive(clap::Args, Debug, Default)]
pub struct GainArgs {
    /// Filter the savings history to the last N days.
    #[arg(long)]
    pub days: Option<u32>,
}

#[derive(clap::Args, Debug)]
pub struct HudLineArgs {
    /// Polling interval in seconds (default 5).
    #[arg(long, default_value_t = 5u64)]
    pub interval: u64,
    /// Run a single update then exit (useful for cron-style invocations).
    #[arg(long)]
    pub once: bool,
    /// Idempotent launcher mode: if a daemon is already running (heartbeat is
    /// fresh), exit silently; otherwise spawn a detached daemon and exit. Use
    /// this from a SessionStart hook so each session re-arms the daemon
    /// without ever stacking duplicates.
    #[arg(long)]
    pub ensure_daemon: bool,
    /// Override the claude-hud config.json path. By default the daemon probes
    /// `~/.claude/plugins/claude-hud/config.json` and the marketplaces variant.
    #[arg(long)]
    pub hud_config: Option<PathBuf>,
    /// Maximum line length (claude-hud truncates at 80 chars).
    #[arg(long, default_value_t = 80usize)]
    pub max_len: usize,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
    /// Print the rendered line to stdout in addition to writing it.
    #[arg(long)]
    pub print: bool,
}

impl Default for HudLineArgs {
    fn default() -> Self {
        Self {
            interval: 5,
            once: false,
            ensure_daemon: false,
            hud_config: None,
            max_len: 80,
            server: None,
            api_key: None,
            print: false,
        }
    }
}

#[derive(clap::Args, Debug, Default)]
pub struct RecallArgs {
    /// Search query. Optional only when `--hook` is set (the prompt is read from stdin).
    #[arg(long, default_value = "")]
    pub query: String,
    /// Maximum results per kind (memories, notes). Default 5.
    #[arg(long, default_value_t = 5)]
    pub limit: u32,
    /// What to return: memory | notes | both (default).
    #[arg(long, default_value = "both")]
    pub kinds: String,
    /// Output format: `json` (default) or `block` (markdown context block).
    #[arg(long, default_value = "json")]
    pub format: String,
    /// Hard cap on the rendered block length (chars). Only used with --format block.
    #[arg(long, default_value_t = 800)]
    pub max_chars: usize,
    /// Heading line for the block. Only used with --format block.
    #[arg(long, default_value = "📌 Relevant memory")]
    pub header: String,
    /// Hook mode: read Claude Code's UserPromptSubmit JSON event from stdin,
    /// pull `prompt`, and emit a `--format block` recall result on stdout.
    /// Errors are swallowed (exit 0) so a flaky server never blocks Claude.
    #[arg(long)]
    pub hook: bool,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct RepoListArgs {
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeSearchArgs {
    /// FTS query against symbol name / signature / docstring.
    #[arg(long)]
    pub query: String,
    /// Optional repo slug filter.
    #[arg(long)]
    pub repo: Option<String>,
    /// Optional kind filter: function | class | method | interface | type |
    /// const-export | struct | enum | trait | impl.
    #[arg(long)]
    pub kind: Option<String>,
    /// Maximum number of results (1–100). Default 20.
    #[arg(long, default_value_t = 20)]
    pub limit: u32,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeGetArgs {
    /// 16-char hex symbol ID (returned by `code-search`).
    #[arg(long)]
    pub id: String,
    /// Maximum body lines to return (0–200, default 200).
    #[arg(long, default_value_t = 200)]
    pub max_body_lines: u32,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeImpactArgs {
    /// 16-char hex symbol ID.
    #[arg(long)]
    pub id: String,
    /// BFS depth (1–5, default 3).
    #[arg(long, default_value_t = 3)]
    pub depth: u32,
    /// Cap on transitive callers returned (default 100, max 500).
    #[arg(long, default_value_t = 100)]
    pub limit: u32,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeOutlineArgs {
    /// Repo slug.
    #[arg(long)]
    pub repo: String,
    /// File path relative to the repo root.
    #[arg(long)]
    pub path: String,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeChainArgs {
    /// 16-char hex source symbol ID (the caller).
    #[arg(long = "from")]
    pub source: String,
    /// 16-char hex target symbol ID (the callee to find a path to).
    #[arg(long = "to")]
    pub target: String,
    /// BFS depth limit (1–20, default 8).
    #[arg(long, default_value_t = 8)]
    pub max_depth: u32,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct CodeFindDuplicatesArgs {
    /// Repo slug to scan.
    #[arg(long)]
    pub repo: String,
    /// Detection mode: `body` (SimHash on normalized body — default; catches
    /// near-copy-paste) or `signature` (groups by exact signature shape).
    #[arg(long, default_value = "body")]
    pub mode: String,
    /// Maximum duplicate-group rows to return (default 50).
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct RewriteArgs {
    /// The full shell command line to consider (positional, may contain spaces
    /// and operators — quote it). Reads from stdin if `-` is passed.
    pub command: Option<String>,
    /// Print the rewrite reason to stderr (one line, useful for hook debug).
    #[arg(long)]
    pub explain: bool,
    /// Hook mode: read Claude Code's PreToolUse JSON event from stdin,
    /// extract the `tool_input.command`, run rewrite, and emit Claude's
    /// expected response JSON (`hookSpecificOutput.updatedInput`). Errors
    /// are swallowed (exit 0 + no output) so the hook never blocks.
    #[arg(long)]
    pub hook: bool,
}

#[derive(clap::Args, Debug, Default)]
pub struct BenchArgs {
    /// Path to a local checkout to bench against. If omitted, you must pass
    /// `--clone-url` for the bench to clone one shallow.
    #[arg(long)]
    pub repo_path: Option<PathBuf>,
    /// Optional shallow-clone target if --repo-path is not supplied. Cloned
    /// to `$TEMP/cortexmd-bench/<basename>`.
    #[arg(long)]
    pub clone_url: Option<String>,
    /// Optional override for the registered repo slug used in queries
    /// (default: basename of repo_path).
    #[arg(long)]
    pub repo_slug: Option<String>,
    /// Number of symbols to sample for query timing (default 10).
    #[arg(long, default_value_t = 10)]
    pub samples: u32,
    /// PRNG seed for deterministic sampling (default 42).
    #[arg(long, default_value_t = 42u64)]
    pub seed: u64,
    /// Skip the cold/warm indexing phase (assume the repo is already indexed).
    #[arg(long)]
    pub skip_index: bool,
    /// Skip the query phase (indexing only).
    #[arg(long)]
    pub skip_query: bool,
    /// Output format: `markdown` (default) or `json`.
    #[arg(long, default_value = "markdown")]
    pub format: String,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct StoreMemoryArgs {
    /// Memory content in markdown. Pass `-` to read from stdin. Optional only
    /// when `--hook` is set (content is built from the PostToolUse event).
    #[arg(long, default_value = "")]
    pub content: String,
    /// Category. Default `observation`. Allowed: observation | decision |
    /// insight | conversation | fact | preference | plan | reflection.
    #[arg(long, default_value = "observation")]
    pub category: String,
    /// Optional title — auto-generated from the first line if omitted.
    #[arg(long)]
    pub title: Option<String>,
    /// Tags (repeat --tag for multiple).
    #[arg(long = "tag")]
    pub tags: Vec<String>,
    /// Source label (e.g. `hook:PostToolUse:systemctl`).
    #[arg(long)]
    pub source: Option<String>,
    /// Output format: `json` (default) or `path` (just the stored file path).
    #[arg(long, default_value = "json")]
    pub format: String,
    /// Hook mode: read Claude Code's PostToolUse JSON event from stdin and
    /// auto-build a memory entry from `tool_name` + `tool_input`. Skips low-
    /// signal calls and silently exits 0 on any error so the hook never
    /// blocks Claude.
    #[arg(long)]
    pub hook: bool,
    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,
    /// MCP API key bearer (default: $MCP_API_KEY or persisted config).
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
}

#[derive(clap::Args, Debug, Default)]
pub struct IndexArgs {
    /// Absolute path to the repo to index.
    pub repo_path: Option<PathBuf>,

    /// Override slug (default: basename of repo_path).
    #[arg(long)]
    pub slug: Option<String>,

    /// MCP server base URL (default: $MCP_URL or persisted config).
    #[arg(long, env = "MCP_URL")]
    pub server: Option<String>,

    /// MCP API key bearer (default: $MCP_API_KEY or persisted config) — never logged.
    #[arg(long, env = "MCP_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,

    /// Override machine_id (default: $MACHINE_ID or hostname).
    #[arg(long, env = "MACHINE_ID")]
    pub machine_id: Option<String>,

    /// Send full_replace=true (prune missing files server-side).
    #[arg(long, default_value_t = true)]
    pub full_replace: bool,

    /// Build payload but don't POST; print sizes.
    #[arg(long)]
    pub dry_run: bool,

    /// Verbose progress (per-file).
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(clap::Args, Debug)]
pub struct ContractArgs {
    #[command(subcommand)]
    pub command: ContractCommand,
}

#[derive(Subcommand, Debug)]
pub enum ContractCommand {
    /// Walk <dir> with the production parser and print the per-file symbol-id
    /// payload as JSON to stdout. `repo_id` is a fixed literal (default
    /// `fixture`) so IDs are reproducible without a git checkout or server.
    ///
    /// Two output shapes:
    ///   --emit expected (default) → the golden-file shape:
    ///       { relative_path -> [ { name, kind, id, signature_normalized } ] }
    ///   --emit payload            → the full `code_ingest_repo` File[] payload
    ///       (symbol id/name/kind/signature/signature_normalized/line span).
    Regen {
        /// Directory to walk (e.g. contract/fixtures/sample-repo).
        dir: PathBuf,
        /// Stable repo id used for symbol-id hashing (contract fixtures pin this).
        #[arg(long, default_value = "fixture")]
        repo_id: String,
        /// Output shape: `expected` (golden-file map) or `payload` (full File[]).
        #[arg(long, default_value = "expected")]
        emit: String,
    },
}

#[derive(clap::Args, Debug)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Subcommand, Debug)]
pub enum AuthCommand {
    /// Persist server URL + api key to the per-user config file.
    Login {
        /// MCP server base URL.
        #[arg(long)]
        server: String,
        /// API key. Omit to be prompted (input hidden).
        #[arg(long)]
        api_key: Option<String>,
    },
    /// Print the config file path + redacted summary.
    Status,
    /// Delete the per-user config file.
    Logout {
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Import server URL + bearer from Claude Code's MCP config.
    ImportFromClaude {
        /// Pick a specific entry by name when more than one HTTP MCP server is configured.
        #[arg(long)]
        name: Option<String>,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Run the full OAuth 2.0 (PKCE + DCR) flow against an MCP server: discover
    /// endpoints, register a client, open a browser, run a localhost callback
    /// listener, and persist the resulting access token. Zero-key bootstrap.
    OauthLogin {
        /// MCP server base URL (e.g. `https://mcp.example.com`). When omitted,
        /// falls back to $MCP_URL → persisted config → Claude Code's MCP config.
        /// A trailing `/mcp` is stripped automatically — discovery lives at the host root.
        #[arg(long)]
        server: Option<String>,
        /// Don't try to launch a browser; just print the authorize URL and
        /// wait for the callback.
        #[arg(long)]
        no_browser: bool,
    },
    /// Print the OAuth token cache path + redacted summary.  Never the token.
    OauthStatus,
    /// Delete the OAuth token cache.
    OauthLogout {
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
}
