//! `cortexmd init` — Claude Code (and friends) integration.
//!
//! Modeled on `rtk init`. Installs three artifacts so an AI agent picks up
//! cheap cortexmd tooling without per-project hand-rolling:
//!
//!   1. `CORTEXMD.md` — a short instruction block the agent loads via an
//!      `@CORTEXMD.md` reference in `CLAUDE.md`. Lists the cheap
//!      `code_*` MCP tools and the `cortexmd` subcommands.
//!   2. `@CORTEXMD.md` reference appended to `CLAUDE.md` (idempotent —
//!      we don't duplicate the line if it's already there).
//!   3. A set of hooks in `settings.json` (idempotent — re-running never
//!      duplicates). Two kinds:
//!      a. Binary-subcommand hooks that run `cortexmd <sub>` directly:
//!        - `SessionStart` → `hud-line --ensure-daemon` (HUD daemon liveness)
//!        - `UserPromptSubmit` → `recall --hook` (auto-recall relevant memory
//!          before each prompt; reads the event JSON from stdin)
//!        - `PostToolUse:Bash` → `store-memory --hook` (auto-capture
//!          high-signal Bash invocations; reads the event JSON from stdin)
//!        - `PreToolUse:Bash` → `rewrite --hook` (code-nav Bash rewrite)
//!      b. Node-script hooks dropped in `<claude_dir>/hooks/cortexmd/` and run
//!         via `node <abs-path>` (see `HOOK_SCRIPTS` / `SCRIPT_HOOKS`):
//!        - `SessionStart` → code-nav hint + background auto-index
//!        - `UserPromptSubmit` → memory recall + trigger capture
//!        - `PreToolUse:Read|Grep|Glob` → code-nav advisory
//!        - `PostToolUse:Bash` → deterministic high-signal capture
//!        - `Stop` → periodic diary nudge (`agent_diary_append`)
//!        - `PreCompact` → diary snapshot before compaction
//!      The shipped-but-opt-in scripts (`pretooluse_hook.mjs`, the two `.sh`
//!      hooks) are written to disk but not auto-wired — see `SCRIPT_HOOKS`.
//!
//! Scope:
//!   - `--global` writes to `~/.claude/`. Default is project-local
//!     `./.claude/` (created if missing).
//!   - `--hook-only` skips the CORTEXMD.md write.
//!   - `--auto-patch` / `--no-patch` control settings.json patching.
//!   - `--show` prints the current install state and exits.
//!   - `--uninstall` removes everything this tool wrote (matched by command
//!     in settings.json, marker line in CLAUDE.md).

use anyhow::{Context, Result};
use serde_json::Value;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};

use crate::cli::InitArgs;

const MARKDOWN_FILE: &str = "CORTEXMD.md";
const CLAUDE_MD: &str = "CLAUDE.md";
const SETTINGS_JSON: &str = "settings.json";
const MD_REFERENCE: &str = "@CORTEXMD.md";
/// Pre-rename artifacts cleaned up on uninstall / re-init so users who ran the
/// old `obsidian-mcp-client init` don't keep stale files/refs around.
const LEGACY_MARKDOWN_FILES: &[&str] = &["OBSIDIAN-MCP.md"];
const LEGACY_MD_REFERENCES: &[&str] = &["@OBSIDIAN-MCP.md"];

/// One hook entry the installer wires into `settings.json`. The full set of
/// `HOOKS` below is the canonical install — re-running `init` patches in
/// whatever's missing without disturbing existing entries.
struct HookSpec {
    /// Event name under `hooks.<event>` in settings.json
    /// (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, …).
    event: &'static str,
    /// Optional `matcher` field (tool-name pattern). `None` means the entry
    /// has no matcher — typical for SessionStart / UserPromptSubmit.
    matcher: Option<&'static str>,
    /// Shell command Claude Code runs when the event fires.
    command: &'static str,
    /// Per-hook timeout in seconds. Hook protocol cap is 60s; we stay well
    /// under that.
    timeout: u32,
    /// Optional one-line label shown in the Claude Code statusline while the
    /// hook is executing.
    status_message: Option<&'static str>,
}

