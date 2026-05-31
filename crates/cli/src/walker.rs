//! Filesystem walker. Mirrors the SKIP_DIRS list and extension filter from
//! `src/lib/code-nav/repos.ts:111-167` and the denied-segments check.
//!
//! Uses the `ignore` crate so `.gitignore` and `.git/info/exclude` are honored
//! automatically.

use crate::payload::Language;
use ignore::WalkBuilder;
use std::path::{Component, Path, PathBuf};

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    ".git",
    ".next",
    "build",
    "out",
    "target",
    "__pycache__",
    "venv",
    ".venv",
    "vendor",
    ".history",
];

const DENIED_SEGMENTS: &[&str] = &[".obsidian", ".sync", ".trash"];

pub fn language_for_path(rel: &str) -> Option<Language> {
    let lower = rel.to_ascii_lowercase();
    let ext = Path::new(&lower).extension().and_then(|s| s.to_str())?;
    Language::from_extension(ext)
}

/// Walk a repo, return relative POSIX-style paths for source files.
pub fn walk_repo(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false) // we want dotfiles like .config/ but skip our explicit list
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Reject denied-segment dirs and SKIP_DIRS by name regardless of depth.
            if SKIP_DIRS.iter().any(|d| *d == name) {
                return false;
            }
            if DENIED_SEGMENTS.iter().any(|d| *d == name) {
                return false;
            }
            true
        })
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        // POSIX-style relative path.
        let rel_posix = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        if rel_posix.is_empty() {
            continue;
        }

        // Defense-in-depth: re-check segments.
        if rel_posix
            .split('/')
            .any(|seg| SKIP_DIRS.contains(&seg) || DENIED_SEGMENTS.contains(&seg))
        {
            continue;
        }

        if language_for_path(&rel_posix).is_none() {
            continue;
        }

        out.push(rel_posix);
    }
    out.sort();
    out
}

/// Resolve absolute path inside the repo from a relative POSIX path.
pub fn abs_from_rel(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    p
}
