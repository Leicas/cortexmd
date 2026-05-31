//! Per-language tree-sitter dispatch. Mirrors `src/lib/code-nav/parser.ts`'s
//! `draftFor` (line 317) and `collectImports` (line 491) split by language.

pub mod cpp;
pub mod go;
pub mod python;
pub mod rust_lang;
pub mod ts_js;

use crate::parser::{ParsedImport, SymbolDraft};
use crate::payload::Language;
use tree_sitter::Node;

/// Convert our enum into a tree-sitter Language. The 0.23 typescript grammar
/// exposes `LANGUAGE_TYPESCRIPT` / `LANGUAGE_TSX`; the 0.25 series exposes
/// `LANGUAGE`. Both convert via Into<tree_sitter::Language>.
pub fn tree_sitter_language(lang: Language) -> tree_sitter::Language {
    match lang {
        Language::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Language::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Language::Javascript => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
    }
}

/// Per-language draft factory. Returns Some(draft) if the node represents a
/// declared symbol we want to index. Mirrors `parser.ts:draftFor`.
pub fn draft_for(
    node: Node<'_>,
    src: &str,
    language: Language,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match language {
        Language::Typescript | Language::Tsx | Language::Javascript => {
            ts_js::draft_for(node, src, parent_idx, namespace)
        }
        Language::Python => python::draft_for(node, src, parent_idx, namespace),
        Language::Rust => rust_lang::draft_for(node, src, parent_idx, namespace),
        Language::Go => go::draft_for(node, src, parent_idx, namespace),
        Language::Cpp => cpp::draft_for(node, src, parent_idx, namespace),
    }
}

/// Per-language import extractor. Walks the whole tree, pushes
/// (imported_name, source_module) rows.
pub fn collect_imports(
    root: Node<'_>,
    src: &str,
    language: Language,
    out: &mut Vec<ParsedImport>,
) {
    match language {
        Language::Typescript | Language::Tsx | Language::Javascript => {
            ts_js::collect_imports(root, src, out)
        }
        Language::Python => python::collect_imports(root, src, out),
        Language::Rust => rust_lang::collect_imports(root, src, out),
        Language::Go => go::collect_imports(root, src, out),
        Language::Cpp => cpp::collect_imports(root, src, out),
    }
}
