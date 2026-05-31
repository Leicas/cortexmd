# Symbol-ID algorithm (canonical)

This is the source of truth for how a code symbol's stable ID is derived. It **must** be implemented byte-identically in:

- Rust: `crates/cli/src/payload.rs` (`normalize_newlines`, `normalize_signature`, `sha1_hex`, `symbol_id`)
- TS: `packages/server/src/lib/code/parser.ts`

Both files should carry a one-line comment pointing here instead of copied line-number references. Parity is enforced by the golden fixtures in [`fixtures/`](./fixtures/) running against both parsers in CI.

## Definition

```
symbol_id = sha1( repo_id | relative_path | name | kind | signature_normalized )[:16]
```

- **separator** — a literal `|` (U+007C), with **no** surrounding spaces.
- **hash** — SHA-1 over the UTF-8 bytes of the joined string, rendered as lowercase hex (40 chars), then truncated to the **first 16** characters.
- **repo_id** — the stable, immutable repo identifier (see `wire-format.md`). Hashing against `repo_id` means repo renames/moves don't churn symbol IDs.
- **relative_path** — repo-relative POSIX path (forward slashes).
- **name** — the symbol's identifier as written in source.
- **kind** — `function | method | class | struct | interface | enum | type | const | …` (the indexer's kind taxonomy).
- **signature_normalized** — see below.

## Normalization rules (the high-drift surface)

These are where the two languages most easily diverge; pin them exactly.

### Newline normalization (applied to source before signature extraction)

```
\r\n  -> \n
\r    -> \n        (any remaining lone CR)
```
Equivalent to the JS regex `/\r\n?/g` → `\n`.

### Signature normalization

1. Take the raw `signature` text (the symbol's declaration/header as captured by the parser).
2. Collapse every run of whitespace (spaces, tabs, newlines) to a single space: `/\s+/g` → `" "`.
3. Trim leading/trailing whitespace.
4. If the result is the empty string, use the literal `<no-sig>`.

> Open question: whether to additionally strip parameter names / generic bounds / default values for cross-language stability. Today's rule is whitespace-only normalization; any change here is a fixture-breaking change and must be made on both sides together.

## Worked example

For a TS function in repo `fixture`, file `src/math.ts`:

```ts
export function add(a: number,
                    b: number): number
```

- `signature` (raw) = `export function add(a: number,\n                    b: number): number`
- after newline normalization + whitespace collapse + trim:
  `export function add(a: number, b: number): number`
- hash input = `fixture|src/math.ts|add|function|export function add(a: number, b: number): number`
- `symbol_id` = first 16 hex chars of `sha1(<that string>)`.

(The exact expected hex for the fixture set is pinned in `fixtures/expected-symbol-ids.json`.)

## Changing this algorithm

Any change is **breaking** — it churns every symbol ID and invalidates stored call graphs. To change it: update this doc, update both implementations in the same PR, regenerate the golden fixtures (`cargo run -p cli -- contract regen`), and review the fixture diff deliberately. CI's `contract` job is the backstop.
