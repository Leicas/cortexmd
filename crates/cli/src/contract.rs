//! Golden-fixture regeneration. The Rust indexer is the source of truth for
//! symbol IDs (see `contract/symbol-id.md`); this command runs the *exact*
//! production parser pipeline (`walker` + `indexer` + `parser`) over a plain
//! directory — no git checkout, no server — so the canonical
//! `contract/fixtures/expected-symbol-ids.json` can be regenerated and diffed
//! against the TS parser in CI.
//!
//! The `repo_id` is a fixed literal (default `fixture`) so the hashes are
//! reproducible. We deliberately reuse `payload.rs`/`parser.rs` rather than
//! reimplementing the symbol-id algorithm.

use crate::cli::ContractCommand;
use crate::payload::{normalize_signature, Language};
use crate::{indexer, walker};
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

pub fn cmd_contract(cmd: ContractCommand) -> Result<()> {
    match cmd {
        ContractCommand::Regen {
            dir,
            repo_id,
            emit,
        } => regen(&dir, &repo_id, &emit),
    }
}

/// One entry in the golden file. Field order is load-bearing: the contract
/// (`symbol-id.md`) pins the hash-input order as
/// `repo_id | relative_path | name | kind | signature_normalized`, and the
/// fixtures README documents the per-symbol object as `{ name, kind, id }`.
/// We append `signature_normalized` so the golden file is self-describing.
#[derive(Serialize)]
struct ExpectedSymbol {
    name: String,
    kind: String,
    id: String,
    signature_normalized: String,
}

/// The golden file shape: `{ relative_path -> [ExpectedSymbol] }`. A BTreeMap
/// keeps `relative_path` keys sorted deterministically.
#[derive(Serialize)]
struct ExpectedFile {
    #[serde(flatten)]
    paths: BTreeMap<String, Vec<ExpectedSymbol>>,
}

fn regen(dir: &Path, repo_id: &str, emit: &str) -> Result<()> {
    let root = dir
        .canonicalize()
        .with_context(|| format!("path does not exist: {}", dir.display()))?;

    let rel_paths = walker::walk_repo(&root);

    let mut files = Vec::new();
    for rel in &rel_paths {
        let lang: Language = match walker::language_for_path(rel) {
            Some(l) => l,
            None => continue,
        };
        let abs = walker::abs_from_rel(&root, rel);
        // Reuse the production single-file pipeline so the emitted IDs are
        // byte-identical to a real `index`/`sync` run.
        if let Some(fp) = indexer::process_file(repo_id, rel, lang, &abs, false)
            .with_context(|| format!("parse {}", rel))?
        {
            files.push(fp);
        }
    }
    // `walk_repo` already sorts paths; keep files in that order.

    match emit {
        "payload" => {
            // Full `code_ingest_repo` File[] shape (the wire payload, minus the
            // envelope). Field order follows `payload.rs`'s serde structs.
            let json = serde_json::to_string_pretty(&files).context("serialize payload")?;
            println!("{json}");
        }
        "expected" => {
            let mut paths: BTreeMap<String, Vec<ExpectedSymbol>> = BTreeMap::new();
            for fp in &files {
                let entries = fp
                    .symbols
                    .iter()
                    .map(|s| {
                        let raw = s.signature.as_deref().unwrap_or("");
                        ExpectedSymbol {
                            name: s.name.clone(),
                            kind: s.kind.clone(),
                            id: s.id.clone(),
                            signature_normalized: normalize_signature(raw),
                        }
                    })
                    .collect();
                paths.insert(fp.relative_path.clone(), entries);
            }
            let out = ExpectedFile { paths };
            let json = serde_json::to_string_pretty(&out).context("serialize expected")?;
            println!("{json}");
        }
        other => anyhow::bail!("unknown --emit value '{other}' (expected: expected | payload)"),
    }
    Ok(())
}
