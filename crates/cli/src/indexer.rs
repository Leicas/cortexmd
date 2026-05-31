//! Per-file parser pipeline shared by the bare `index` action (full walk)
//! and the background incremental push in `sync.rs` (mtime-filtered delta).
//!
//! The full-walk path lives in `main.rs::run_index`; this module owns the
//! single-file step (read → strip BOM → tree-sitter parse → produce a
//! `FilePayload`) so both call sites stay byte-for-byte identical.

use crate::parser;
use crate::payload::{
    normalize_newlines, sha1_hex, CallPayload, FilePayload, ImportPayload, Language,
    SymbolPayload,
};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

// Per-file payload caps. Must stay <= the server's `code_ingest_repo` schema
// limits (FilePayloadSchema in packages/server/src/tools/code-nav.ts), otherwise
// the whole repo ingest is rejected with a -32602 validation error. A single
// bundled/minified file can blow past these (e.g. a 40k-call vendored bundle),
// so we truncate per-file rather than fail the entire run.
pub const MAX_SYMBOLS_PER_FILE: usize = 5000;
pub const MAX_CALLS_PER_FILE: usize = 20000;
pub const MAX_IMPORTS_PER_FILE: usize = 2000;

/// Truncate `items` to `max`, emitting a one-line notice (always, since
/// dropping data is worth surfacing) about how many were discarded.
fn truncate_with_warning<T>(items: &mut Vec<T>, max: usize, label: &str, rel: &str, verbose: bool) {
    if items.len() > max {
        let dropped = items.len() - max;
        if verbose {
            eprintln!(
                "[client] truncating {} {} in {} ({} dropped, server cap {})",
                items.len(),
                label,
                rel,
                dropped,
                max
            );
        }
        items.truncate(max);
    }
}

/// Read+parse a file. Returns `Ok(None)` for soft-skips (binary / oversized /
/// unparseable) so callers can count them without a control-flow hop.
pub fn process_file(
    repo_id: &str,
    rel: &str,
    language: Language,
    abs: &Path,
    verbose: bool,
) -> Result<Option<FilePayload>> {
    let meta = fs::metadata(abs).with_context(|| format!("stat {}", abs.display()))?;
    if meta.len() > MAX_FILE_BYTES {
        if verbose {
            eprintln!("[client] skip oversized {} ({} bytes)", rel, meta.len());
        }
        return Ok(None);
    }
    let bytes = fs::read(abs).with_context(|| format!("read {}", abs.display()))?;
    if bytes.contains(&0u8) {
        if verbose {
            eprintln!("[client] skip binary (NUL byte) {}", rel);
        }
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let normalized = normalize_newlines(&raw);
    let content_hash = sha1_hex(&normalized);

    let result = match parser::parse_file(repo_id, rel, language, &normalized) {
        Ok(r) => r,
        Err(err) => {
            if verbose {
                eprintln!("[client] skip unparseable {}: {}", rel, err);
            }
            return Ok(None);
        }
    };

    // The server schema requires non-empty `name`; drop nameless symbols
    // rather than have the whole repo ingest rejected.
    let mut symbols: Vec<SymbolPayload> = result
        .symbols
        .into_iter()
        .filter(|s| !s.name.is_empty())
        .map(|s| SymbolPayload {
            id: s.id,
            name: s.name,
            kind: s.kind,
            qualified_name: s.qualified_name,
            signature: s.signature,
            docstring: s.docstring,
            start_line: s.start_line,
            end_line: s.end_line,
            parent_id: s.parent_id,
            content_hash: s.content_hash,
            body_simhash: s.body_simhash,
        })
        .collect();
    // The server rejects calls with an empty `callee_name` (min(1)); these are
    // parse noise (e.g. calls through expressions with no resolvable name).
    let mut calls: Vec<CallPayload> = result
        .calls
        .into_iter()
        .filter(|c| !c.callee_name.is_empty())
        .map(|c| CallPayload {
            caller_id: c.caller_id,
            callee_name: c.callee_name,
            call_line: c.call_line,
        })
        .collect();
    let mut imports: Vec<ImportPayload> = result
        .imports
        .into_iter()
        .filter(|i| !i.imported_name.is_empty() && !i.source_module.is_empty())
        .map(|i| ImportPayload {
            imported_name: i.imported_name,
            source_module: i.source_module,
        })
        .collect();

    // Truncate to the server's per-file maxima so one oversized (typically
    // bundled/minified) file can't fail the entire repo ingest.
    truncate_with_warning(&mut symbols, MAX_SYMBOLS_PER_FILE, "symbols", rel, verbose);
    truncate_with_warning(&mut calls, MAX_CALLS_PER_FILE, "calls", rel, verbose);
    truncate_with_warning(&mut imports, MAX_IMPORTS_PER_FILE, "imports", rel, verbose);

    Ok(Some(FilePayload {
        relative_path: rel.to_string(),
        language: language.as_payload_str(),
        content_hash,
        size_bytes: meta.len(),
        symbols,
        calls,
        imports,
    }))
}
