# The cortexmd hook system

cortexmd ships a small set of agent-session hooks that turn the MCP tools into
*automatic* behavior: relevant memory is recalled before each prompt, high-signal
commands are captured after they run, a code-nav directive is injected when you
open a code repo, and the agent writes a diary entry before it stops or compacts.

Hooks are **convenience automation, not a requirement**. The MCP tools
(`memory_recall`, `memory_store`, `agent_diary_append`, `code_symbol_search`, …)
work in any MCP client with no hooks at all. Hooks just make the agent reach for
them at the right moment without being told.

The reference implementation targets **Claude Code**, whose hook events
`cortexmd init` wires up directly. Other clients (Cursor, Mistral/Vibe, Codex)
have their own — and in several cases still-evolving — hook mechanisms; the
sections below give best-effort wiring and call out where it is version-dependent.

---

## What each hook does

| Hook | Event | Behavior |
|---|---|---|
| Memory recall | UserPromptSubmit | Tokenizes the prompt, recalls the top matching memories/notes, and injects them as context. Also captures "remember that / never / always" trigger phrases as preferences. Strips `<private>…</private>` before anything is stored. |
| Code-nav hint | SessionStart | If the cwd is a git repo with source files, injects a directive to prefer the `code_*` MCP tools over Read/Grep, and background-indexes the repo if it is not registered yet. |
| Code-nav advisory | PreToolUse (Read/Grep/Glob) | If the target file/pattern is inside an indexed repo, injects a one-shot suggestion to use the cheaper `code_*` equivalent. Awareness-only: never blocks, never prompts. |
| High-signal capture | PostToolUse (Bash) | Deterministic regex over the command. Captures `systemctl`, `crontab`, `chmod`/`chown`, `docker compose`, and `git commit -m` as observations, anchored to the repo. |
| Diary auto-write (Stop) | Stop | Every Nth stop attempt, blocks once and asks the agent to append a short session recap via `agent_diary_append(silent=true)`. |
| Diary auto-write (PreCompact) | PreCompact | Always blocks before compaction so the agent snapshots the conversation into the diary — `memory_wakeup` reads it to bootstrap the next session. |
| HUD status line | SessionStart | Ensures the HUD-line daemon is alive so the in-session statusline shows server-side savings/latency. (`cortexmd hud-line`.) |
| Bash code-nav rewrite | PreToolUse (Bash) | Rewrites `grep`/`cat`/`head`/`tail` on indexed repos to the code-nav CLI equivalent. (`cortexmd rewrite`.) |

Two implementation styles back these:

- **Binary-subcommand hooks** run `cortexmd <sub>` directly (HUD line, recall,
  store-memory, rewrite). No Node required.
- **Node-script hooks** are small `.mjs` files that read the Claude Code event
  JSON on stdin and shell back out to `cortexmd recall` / `cortexmd store-memory`
  / `cortexmd repo-list` for everything that needs the server + credentials. They
  use Node built-ins only (work on Windows without Git Bash) and **never block
  the session** — any error emits the pass-through `{}` and exits 0.

