# Claude Code hooks for cortexmd

These Node + bash scripts integrate Claude Code's hook system with the cortexmd
server. They are installed (and removed) by `cortexmd init` — you normally do
not wire them by hand. See `docs/hooks.md` at the repo root for the full
multi-client guide (Claude Code, Cursor, Mistral/Vibe, Codex, generic MCP).

All scripts delegate credential resolution + HTTP to the `cortexmd` binary
(`cortexmd recall`, `cortexmd store-memory`, `cortexmd repo-list`) via the
shared `_mcp_rest.mjs` helper, so there is one source of truth for auth. Every
script swallows its own errors and emits the schema-valid pass-through (`{}`)
on failure: a broken hook can never block the session.

## Scripts

| File | Event | What it does |
|---|---|---|
| `code_nav_hint_hook.mjs` | SessionStart | In a git repo containing source files, nudges the agent toward the `code_*` MCP tools over Read/Grep; auto-indexes the repo in the background if it is not yet registered. |
| `wakeup_directive_hook.mjs` | SessionStart | Emits a directive telling the agent its FIRST action is to call `memory_wakeup` with the machine-scoped diary agentName (`Claude Code (<host>)`). Diaries are per-machine, so each machine reads/writes its own `Ops/Agent Diaries/Claude Code (<host>)/` directory. |
| `code_nav_pretool_hook.mjs` | PreToolUse (Read/Grep/Glob) | Per-call advisory: if the target is in an indexed repo, suggests the cheaper `code_*` equivalent. Awareness-only — never blocks, never prompts. |
| `userprompt_hook.mjs` | UserPromptSubmit | Recalls memory relevant to the prompt and captures "remember that / never / always" trigger phrases. Strips `<private>…</private>` before anything is stored. |
| `pretooluse_hook.mjs` | PreToolUse | Scoped memory injection before Read/Edit/Bash (have I touched this file / hit this failure before?). |
| `posttooluse_hook.mjs` | PostToolUse (Bash) | Deterministic capture of high-signal commands (systemctl, crontab, chmod/chown, docker compose, git commit) as observations. |
| `diary_stop_hook.mjs` | Stop | Every Nth stop attempt, blocks and asks the agent to append a short recap via `agent_diary_append(silent=true)` under the machine-scoped agentName (`Claude Code (<host>)`). |
| `precompact_diary_hook.mjs` | PreCompact | Always blocks before compaction so the agent writes a diary snapshot (machine-scoped agentName) the next session can wake up from. |
| `stop-hook.sh` | Stop | Bash alternative to the diary stop hook: counts transcript turns and asks for a `memory_store` save every Nth turn. Needs `python3`/`python` on PATH. |
| `precompact-hook.sh` | PreCompact | Bash alternative to the diary precompact hook. |
| `_mcp_rest.mjs` | — | Shared helper (spawns `cortexmd`, caches the repo list, formats memory blocks). Not a hook itself. |

The Node hooks use only Node built-ins, so they work on Windows without Git
Bash. The two `.sh` hooks need a POSIX shell + `python3`/`python` and are an
opt-in alternative to the Node diary hooks (do not enable both for the same
event).

Diaries are **per-machine**: the diary hooks derive the agentName from the host
(`Claude Code (<hostname>)`), so each machine reads/writes its own directory
under `Ops/Agent Diaries/Claude Code (<host>)/`. `wakeup_directive_hook.mjs`
bakes the same machine-scoped name into its SessionStart directive so the agent
calls `memory_wakeup` with the matching agentName and recovers that machine's
own recap.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CORTEXMD_BIN` | `cortexmd` | Path to the cortexmd binary (resolved against `$PATH`). |
| `CORTEXMD_HOOK_TIMEOUT_MS` | `4000` | Per-call subprocess timeout. |
| `CORTEXMD_HOOKS_DISABLE` | — | `1`/`true` → every hook passes through. |
| `CORTEXMD_HOOK_MINIMAL` | — | Drop nice-to-have parts of hook output. |
| `CORTEXMD_MEMORY_DISABLE` | — | Suppress memory-injection blocks. |
| `CORTEXMD_CODE_NAV_HINT_DISABLE` | — | Disable just the code-nav hooks. |
| `CORTEXMD_CODE_NAV_AUTOINDEX_DISABLE` | — | Disable the SessionStart background auto-index. |
| `CORTEXMD_WAKEUP_DISABLE` | — | Disable just the `wakeup_directive_hook.mjs` SessionStart directive. |
| `DIARY_STOP_EVERY` | `5` | `diary_stop_hook.mjs` fires every Nth Stop attempt. |
| `SAVE_HOOK_EVERY` | `15` | `stop-hook.sh` fires every Nth human turn. |

The diary stop hook keeps its counter in `.diary-stop-state.json` next to the
script; delete it to reset. The Node helpers write their cache + error log
under `${XDG_STATE_HOME:-~/.local/state}/cortexmd/`. The bash stop hook keeps
per-session counters under `~/.cortexmd/hook_state/`.

## Troubleshooting

- **Hooks not firing**: confirm `settings.json` has the `hooks` section
  (`cortexmd init --show`). Restart Claude Code after install.
- **Save loop**: the `stop_hook_active` flag prevents recursion; if stuck,
  delete `.diary-stop-state.json` and `~/.cortexmd/hook_state/`.
- **`python` not found**: the `.sh` hooks need `python3`/`python` for JSON
  parsing. Use the Node diary hooks instead (they have no such dependency).
- **Nothing recalled / stored**: check `cortexmd status` for auth/server, and
  the error log at `${XDG_STATE_HOME:-~/.local/state}/cortexmd/hook-errors.log`.