const HOOKS: &[HookSpec] = &[
    HookSpec {
        event: "SessionStart",
        matcher: None,
        command: "cortexmd hud-line --ensure-daemon",
        timeout: 5,
        status_message: Some("Ensuring cortexmd HUD-line daemon..."),
    },
    HookSpec {
        event: "UserPromptSubmit",
        matcher: None,
        command: "cortexmd recall --hook",
        timeout: 8,
        status_message: Some("cortexmd recall..."),
    },
    HookSpec {
        event: "PostToolUse",
        matcher: Some("Bash"),
        command: "cortexmd store-memory --hook",
        timeout: 5,
        status_message: None,
    },
    HookSpec {
        event: "PreToolUse",
        matcher: Some("Bash"),
        command: "cortexmd rewrite --hook",
        timeout: 5,
        status_message: None,
    },
];

// ── Node hook scripts ───────────────────────────────────────────────────────
//
// The richer hooks (diary auto-write, code-nav hints, memory recall/capture)
// are Node scripts rather than `cortexmd` subcommands. We embed them at compile
// time, drop them into `<claude_dir>/hooks/cortexmd/` on install, and wire the
// settings.json entries to run them with `node <abs-path>`. They delegate all
// HTTP + credentials back to the `cortexmd` binary via `_mcp_rest.mjs`.

/// Subdirectory (under the resolved `.claude/` dir) the scripts are written to.
const HOOK_SCRIPT_SUBDIR: &str = "hooks/cortexmd";

/// One embedded hook script: a filename + its compile-time contents.
struct HookScript {
    name: &'static str,
    contents: &'static str,
}

/// Every script we drop on disk. `_mcp_rest.mjs` is the shared helper imported
/// by the others — it is not itself a hook, but must be present.
const HOOK_SCRIPTS: &[HookScript] = &[
    HookScript { name: "_mcp_rest.mjs", contents: include_str!("../hooks/_mcp_rest.mjs") },
    HookScript { name: "userprompt_hook.mjs", contents: include_str!("../hooks/userprompt_hook.mjs") },
    HookScript { name: "pretooluse_hook.mjs", contents: include_str!("../hooks/pretooluse_hook.mjs") },
    HookScript { name: "posttooluse_hook.mjs", contents: include_str!("../hooks/posttooluse_hook.mjs") },
    HookScript { name: "code_nav_hint_hook.mjs", contents: include_str!("../hooks/code_nav_hint_hook.mjs") },
    HookScript { name: "wakeup_directive_hook.mjs", contents: include_str!("../hooks/wakeup_directive_hook.mjs") },
    HookScript { name: "code_nav_pretool_hook.mjs", contents: include_str!("../hooks/code_nav_pretool_hook.mjs") },
    HookScript { name: "diary_stop_hook.mjs", contents: include_str!("../hooks/diary_stop_hook.mjs") },
    HookScript { name: "precompact_diary_hook.mjs", contents: include_str!("../hooks/precompact_diary_hook.mjs") },
    // Opt-in bash alternatives to the Node diary hooks (need python on PATH).
    // Shipped on disk for manual wiring; never auto-installed.
    HookScript { name: "stop-hook.sh", contents: include_str!("../hooks/stop-hook.sh") },
    HookScript { name: "precompact-hook.sh", contents: include_str!("../hooks/precompact-hook.sh") },
];

/// A settings.json hook whose command runs one of the embedded Node scripts.
/// The script filename is resolved to an absolute `node <path>` command at
/// install time (see `resolve_script_hooks`).
struct ScriptHookSpec {
    event: &'static str,
    matcher: Option<&'static str>,
    /// Filename in `HOOK_SCRIPTS` this entry runs.
    script: &'static str,
    timeout: u32,
    status_message: Option<&'static str>,
}

