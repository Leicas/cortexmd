//! Java draft+import extraction. Uses tree-sitter-java's node kinds:
//! - class_declaration / interface_declaration / enum_declaration /
//!   record_declaration (each has a `name` identifier and a `body`)
//! - method_declaration / constructor_declaration (`name` identifier, `body` block)
//! - import_declaration (scoped_identifier path)
//!
//! Class/interface/enum/record are container kinds, so the generic walk in
//! parser.rs descends into them, prefixing method qualified names.

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
        "class_declaration" => container(node, src, parent_idx, namespace, "class"),
        "interface_declaration" => container(node, src, parent_idx, namespace, "interface"),
        "annotation_type_declaration" => container(node, src, parent_idx, namespace, "interface"),
        "enum_declaration" => container(node, src, parent_idx, namespace, "enum"),
        // Java records behave like final data classes; index them as classes.
        "record_declaration" => container(node, src, parent_idx, namespace, "class"),
        "method_declaration" | "constructor_declaration" => {
            let n = field(node, "name")?;
            let sig = decl_signature(src, node);
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
        _ => None,
    }
}

fn container(
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

/// Header text up to the `body` block — collapses the body out of the signature.
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
        if node.kind() == "import_declaration" {
            // The qualified path is the first scoped_identifier/identifier child.
            let mut cur = node.walk();
            let path = node
                .named_children(&mut cur)
                .find(|c| matches!(c.kind(), "scoped_identifier" | "identifier"));
            if let Some(p) = path {
                let module = node_text(src, p).to_string();
                // `import a.b.C` → name C; `import a.b.*` → name b (last concrete).
                let last = module
                    .rsplit('.')
                    .find(|s| *s != "*")
                    .unwrap_or(&module)
                    .to_string();
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
