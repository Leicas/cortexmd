//! Kotlin draft+import extraction. Uses fwcd tree-sitter-kotlin's node kinds:
//! - class_declaration (class / interface / enum, distinguished by keyword)
//! - object_declaration (`object`)
//! - function_declaration (`fun`)
//! - import_header (dotted import path)
//!
//! fwcd's grammar names declaration identifiers `simple_identifier`
//! (functions) and `type_identifier` (types), neither always exposed via a
//! `name` field — so names are pulled by scanning named children.

use crate::parser::{make_draft, node_text, ParsedImport, SymbolDraft};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match node.kind() {
        "class_declaration" => {
            let name = type_name(node, src)?;
            let kind = class_kind(src, node);
            Some(make_draft(&name, kind, &first_line(src, node), node, parent_idx, namespace, src))
        }
        "object_declaration" => {
            let name = type_name(node, src)?;
            Some(make_draft(&name, "object", &first_line(src, node), node, parent_idx, namespace, src))
        }
        "function_declaration" => {
            let name = simple_name(node, src)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            Some(make_draft(&name, kind, &first_line(src, node), node, parent_idx, namespace, src))
        }
        _ => None,
    }
}

/// `interface Foo` / `enum class Foo` / `class Foo` share class_declaration;
/// pick the kind off the leading keywords.
fn class_kind(src: &str, node: Node<'_>) -> &'static str {
    let head = node_text(src, node);
    let head = head.lines().next().unwrap_or("");
    if head.contains("interface") {
        "interface"
    } else if head.contains("enum") {
        "enum"
    } else {
        "class"
    }
}

// The identifier node kind differs by grammar lineage: tree-sitter-kotlin-ng
// (Rust) names it `identifier`; fwcd tree-sitter-kotlin (npm) names it
// `simple_identifier` / `type_identifier`. Accepting all keeps both adapters
// producing the same name string.
const NAME_KINDS: &[&str] = &["identifier", "type_identifier", "simple_identifier"];

fn type_name(node: Node<'_>, src: &str) -> Option<String> {
    child_named(node, src, NAME_KINDS)
}

fn simple_name(node: Node<'_>, src: &str) -> Option<String> {
    child_named(node, src, NAME_KINDS)
}

fn child_named(node: Node<'_>, src: &str, kinds: &[&str]) -> Option<String> {
    let mut cur = node.walk();
    for ch in node.named_children(&mut cur) {
        if kinds.contains(&ch.kind()) {
            return Some(node_text(src, ch).to_string());
        }
    }
    None
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
        // `import` (kotlin-ng) / `import_header` (fwcd). The dotted path is a
        // qualified_identifier (ng) or identifier (fwcd) child.
        if node.kind() == "import" || node.kind() == "import_header" {
            let mut cur = node.walk();
            let id = node
                .named_children(&mut cur)
                .find(|c| matches!(c.kind(), "qualified_identifier" | "identifier"));
            if let Some(id) = id {
                let module = node_text(src, id).to_string();
                let last = module.rsplit('.').next().unwrap_or(&module).to_string();
                let key = format!("{}|{}", last, module);
                if seen.insert(key) {
                    out.push(ParsedImport {
                        imported_name: last,
                        source_module: module,
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