/// Node hooks wired into settings.json. We intentionally do NOT auto-install
/// `pretooluse_hook.mjs` (per-tool memory injection on every Read/Edit/Bash) —
/// it is the noisiest hook and overlaps with the UserPromptSubmit recall, so
/// it ships on disk but stays opt-in (wire it by hand if you want it). The two
/// bash hooks (`stop-hook.sh` / `precompact-hook.sh`) are also opt-in: they
/// need python on PATH and duplicate the Node diary hooks.
const SCRIPT_HOOKS: &[ScriptHookSpec] = &[
    ScriptHookSpec {
        event: "UserPromptSubmit",
        matcher: None,
        script: "userprompt_hook.mjs",
        timeout: 8,
        status_message: Some("cortexmd memory recall..."),
    },
    ScriptHookSpec {
        event: "SessionStart",
        matcher: None,
        script: "code_nav_hint_hook.mjs",
        timeout: 6,
        status_message: Some("cortexmd code-nav hint..."),
    },
    ScriptHookSpec {
        event: "SessionStart",
        matcher: None,
        script: "wakeup_directive_hook.mjs",
        timeout: 6,
        status_message: None,
    },
    ScriptHookSpec {
        event: "PreToolUse",
        matcher: Some("Read|Grep|Glob"),
        script: "code_nav_pretool_hook.mjs",
        timeout: 5,
        status_message: None,
    },
    ScriptHookSpec {
        event: "PostToolUse",
        matcher: Some("Bash"),
        script: "posttooluse_hook.mjs",
        timeout: 5,
        status_message: None,
    },
    ScriptHookSpec {
        event: "Stop",
        matcher: None,
        script: "diary_stop_hook.mjs",
        timeout: 8,
        status_message: None,
    },
    ScriptHookSpec {
        event: "PreCompact",
        matcher: None,
        script: "precompact_diary_hook.mjs",
        timeout: 8,
        status_message: None,
    },
];

/// An owned hook ready to be matched/inserted in settings.json. Produced from
/// either a static `HookSpec` (binary subcommand) or a `ScriptHookSpec` (Node
/// script resolved to an absolute path).
struct ResolvedHook {
    event: &'static str,
    matcher: Option<&'static str>,
    command: String,
    timeout: u32,
    status_message: Option<&'static str>,
}

/// Quote a script path for use inside a shell command. We keep it simple:
/// wrap in double quotes (handles spaces) — paths with embedded double quotes
/// are not supported (and never occur for a `.claude` dir).
fn node_command_for(script_path: &Path) -> String {
    format!("node \"{}\"", script_path.display())
}

/// Build the full set of hooks for a given install dir: the static binary
/// hooks plus the Node script hooks resolved against `<claude_dir>/hooks/cortexmd/`.
fn resolve_all_hooks(claude_dir: &Path) -> Vec<ResolvedHook> {
    let script_dir = claude_dir.join(HOOK_SCRIPT_SUBDIR);
    let mut out: Vec<ResolvedHook> = HOOKS
        .iter()
        .map(|h| ResolvedHook {
            event: h.event,
            matcher: h.matcher,
            command: h.command.to_string(),
            timeout: h.timeout,
            status_message: h.status_message,
        })
        .collect();
    for s in SCRIPT_HOOKS {
        let path = script_dir.join(s.script);
        out.push(ResolvedHook {
            event: s.event,
            matcher: s.matcher,
            command: node_command_for(&path),
            timeout: s.timeout,
            status_message: s.status_message,
        });
    }
    out
}

/// Write every embedded hook script into `<claude_dir>/hooks/cortexmd/`.
/// Idempotent: only rewrites a file when its contents differ. Returns the
/// number of files written/updated.
fn install_hook_scripts(claude_dir: &Path, verbose: u8) -> Result<usize> {
    let script_dir = claude_dir.join(HOOK_SCRIPT_SUBDIR);
    fs::create_dir_all(&script_dir)
        .with_context(|| format!("create {}", script_dir.display()))?;
    let mut written = 0;
    for s in HOOK_SCRIPTS {
        let path = script_dir.join(s.name);
        if write_if_changed(&path, s.contents, verbose)? {
            written += 1;
            if verbose > 0 {
                eprintln!("  wrote {}", path.display());
            }
        }
    }
    Ok(written)
}

/// Remove the installed hook-script directory (and the scripts in it). Returns
/// true if anything was removed.
fn remove_hook_scripts(claude_dir: &Path) -> Result<bool> {
    let script_dir = claude_dir.join(HOOK_SCRIPT_SUBDIR);
    if !script_dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&script_dir)
        .with_context(|| format!("remove {}", script_dir.display()))?;
    Ok(true)
}

