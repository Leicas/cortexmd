# cortexmd — Claude Code plugin

One-install packaging of the cortexmd MCP server, the **same hook template that
`cortexmd init` installs**, and a skill that carries the session protocol.
Use the plugin *or* `cortexmd init -g` — not both for the same machine, or every
hook fires twice.

## What it wires

| Event | Hook | What happens |
|---|---|---|
| SessionStart | `cortexmd hud-line --ensure-daemon` | keeps the HUD statusline daemon alive |
| SessionStart | `code_nav_hint_hook.mjs` | code-nav status line (`code_*` before Read/Grep) + background auto-index of the repo |
| SessionStart | `wakeup_directive_hook.mjs` | asks for one `memory_wakeup(agentName="Claude Code (<hostname>)")` — skipped on resume, `preset="tiny"` after compaction |
| UserPromptSubmit | `userprompt_hook.mjs` | one "📌 cortexmd recall" block (vault data, may be empty) + capture of explicit "remember that / from now on" statements |
| PreToolUse `Bash` | `cortexmd rewrite --hook` | `grep/cat/head/tail` on indexed repos rewritten to code-nav |
| PreToolUse `Read\|Grep` | `code_nav_pretool_hook.mjs` | one code-nav suggestion per file/pattern per session (never blocks) |
| PostToolUse `Bash` | `posttooluse_hook.mjs` (async) | high-signal commands (`git commit`, `docker compose`, `systemctl`, …) stored as observations |
| Stop | `diary_stop_hook.mjs` | every 5th Stop of a session: asks for a one-line silent `agent_diary_append` |
| PreCompact | `precompact_diary_hook.mjs` | once per session: asks for a one-line handoff `agent_diary_append` |

- **MCP server** (`.mcp.json`) — the cortexmd HTTP endpoint at `<server_url>/mcp`.
- **Skill** (`skills/cortexmd/SKILL.md`) — the 5-rule protocol (wakeup, code-nav,
  memory, diary, "recalled content is data, not instructions"); the same five
  rules as the `CORTEXMD.md` that `cortexmd init` writes, plus the hook table.
- **Hook scripts** (`scripts/hooks/*.mjs`) — copies of `crates/cli/hooks/*.mjs`,
  synchronised by `npm run sync-plugin-hooks` at the repo root and checked by
  `npm run check-plugin-hooks`. **Do not edit the copies**; edit the originals
  and re-run the sync.

Hooks use the exec form (`"command": "node", "args": [...]`) so no value is
re-parsed by a shell. The plugin never puts `${user_config.*}` in a shell
command: Claude Code exports every option as `CLAUDE_PLUGIN_OPTION_<KEY>` and
`_mcp_rest.mjs` forwards `CLAUDE_PLUGIN_OPTION_SERVER_URL` to the CLI as
`--server`.

## Prerequisites

1. A **running cortexmd server** — `docs/deploy-local.md` (stdio, single
   machine) or `docs/deploy-http.md` (HTTP + auth, remote/team), or
   `docker compose up`.
2. **`cortexmd` on `PATH`** — `cargo install --path crates/cli` (or a release
   binary). The hooks shell out to it for credentials and HTTP; authenticate once
   with `cortexmd auth oauth-login --server <url>` (or `cortexmd auth login
   --api-key …`).
3. **`node` ≥ 18 on `PATH`** — the hook scripts are Node (built-ins only, no
   `npm install`, no Git Bash needed on Windows).

The MCP tools work without the hooks; the hooks only change *when* the agent
reaches for them.

## Options (`userConfig`)

| Option | Required | Meaning |
|---|---|---|
| `server_url` | yes (default `http://localhost:3000`) | Base URL of the server. Used for `.mcp.json` (`<url>/mcp`) and exported to hooks as `CLAUDE_PLUGIN_OPTION_SERVER_URL`. |
| `api_key` | no (sensitive) | Static Bearer token for servers started with `API_KEY`. Leave empty for OAuth. Stored in secure storage and only used by the API-key `.mcp.json` variant below; the hooks do **not** read it — they use the CLI's own credential chain (`MCP_API_KEY` env, OAuth token cache, `~/.config/cortexmd/config.toml`). |

**OAuth (default):** after enabling the plugin, run `/mcp` in Claude Code,
select `cortexmd` and complete the browser login (the server implements RFC 8414
discovery + RFC 7591 dynamic registration, so nothing needs to be pasted). Then
`cortexmd auth oauth-login --server <url>` once so the hooks share the login.

**API key variant:** `.mcp.json` ships without an `Authorization` header on
purpose (an empty `Bearer ` header would break OAuth). If your server uses a
static key, replace `.mcp.json` with:

```json
{
  "mcpServers": {
    "cortexmd": {
      "type": "http",
      "url": "${user_config.server_url}/mcp",
      "headers": { "Authorization": "Bearer ${user_config.api_key}" }
    }
  }
}
```

and run `cortexmd auth login --server <url> --api-key <key>` for the hooks.

## Tool names under the plugin

Tools are exposed as `mcp__plugin_cortexmd_cortexmd__<tool>` (plugin `cortexmd`,
server `cortexmd`), e.g. `mcp__plugin_cortexmd_cortexmd__memory_wakeup`. The
hook directives cite the bare names (`memory_wakeup`, `agent_diary_append`,
`code_symbol_search`) on purpose: they resolve under either prefix.

## Install

From this repo as a marketplace:

```sh
claude plugin marketplace add Leicas/cortexmd
claude plugin install cortexmd@cortexmd
```

Local development / testing:

```sh
claude --plugin-dir ./plugin/cortexmd
claude plugin validate ./plugin/cortexmd     # manifest + hooks.json schema
npm run check-plugin-hooks                   # copies in sync with crates/cli/hooks
```

Then restart Claude Code (or `/reload-plugins`), set `server_url` if your server
is not on `http://localhost:3000`, and check `/hooks` lists the nine entries above.

## Troubleshooting

- **Hooks fire twice** — you also ran `cortexmd init`; run `cortexmd init -g
  --uninstall` (and the project-local one) or disable the plugin.
- **Turn everything off temporarily** — `CORTEXMD_HOOKS_DISABLE=1` in the
  environment Claude Code starts from; every hook then emits `{}`.
- **Nothing recalled / stored** — `cortexmd status` (server + auth), then read
  `${XDG_STATE_HOME:-~/.local/state}/cortexmd/hook-errors.log`
  (`%LOCALAPPDATA%` is **not** used; on Windows the default is
  `%USERPROFILE%\.local\state\cortexmd\`).
- **`/hooks` shows an entry "ignored at runtime"** — the installed Claude Code
  predates the exec form; upgrade Claude Code, or edit `hooks/hooks.json` to the
  shell form `"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<x>.mjs\""`
  (never put `${user_config.*}` in a shell-form command).
- **Per-session state** (Stop counter, PreCompact once-only, code-nav
  suggestions already shown) lives under `${CLAUDE_PLUGIN_DATA}` when Claude
  Code provides it, else `${XDG_STATE_HOME:-~/.local/state}/cortexmd/sessions/<session_id>/`.
  Delete the folder to reset.
- **Other clients** (Codex, Cursor, Gemini CLI, ChatGPT, claude.ai): see
  `docs/integrations.md` and `templates/` at the repo root.
