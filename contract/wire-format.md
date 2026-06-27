# The `code_ingest_repo` wire format

Prose companion to [`code-ingest-payload.schema.json`](./code-ingest-payload.schema.json) (the authoritative, machine-checkable definition). This is the JSON envelope the Rust indexer (`crates/cli`) sends and the TS server (`packages/server`) ingests. All field names are **snake_case**.

## Envelope

```jsonc
{
  "repo_id": "fixture",                 // string, required — stable & immutable; part of every symbol_id
  "git_origin": "https://…/repo.git",   // string|null — remote URL, null if none
  "files": [ /* File[] */ ]             // required
}
```

`repo_id` is client-controlled but the server sanity-checks it: it must equal `sha1(git_origin)[:16]` when an origin exists, else `first_commit_sha[:16]`. The server treats it as authoritative for symbol-ID hashing and rebinds `(machine_id, abs_path)` if the same checkout reappears under a new id.

## File

```jsonc
{
  "relative_path": "src/foo.ts",   // required — repo-relative POSIX path; part of symbol_id
  "language": "typescript",        // required — one of: typescript tsx javascript python rust go cpp c java kotlin ruby php dart
  "symbols": [ /* Symbol[] */ ],   // required
  "calls":   [ /* Call[] */ ],     // optional, default []
  "imports": [ /* Import[] */ ]    // optional, default []
}
```

## Symbol

```jsonc
{
  "id": "0123456789abcdef",   // required — sha1(repo_id|relative_path|name|kind|signature_normalized)[:16]
  "kind": "function",         // required — function|method|class|struct|interface|enum|type|const|…
  "name": "add",              // required
  "signature": "export function add(a: number, b: number): number",  // required, raw; see symbol-id.md
  "start_line": 12,           // required, 1-based
  "end_line": 14,             // required, 1-based
  "docstring": null,          // optional, string|null
  "body_simhash": null        // optional, string|null — 64-bit SimHash hex of the body (copy-paste detection)
}
```

`body_simhash` is `skip_serializing_if None` on the Rust side and a nullable column server-side, so older servers ignore it and older clients simply omit it — a forward/backward-compatible optional field.

## Call

```jsonc
{
  "caller": "0123456789abcdef",   // required — symbol_id of the calling symbol
  "callee": "fedcba9876543210",   // required — resolved symbol_id, OR the raw callee name if unresolved
  "line": 13                      // optional, int|null
}
```

## Import

```jsonc
{
  "module": "./util",   // required — module specifier as written in source
  "line": 1             // optional, int|null
}
```

## Compatibility & limits

- `files` is capped (current server limit: 10000) per ingest.
- A `full_replace=true` ingest with an empty `files` array is rejected (guards against accidental wipes).
- Adding a new optional field is non-breaking only if both sides treat it as `skip_serializing_if None` / nullable. Changing any field that feeds `symbol_id` (see `symbol-id.md`) is a breaking, fixture-regenerating change.
