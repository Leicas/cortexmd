# contract/fixtures/

Golden fixtures that enforce symbol-ID parity between the Rust indexer (`crates/cli`) and the TS server parser (`packages/server`). CI runs BOTH parsers over the same input and asserts byte-identical output. If either side drifts, the build fails — no more hand-copied line-number comments.

## Layout (planned)

```
fixtures/
├── README.md                     (this file)
├── sample-repo/                  a tiny, multi-language fixture repo
│   ├── src/math.ts               TS: functions/classes/interface + cross-file call + import
│   ├── src/util.ts               TS: default params + arrow const-export (math.ts imports clamp)
│   ├── src/util.py               Python: default args, *args/**kwargs, class+methods
│   ├── src/lib.rs                Rust: generics, struct/impl, cross-file call (uses helper::clamp)
│   ├── src/helper.rs             Rust: the cross-file callee for lib.rs
│   └── src/math.go               Go: variadic params, multi-line signature, cross-symbol calls
├── expected-symbol-ids.json      the source of truth: { relative_path -> [ {name, kind, id, signature_normalized} ] }
└── out/                          (gitignored) per-toolchain emitted JSON for diffing
```

Regenerate `expected-symbol-ids.json` with the Rust indexer (the source of truth):

```
cargo run -- contract regen contract/fixtures/sample-repo --emit expected
```

The fixture `repo_id` is the fixed literal `fixture` (the command's default), so
IDs are reproducible with no git checkout or running server. `--emit payload`
prints the full `code_ingest_repo` File[] instead of the golden map.

`expected-symbol-ids.json` is computed once (by hand or by a vetted run) and reviewed. It pins, for every symbol in `sample-repo/`, the canonical 16-hex `id`. The fixture `repo_id` is a fixed literal (e.g. `"fixture"`) so IDs are reproducible.

## How CI uses it

1. Rust: `cortexmd-cli` ingests `sample-repo/` in an `--emit-symbol-ids` mode -> `out/rust.json`.
2. TS: a small script runs `parser.ts` over `sample-repo/` -> `out/ts.json`.
3. Both `out/rust.json` and `out/ts.json` are diffed against `expected-symbol-ids.json`.
4. Any mismatch (in ID, ordering of fields, or set of symbols) fails the `contract` CI job.

## What the fixtures exercise

The sample repo intentionally includes the edge cases the symbol-ID algorithm must handle the same way on both sides:

- multi-line signatures (whitespace collapse + trim).
- symbols with an empty signature (must hash as `<no-sig>`).
- CRLF vs LF line endings (newline normalization before signature extraction).
- the `|` separator field order: `repo_id | relative_path | name | kind | signature_normalized`.
- at least one symbol per supported language family represented in the fixture.

## Adding a case

1. Add the source to `sample-repo/`.
2. Regenerate / hand-add its expected entry in `expected-symbol-ids.json`.
3. Run both parsers locally; confirm they match the expected file before committing.
