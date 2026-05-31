//! Go draft+import extraction.
//! Mirrors `parser.ts:430-484` (drafts) and `parser.ts:611-633` (imports).

use crate::parser::{
    field, make_draft, name_of, node_text, strip_quotes, ParsedImport, SymbolDraft,
};
use std::collections::HashSet;
use tree_sitter::Node;

pub fn draft_for(
    node: Node<'_>,
    src: &str,
    parent_idx: Option<usize>,
    namespace: &[String],
) -> Option<SymbolDraft> {
    match node.kind() {
        "function_declaration" => {
            let n = name_of(node)?;
            let sig = go_func_signature(src, node);
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
        "method_declaration" => {
            let n = name_of(node)?;
            // Find receiver type name by walking the receiver subtree.
            let mut receiver_name: Option<String> = None;
            if let Some(receiver) = field(node, "receiver") {
                let mut stack: Vec<Node> = vec![receiver];
                while let Some(cur) = stack.pop() {
                    if cur.kind() == "type_identifier" {
                        receiver_name = Some(node_text(src, cur).to_string());
                        break;
                    }
                    let mut c = cur.walk();
                    for ch in cur.named_children(&mut c) {
                        stack.push(ch);
                    }
                }
            }
            let mut ns = namespace.to_vec();
            if let Some(r) = receiver_name {
                ns.push(r);
            }
            let sig = go_func_signature(src, node);
            Some(make_draft(
                node_text(src, n),
                "method",
                &sig,
                node,
                parent_idx,
                &ns,
                src,
            ))
        }
        "type_declaration" => {
            // Only emit a struct/interface; skip plain type aliases.
            let mut cur = node.walk();
            for spec in node.named_children(&mut cur) {
                if spec.kind() != "type_spec" {
                    continue;
                }
                let n = field(spec, "name")?;
                let ty = field(spec, "type")?;
                let name = node_text(src, n);
                if ty.kind() == "struct_type" {
                    let sig = format!("type {} struct", name);
                    return Some(make_draft(
                        name, "struct", &sig, spec, parent_idx, namespace, src,
                    ));
                }
                if ty.kind() == "interface_type" {
                    let sig = format!("type {} interface", name);
                    return Some(make_draft(
                        name,
                        "interface",
                        &sig,
                        spec,
                        parent_idx,
                        namespace,
                        src,
                    ));
                }
            }
            None
        }
        _ => None,
    }
}

fn go_func_signature(src: &str, node: Node<'_>) -> String {
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
        if node.kind() == "import_declaration" {
            let mut walk_stack: Vec<Node> = {
                let mut cur = node.walk();
                node.named_children(&mut cur).collect()
            };
            while let Some(cur) = walk_stack.pop() {
                if cur.kind() == "import_spec" {
                    let path_node = field(cur, "path").or_else(|| {
                        let mut c = cur.walk();
                        let found = cur
                            .named_children(&mut c)
                            .find(|c| c.kind() == "interpreted_string_literal");
                        found
                    });
                    if let Some(p) = path_node {
                        let module_name = strip_quotes(node_text(src, p)).to_string();
                        let imported = module_name
                            .rsplit('/')
                            .next()
                            .unwrap_or(&module_name)
                            .to_string();
                        let key = format!("{}|{}", imported, module_name);
                        if seen.insert(key) {
                            out.push(ParsedImport {
                                imported_name: imported,
                                source_module: module_name,
                            });
                        }
                    }
                    continue;
                }
                let mut c = cur.walk();
                for ch in cur.named_children(&mut c) {
                    walk_stack.push(ch);
                }
            }
        }
        let mut cur = node.walk();
        for ch in node.named_children(&mut cur) {
            stack.push(ch);
        }
    }
}
