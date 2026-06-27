//! Dart draft+import extraction. Uses tree-sitter-dart's node kinds:
//! - class_definition / enum_declaration / mixin_declaration /
//!   extension_declaration (container kinds)
//! - function_signature / method_signature (the name-bearing node; the body is
//!   a separate sibling)
//! - import_or_export → import_specification (`import 'package:foo/bar.dart'`)
//!
//! Dart's grammar splits a declaration into a signature node plus a separate
//! body node, so signatures here are taken from the signature node's text.

use crate::parser::{make_draft, node_text, strip_quotes, ParsedImport, SymbolDraft};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match node.kind() {
        "class_declaration" => named(node, src, parent_idx, namespace, "class"),
        "enum_declaration" => named(node, src, parent_idx, namespace, "enum"),
        "mixin_declaration" => named(node, src, parent_idx, namespace, "mixin"),
        "extension_declaration" => named(node, src, parent_idx, namespace, "extension"),
        // The name-bearing leaves. `method_signature` is only a wrapper around
        // one of these, so we match the leaves directly to avoid emitting a
        // method twice. namespace decides function vs method.
        "function_signature"
        | "getter_signature"
        | "setter_signature"
        | "constructor_signature"
        | "factory_constructor_signature" => {
            let name = ident(node, src)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            Some(make_draft(&name, kind, &first_line(src, node), node, parent_idx, namespace, src))
        }
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
    let name = ident(node, src)?;
    Some(make_draft(&name, kind, &first_line(src, node), node, parent_idx, namespace, src))
}

/// First direct `identifier` named child.
fn ident(node: Node<'_>, src: &str) -> Option<String> {
    let mut cur = node.walk();
    let found = node.named_children(&mut cur).find(|c| c.kind() == "identifier");
    found.map(|c| node_text(src, c).to_string())
}

fn first_line(src: &str, node: Node<'_>) -> String {
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
        // import directives carry a string URI; node kind varies by grammar
        // version (import_specification / import_or_export). Match on a string
        // literal under any node whose kind mentions "import".
        if node.kind().contains("import") {
            if let Some(uri) = find_uri(node, src) {
                let name = uri
                    .rsplit('/')
                    .next()
                    .unwrap_or(&uri)
                    .trim_end_matches(".dart")
                    .to_string();
                let key = format!("{}|{}", name, uri);
                if seen.insert(key) {
                    out.push(ParsedImport {
                        imported_name: name,
                        source_module: uri,
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

fn find_uri(node: Node<'_>, src: &str) -> Option<String> {
    let mut stack: Vec<Node> = vec![node];
    while let Some(cur) = stack.pop() {
        let k = cur.kind();
        if k == "string_literal" || k == "uri" {
            return Some(strip_quotes(node_text(src, cur)).to_string());
        }
        let mut c = cur.walk();
        for ch in cur.named_children(&mut c) {
            stack.push(ch);
        }
    }
    None
}
