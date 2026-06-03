# cortexmd — Claude Code plugin

One-install packaging of the cortexmd MCP server + its automation hooks + a tools skill.
This is the modern alternative to `cortexmd init` (which patches `settings.json` directly).

## What it wires

- **MCP server** (`.mcp.json`) — registers the cortexmd HTTP MCP endpoint at
  `<server_url>/mcp`. Set `server_url` when enabling the plugin (default
  `http://localhost:3000`).
- **Hooks** (`hooks/hooks.json`) — binary-subcommand hooks:
  - `UserPromptSubmit` → `cortexmd recall --hook` — per-prompt memory recall + inject (sweep).
  - `SessionStart` → `cortexmd hud-line --ensure-daemon` — keeps the HUD statusline alive.
  - `PreToolUse:Bash` → `cortexmd rewrite --hook` — rewrites grep/cat/head/tail to code-nav.
  - `PostToolUse:Bash` → `cortexmd store-memory --hook` — captures high-signal commands.
- **Skill** (`skills/cortexmd/`) — nudges the agent toward the cheap `code_*` / `memory_*` tools.

## Prerequisites

1. A **running cortexmd server** (see the repo's `docs/deploy-local.md` / `docs/deploy-http.md`,
   or `docker compose up`).
2. The **`cortexmd` binary on `PATH`** (the hooks shell out to it). Build with
   `cargo build --release -p cortexmd-cli` and put it on `PATH`, or run `cortexmd auth`
   once so credentials are cached.

The MCP tools work without the hooks; the hooks only change *when* the agent reaches for them.

## Install

From this repo as a marketplace:

```sh
claude plugin marketplace add Leicas/cortexmd
claude plugin install cortexmd@cortexmd
```

Local development / testing:

```sh
claude --plugin-dir ./plugin/cortexmd
# validate the manifest before shipping:
claude plugin validate ./plugin/cortexmd
```

Then restart Claude Code (or `/reload-plugins`) and set `server_url` if your server is not
on `http://localhost:3000`.