/// Commands we used to install but no longer want present. Stripped on every
/// `init` run so users don't accumulate stale entries when we rename the bin
/// or drop a hook.
const LEGACY_COMMANDS: &[&str] = &[
    "obsidian-mcp-indexer hud-line --ensure-daemon",
    "obsidian-mcp-client hud-line --ensure-daemon",
    "obsidian-mcp-client recall --hook",
    "obsidian-mcp-client store-memory --hook",
    "obsidian-mcp-client rewrite --hook",
];

/// Slim instruction block. Contract: `#`-headings, no surprises, kept short
/// enough to stay relevant after CLAUDE.md inlines it.
const OBSIDIAN_MD: &str = r#"# cortexmd

**What**: Local CLI for a `cortexmd` server. Indexes repos for code-nav,
mirrors a SQLite cache of the symbol DB, and drives session hooks (HUD line,
memory recall, store-memory).

## Cheap MCP code-nav tools (prefer over Read/Grep on TS/JS/Python/Rust/Go/C++)

- `code_symbol_search(query, repo)` — FTS over names/sigs/docstrings (~60 tokens/result)
- `code_file_outline(repo, path)` — file overview without reading the body
- `code_symbol_get(id)` — body of one symbol (capped at 200 lines)
- `code_symbol_callers(id)` / `code_symbol_callees(id)` — call-graph navigation
- `code_change_impact(id, depth)` — transitive callers ("if I change X, who breaks?")
- `code_find_import_cycles(repo)` — file-level SCCs in the call graph
- `code_find_dead_code(repo)` — symbols with no resolved callers
- `code_find_semantic_duplicates(repo, mode=body)` — copy-paste detection via body SimHash
- `code_detect_breaking_changes(repo, since_ts?)` — removed/sig-changed symbols since N

A `PreToolUse:Bash` hook auto-rewrites `grep|cat|head|tail` on indexed repos to
the equivalent code-nav CLI calls — see `cortexmd rewrite --help`.

If `code_repo_list` does not show the current repo, the index is empty:

```sh
cortexmd <repo-path>           # walk + ingest
cortexmd scan <root> --yes     # auto-index every repo under <root>
```

## CLI surface

```sh
cortexmd status                # server, auth, repos, savings
cortexmd discover [<root>]     # list repos under <root>
cortexmd gain [--days N]       # token-savings analytics
cortexmd recall --query "..."  # hybrid memory + notes recall
cortexmd store-memory --content "..."  # append a memory
cortexmd code-search --query "..." [--repo X]
cortexmd code-get --id <16-hex>
cortexmd code-impact --id <16-hex> [--depth 3]
cortexmd code-outline --repo X --path src/foo.ts
cortexmd rewrite "<bash-command>"   # rtk-style code-nav rewrite
```

## Auth bootstrap

```sh
cortexmd auth oauth-login --server URL    # OAuth (zero key paste)
cortexmd auth status                      # config + redacted token
cortexmd auth import-from-claude          # lift creds from Claude Code
```

## Verification

```sh
cortexmd --version
cortexmd init --show       # confirm hook + ref + markdown installed
```
"#;

pub fn cmd_init(args: InitArgs) -> Result<()> {
    let claude_dir = resolve_claude_dir(args.global)?;

    if args.show {
        return cmd_show(&claude_dir, args.global);
    }
    if args.uninstall {
        return cmd_uninstall(&claude_dir, args.global, args.hook_only, args.verbose);
    }

    let mode = patch_mode(&args);
    install(&claude_dir, args.hook_only, mode, args.global, args.verbose)
}

