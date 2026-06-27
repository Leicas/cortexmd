//! C draft+import extraction. Uses tree-sitter-c's node kinds:
//! - function_definition (declarator chain → identifier)
//! - struct_specifier / union_specifier / enum_specifier (with `name` field)
//! - preproc_include (#include <foo.h> / "foo.h")
//!
//! Mirrors the C++ adapter (`cpp.rs`) minus namespaces and classes — C has no
//! `namespace_definition` / `class_specifier`. Function names live inside a
//! declarator chain identical to C++:
//!   function_definition.declarator: function_declarator.declarator: identifier

use crate::parser::{field, make_draft, node_text, ParsedImport, SymbolDraft};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match node.kind() {
        "function_definition" => {
            let name = function_name(node, src)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            let sig = function_signature(src, node);
            Some(make_draft(&name, kind, &sig, node, parent_idx, namespace, src))
        }
        "struct_specifier" => named_type(node, src, parent_idx, namespace, "struct"),
        "union_specifier" => named_type(node, src, parent_idx, namespace, "union"),
        "enum_specifier" => named_type(node, src, parent_idx, namespace, "enum"),
        _ => None,
    }
}

/// struct/union/enum carry a `name` (type_identifier). Forward declarations and
/// anonymous specifiers (no name, or no body) are skipped — we only index a
/// definition once, where it has a name.
fn named_type(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
    kind: &str,
) -> Option<SymbolDraft> {
    let n = field(node, "name")?;
    let name = node_text(src, n).to_string();
    let sig = format!("{} {}", kind, name);
    Some(make_draft(&name, kind, &sig, node, parent_idx, namespace, src))
}

/// Unwrap the declarator chain (pointer/array wrappers) to the identifier.
fn function_name(node: Node<'_>, src: &str) -> Option<String> {
    let mut decl = field(node, "declarator")?;
    loop {
        match decl.kind() {
            "function_declarator" => {
                let inner = field(decl, "declarator")?;
                return name_from_declarator_id(inner, src);
            }
            "pointer_declarator" | "array_declarator" | "parenthesized_declarator" => {
                decl = field(decl, "declarator")?;
            }
            _ => return None,
        }
    }
}

fn name_from_declarator_id(node: Node<'_>, src: &str) -> Option<String> {
    match node.kind() {
        "identifier" | "field_identifier" => Some(node_text(src, node).to_string()),
        // Defensive: a wrapped declarator can still appear here.
        "pointer_declarator" | "parenthesized_declarator" | "function_declarator" => {
            field(node, "declarator").and_then(|d| name_from_declarator_id(d, src))
        }
        _ => None,
    }
}

fn function_signature(src: &str, node: Node<'_>) -> String {
    if let Some(body) = field(node, "body") {
        let start = node.start_byte();
        let end = body.start_byte();
        return src[start..end].trim().to_string();
    }
    let text = node_text(src, node);
    text.lines().next().unwrap_or("").trim().to_string()
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "preproc_include" {
            if let Some(path_node) = field(node, "path") {
                let raw = node_text(src, path_node).trim();
                let inner = raw
                    .strip_prefix('<')
                    .and_then(|s| s.strip_suffix('>'))
                    .or_else(|| raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
                    .unwrap_or(raw)
                    .to_string();
                if !inner.is_empty() && seen.insert(inner.clone()) {
                    let basename = inner
                        .rsplit('/')
                        .next()
                        .unwrap_or(&inner)
                        .split('.')
                        .next()
                        .unwrap_or(&inner)
                        .to_string();
                    out.push(ParsedImport {
                        imported_name: basename,
                        source_module: inner,
                    });
                }
            }
        }
        let mut cur = node.walk();
        for ch in node.named_children(&mut cur) {
            stack.push(ch);
        }
    }
}
