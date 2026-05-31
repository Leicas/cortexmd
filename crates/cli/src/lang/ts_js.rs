//! TypeScript / TSX / JavaScript draft+import extraction.
//! Mirrors `parser.ts:327-378` (drafts) and `parser.ts:504-543` (imports).

use crate::parser::{
    field, leading_docstring, make_draft, name_of, node_text, strip_quotes, ParsedImport,
    SymbolDraft,
};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    let _ = leading_docstring; // referenced via make_draft — silence unused warning here
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            let n = name_of(node)?;
            let sig = function_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "function",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "class_declaration" | "abstract_class_declaration" => {
            let n = name_of(node)?;
            let sig = brace_signature(src, node);
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
        "interface_declaration" => {
            let n = name_of(node)?;
            let sig = brace_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "interface",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "type_alias_declaration" => {
            let n = name_of(node)?;
            let first_line = node_text(src, node).lines().next().unwrap_or("");
            Some(make_draft(
                node_text(src, n),
                "type",
                first_line,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "method_definition" | "method_signature" | "abstract_method_signature" => {
            let n = name_of(node)?;
            let sig = function_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "method",
                &sig,
                node,
                parent_idx,
                namespace,
                src,
            ))
        }
        "lexical_declaration" | "variable_declaration" => {
            // Top-level exported `const x = (...) => ...` only.
            let parent_kind = node.parent().map(|p| p.kind());
            if parent_kind != Some("export_statement") {
                return None;
            }
            let mut cur = node.walk();
            for decl in node.named_children(&mut cur) {
                if decl.kind() != "variable_declarator" {
                    continue;
                }
                let n = field(decl, "name")?;
                let value = field(decl, "value")?;
                if !matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "function"
                ) {
                    continue;
                }
                let name = node_text(src, n);
                let value_first_line = node_text(src, value).lines().next().unwrap_or("");
                let sig = format!("const {} = {}", name, value_first_line);
                return Some(make_draft(
                    name,
                    "const-export",
                    &sig,
                    decl,
                    parent_idx,
                    namespace,
                    src,
                ));
            }
            None
        }
        _ => None,
    }
}

fn function_signature(src: &str, node: Node<'_>) -> String {
    let text = node_text(src, node);
    if let Some(idx) = text.find('{') {
        return text[..idx].trim().to_string();
    }
    if let Some(idx) = text.find(';') {
        return text[..idx].trim().to_string();
    }
    text.lines().next().unwrap_or("").trim().to_string()
}

fn brace_signature(src: &str, node: Node<'_>) -> String {
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
        let kind = node.kind();
        if kind == "import_statement" || kind == "export_from_clause" {
            let source_node = field(node, "source").or_else(|| {
                let mut cur = node.walk();
                let found = node
                    .named_children(&mut cur)
                    .find(|c| c.kind() == "string");
                found
            });
            if let Some(sn) = source_node {
                let source_module = strip_quotes(node_text(src, sn)).to_string();
                let mut names = Vec::<String>::new();
                let mut istack: Vec<Node> = {
                    let mut cur = node.walk();
                    node.named_children(&mut cur).collect()
                };
                while let Some(cur) = istack.pop() {
                    match cur.kind() {
                        "import_specifier" => {
                            let alias = field(cur, "alias");
                            let nm = field(cur, "name");
                            let use_node = alias.or(nm);
                            if let Some(u) = use_node {
                                names.push(node_text(src, u).to_string());
                            }
                        }
                        "namespace_import" => {
                            let mut c2 = cur.walk();
                            let id_opt = cur
                                .named_children(&mut c2)
                                .find(|c| c.kind() == "identifier");
                            if let Some(id) = id_opt {
                                names.push(node_text(src, id).to_string());
                            }
                        }
                        "identifier" => {
                            if cur.parent().map(|p| p.kind()) == Some("import_clause") {
                                names.push(node_text(src, cur).to_string());
                            }
                        }
                        _ => {
                            let mut c2 = cur.walk();
                            for ch in cur.named_children(&mut c2) {
                                istack.push(ch);
                            }
                        }
                    }
                }
                for n in names {
                    let key = format!("{}|{}", n, source_module);
                    if seen.insert(key) {
                        out.push(ParsedImport {
                            imported_name: n,
                            source_module: source_module.clone(),
                        });
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