fn install(
    claude_dir: &Path,
    hook_only: bool,
    mode: PatchMode,
    global: bool,
    verbose: u8,
) -> Result<()> {
    fs::create_dir_all(claude_dir)
        .with_context(|| format!("create {}", claude_dir.display()))?;

    if !hook_only {
        let md_path = claude_dir.join(MARKDOWN_FILE);
        let changed = write_if_changed(&md_path, OBSIDIAN_MD, verbose)?;
        if changed {
            println!("  wrote {}", md_path.display());
        } else if verbose > 0 {
            eprintln!("  {} already up to date", md_path.display());
        }
    }

    let claude_md_path = claude_md_target(claude_dir, global);
    let added_ref = add_reference_to_claude_md(&claude_md_path, hook_only)?;
    if added_ref {
        println!("  added `{}` reference to {}", MD_REFERENCE, claude_md_path.display());
    } else if verbose > 0 {
        eprintln!("  {} already references {}", claude_md_path.display(), MD_REFERENCE);
    }

    // Drop the Node hook scripts before patching settings.json — the settings
    // entries reference these files by absolute path.
    let wrote = install_hook_scripts(claude_dir, verbose)?;
    if wrote > 0 {
        println!(
            "  installed {} hook script(s) in {}",
            wrote,
            claude_dir.join(HOOK_SCRIPT_SUBDIR).display()
        );
    } else if verbose > 0 {
        eprintln!("  hook scripts already up to date");
    }

    let hooks = resolve_all_hooks(claude_dir);
    let settings_path = claude_dir.join(SETTINGS_JSON);
    match patch_settings_json(&settings_path, &hooks, mode, verbose)? {
        PatchResult::Patched => {
            println!("  patched {}:", settings_path.display());
            for spec in &hooks {
                println!(
                    "    + {}{} → `{}`",
                    spec.event,
                    spec.matcher.map(|m| format!(":{}", m)).unwrap_or_default(),
                    spec.command,
                );
            }
        }
        PatchResult::AlreadyPresent => {
            if verbose > 0 {
                eprintln!("  {} already has all hooks", settings_path.display());
            }
        }
        PatchResult::Declined => {
            print_manual_hook_instructions(&settings_path, &hooks);
        }
        PatchResult::Skipped => {
            print_manual_hook_instructions(&settings_path, &hooks);
        }
    }

    let scope = if global { "global" } else { "local project" };
    println!("\ncortexmd init complete ({}).", scope);
    println!("  Restart Claude Code to pick up the hooks. Test with: cortexmd status");
    Ok(())
}

// ── show / uninstall ──────────────────────────────────────────────────────

fn cmd_show(claude_dir: &Path, global: bool) -> Result<()> {
    let md_path = claude_dir.join(MARKDOWN_FILE);
    let claude_md_path = claude_md_target(claude_dir, global);
    let settings_path = claude_dir.join(SETTINGS_JSON);

    println!("cortexmd init — current state:");
    println!("  Claude dir         : {}", claude_dir.display());
    println!(
        "  CORTEXMD.md        : {} {}",
        marker(md_path.exists()),
        md_path.display()
    );
    let ref_present = claude_md_has_reference(&claude_md_path).unwrap_or(false);
    println!(
        "  CLAUDE.md @-ref    : {} {}",
        marker(ref_present),
        claude_md_path.display()
    );
    let script_dir = claude_dir.join(HOOK_SCRIPT_SUBDIR);
    println!(
        "  hook scripts       : {} {}",
        marker(script_dir.exists()),
        script_dir.display()
    );
    println!("  settings.json      : {}", settings_path.display());
    let root = read_settings_root(&settings_path).unwrap_or_else(|_| serde_json::json!({}));
    for spec in resolve_all_hooks(claude_dir) {
        let label = format!(
            "    {}{}",
            spec.event,
            spec.matcher.map(|m| format!(":{}", m)).unwrap_or_default(),
        );
        println!(
            "{:<22} : {} {}",
            label,
            marker(hook_present(&root, &spec)),
            spec.command,
        );
    }
    Ok(())
}

fn marker(present: bool) -> &'static str {
    if present { "[ok]" } else { "[--]" }
}

fn cmd_uninstall(claude_dir: &Path, global: bool, hook_only: bool, verbose: u8) -> Result<()> {
    let mut removed: Vec<String> = Vec::new();

    if !hook_only {
        for name in std::iter::once(MARKDOWN_FILE).chain(LEGACY_MARKDOWN_FILES.iter().copied()) {
            let md_path = claude_dir.join(name);
            if md_path.exists() {
                fs::remove_file(&md_path)
                    .with_context(|| format!("remove {}", md_path.display()))?;
                removed.push(format!("{}", md_path.display()));
            }
        }
    }

    let claude_md_path = claude_md_target(claude_dir, global);
    if claude_md_path.exists() && remove_reference_from_claude_md(&claude_md_path)? {
        removed.push(format!("{} (removed @-ref)", claude_md_path.display()));
    }

    let settings_path = claude_dir.join(SETTINGS_JSON);
    if settings_path.exists() && remove_hook_from_settings(claude_dir, &settings_path, verbose)? {
        removed.push(format!("{} (removed cortexmd hooks)", settings_path.display()));
    }

    if remove_hook_scripts(claude_dir)? {
        removed.push(format!("{} (removed hook scripts)", claude_dir.join(HOOK_SCRIPT_SUBDIR).display()));
    }

    if removed.is_empty() {
        println!("cortexmd init: nothing installed under {} (nothing to remove)", claude_dir.display());
    } else {
        println!("cortexmd uninstall — removed:");
        for r in &removed {
            println!("  - {}", r);
        }
        println!("Restart Claude Code to apply.");
    }
    Ok(())
}