Both kinds delegate all credential resolution to the `cortexmd` binary, so there
is exactly one auth path (env `MCP_URL`/`MCP_API_KEY` → OAuth token cache →
`~/.config/cortexmd/config.toml` → the client's MCP config). The default server
URL is `http://localhost:3000`.

### Common environment toggles

| Variable | Default | Effect |
|---|---|---|
| `CORTEXMD_HOOKS_DISABLE` | — | `1`/`true` → every hook passes through. |
| `CORTEXMD_MEMORY_DISABLE` | — | Suppress memory-injection blocks (capture still runs). |
| `CORTEXMD_HOOK_MINIMAL` | — | Drop the nice-to-have parts of hook output. |
| `CORTEXMD_BIN` | `cortexmd` | Path to the binary if not on `$PATH`. |
| `CORTEXMD_HOOK_TIMEOUT_MS` | `4000` | Per-call subprocess timeout. |
| `CORTEXMD_CODE_NAV_HINT_DISABLE` | — | Disable just the code-nav hooks. |
| `CORTEXMD_CODE_NAV_AUTOINDEX_DISABLE` | — | Keep the hint but skip background auto-indexing. |
| `DIARY_STOP_EVERY` | `5` | Diary Stop hook fires every Nth stop attempt. |
| `SAVE_HOOK_EVERY` | `15` | Bash `stop-hook.sh` fires every Nth human turn. |

---

## Claude Code (authoritative)

`cortexmd init` installs everything for Claude Code. In a repo:

```sh
cortexmd init            # project-local ./.claude/  (prompts before patching)
cortexmd init -g         # user-global  ~/.claude/
cortexmd init --auto-patch   # patch settings.json without the y/N prompt
cortexmd init --show     # print current install state
cortexmd init --uninstall    # remove everything init wrote
```

What it does:

1. Writes `CORTEXMD.md` (the cheap-tools cheatsheet) and references it from
   `CLAUDE.md` via `@CORTEXMD.md`.
2. Drops the Node hook scripts into `<.claude>/hooks/cortexmd/`.
3. Patches `settings.json` with these hook events (idempotent — re-running never
   duplicates, and a `.json.bak` backup is written before any change):

   | Event | Matcher | Command |
   |---|---|---|
   | `SessionStart` | — | `cortexmd hud-line --ensure-daemon` |
   | `SessionStart` | — | `node <…>/code_nav_hint_hook.mjs` |
   | `UserPromptSubmit` | — | `cortexmd recall --hook` |
   | `UserPromptSubmit` | — | `node <…>/userprompt_hook.mjs` |
   | `PreToolUse` | `Bash` | `cortexmd rewrite --hook` |
   | `PreToolUse` | `Read\|Grep\|Glob` | `node <…>/code_nav_pretool_hook.mjs` |
   | `PostToolUse` | `Bash` | `cortexmd store-memory --hook` |
   | `PostToolUse` | `Bash` | `node <…>/posttooluse_hook.mjs` |
   | `Stop` | — | `node <…>/diary_stop_hook.mjs` |
   | `PreCompact` | — | `node <…>/precompact_diary_hook.mjs` |

Restart Claude Code after install so it re-reads `settings.json`.

### Manual setup

If you patch `settings.json` by hand, each entry has this shape (use the
absolute path to the script `cortexmd init` dropped in `.claude/hooks/cortexmd/`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "node \"/abs/path/.claude/hooks/cortexmd/diary_stop_hook.mjs\"",
          "timeout": 8 }
      ] }
    ],
    "PreToolUse": [
      { "matcher": "Read|Grep|Glob",
        "hooks": [
          { "type": "command",
            "command": "node \"/abs/path/.claude/hooks/cortexmd/code_nav_pretool_hook.mjs\"",
            "timeout": 5 }
        ] }
    ]
  }
}
```

`cortexmd init --no-patch` prints the full manual block for every entry without
touching the file.

### Shipped but opt-in

`cortexmd init` writes these to `.claude/hooks/cortexmd/` but does **not** wire
them — enable by hand if you want them:

- `pretooluse_hook.mjs` — per-tool memory injection before every Read/Edit/Bash.
  Noisier than the UserPromptSubmit recall and overlaps with it; left off by
  default. Wire it on `PreToolUse` (no matcher, or scope to `Read|Edit|Write`).
- `stop-hook.sh` / `precompact-hook.sh` — bash alternatives to the Node diary
  hooks that count transcript turns and call `memory_store`. They require
  `python3`/`python` on PATH and duplicate the Node diary hooks, so do **not**
  enable both for the same event.

---

## Cursor

> Verify against your Cursor version — Cursor's hook/rules surface has changed
> across releases and field names below may differ in yours.

Two halves: the MCP server (so the `code_*` / `memory_*` tools exist) and the
hook-equivalent automation.

**MCP server** — add to `.cursor/mcp.json` (project) or the global equivalent:

```json
{
  "mcpServers": {
    "cortexmd": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

(For a stdio build, use `"command"`/`"args"` instead of `"url"`. The tool names
are identical to Claude Code's, minus the client-specific `mcp__…__` prefix.)

**Hook-equivalents** — Cursor does not expose the same six lifecycle events as
Claude Code. Two practical options:

1. **Project Rules** (`.cursor/rules/*.mdc`) for the always-on directives that
   don't need an event. Put the code-nav guidance and the "before you stop,
   append a diary entry via `agent_diary_append`" instruction in an
   `alwaysApply: true` rule. This covers the SessionStart-hint and the
   diary-on-stop intent declaratively, without a process hook.
2. **Cursor Hooks** (`hooks.json`, where available) for the event-driven pieces.
   If your Cursor build supports `beforeSubmit` / `afterToolUse`-style hooks,
   point them at the same scripts in `.claude/hooks/cortexmd/`; the Node hooks
   read a generic `{ prompt, tool_name, tool_input, cwd }` event shape and fall
   back to a no-op when fields are absent, so they degrade gracefully if
   Cursor's event JSON differs.

Set `CORTEXMD_BIN` if `cortexmd` is not on the PATH Cursor launches with.

---

## Mistral (Vibe)

> Best-effort — Vibe's tools/hooks configuration is evolving; treat the
> following as a starting point and verify against your installed version.

**MCP wiring** — Vibe consumes MCP servers via its tools/MCP config. Register
cortexmd the same way as any other MCP server (HTTP endpoint
`http://localhost:3000/mcp`, or a stdio command for the local build). Once
registered, the `code_*` and `memory_*` tools are available to the agent.

**Hook-equivalents** — if your Vibe version exposes pre-prompt / post-tool /
session lifecycle hooks, point the pre-prompt hook at `userprompt_hook.mjs` and
the post-tool hook at `posttooluse_hook.mjs` from `.claude/hooks/cortexmd/`. If
it does not, fall back to a system-prompt/rule instruction that tells the agent
to call `memory_recall` at the start of a task and `agent_diary_append` before
finishing — the tools do the real work, the hook only changes *when* they fire.

---

## Codex

> Codex's hook surface is limited and version-dependent — prefer the
> prompt/tool-config path below over assuming a six-event lifecycle.

Codex speaks MCP, so register cortexmd as an MCP server in your Codex config
(`~/.codex/config.toml` or the equivalent your build uses):

```toml
[mcp_servers.cortexmd]
url = "http://localhost:3000/mcp"
# or, for the local stdio build:
# command = "cortexmd"
# args = ["mcp"]
```

Without a rich hook lifecycle, drive the automation from instructions instead of
events: add a line to your Codex system/instructions file telling the agent to
`memory_recall` relevant context before starting and `agent_diary_append` a
recap before stopping, and to prefer `code_symbol_search` / `code_file_outline`
over reading whole files. This reproduces the *intent* of the SessionStart,
UserPromptSubmit, and Stop hooks declaratively.

---

## Any MCP client (generic fallback)

If your client speaks MCP but has no hook mechanism at all, you lose only the
*automation*, not the capability:

- Point the client at the cortexmd MCP server (`http://localhost:3000/mcp`, or a
  stdio command for the local build).
- The agent can call every tool directly: `memory_recall`, `memory_store`,
  `agent_diary_append`, `code_symbol_search`, `code_file_outline`,
  `code_symbol_get`, `code_symbol_callers`/`code_symbol_callees`,
  `code_change_impact`, `code_repo_list`, and the rest.
- Encode the hook intent as standing instructions (a system prompt or rules
  file): recall before acting, capture decisions as memories, write a diary
  entry before ending a session, prefer `code_*` over Read/Grep.

The `cortexmd` CLI is also usable outside any agent — `cortexmd recall`,
`cortexmd store-memory`, `cortexmd repo-list`, `cortexmd status` — so the same
behavior can be scripted from a shell hook in editors not covered above.
