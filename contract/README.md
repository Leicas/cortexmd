# contract/

The shared spec that keeps the two toolchains honest. The Rust indexer (`crates/cli`) produces `code_ingest_repo` payloads; the TS server (`packages/server`) parses them — and both sides independently derive **symbol IDs**. If those IDs ever disagree, the symbol DB silently corrupts (duplicate/orphaned symbols, broken call graph). This directory pins the format and proves parity in CI.

## Files

- [`wire-format.md`](./wire-format.md) — prose spec of the `code_ingest_repo` envelope.
- [`symbol-id.md`](./symbol-id.md) — the canonical symbol-ID algorithm + normalization rules (the source of truth `payload.rs`/`parser.ts` point at).
- [`code-ingest-payload.schema.json`](./code-ingest-payload.schema.json) — authoritative JSON Schema (draft 2020-12) for the payload.
- [`fixtures/`](./fixtures/) — golden sample repo + expected symbol IDs, run against BOTH parsers in CI.

## The `code_ingest_repo` wire format (summary)

JSON, snake_case. See `wire-format.md` + the JSON Schema for the authoritative shape:

```
{
  "repo_id": "...",            // stable, immutable repo identifier
  "git_origin": "...",         // remote URL, nullable
  "files": [
    {
      "relative_path": "src/foo.ts",
      "language": "typescript",
      "symbols": [
        { "id", "kind", "name", "signature",
          "start_line", "end_line", "docstring", "body_simhash"? }
      ],
      "calls":   [ { "caller", "callee", "line" } ],
      "imports": [ { "module", "line" } ]
    }
  ]
}
```

## The symbol-ID algorithm (summary)

A symbol's ID is the first **16 hex chars** of the SHA-1 of five pipe-joined fields:

```
symbol_id = sha1( repo_id | relative_path | name | kind | signature_normalized )[:16]
```

Full normalization rules live in [`symbol-id.md`](./symbol-id.md). Implemented identically in:
- Rust: `crates/cli/src/payload.rs` (`normalize_newlines`, `normalize_signature`, `sha1_hex`, `symbol_id`).
- TS: `packages/server/src/lib/code/parser.ts`.

## Why a contract instead of comments

The two implementations previously stayed in sync via hand-copied line-number comments (`mirrors parser.ts:62-70`). That drifts the moment either file moves. Instead, **golden fixtures** (a tiny sample repo with a checked-in expected-IDs file) are run against BOTH parsers in CI — see [`fixtures/`](./fixtures/). Any divergence fails the build.
