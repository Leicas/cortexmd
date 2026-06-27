//! Ruby draft+import extraction. Uses tree-sitter-ruby's node kinds:
//! - method / singleton_method (`name` field)
//! - class / module (`name` field is a `constant`; both are container kinds)
//! - require / require_relative calls → imports (best-effort)
//!
//! Top-level `def` is recorded as a `function`; a `def` nested in a class or
//! module is a `method` — mirroring the Python adapter's namespace rule.

use crate::parser::{field, make_draft, node_text, strip_quotes, ParsedImport, SymbolDraft};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match node.kind() {
        "method" | "singleton_method" => {
            let n = field(node, "name")?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            Some(make_draft(
                node_text(src, n),
                kind,
                &first_line(src, node),
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "class" | "singleton_class" => {
            let n = field(node, "name")?;
            Some(make_draft(
                node_text(src, n),
                "class",
                &first_line(src, node),
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "module" => {
            let n = field(node, "name")?;
            Some(make_draft(
                node_text(src, n),
                "module",
                &first_line(src, node),
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        _ => None,
    }
}

/// Ruby declarations open on their first line (`def foo(a)`, `class Foo < Bar`);
/// that line is a stable signature.
fn first_line(src: &str, node: Node<'_>) -> String {
    node_text(src, node).lines().next().unwrap_or("").trim().to_string()
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            let method = field(node, "method").map(|m| node_text(src, m));
            if matches!(method, Some("require") | Some("require_relative")) {
                if let Some(args) = field(node, "arguments") {
                    let mut cur = args.walk();
                    let arg = args.named_children(&mut cur).next();
                    if let Some(arg) = arg {
                        // string node → strip quotes / read string_content.
                        let module = string_value(arg, src);
                        if let Some(module) = module {
                            let name = module
                                .rsplit('/')
                                .next()
                                .unwrap_or(&module)
                                .to_string();
                            let key = format!("{}|{}", name, module);
                            if seen.insert(key) {
                                out.push(ParsedImport {
                                    imported_name: name,
                                    source_module: module,
                                });
                            }
                        }
                    }
                }
            }
        }
        let mut cur = node.walk();
        for ch in node.named_children(&mut cur) {
            stack.push(ch);
        }
    }
}

/// Read a Ruby string literal's textual value. Handles both the `string` node
/// (with a `string_content` child) and bare quoted text.
fn string_value(node: Node<'_>, src: &str) -> Option<String> {
    if node.kind() == "string" {
        let mut cur = node.walk();
        if let Some(content) = node
            .named_children(&mut cur)
            .find(|c| c.kind() == "string_content")
        {
            return Some(node_text(src, content).to_string());
        }
        return Some(strip_quotes(node_text(src, node)).to_string());
    }
    None
}