// ── path resolution ───────────────────────────────────────────────────────

fn resolve_claude_dir(global: bool) -> Result<PathBuf> {
    if global {
        let home = dirs::home_dir().context("could not determine HOME")?;
        Ok(home.join(".claude"))
    } else {
        let cwd = std::env::current_dir().context("could not determine current dir")?;
        Ok(cwd.join(".claude"))
    }
}

/// In global mode, the @OBSIDIAN-MCP.md reference goes in `~/.claude/CLAUDE.md`
/// (next to settings.json). In project mode, the convention is to put project
/// instructions in `./CLAUDE.md` at the repo root, NOT inside `./.claude/`.
fn claude_md_target(claude_dir: &Path, global: bool) -> PathBuf {
    if global {
        claude_dir.join(CLAUDE_MD)
    } else {
        match claude_dir.parent() {
            Some(parent) => parent.join(CLAUDE_MD),
            None => claude_dir.join(CLAUDE_MD),
        }
    }
}

// ── markdown writing ──────────────────────────────────────────────────────

fn write_if_changed(path: &Path, content: &str, verbose: u8) -> Result<bool> {
    if path.exists() {
        let existing = fs::read_to_string(path)
            .with_context(|| format!("read {}", path.display()))?;
        if existing == content {
            return Ok(false);
        }
        if verbose > 0 {
            eprintln!("  updating {}", path.display());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, content).with_context(|| format!("write {}", path.display()))?;
    Ok(true)
}

// ── CLAUDE.md @-reference handling ────────────────────────────────────────

fn claude_md_has_reference(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    Ok(text.lines().any(|l| l.trim() == MD_REFERENCE))
}

fn add_reference_to_claude_md(path: &Path, hook_only: bool) -> Result<bool> {
    if hook_only {
        return Ok(false);
    }
    if claude_md_has_reference(path)? {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let mut new = if path.exists() {
        let mut existing = fs::read_to_string(path)
            .with_context(|| format!("read {}", path.display()))?;
        if !existing.ends_with('\n') {
            existing.push('\n');
        }
        existing
    } else {
        String::new()
    };
    if !new.is_empty() && !new.ends_with("\n\n") {
        new.push('\n');
    }
    new.push_str(MD_REFERENCE);
    new.push('\n');
    fs::write(path, new).with_context(|| format!("write {}", path.display()))?;
    Ok(true)
}

fn is_md_reference_line(line: &str) -> bool {
    let t = line.trim();
    t == MD_REFERENCE || LEGACY_MD_REFERENCES.contains(&t)
}

fn remove_reference_from_claude_md(path: &Path) -> Result<bool> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    if !text.lines().any(is_md_reference_line) {
        return Ok(false);
    }
    let cleaned: Vec<&str> = text
        .lines()
        .filter(|l| !is_md_reference_line(l))
        .collect();
    let mut joined = cleaned.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    fs::write(path, joined).with_context(|| format!("write {}", path.display()))?;
    Ok(true)
}

// ── settings.json patching ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum PatchMode {
    Ask,
    Auto,
    Skip,
}

