# cortexmd

Standalone Rust CLI (crate `cortexmd-cli`, binary `cortexmd`) for a cortexmd
server. It plays four roles:

- **Indexer** — walks a source repo, parses with tree-sitter, and ships
  symbol/call/import payloads to a cortexmd server's `code_ingest_repo` tool.
  Use this when the server cannot reach the source tree directly (e.g. a
  containerised server without the dev tree mounted).
- **Code-nav client** — thin wrappers over the server's code-nav HTTP API
  (`code-search`, `code-get`, `code-impact`, `code-outline`) that mirror the
  matching MCP tools, for shell pipelines and scripting.
- **Claude Code integration** — installs hooks + a HUD-line daemon and a
  token-saving `rewrite` engine that nudges agents toward the cheaper
  code-nav tools.
- **Auth bootstrap** — OAuth 2.0 (PKCE + dynamic client registration) or a
  static API key, with credential lift-over from an existing Claude Code MCP
  config.

> **Legacy alias (deprecated):** the binary was previously published as
> `obsidian-mcp-client`. That name still resolves for backwards compatibility
> but is deprecated — use `cortexmd`.

## Install

```sh
cargo install --git https://github.com/Leicas/cortexmd
```

## Quick start (OAuth — recommended, zero key paste)

A cortexmd server exposes a full OAuth 2.0 stack (RFC 8414 discovery, RFC 7591
dynamic client registration, authorization-code + PKCE). The CLI uses it to
bootstrap itself without ever asking you for an API key:

```sh
cortexmd auth oauth-login --server https://mcp.example.com
cortexmd /path/to/repo
```

`oauth-login` discovers the server's OAuth endpoints, registers itself as a
dynamic client, opens your browser to the authorize page (handled by the
server's upstream SSO), and persists the resulting access token to
`${config_dir}/cortexmd/oauth-tokens.json` (0600 on Linux). Subsequent
`cortexmd …` runs pick the token up automatically and refresh it transparently
when possible.

Headless / SSH session:

```sh
cortexmd auth oauth-login \
    --server https://mcp.example.com --no-browser
# Prints the authorize URL; open it in any browser. The localhost callback
# listener is still bound on the headless box, so you'll need either a
# tunnel back (ssh -L) or to run the flow on a workstation that shares the
# config dir.
```

## Quick start (static API key)

Useful for CI, headless boxes, or any environment where a browser-based
flow is impractical:

```sh
cortexmd auth login \
    --server https://mcp.example.com --api-key "$MCP_API_KEY"
cortexmd /path/to/repo
```

If you already use Claude Code with the same server, you can lift the
URL + bearer from its config in one shot:

```sh
cortexmd auth import-from-claude
```

(If Claude Code stores its bearer in an OAuth token cache rather than a
plain header, the importer will print the discovered URL and ask you to
run `auth login` or `auth oauth-login` instead.)

## Auth

Credentials are resolved on every index call in this priority order:

1. CLI flags (`--server` / `--api-key`)
2. Env vars (`MCP_URL` / `MCP_API_KEY`)
3. **OAuth token cache** at
   `${config_dir}/cortexmd/oauth-tokens.json` (auto-refreshed when possible;
   `auth oauth-login` to re-issue if expired)
4. Per-user config file at `${config_dir}/cortexmd/config.toml`
   (Windows: `%APPDATA%\…`, Linux: `~/.config/…`, macOS:
   `~/Library/Application Support/…`)
5. Auto-discovery from Claude Code's MCP config (`~/.claude.json` or the
   per-platform Claude Desktop config)

```sh
# OAuth flow (zero-key bootstrap; opens a browser).
cortexmd auth oauth-login --server https://mcp.example.com
cortexmd auth oauth-login --server https://mcp.example.com --no-browser
cortexmd auth oauth-status     # cache path + expiry (no token printed)
cortexmd auth oauth-logout --yes

# Static API key flow.
cortexmd auth login --server https://mcp.example.com --api-key "$MCP_API_KEY"
cortexmd auth login --server https://mcp.example.com   # prompts (hidden)
cortexmd auth status
cortexmd auth logout --yes

# Lift creds from Claude Code.  --name when multiple HTTP MCP servers exist.
cortexmd auth import-from-claude --name my-server --yes
```

## Indexing

```sh
cortexmd /path/to/repo \
    --slug my-repo \
    --server https://mcp.example.com \
    --api-key "$MCP_API_KEY"
```

Dry run (build payload, print sizes, never POST):

