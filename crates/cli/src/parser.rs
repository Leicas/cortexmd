//! Tree-sitter driven parser. Mirrors `src/lib/code-nav/parser.ts:217-311`.
//! Yields a `ParseResult` per file with symbols, calls, imports.

use crate::lang;
use crate::payload::{
    normalize_newlines, normalize_signature, sha1_hex, symbol_id, Language,
};
use crate::simhash;
use anyhow::{Context, Result};
use tree_sitter::{Node, Parser, Tree};

#[derive(Debug, Clone)]
pub struct ParsedSymbol {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub start_line: u32,
    pub end_line: u32,
    pub parent_id: Option<String>,
    pub content_hash: String,
    /// 64-bit SimHash of the body as 16-char lowercase hex, or `None` when
    /// the body produced fewer than 3 normalized tokens (too small to
    /// fingerprint meaningfully).
    pub body_simhash: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedCall {
    pub caller_id: String,
    pub callee_name: String,
    pub call_line: u32,
}

#[derive(Debug, Clone)]
pub struct ParsedImport {
    pub imported_name: String,
    pub source_module: String,
}

#[derive(Debug, Default)]
pub struct ParseResult {
    pub symbols: Vec<ParsedSymbol>,
    pub calls: Vec<ParsedCall>,
    pub imports: Vec<ParsedImport>,
}

/// A draft symbol carries enough info to compute the final id + parent id
/// after the second pass. Mirrors `SymbolDraft` in parser.ts.
#[derive(Debug, Clone)]
pub struct SymbolDraft {
    pub name: String,
    pub kind: String,
    pub signature: String,
    pub start_line: u32,
    pub end_line: u32,
    pub body_start: usize,
    pub body_end: usize,
    pub parent_draft_idx: Option<usize>,
    pub docstring: Option<String>,
    pub qualified_parts: Vec<String>,
}

pub fn make_draft(
    name: &str,
    kind: &str,
    signature: &str,
    node: Node<'_>,
    parent_idx: Option<usize>,
    namespace: &[String],
    src: &str,
) -> SymbolDraft {
    SymbolDraft {
        name: name.to_string(),
        kind: kind.to_string(),
        signature: signature.trim().to_string(),
        start_line: node.start_position().row as u32 + 1,
        end_line: node.end_position().row as u32 + 1,
        body_start: node.start_byte(),
        body_end: node.end_byte(),
        parent_draft_idx: parent_idx,
        docstring: leading_docstring(src, node.start_byte()),
        qualified_parts: namespace.to_vec(),
    }
}

/// Find a leading /* */ block comment immediately preceding `start`.
/// Mirrors `parser.ts:173-189`.
pub fn leading_docstring(src: &str, start_idx: usize) -> Option<String> {
    let bytes = src.as_bytes();
    if start_idx == 0 {
        return None;
    }
    let mut i = start_idx as isize - 1;
    while i >= 0 && (bytes[i as usize] as char).is_whitespace() {
        i -= 1;
    }
    if i < 1 || bytes[i as usize] != b'/' {
        return None;
    }
    if bytes[(i - 1) as usize] != b'*' {
        return None;
    }
    let end = (i + 1) as usize;
    let start = src[..end.saturating_sub(2)].rfind("/*")?;
    let block = &src[start..end];
    let stripped: String = block
        .strip_prefix("/*")
        .unwrap_or(block)
        .trim_start_matches('*')
        .strip_suffix("*/")
        .unwrap_or(block)
        .lines()
        .map(|l| l.trim_start().trim_start_matches('*').trim_start().trim_end())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if stripped.is_empty() {
        None
    } else {
        Some(stripped)
    }
}

pub fn node_text<'a>(src: &'a str, node: Node<'_>) -> &'a str {
    &src[node.start_byte()..node.end_byte()]
}

/// Get a child by field name (helper that returns None on missing).
pub fn field<'tree>(node: Node<'tree>, name: &str) -> Option<Node<'tree>> {
    node.child_by_field_name(name)
}