fn patch_mode(args: &InitArgs) -> PatchMode {
    if args.no_patch {
        PatchMode::Skip
    } else if args.auto_patch {
        PatchMode::Auto
    } else {
        PatchMode::Ask
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PatchResult {
    Patched,
    AlreadyPresent,
    Declined,
    Skipped,
}

/// Read settings.json into a JSON Value (or `{}` if the file is missing /
/// empty). Used by both `cmd_show` and the patcher.
fn read_settings_root(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let text = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&text)
        .with_context(|| format!("parse JSON {}", path.display()))
}

/// Is a hook already present in the JSON tree? An entry counts as present iff
/// its `matcher` matches the spec (treating an absent matcher the same as
/// `None`) AND any of its inner `hooks[].command` strings equals the spec's
/// command.
fn hook_present(root: &Value, spec: &ResolvedHook) -> bool {
    let arr = match root
        .get("hooks")
        .and_then(|h| h.get(spec.event))
        .and_then(|s| s.as_array())
    {
        Some(a) => a,
        None => return false,
    };
    arr.iter().any(|entry| {
        let matcher = entry.get("matcher").and_then(|v| v.as_str());
        let matcher_ok = match (spec.matcher, matcher) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(want), Some(got)) => want == got,
            (Some(_), None) => false,
        };
        if !matcher_ok {
            return false;
        }
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|inner| {
                inner.iter().any(|h| {
                    h.get("command").and_then(|c| c.as_str()) == Some(spec.command.as_str())
                })
            })
            .unwrap_or(false)
    })
}

/// Strip every inner hook whose command matches one of `commands`, across
/// every event under `hooks.*`. Empty entry shells (no remaining inner
/// hooks) are dropped too. Returns `true` if anything was removed.
fn strip_hook_commands(root: &mut Value, commands: &[&str]) -> bool {
    let hooks = match root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        Some(o) => o,
        None => return false,
    };
    let mut changed = false;
    for (_event, entries_value) in hooks.iter_mut() {
        let entries = match entries_value.as_array_mut() {
            Some(a) => a,
            None => continue,
        };
        for entry in entries.iter_mut() {
            if let Some(inner) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let before = inner.len();
                inner.retain(|h| {
                    let cmd = h.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    !commands.iter().any(|c| *c == cmd)
                });
                if inner.len() != before {
                    changed = true;
                }
            }
        }
        let before = entries.len();
        entries.retain(|entry| {
            entry
                .get("hooks")
                .and_then(|h| h.as_array())
                .map(|arr| !arr.is_empty())
                .unwrap_or(true)
        });
        if entries.len() != before {
            changed = true;
        }
    }
    changed
}

/// Insert one hook at the right place under `hooks.<event>`. Idempotency is
/// the caller's responsibility — call `hook_present` first.
fn insert_hook_entry(root: &mut Value, spec: &ResolvedHook) -> Result<()> {
    let root_obj = match root.as_object_mut() {
        Some(obj) => obj,
        None => {
            *root = serde_json::json!({});
            root.as_object_mut().expect("just created")
        }
    };
    let hooks = root_obj
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("`hooks` value is not an object")?;
    let entries = hooks
        .entry(spec.event.to_string())
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .with_context(|| format!("`hooks.{}` is not an array", spec.event))?;

    let mut inner = serde_json::Map::new();
    inner.insert("type".to_string(), Value::String("command".to_string()));
    inner.insert("command".to_string(), Value::String(spec.command.clone()));
    inner.insert("timeout".to_string(), Value::Number(spec.timeout.into()));
    if let Some(msg) = spec.status_message {
        inner.insert("statusMessage".to_string(), Value::String(msg.to_string()));
    }

    let mut entry = serde_json::Map::new();
    if let Some(matcher) = spec.matcher {
        entry.insert("matcher".to_string(), Value::String(matcher.to_string()));
    }
    entry.insert(
        "hooks".to_string(),
        Value::Array(vec![Value::Object(inner)]),
    );
    entries.push(Value::Object(entry));
    Ok(())
}

