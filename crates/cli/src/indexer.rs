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

    let symbols = result
        .symbols
        .into_iter()
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
    let calls = result
        .calls
        .into_iter()
        .map(|c| CallPayload {
            caller_id: c.caller_id,
            callee_name: c.callee_name,
            call_line: c.call_line,
        })
        .collect();
    let imports = result
        .imports
        .into_iter()
        .map(|i| ImportPayload {
            imported_name: i.imported_name,
            source_module: i.source_module,
        })
        .collect();

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