/// Get the named identifier of a declaration. First tries field "name",
/// then named children of common id types. Mirrors `parser.ts:nameOf`.
pub fn name_of<'tree>(node: Node<'tree>) -> Option<Node<'tree>> {
    if let Some(n) = node.child_by_field_name("name") {
        return Some(n);
    }
    let mut cur = node.walk();
    for ch in node.named_children(&mut cur) {
        match ch.kind() {
            "identifier" | "property_identifier" | "type_identifier" => return Some(ch),
            _ => {}
        }
    }
    None
}

pub fn strip_quotes(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next().unwrap();
        let last = trimmed.chars().last().unwrap();
        if (first == '"' || first == '\'' || first == '`')
            && first == last
        {
            return &trimmed[1..trimmed.len() - 1];
        }
    }
    trimmed
}

fn make_parser(language: Language) -> Result<Parser> {
    let mut parser = Parser::new();
    let lang_obj = lang::tree_sitter_language(language);
    parser
        .set_language(&lang_obj)
        .context("failed to set tree-sitter language")?;
    Ok(parser)
}

/// Parse a single file. `repo_id` (not slug) feeds the symbol id derivation.
pub fn parse_file(
    repo_id: &str,
    relative_path: &str,
    language: Language,
    source: &str,
) -> Result<ParseResult> {
    let src = normalize_newlines(source);

    // Reject anything containing NUL — defensive against binary masquerade.
    if src.contains('\0') {
        anyhow::bail!("source contains NUL bytes");
    }

    let mut parser = make_parser(language)?;
    let tree: Tree = parser
        .parse(&src, None)
        .context("tree-sitter parse returned None")?;

    // 1. Imports.
    let mut imports = Vec::<ParsedImport>::new();
    lang::collect_imports(tree.root_node(), &src, language, &mut imports);

    // 2. Drafts via iterative DFS, carrying parent index + namespace.
    let mut drafts: Vec<SymbolDraft> = Vec::new();
    iterate_for_drafts(tree.root_node(), &src, language, &mut drafts);

    // 3. Materialize symbols.
    let mut symbols: Vec<ParsedSymbol> = drafts
        .iter()
        .map(|d| {
            let mut parts = d.qualified_parts.clone();
            parts.push(d.name.clone());
            let qualified = parts.join(".");
            let sig_norm = normalize_signature(&d.signature);
            let id = symbol_id(repo_id, relative_path, &d.name, &d.kind, &sig_norm);
            let body_text = &src[d.body_start..d.body_end];
            let fp = simhash::compute(body_text);
            ParsedSymbol {
                id,
                name: d.name.clone(),
                kind: d.kind.clone(),
                qualified_name: qualified,
                signature: if d.signature.is_empty() {
                    None
                } else {
                    Some(d.signature.clone())
                },
                docstring: d.docstring.clone(),
                start_line: d.start_line,
                end_line: d.end_line,
                parent_id: None,
                content_hash: sha1_hex(body_text),
                body_simhash: if fp == 0 {
                    None
                } else {
                    Some(simhash::to_hex(fp))
                },
            }
        })
        .collect();

    // 4. Resolve parent ids.
    for i in 0..drafts.len() {
        if let Some(p) = drafts[i].parent_draft_idx {
            symbols[i].parent_id = Some(symbols[p].id.clone());
        }
    }

    // 5. Calls — innermost-enclosing-symbol attribution.
    let calls = collect_calls(tree.root_node(), &src, &drafts, &symbols);

    Ok(ParseResult {
        symbols,
        calls,
        imports,
    })
}

