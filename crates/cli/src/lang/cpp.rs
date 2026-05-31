//! C++ draft+import extraction. Uses tree-sitter-cpp's node kinds:
//! - function_definition (top-level functions and class methods)
//! - class_specifier / struct_specifier / union_specifier
//! - enum_specifier (with enumerators)
//! - namespace_definition (contributes to qualified_name)
//! - template_declaration (wraps a definition; we look inside)
//! - preproc_include (#include <foo> / "foo.hpp")
//!
//! Function/method names live inside declarators:
//!   function_definition
//!     declarator: function_declarator
//!       declarator: identifier|field_identifier|qualified_identifier|destructor_name
//!
//! For methods the declarator is `qualified_identifier` (Foo::bar) or just
//! `field_identifier` when defined inline inside a class body.

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
            let (name_str, _was_qualified) = function_name(node, src)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            let sig = function_signature(src, node);
            Some(make_draft(
                &name_str,
                kind,
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "class_specifier" => class_like(node, src, parent_idx, namespace, "class"),
        "struct_specifier" => class_like(node, src, parent_idx, namespace, "struct"),
        "union_specifier" => class_like(node, src, parent_idx, namespace, "union"),
        "enum_specifier" => class_like(node, src, parent_idx, namespace, "enum"),
        "namespace_definition" => {
            // namespace_definition has a `name` field (identifier or
            // namespace_identifier). Anonymous namespaces have no name.
            let n = field(node, "name")?;
            let name = node_text(src, n).to_string();
            // Treat namespace as a "class"-like container so children get a
            // qualified_name prefix.
            let sig = format!("namespace {}", name);
            Some(make_draft(
                &name,
                "class",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        // template_declaration wraps function_definition / class_specifier;
        // we don't index the template wrapper itself — recursion finds the
        // wrapped declaration.
        _ => None,
    }
}

fn class_like(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
    kind: &str,
) -> Option<SymbolDraft> {
    let n = field(node, "name")?;
    let name = node_text(src, n).to_string();
    let sig = class_signature(src, node);
    Some(make_draft(
        &name,
        kind,
        &sig,
        node,
        parent_idx,
        namespace,
        src,
    ))
}

/// Extract a flat name string from the declarator chain inside a function_definition.
/// Returns (name, was_qualified). "Foo::bar" → "bar", was_qualified=true.
fn function_name(node: Node<'_>, src: &str) -> Option<(String, bool)> {
    let mut decl = field(node, "declarator")?;
    // Unwrap pointer/reference declarators that wrap function_declarator.
    loop {
        match decl.kind() {
            "function_declarator" => {
                let inner = field(decl, "declarator")?;
                return name_from_declarator_id(inner, src);
            }
            "pointer_declarator" | "reference_declarator" => {
                decl = field(decl, "declarator")?;
            }
            _ => return None,
        }
    }
}

fn name_from_declarator_id(node: Node<'_>, src: &str) -> Option<(String, bool)> {
    match node.kind() {
        "identifier" | "field_identifier" => {
            Some((node_text(src, node).to_string(), false))
        }
        "destructor_name" => {
            // ~Foo
            Some((node_text(src, node).to_string(), false))
        }
        "operator_name" => {
            // operator+, operator==
            Some((node_text(src, node).to_string(), false))
        }
        "qualified_identifier" | "scoped_identifier" | "template_function" => {
            // A::B::name — take the last segment as the symbol name.
            let text = node_text(src, node);
            let last = text
                .rsplit("::")
                .next()
                .unwrap_or(text)
                .to_string();
            Some((last, true))
        }
        _ => None,
    }
}

/// Build a function signature: take everything from the start of the node up to
/// the function body (compound_statement) — collapses whitespace.
fn function_signature(src: &str, node: Node<'_>) -> String {
    if let Some(body) = field(node, "body") {
        let start = node.start_byte();
        let end = body.start_byte();
        return src[start..end].trim().to_string();
    }
    let text = node_text(src, node);
    text.lines().next().unwrap_or("").trim().to_string()
}

/// Class signature: pull the header up to '{'.
fn class_signature(src: &str, node: Node<'_>) -> String {
    let text = node_text(src, node);
    if let Some(brace) = text.find('{') {
        text[..brace].trim().to_string()
    } else {
        text.lines().next().unwrap_or("").trim().to_string()
    }
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "preproc_include" {
            // The path field holds the include target. It can be a
            // system_lib_string (<foo>) or a string_literal ("foo.hpp").
            if let Some(path_node) = field(node, "path") {
                let raw = node_text(src, path_node);
                // Strip <...> or "..." wrappers.
                let trimmed = raw.trim();
                let inner = trimmed
                    .strip_prefix('<')
                    .and_then(|s| s.strip_suffix('>'))
                    .or_else(|| trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
                    .unwrap_or(trimmed)
                    .to_string();
                if !inner.is_empty() && seen.insert(inner.clone()) {
                    // Use the basename (sans extension) as imported_name and
                    // the full path as source_module — mirrors the convention
                    // used by other languages where the "name" is what local
                    // code would reference.
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
