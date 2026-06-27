//! PHP draft+import extraction. Uses tree-sitter-php's node kinds:
//! - function_definition / method_declaration (`name` field, `body` block)
//! - class_declaration / interface_declaration / trait_declaration /
//!   enum_declaration (container kinds with a `body`)
//! - namespace_definition (`name` field; container)
//! - namespace_use_declaration → imports (`use Foo\Bar;`)
//!
//! Parsed with the LANGUAGE_PHP grammar variant, so the leading `<?php` tag is
//! expected and handled by the grammar.

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
        "function_definition" => named(node, src, parent_idx, namespace, "function"),
        "method_declaration" => named(node, src, parent_idx, namespace, "method"),
        "class_declaration" => named(node, src, parent_idx, namespace, "class"),
        "interface_declaration" => named(node, src, parent_idx, namespace, "interface"),
        "trait_declaration" => named(node, src, parent_idx, namespace, "trait"),
        "enum_declaration" => named(node, src, parent_idx, namespace, "enum"),
        "namespace_definition" => named(node, src, parent_idx, namespace, "namespace"),
        _ => None,
    }
}

fn named(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
    kind: &str,
) -> Option<SymbolDraft> {
    let n = field(node, "name")?;
    let sig = decl_signature(src, node);
    Some(make_draft(
        node_text(src, n),
        kind,
        &sig,
        node,
        parent_idx,
        namespace,
        src,
    ))
}

/// Header up to the `body`. namespace_definition without braces has no body —
/// fall back to the first line.
fn decl_signature(src: &str, node: Node<'_>) -> String {
    if let Some(body) = field(node, "body") {
        return src[node.start_byte()..body.start_byte()].trim().to_string();
    }
    let text = node_text(src, node);
    if let Some(idx) = text.find('{') {
        return text[..idx].trim().to_string();
    }
    text.lines().next().unwrap_or("").trim().to_string()
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "namespace_use_declaration" {
            // Each clause carries a qualified_name (and optional alias).
            let mut cur = node.walk();
            let mut inner: Vec<Node> = node.named_children(&mut cur).collect();
            while let Some(child) = inner.pop() {
                if matches!(child.kind(), "qualified_name" | "name") {
                    let module = node_text(src, child).trim_start_matches('\\').to_string();
                    let last = module
                        .rsplit('\\')
                        .next()
                        .unwrap_or(&module)
                        .to_string();
                    let key = format!("{}|{}", last, module);
                    if seen.insert(key) {
                        out.push(ParsedImport {
                            imported_name: last,
                            source_module: module,
                        });
                    }
                    continue;
                }
                let mut c = child.walk();
                for ch in child.named_children(&mut c) {
                    inner.push(ch);
                }
            }
        }
        let mut cur = node.walk();
        for ch in node.named_children(&mut cur) {
            stack.push(ch);
        }
    }
}