/// Iterative DFS pushing children right-to-left so traversal is left-to-right.
/// Mirrors `parser.ts:246-278`.
fn iterate_for_drafts(
    root: Node<'_>,
    src: &str,
    language: Language,
    drafts: &mut Vec<SymbolDraft>,
) {
    type Frame<'tree> = (Node<'tree>, Option<usize>, Vec<String>);
    let mut stack: Vec<Frame> = vec![(root, None, vec![])];

    while let Some((node, parent_idx, namespace)) = stack.pop() {
        let mut next_parent = parent_idx;
        let mut next_namespace = namespace.clone();

        if let Some(draft) = lang::draft_for(node, src, language, parent_idx, &namespace) {
            drafts.push(draft);
            let new_idx = drafts.len() - 1;
            let kind = drafts[new_idx].kind.as_str();
            if matches!(
                kind,
                "class"
                    | "interface"
                    | "struct"
                    | "enum"
                    | "trait"
                    | "impl"
                    | "union"
                    | "namespace"
                    | "module"
                    | "object"
                    | "mixin"
                    | "extension"
            ) {
                next_parent = Some(new_idx);
                next_namespace.push(drafts[new_idx].name.clone());
            }
        }

        // Push named children in reverse for left-to-right traversal.
        let mut cur = node.walk();
        let children: Vec<Node> = node.named_children(&mut cur).collect();
        for ch in children.into_iter().rev() {
            stack.push((ch, next_parent, next_namespace.clone()));
        }
    }
}

/// Walk the tree and collect calls, attaching to the innermost containing
/// symbol draft (binary search on sorted ranges). Mirrors `parser.ts:707-791`.
fn collect_calls(
    root: Node<'_>,
    src: &str,
    drafts: &[SymbolDraft],
    symbols: &[ParsedSymbol],
) -> Vec<ParsedCall> {
    // (start, end, idx) sorted by start asc, end desc — match parser.ts.
    let mut ranges: Vec<(usize, usize, usize)> = drafts
        .iter()
        .enumerate()
        .map(|(i, d)| (d.body_start, d.body_end, i))
        .collect();
    ranges.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));

    let innermost_idx = |pos: usize| -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut best_size = usize::MAX;
        for &(start, end, idx) in &ranges {
            if start <= pos && pos < end {
                let size = end - start;
                if size < best_size {
                    best_size = size;
                    best = Some(idx);
                }
            } else if start > pos {
                break;
            }
        }
        best
    };

    let mut calls = Vec::<ParsedCall>::new();
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        let kind = node.kind();
        if kind == "call_expression" || kind == "call" || kind == "method_invocation" {
            if let Some(callee) = field(node, "function").or_else(|| field(node, "name")) {
                let callee_name = extract_callee_name(callee, src);
                if let Some(name) = callee_name {
                    if let Some(caller_idx) = innermost_idx(node.start_byte()) {
                        calls.push(ParsedCall {
                            caller_id: symbols[caller_idx].id.clone(),
                            callee_name: name,
                            call_line: node.start_position().row as u32 + 1,
                        });
                    }
                }
            }
        }

        let mut cur = node.walk();
        let children: Vec<Node> = node.named_children(&mut cur).collect();
        for ch in children.into_iter().rev() {
            stack.push(ch);
        }
    }
    calls
}

fn extract_callee_name(callee: Node<'_>, src: &str) -> Option<String> {
    match callee.kind() {
        "identifier" => Some(node_text(src, callee).to_string()),
        "member_expression" | "attribute" => {
            let prop = field(callee, "property").or_else(|| field(callee, "attribute"));
            prop.map(|p| node_text(src, p).to_string())
        }
        "selector_expression" | "field_expression" => {
            // Go: x.Foo(...) ; C++: obj.member(...) or obj->member(...).
            // Both expose the member name as the "field" child.
            field(callee, "field").map(|p| node_text(src, p).to_string())
        }
        "scoped_identifier" | "qualified_identifier" => {
            // Rust: foo::bar(...) ; C++: Foo::bar(...) — take last segment.
            let text = node_text(src, callee);
            text.split(|c| c == '.' || c == ':')
                .filter(|s| !s.is_empty())
                .last()
                .map(|s| s.to_string())
        }
        "template_function" => {
            // C++: foo<T>(...). The function name is the `name` field.
            field(callee, "name").map(|n| node_text(src, n).to_string())
        }
        _ => None,
    }
}