```sh
cortexmd /path/to/repo --dry-run
```

### Index flags

| flag | env | description |
| --- | --- | --- |
| `<repo-path>` |  | Absolute path to the repo (required for the index action) |
| `--slug` |  | Override slug (default: basename of repo path) |
| `--server` | `MCP_URL` | Server base URL (else: persisted config / Claude config / `http://localhost:3000` for `--dry-run`) |
| `--api-key` | `MCP_API_KEY` | Bearer token (else: persisted config / Claude config; required unless `--dry-run`) |
| `--machine-id` | `MACHINE_ID` | Override machine id (default: hostname) |
| `--full-replace` |  | Server prunes files missing from payload (default: true) |
| `--dry-run` |  | Build payload, print sizes, do not POST |
| `-v` / `--verbose` |  | Per-file progress / skip reasons / credential source |

Subcommands: `index` (the default; the bare positional form keeps working),
`scan`, `status`, `discover`, `gain`, `recall`, `code-search`, `code-get`,
`code-impact`, `code-outline`, `code-find-duplicates`, `code-chain`, `rewrite`,
`init`, `auth login`, `auth status`, `auth logout`, `auth import-from-claude`,
`auth oauth-login`, `auth oauth-status`, `auth oauth-logout`.

## Inspect / discover

```sh
# Server URL, auth method+expiry, registered repos, token savings.
cortexmd status

# List git repos under <root> (defaults to parent of cwd / D:\dev / ~/code)
# and mark which ones are registered with the server.
cortexmd discover            # default root
cortexmd discover D:/dev     # explicit root
cortexmd discover . --depth 5

# Discover + auto-index every repo that isn't already registered.
# Prompts y/n/all/none/q per repo (or --yes / non-TTY skips prompting).
cortexmd scan D:/dev
cortexmd scan D:/dev --yes

# Token-savings analytics from the server's `code_nav_stats` MCP tool.
cortexmd gain
cortexmd gain --days 7
```

`status` and `gain` gracefully degrade when the server hasn't been updated to
expose `code_nav_stats` — they still show repos and print an actionable hint
to update the server instead of failing.

## Code-nav queries

Thin clients over the server's code-nav HTTP API, mirroring the matching MCP
tools so they're usable from shell pipelines:

```sh
# FTS over symbol name / signature / docstring.
cortexmd code-search --query "parse payload" --repo my-repo --limit 20

# Fetch one symbol's metadata + body by its 16-char hex id (from code-search).
cortexmd code-get --id 0123456789abcdef

# Transitive caller graph: "who breaks if I change this symbol?"
cortexmd code-impact --id 0123456789abcdef --depth 3

# Symbol outline for one file in a registered repo (kind/name/signature/lines).
cortexmd code-outline --repo my-repo --path src/foo.ts

# Shortest call path from one symbol to another.
cortexmd code-chain --from 0123456789abcdef --to fedcba9876543210
```

## Editor integration (`init`)

One command writes `CORTEXMD.md`, registers an `@CORTEXMD.md` reference in
`CLAUDE.md`, and idempotently patches `settings.json` with a `SessionStart`
hook so the HUD-line daemon is kept alive across sessions.

```sh
cortexmd init                   # local: ./.claude/ + ./CLAUDE.md
cortexmd init -g --auto-patch   # global: ~/.claude/ no prompt
cortexmd init --show            # report current install state
cortexmd init --uninstall       # remove every artifact init wrote
```

`init` is idempotent: re-running won't duplicate the hook, and an upgrade from
an older hook command is detected and replaced in-place.

The `rewrite` subcommand backs the code-nav hook: it reads a Bash command and
emits the cheaper code-nav equivalent (or nothing), so `cat|head|tail|grep` on
indexed source files are transparently rewritten toward `code-outline` and
friends.

## Languages

Indexes `.ts .tsx .js .jsx .py .rs .go`. Skips
`node_modules / dist / .git / .next / build / out / target / __pycache__ /
venv / .venv / vendor`, plus a small set of denied segments
(`.obsidian / .sync / .trash`). Honours `.gitignore` via the
[`ignore`](https://crates.io/crates/ignore) crate.

## Symbol-id parity

Symbol IDs are `sha1(repo_id|relpath|name|kind|signature_normalized)[:16]`.
This matches what the cortexmd server-side (TypeScript) parser produces — see
`contract/` for the shared symbol-id contract and golden fixtures — so
re-indexing from a different machine doesn't churn the symbol DB.

## License

MIT.
