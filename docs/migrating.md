# Migrating from a legacy deployment

This guide is for operators moving an existing, pre-rename deployment onto
cortexmd. If you are installing fresh, you don't need any of this — start with
[`deploy-local.md`](./deploy-local.md) or [`deploy-http.md`](./deploy-http.md).

The rename touched four surfaces: **env vars**, the **CLI binary**, the
**per-user data dir**, and the **MCP tool namespace**. Every legacy name is
honored for **one more release** with a deprecation warning, so an upgrade does
not break on the first boot — but you should migrate off the old names before
that grace period ends. Nothing here changes your data; the one thing that needs
real attention is [data continuity](#data-continuity), below.

## Env var renames

| Legacy name | New name | Notes |
|-------------|----------|-------|
| `VAULT_RW` | `BRAIN_VAULT` | The sole write target. |
| `VAULT_RO_PERSO` | `SOURCE_VAULTS` (append an entry) | Becomes a read-only source named `perso`. |
| `VAULT_RO_HAPLY` | `SOURCE_VAULTS` (append an entry) | Becomes a read-only source named `haply`. |

### The deprecation shim

The legacy names are still read. On boot:

- `VAULT_RW` is used as `BRAIN_VAULT` if `BRAIN_VAULT` is unset, and a
  `[deprecation] VAULT_RW is deprecated; use BRAIN_VAULT instead` warning is
  written to stderr.
- `VAULT_RO_PERSO` / `VAULT_RO_HAPLY`, if set, are **appended** to whatever
  `SOURCE_VAULTS` already resolved to, each as a source with no index allowlist
  (`perso` / `haply` respectively), again with a deprecation warning.

This means you can set the new and the legacy names simultaneously during a
transition — the new names take precedence for the brain vault, and legacy
read-only vars only ever add sources. Drop the legacy vars once you've moved to
the new ones.

### Rewriting the read-only vars

The old deployment had two fixed read-only slots. The new model has a single
comma-separated `SOURCE_VAULTS` list where each entry is `name=path`,
`name=path:glob1|glob2` (a default-deny index allowlist), or a bare `path`
(basename becomes the label). So:

```sh
# legacy
VAULT_RW=/data/brain
VAULT_RO_PERSO=/data/perso
VAULT_RO_HAPLY=/data/work-kb

# new
BRAIN_VAULT=/data/brain
SOURCE_VAULTS="perso=/data/perso,haply=/data/work-kb"
```

The allowlist syntax (the `:glob|glob` suffix) is new and opt-in; it lets a
source vault expose only matching subtrees to indexing. See
[`brain-vault.md`](./brain-vault.md#the-allowlist) and the
[source-vaults section of `deploy-local.md`](./deploy-local.md#4-configuring-source-vaults).

## Data continuity

This is the part to get right. cortexmd writes **only** to `BRAIN_VAULT` — never
to any source vault (this is the enforced one-way model described in
[`brain-vault.md`](./brain-vault.md)). Your accumulated state — memories,
journal, knowledge-graph notes, agent diaries, tasks, `Ops/code-repos.json` —
all lives **inside** the writable vault of your legacy deployment.

To preserve it, **point `BRAIN_VAULT` at that existing writable path**:

```sh
BRAIN_VAULT=/data/brain      # the same directory your old VAULT_RW used
```

If you leave `BRAIN_VAULT` unset, the server falls back to a fresh per-user data
dir (`$XDG_DATA_HOME/cortexmd/brain`, or `%LOCALAPPDATA%\cortexmd\brain` on
Windows) — which is **empty**, and your old data will appear to be "gone" even
though it is untouched on disk. Either:

1. set `BRAIN_VAULT` to the old writable vault path (simplest), or
2. move the brain subdirectories (`memories/`, `journal/`, `agent-diaries/`,
   `tasks/`, `kg/`, `Ops/`) into the new default location before first boot.

> Do **not** point `BRAIN_VAULT` at a vault you also attach as a source, and do
> not put it inside a vault you edit by hand — that reintroduces the
> shared-writer hazard the brain-vault model exists to eliminate. Writes are
> path-contained to `BRAIN_VAULT` and a write aimed elsewhere is rejected, so
> attaching your old data vault read-only as a `SOURCE_VAULTS` entry is safe;
> just keep the brain itself separate.

## Binary & data-dir rename

The CLI binary is now `cortexmd`. The old command name continues to work as a
**deprecation alias for one release**, so existing scripts keep running:

```sh
cortexmd status          # new
```

The per-user data directory was also renamed to `cortexmd`. On first use after
upgrading, the CLI **auto-migrates** the legacy per-user dir: if the new
`cortexmd` config dir does not yet exist and a legacy one does, it is renamed in
place (atomic on the same filesystem) and a one-line migration notice is printed.
If the rename can't happen automatically (e.g. a cross-device move), the CLI
prints a warning telling you to move it manually. Cached OAuth tokens and the
per-user `config.toml` come across with it, so you don't have to re-authenticate.

## MCP tool namespace

The MCP tools are now exposed under the neutral `mcp__cortexmd__*` prefix.
Anything that referenced the **old** `mcp__<old>__*` prefix must be updated:

- MCP client config (the server entry name in `~/.claude.json`,
  `claude_desktop_config.json`, Cursor/Codex configs) — rename the server key to
  `cortexmd` so tools surface as `mcp__cortexmd__*`.
- Any hook commands, `allowedTools` / permission lists, or agent instructions
  that hard-code the old tool prefix.

The simplest way to fix the agent-integration side is to re-run the installer,
which rewrites the `CORTEXMD.md` instruction block, the `@CORTEXMD.md` reference
in `CLAUDE.md`, and the `settings.json` hooks — and strips the pre-rename
artifacts (the old markdown file, old `@`-reference, and old hook commands) in
the same pass:

```sh
cortexmd init            # project-local; --global for ~/.claude
cortexmd init --show     # verify what's installed
```

## Re-enabling opt-in features

Optional features are off by default. If your legacy deployment relied on them,
turn them back on explicitly.

### Reranker

```sh
ENABLE_RERANKER=true
RERANKER_PROVIDER=openai-compatible   # or "anthropic"
RERANKER_BASE_URL=http://localhost:8080
RERANKER_MODEL=your-reranker-model
RERANKER_API_KEY=...                  # if the backend needs one
# RERANKER_TIMEOUT_MS=10000           # optional, defaults to 10s
```

There is no default host or model — the reranker is fully opt-in.

### Custom collection patterns

The shipped retrieval collections are now a minimal, vault-layout-agnostic set
(`memories`, `journal`, `code`, `archive`, `general`). If your legacy deployment
used custom path-to-collection rules tuned to a particular folder layout, those
personal patterns are **not** baked into the defaults anymore. A worked example
of how to override `DEFAULT_COLLECTIONS` with your own folder structure and
weights lives as a commented block at the top of
[`packages/server/src/lib/collections.ts`](../packages/server/src/lib/collections.ts);
copy it into the live `DEFAULT_COLLECTIONS` and adapt the `pathPattern`s to your
vault.

## Local dashboard auth

The HTTP deployment now has a built-in, local password login for the dashboard
that needs no external identity provider:

- Set `DASHBOARD_PASSWORD` to the dashboard password. If you leave it unset, the
  server generates one on first boot, persists it under
  `${BRAIN_VAULT}/Ops/local-secrets.json`, and prints it to stderr **once** so
  you can capture it.
- Browsers hitting a protected dashboard route are redirected to `/login` for a
  password form; on success the server sets a `cortexmd_session` cookie.
  API/XHR requests still get a `401` JSON error rather than the form.

The pre-existing auth mechanisms remain available and unchanged: a static
`API_KEY` Bearer token, standalone OAuth 2.0 (`cortexmd auth oauth-login`), and
the optional `PROXY_AUTH` forward-auth path for teams already running an identity
provider. OAuth and `PROXY_AUTH` are advanced/team knobs — see
[`deploy-http.md`](./deploy-http.md#2-authentication). In local-stdio mode none
of this applies; there is no network surface to protect.

## Checklist

1. Set `BRAIN_VAULT` to your **existing** writable vault path (data continuity).
2. Convert `VAULT_RO_*` into `SOURCE_VAULTS` entries; drop `VAULT_RW`.
3. Replace the old CLI command with `cortexmd`; let the per-user data dir
   auto-migrate on first run.
4. Re-run `cortexmd init` (or rename the MCP server key) so tools resolve under
   `mcp__cortexmd__*`.
5. Re-enable any opt-in features (reranker, custom collections) you relied on.
6. (HTTP) Set `DASHBOARD_PASSWORD` and confirm the `/login` flow.
7. Boot once, watch stderr for `[deprecation]` warnings, and remove the legacy
   env vars they name.
