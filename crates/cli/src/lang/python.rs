//! Python draft+import extraction.
//! Mirrors `parser.ts:382-394` (drafts) and `parser.ts:545-594` (imports).

use crate::parser::{field, make_draft, name_of, node_text, ParsedImport, SymbolDraft};
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
            let n = name_of(node)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            let sig = python_def_signature(src, node);
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
        "class_definition" => {
            let n = name_of(node)?;
            let sig = python_def_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "class",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        _ => None,
    }
}

fn python_def_signature(src: &str, node: Node<'_>) -> String {
    let text = node_text(src, node);
    if let Some(idx) = text.find(':') {
        return text[..idx].trim().to_string();
    }
    text.lines().next().unwrap_or("").trim().to_string()
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        let kind = node.kind();
        if kind == "import_statement" {
            let mut cur = node.walk();
            for ch in node.named_children(&mut cur) {
                match ch.kind() {
                    "dotted_name" => {
                        let text = node_text(src, ch);
                        let key = format!("{}|{}", text, text);
                        if seen.insert(key) {
                            let last = text.rsplit('.').next().unwrap_or(text).to_string();
                            out.push(ParsedImport {
                                imported_name: last,
                                source_module: text.to_string(),
                            });
                        }
                    }
                    "aliased_import" => {
                        let nm = field(ch, "name");
                        let al = field(ch, "alias");
                        if let Some(n) = nm {
                            let module = node_text(src, n).to_string();
                            let alias = al
                                .map(|a| node_text(src, a).to_string())
                                .unwrap_or_else(|| module.clone());
                            let key = format!("{}|{}", alias, module);
                            if seen.insert(key) {
                                out.push(ParsedImport {
                                    imported_name: alias,
                                    source_module: module,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        } else if kind == "import_from_statement" {
            let module_node = field(node, "module_name");
            let module_name = module_node
                .map(|m| node_text(src, m).to_string())
                .unwrap_or_default();
            let mut cur = node.walk();
            for ch in node.named_children(&mut cur) {
                if Some(ch.id()) == module_node.map(|m| m.id()) {
                    continue;
                }
                match ch.kind() {
                    "dotted_name" | "identifier" => {
                        let text = node_text(src, ch).to_string();
                        let key = format!("{}|{}", text, module_name);
                        if seen.insert(key) {
                            out.push(ParsedImport {
                                imported_name: text,
                                source_module: module_name.clone(),
                            });
                        }
                    }
                    "aliased_import" => {
                        let nm = field(ch, "name");
                        let al = field(ch, "alias");
                        let import_name = al
                            .or(nm)
                            .map(|n| node_text(src, n).to_string());
                        if let Some(name) = import_name {
                            let key = format!("{}|{}", name, module_name);
                            if seen.insert(key) {
                                out.push(ParsedImport {
                                    imported_name: name,
                                    source_module: module_name.clone(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut cur = node.walk();
        for ch in node.named_children(&mut cur) {
            stack.push(ch);
        }
    }
}