fn patch_settings_json(
    path: &Path,
    hooks: &[ResolvedHook],
    mode: PatchMode,
    verbose: u8,
) -> Result<PatchResult> {
    let mut root = read_settings_root(path)?;

    let missing: Vec<&ResolvedHook> = hooks
        .iter()
        .filter(|spec| !hook_present(&root, spec))
        .collect();
    let has_legacy = HOOKS_legacy_present(&root);
    if missing.is_empty() && !has_legacy {
        return Ok(PatchResult::AlreadyPresent);
    }

    match mode {
        PatchMode::Skip => return Ok(PatchResult::Skipped),
        PatchMode::Ask => {
            if !prompt_user_consent(path, &missing)? {
                return Ok(PatchResult::Declined);
            }
        }
        PatchMode::Auto => {}
    }

    if has_legacy {
        let stripped = strip_hook_commands(&mut root, LEGACY_COMMANDS);
        if stripped && verbose > 0 {
            eprintln!("  removed legacy hook entries: {:?}", LEGACY_COMMANDS);
        }
    }
    for spec in &missing {
        insert_hook_entry(&mut root, spec)?;
    }

    if path.exists() {
        let backup = path.with_extension("json.bak");
        fs::copy(path, &backup)
            .with_context(|| format!("backup {} → {}", path.display(), backup.display()))?;
        if verbose > 0 {
            eprintln!("  backup: {}", backup.display());
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(&root)
        .context("serialize settings.json")?;
    fs::write(path, serialized)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(PatchResult::Patched)
}

#[allow(non_snake_case)]
fn HOOKS_legacy_present(root: &Value) -> bool {
    let hooks = match root.get("hooks").and_then(|h| h.as_object()) {
        Some(o) => o,
        None => return false,
    };
    hooks.values().any(|entries| {
        entries
            .as_array()
            .map(|arr| {
                arr.iter().any(|entry| {
                    entry
                        .get("hooks")
                        .and_then(|h| h.as_array())
                        .map(|inner| {
                            inner.iter().any(|h| {
                                let cmd = h.get("command").and_then(|c| c.as_str()).unwrap_or("");
                                LEGACY_COMMANDS.iter().any(|c| *c == cmd)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    })
}

fn remove_hook_from_settings(claude_dir: &Path, path: &Path, verbose: u8) -> Result<bool> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(false);
    }
    let mut root: Value = serde_json::from_str(&text)
        .with_context(|| format!("parse JSON {}", path.display()))?;

    let resolved = resolve_all_hooks(claude_dir);
    let mut all_commands: Vec<&str> = resolved.iter().map(|s| s.command.as_str()).collect();
    all_commands.extend_from_slice(LEGACY_COMMANDS);

    let removed_anything = strip_hook_commands(&mut root, &all_commands);
    if !removed_anything {
        return Ok(false);
    }

    let backup = path.with_extension("json.bak");
    fs::copy(path, &backup)
        .with_context(|| format!("backup {} → {}", path.display(), backup.display()))?;
    if verbose > 0 {
        eprintln!("  backup: {}", backup.display());
    }
    let serialized = serde_json::to_string_pretty(&root)
        .context("serialize settings.json")?;
    fs::write(path, serialized)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(true)
}

fn prompt_user_consent(settings_path: &Path, missing: &[&ResolvedHook]) -> Result<bool> {
    use std::io::{BufRead, Write};
    eprintln!(
        "\n  patch {} to add the following hook(s)?",
        settings_path.display()
    );
    for spec in missing {
        eprintln!(
            "    + {}{} → `{}`",
            spec.event,
            spec.matcher.map(|m| format!(":{}", m)).unwrap_or_default(),
            spec.command,
        );
    }
    eprint!("  [y/N] ");
    if !io::stdin().is_terminal() {
        eprintln!("\n  (non-interactive, defaulting to N — re-run with --auto-patch to skip the prompt)");
        return Ok(false);
    }
    let _ = io::stderr().flush();
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line).context("read stdin")?;
    let resp = line.trim().to_ascii_lowercase();
    Ok(resp == "y" || resp == "yes")
}

fn print_manual_hook_instructions(settings_path: &Path, hooks: &[ResolvedHook]) {
    println!("\n  MANUAL STEP — add the following entries to {}:", settings_path.display());
    for spec in hooks {
        println!("\n  hooks.{}:", spec.event);
        if let Some(matcher) = spec.matcher {
            println!("    {{ \"matcher\": \"{}\", \"hooks\": [", matcher);
        } else {
            println!("    {{ \"hooks\": [");
        }
        let status = spec
            .status_message
            .map(|m| format!(", \"statusMessage\": \"{}\"", m))
            .unwrap_or_default();
        println!(
            "      {{ \"type\": \"command\", \"command\": \"{}\", \"timeout\": {}{} }}",
            spec.command, spec.timeout, status,
        );
        println!("    ] }}");
    }
    println!();
}
