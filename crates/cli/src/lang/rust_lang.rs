//! Rust draft+import extraction.
//! Mirrors `parser.ts:398-426` (drafts) and `parser.ts:595-610` (imports).

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
        "function_item" => {
            let n = name_of(node)?;
            let kind = if !namespace.is_empty() { "method" } else { "function" };
            let sig = rust_item_signature(src, node);
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
        "struct_item" => {
            let n = name_of(node)?;
            let sig = rust_item_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "struct",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "enum_item" => {
            let n = name_of(node)?;
            let sig = rust_item_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "enum",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "trait_item" => {
            let n = name_of(node)?;
            let sig = rust_item_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "trait",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "impl_item" => {
            let type_node = field(node, "type");
            let name = type_node
                .map(|t| node_text(src, t).to_string())
                .unwrap_or_else(|| "impl".to_string());
            let sig = rust_item_signature(src, node);
            Some(make_draft(
                &name,
                "impl",
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

fn rust_item_signature(src: &str, node: Node<'_>) -> String {
    let text = node_text(src, node);
    if let Some(idx) = text.find('{') {
        return text[..idx].trim().to_string();
    }
    if let Some(idx) = text.find(';') {
        return text[..idx].trim().to_string();
    }
    text.lines().next().unwrap_or("").trim().to_string()
}

pub fn collect_imports(root: Node<'_>, src: &str, out: &mut Vec<ParsedImport>) {
    let mut seen = HashSet::<String>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "use_declaration" {
            let full_text = node_text(src, node)
                .trim_start_matches("use")
                .trim_start()
                .trim_end_matches(';')
                .trim();
            let last = full_text.rsplit("::").next().unwrap_or(full_text);
            // Strip any { … } group — fall back to last segment.
            let stripped = strip_braces(last);
            let clean_last = stripped.trim();
            if !clean_last.is_empty() {
                let key = format!("{}|{}", clean_last, full_text);
                if seen.insert(key) {
                    out.push(ParsedImport {
                        imported_name: clean_last.to_string(),
                        source_module: full_text.to_string(),
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

fn strip_braces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
            }
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}
