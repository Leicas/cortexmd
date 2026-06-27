//! Wire-format types matching the cortexmd `code_ingest_repo` Zod schema.
//! Also houses the canonical SHA1 helper and symbol-id derivation. The
//! symbol-id algorithm's single source of truth is `contract/symbol-id.md`.

use serde::Serialize;
use sha1::{Digest, Sha1};

/// Normalize CRLF → LF. See `contract/symbol-id.md` (newline normalization).
pub fn normalize_newlines(src: &str) -> String {
    // Replace \r\n then any remaining \r — matches the JS regex /\r\n?/g.
    src.replace("\r\n", "\n").replace('\r', "\n")
}

/// SHA1 hex digest, full 40 chars, lowercase. The single canonical hash helper.
pub fn sha1_hex(input: &str) -> String {
    let mut h = Sha1::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    hex::encode(digest)
}

/// Collapse whitespace runs to a single space, trim. Empty → "<no-sig>".
/// See `contract/symbol-id.md` (signature normalization).
pub fn normalize_signature(sig: &str) -> String {
    let mut out = String::with_capacity(sig.len());
    let mut last_space = true; // skip leading whitespace
    for ch in sig.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "<no-sig>".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build the 16-char symbol id. Hashed against `repo_id` (immutable) so
/// renames don't churn IDs. See `contract/symbol-id.md` (the canonical spec).
pub fn symbol_id(
    repo_id: &str,
    relative_path: &str,
    name: &str,
    kind: &str,
    signature_normalized: &str,
) -> String {
    let s = format!(
        "{}|{}|{}|{}|{}",
        repo_id, relative_path, name, kind, signature_normalized
    );
    sha1_hex(&s)[..16].to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Typescript,
    Tsx,
    Javascript,
    Python,
    Rust,
    Go,
    Cpp,
    C,
    Java,
    Kotlin,
    Ruby,
    Php,
    Dart,
}

impl Language {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "ts" => Some(Self::Typescript),
            "tsx" => Some(Self::Tsx),
            "js" | "jsx" => Some(Self::Javascript),
            "py" => Some(Self::Python),
            "rs" => Some(Self::Rust),
            "go" => Some(Self::Go),
            // `.h` stays C++ (most headers compile as C++; tree-sitter-cpp also
            // parses C). `.c` is plain C.
            "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hxx" | "h++" | "h" => Some(Self::Cpp),
            "c" => Some(Self::C),
            "java" => Some(Self::Java),
            "kt" | "kts" => Some(Self::Kotlin),
            "rb" => Some(Self::Ruby),
            "php" => Some(Self::Php),
            "dart" => Some(Self::Dart),
            _ => None,
        }
    }
    pub fn as_payload_str(self) -> &'static str {
        match self {
            Self::Typescript => "typescript",
            Self::Tsx => "tsx",
            Self::Javascript => "javascript",
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Go => "go",
            Self::Cpp => "cpp",
            Self::C => "c",
            Self::Java => "java",
            Self::Kotlin => "kotlin",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Dart => "dart",
        }
    }
}

// ─── Wire types (snake_case match server schema) ──────────────────────────

#[derive(Debug, Serialize)]
pub struct SymbolPayload {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
    pub parent_id: Option<String>,
    pub content_hash: String,
    /// 64-bit SimHash of the symbol body, lowercase 16-char hex. Skipped on
    /// the wire when `None` so older servers (pre-body-simhash) ignore the
    /// field cleanly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_simhash: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CallPayload {
    pub caller_id: String,
    pub callee_name: String,
    pub call_line: u32,
}

#[derive(Debug, Serialize)]
pub struct ImportPayload {
    pub imported_name: String,
    pub source_module: String,
}

#[derive(Debug, Serialize)]
pub struct FilePayload {
    pub relative_path: String,
    pub language: &'static str,
    pub content_hash: String,
    pub size_bytes: u64,
    pub symbols: Vec<SymbolPayload>,
    pub calls: Vec<CallPayload>,
    pub imports: Vec<ImportPayload>,
}

#[derive(Debug, Serialize, Default)]
pub struct WorkspacePackage {
    pub name: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Default)]
pub struct PackageWorkspaces {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_packages: Option<Vec<WorkspacePackage>>,
}

impl PackageWorkspaces {
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.workspaces.is_none() && self.workspace_packages.is_none()
    }
}

#[derive(Debug, Serialize)]
pub struct IngestPayload {
    pub repo_id: String,
    pub slug: String,
    pub git_origin: Option<String>,
    pub first_commit_sha: String,
    pub machine_id: String,
    pub abs_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_workspaces: Option<PackageWorkspaces>,
    pub files: Vec<FilePayload>,
    pub full_replace: bool,
}
