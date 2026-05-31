import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

// Dynamic imports — native modules may fail to load on some systems.
// We surface a clean error from tools rather than crashing the server at startup.
let TS_Parser: any = null;
let TS_Lang_typescript: any = null;
let TS_Lang_tsx: any = null;
let TS_Lang_javascript: any = null;
let TS_Lang_python: any = null;
let TS_Lang_rust: any = null;
let TS_Lang_go: any = null;
let parsersReady = false;
const parserLoadErrors: Record<string, string> = {};

export type Language = 'typescript' | 'tsx' | 'javascript' | 'python' | 'rust' | 'go';

export interface ParsedSymbol {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  signature: string | null;
  docstring: string | null;
  startLine: number;
  endLine: number;
  parentId: string | null;
  contentHash: string;
  /// 64-bit body SimHash, lowercase 16-char hex. Only populated by the
  /// Rust client (cortexmd) at ingest time — server-side
  /// `parseFile()` doesn't compute it, so its results carry `null`.
  bodySimhash?: string | null;
}

export interface ParsedCall {
  callerId: string;
  calleeName: string;
  callLine: number;
}

export interface ParsedImport {
  importedName: string;
  sourceModule: string;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
  imports: ParsedImport[];
}

// Symbol-ID algorithm — the single source of truth is contract/symbol-id.md.
// Any change here is a fixture-breaking change and must be mirrored in
// crates/cli/src/payload.rs in the same PR.

/** Normalize CRLF→LF so hashes/IDs are stable across Windows and Linux. */
export function normalizeNewlines(src: string): string {
  return src.replace(/\r\n?/g, '\n');
}

/** sha1 hex of input, returned as full 40-char digest. */
export function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Build the 16-char symbol id from stable inputs.
 * Hashed against repo_id (immutable) so renames don't churn IDs.
 */
export function symbolId(
  repoId: string,
  relativePath: string,
  name: string,
  kind: string,
  signatureNormalized: string,
): string {
  return sha1Hex(`${repoId}|${relativePath}|${name}|${kind}|${signatureNormalized}`).slice(0, 16);
}

/** Lazy-load tree-sitter and language grammars. Sets parsersReady on success. */
async function ensureParsers(): Promise<void> {
  if (parsersReady) return;

  try {
    const Parser = (await import('tree-sitter')).default;
    TS_Parser = Parser;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['_core'] = `tree-sitter core unavailable: ${msg}`;
    logger.error('Failed to load tree-sitter core', { error: msg });
    throw new Error(parserLoadErrors['_core']);
  }

  // TS / JS bundle — single import covers typescript and tsx.
  try {
    const tsLangs = await import('tree-sitter-typescript');
    const tsExp: any = (tsLangs as any).default ?? tsLangs;
    TS_Lang_typescript = tsExp.typescript;
    TS_Lang_tsx = tsExp.tsx;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['typescript'] = `typescript grammar unavailable: ${msg}`;
    parserLoadErrors['tsx'] = `tsx grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-typescript', { error: msg });
  }

  try {
    const jsLang = await import('tree-sitter-javascript');
    const jsExp: any = (jsLang as any).default ?? jsLang;
    TS_Lang_javascript = jsExp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['javascript'] = `javascript grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-javascript', { error: msg });
  }

  try {
    const pyLang: any = await import('tree-sitter-python');
    TS_Lang_python = pyLang.default ?? pyLang;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['python'] = `python grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-python', { error: msg });
  }

  try {
    const rsLang: any = await import('tree-sitter-rust');
    TS_Lang_rust = rsLang.default ?? rsLang;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['rust'] = `rust grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-rust', { error: msg });
  }

  try {
    const goLang: any = await import('tree-sitter-go');
    TS_Lang_go = goLang.default ?? goLang;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['go'] = `go grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-go', { error: msg });
  }

  parsersReady = true;
  logger.info('Code-nav: tree-sitter parsers loaded', {
    typescript: !!TS_Lang_typescript,
    tsx: !!TS_Lang_tsx,
    javascript: !!TS_Lang_javascript,
    python: !!TS_Lang_python,
    rust: !!TS_Lang_rust,
    go: !!TS_Lang_go,
  });
}

/** Return any per-language load error captured at parser-init time. */
export function getParserError(language: Language): string | null {
  return parserLoadErrors[language] ?? null;
}

function getLanguage(lang: Language): any {
  switch (lang) {
    case 'typescript': return TS_Lang_typescript;
    case 'tsx':        return TS_Lang_tsx;
    case 'javascript': return TS_Lang_javascript;
    case 'python':     return TS_Lang_python;
    case 'rust':       return TS_Lang_rust;
    case 'go':         return TS_Lang_go;
  }
}

function nodeText(src: string, node: any): string {
  return src.slice(node.startIndex, node.endIndex);
}

/** Collapse whitespace so signatures hash stably across formatting changes. */
function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, ' ').trim();
}

/** Find the leading JSDoc/block comment immediately preceding a node, if any. */
function leadingDocstring(src: string, node: any): string | null {
  let i = node.startIndex - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 1 || src[i] !== '/') return null;
  if (src[i - 1] !== '*') return null;
  const end = i + 1;
  let start = src.lastIndexOf('/*', end - 2);
  if (start < 0) return null;
  const block = src.slice(start, end);
  return block
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l.length > 0)
    .join('\n') || null;
}

/** Pull a `name` identifier child from a tree-sitter node, by common field names. */
function nameOf(node: any): any | null {
  return (
    node.childForFieldName?.('name') ??
    node.namedChildren?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'type_identifier') ??
    null
  );
}

interface SymbolDraft {
  name: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  bodyStartIndex: number;
  bodyEndIndex: number;
  parentDraftIdx: number | null;
  docstring: string | null;
  qualifiedNameParts: string[];
}

/**
 * Parse a single source file and extract symbol/call/import information.
 * `repoId` (not slug) is used to derive symbol IDs so renames don't churn them.
 */
export async function parseFile(
  repoId: string,
  relativePath: string,
  language: Language,
  source: string,
): Promise<ParseResult> {
  await ensureParsers();
  const lang = getLanguage(language);
  if (!lang) {
    const err = parserLoadErrors[language] ?? `language not supported: ${language}`;
    throw new Error(err);
  }

  const src = normalizeNewlines(source);
  const parser = new TS_Parser();
  parser.setLanguage(lang);
  // tree-sitter's default 32KB buffer rejects large source strings with
  // "Invalid argument". Size the buffer to fit the source comfortably.
  const bufferSize = Math.max(32 * 1024, src.length * 4 + 1024);
  const tree = parser.parse(src, null, { bufferSize });

  const drafts: SymbolDraft[] = [];
  const imports: ParsedImport[] = [];

  // Extract imports up front (separate walk per language adapter).
  collectImports(tree.rootNode, src, language, imports);

  // Walk the AST iteratively. Stack entries carry a parent-draft index for nesting.
  type Frame = { node: any; parentIdx: number | null; namespace: string[] };
  const stack: Frame[] = [{ node: tree.rootNode, parentIdx: null, namespace: [] }];

  while (stack.length > 0) {
    const { node, parentIdx, namespace } = stack.pop()!;
    let nextParentIdx: number | null = parentIdx;
    let nextNamespace = namespace;

    const drafted = draftFor(node, src, language, parentIdx, namespace);

    if (drafted) {
      drafts.push(drafted);
      const newIdx = drafts.length - 1;
      // For container types, descend with this as parent and namespace.
      if (
        drafted.kind === 'class' ||
        drafted.kind === 'interface' ||
        drafted.kind === 'struct' ||
        drafted.kind === 'enum' ||
        drafted.kind === 'trait' ||
        drafted.kind === 'impl'
      ) {
        nextParentIdx = newIdx;
        nextNamespace = [...namespace, drafted.name];
      }
    }

    // Handle decorated_definition (Python) — unwrap so methods inside still get found.
    // Push children (in reverse so traversal is left-to-right)
    const children = node.namedChildren ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentIdx: nextParentIdx, namespace: nextNamespace });
    }
  }

  // Build symbol records and assign IDs.
  const symbols: ParsedSymbol[] = drafts.map((d) => {
    const qualified = [...d.qualifiedNameParts, d.name].join('.');
    const sigNorm = normalizeSignature(d.signature);
    const id = symbolId(repoId, relativePath, d.name, d.kind, sigNorm);
    const bodyText = src.slice(d.bodyStartIndex, d.bodyEndIndex);
    return {
      id,
      name: d.name,
      kind: d.kind,
      qualifiedName: qualified,
      signature: d.signature || null,
      docstring: d.docstring,
      startLine: d.startLine,
      endLine: d.endLine,
      parentId: null, // resolved below
      contentHash: sha1Hex(bodyText),
    };
  });

  // Resolve parentId from draft.parentDraftIdx
  for (let i = 0; i < drafts.length; i++) {
    const pIdx = drafts[i].parentDraftIdx;
    symbols[i].parentId = pIdx !== null ? symbols[pIdx].id : null;
  }

  // Extract calls — walk the tree once, attach to the innermost enclosing draft.
  const calls: ParsedCall[] = [];
  walkForCalls(tree.rootNode, src, drafts, symbols, calls);

  return { symbols, calls, imports };
}

/**
 * Per-language draft factory. Returns a SymbolDraft for nodes representing
 * top-level/declared symbols, or null when the node is not interesting.
 */
function draftFor(
  node: any,
  src: string,
  language: Language,
  parentIdx: number | null,
  namespace: string[],
): SymbolDraft | null {
  const t = node.type;

  // ── TypeScript / JavaScript ───────────────────────────────────────────
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'function', extractFunctionSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'class', extractBraceSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'interface_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'interface', extractBraceSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'type_alias_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'type', nodeText(src, node).split('\n')[0], node, parentIdx, namespace, src);
    }
    if (t === 'method_definition' || t === 'method_signature' || t === 'abstract_method_signature') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'method', extractFunctionSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'lexical_declaration' || t === 'variable_declaration') {
      // Top-level exported `const x = (...) => ...` / `const x = function ...`
      const isExported = node.parent?.type === 'export_statement';
      if (!isExported) return null;
      // We special-case: emit drafts here directly, but only the first one fits the
      // single-return contract. Fall back to walking children separately.
      const decls = (node.namedChildren ?? []).filter((d: any) => d.type === 'variable_declarator');
      // We can only return one draft here; emit the first matching arrow/function.
      for (const decl of decls) {
        const n = decl.childForFieldName?.('name');
        const value = decl.childForFieldName?.('value');
        if (!n || !value) continue;
        if (
          value.type === 'arrow_function' ||
          value.type === 'function_expression' ||
          value.type === 'function'
        ) {
          const name = nodeText(src, n);
          const sig = `const ${name} = ${nodeText(src, value).split('\n')[0]}`;
          return makeDraft(name, 'const-export', sig, decl, parentIdx, namespace, src);
        }
      }
      return null;
    }
    return null;
  }

  // ── Python ─────────────────────────────────────────────────────────────
  if (language === 'python') {
    if (t === 'function_definition') {
      const n = nameOf(node);
      if (!n) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(nodeText(src, n), kind, extractPythonDefSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'class_definition') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'class', extractPythonDefSignature(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── Rust ───────────────────────────────────────────────────────────────
  if (language === 'rust') {
    if (t === 'function_item') {
      const n = nameOf(node);
      if (!n) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(nodeText(src, n), kind, extractRustItemSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'struct_item') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'struct', extractRustItemSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'enum_item') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'enum', extractRustItemSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'trait_item') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'trait', extractRustItemSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'impl_item') {
      // Use the type field as the namespace name.
      const typeNode = node.childForFieldName?.('type');
      const name = typeNode ? nodeText(src, typeNode) : 'impl';
      return makeDraft(name, 'impl', extractRustItemSignature(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── Go ─────────────────────────────────────────────────────────────────
  if (language === 'go') {
    if (t === 'function_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'function', extractGoFuncSignature(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'method_declaration') {
      const n = nameOf(node);
      if (!n) return null;
      // Receiver type as namespace.
      let receiverName: string | null = null;
      const receiver = node.childForFieldName?.('receiver');
      if (receiver) {
        // Walk to find the type identifier.
        const stack = [receiver];
        while (stack.length > 0) {
          const cur = stack.pop();
          if (!cur) continue;
          if (cur.type === 'type_identifier') {
            receiverName = nodeText(src, cur);
            break;
          }
          for (const ch of cur.namedChildren ?? []) stack.push(ch);
        }
      }
      const ns = receiverName ? [...namespace, receiverName] : namespace;
      const draft = makeDraft(
        nodeText(src, n),
        'method',
        extractGoFuncSignature(src, node),
        node,
        parentIdx,
        ns,
        src,
      );
      return draft;
    }
    if (t === 'type_declaration') {
      // Look for type_spec children with struct_type or interface_type bodies.
      // We can return one draft — emit the first; the walker will visit children separately.
      for (const spec of node.namedChildren ?? []) {
        if (spec.type !== 'type_spec') continue;
        const n = spec.childForFieldName?.('name');
        const ty = spec.childForFieldName?.('type');
        if (!n || !ty) continue;
        const name = nodeText(src, n);
        if (ty.type === 'struct_type') {
          return makeDraft(name, 'struct', `type ${name} struct`, spec, parentIdx, namespace, src);
        }
        if (ty.type === 'interface_type') {
          return makeDraft(name, 'interface', `type ${name} interface`, spec, parentIdx, namespace, src);
        }
      }
      return null;
    }
    return null;
  }

  return null;
}

/** Walk and collect imports. Per-language extraction. */
function collectImports(
  root: any,
  src: string,
  language: Language,
  out: ParsedImport[],
): void {
  const stack: any[] = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const t = node.type;

    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      if (t === 'import_statement' || t === 'export_from_clause') {
        const sourceNode =
          node.childForFieldName?.('source') ??
          node.namedChildren?.find((c: any) => c.type === 'string');
        if (sourceNode) {
          const sourceModule = stripQuotes(nodeText(src, sourceNode));
          // Find import_clause / named_imports / namespace_import / identifier
          const names: string[] = [];
          const istack = [...(node.namedChildren ?? [])];
          while (istack.length > 0) {
            const cur = istack.pop();
            if (!cur) continue;
            if (cur.type === 'import_specifier') {
              const aliasNode = cur.childForFieldName?.('alias');
              const nameNode = cur.childForFieldName?.('name');
              const useNode = aliasNode ?? nameNode;
              if (useNode) names.push(nodeText(src, useNode));
              continue;
            }
            if (cur.type === 'namespace_import') {
              // import * as Foo
              const id = cur.namedChildren?.find((c: any) => c.type === 'identifier');
              if (id) names.push(nodeText(src, id));
              continue;
            }
            if (cur.type === 'identifier' && cur.parent?.type === 'import_clause') {
              names.push(nodeText(src, cur));
              continue;
            }
            for (const ch of cur.namedChildren ?? []) istack.push(ch);
          }
          for (const n of names) {
            const key = `${n}|${sourceModule}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ importedName: n, sourceModule });
          }
        }
      }
    } else if (language === 'python') {
      if (t === 'import_statement') {
        // import a, b as c
        for (const ch of node.namedChildren ?? []) {
          if (ch.type === 'dotted_name') {
            const text = nodeText(src, ch);
            const key = `${text}|${text}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ importedName: text.split('.').pop() || text, sourceModule: text });
            }
          } else if (ch.type === 'aliased_import') {
            const nameN = ch.childForFieldName?.('name');
            const aliasN = ch.childForFieldName?.('alias');
            if (nameN) {
              const moduleName = nodeText(src, nameN);
              const aliasName = aliasN ? nodeText(src, aliasN) : moduleName;
              const key = `${aliasName}|${moduleName}`;
              if (!seen.has(key)) {
                seen.add(key);
                out.push({ importedName: aliasName, sourceModule: moduleName });
              }
            }
          }
        }
      } else if (t === 'import_from_statement') {
        const moduleN = node.childForFieldName?.('module_name');
        const moduleName = moduleN ? nodeText(src, moduleN) : '';
        for (const ch of node.namedChildren ?? []) {
          if (ch === moduleN) continue;
          if (ch.type === 'dotted_name' || ch.type === 'identifier') {
            const text = nodeText(src, ch);
            const key = `${text}|${moduleName}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ importedName: text, sourceModule: moduleName });
            }
          } else if (ch.type === 'aliased_import') {
            const nameN = ch.childForFieldName?.('name');
            const aliasN = ch.childForFieldName?.('alias');
            const importName = aliasN ? nodeText(src, aliasN) : nameN ? nodeText(src, nameN) : null;
            if (importName) {
              const key = `${importName}|${moduleName}`;
              if (!seen.has(key)) {
                seen.add(key);
                out.push({ importedName: importName, sourceModule: moduleName });
              }
            }
          }
        }
      }
    } else if (language === 'rust') {
      if (t === 'use_declaration') {
        // Capture each leaf identifier in the path/scope tree; fall back to
        // last segment of `path` when nothing finer-grained is available.
        const fullText = nodeText(src, node).replace(/^use\s+/, '').replace(/;$/, '');
        const last = fullText.split('::').pop() || fullText;
        const cleanLast = last.replace(/\{.*?\}/g, '').trim();
        const moduleName = fullText;
        if (cleanLast) {
          const key = `${cleanLast}|${moduleName}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ importedName: cleanLast, sourceModule: moduleName });
          }
        }
      }
    } else if (language === 'go') {
      if (t === 'import_declaration') {
        const stack2 = [...(node.namedChildren ?? [])];
        while (stack2.length > 0) {
          const cur = stack2.pop();
          if (!cur) continue;
          if (cur.type === 'import_spec') {
            const pathN = cur.childForFieldName?.('path') ??
              cur.namedChildren?.find((c: any) => c.type === 'interpreted_string_literal');
            if (pathN) {
              const moduleName = stripQuotes(nodeText(src, pathN));
              const importedName = moduleName.split('/').pop() || moduleName;
              const key = `${importedName}|${moduleName}`;
              if (!seen.has(key)) {
                seen.add(key);
                out.push({ importedName, sourceModule: moduleName });
              }
            }
            continue;
          }
          for (const ch of cur.namedChildren ?? []) stack2.push(ch);
        }
      }
    }

    for (const ch of node.namedChildren ?? []) stack.push(ch);
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function makeDraft(
  name: string,
  kind: string,
  signature: string,
  node: any,
  parentIdx: number | null,
  namespace: string[],
  src: string,
): SymbolDraft {
  return {
    name,
    kind,
    signature: signature.trim(),
    startLine: (node.startPosition?.row ?? 0) + 1,
    endLine: (node.endPosition?.row ?? 0) + 1,
    bodyStartIndex: node.startIndex,
    bodyEndIndex: node.endIndex,
    parentDraftIdx: parentIdx,
    docstring: leadingDocstring(src, node),
    qualifiedNameParts: [...namespace],
  };
}

function extractFunctionSignature(src: string, node: any): string {
  const text = nodeText(src, node);
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) return text.slice(0, braceIdx).trim();
  // method signatures and overloads end with `;`
  const semiIdx = text.indexOf(';');
  if (semiIdx > 0) return text.slice(0, semiIdx).trim();
  return text.split('\n')[0].trim();
}

function extractBraceSignature(src: string, node: any): string {
  const text = nodeText(src, node);
  const braceIdx = text.indexOf('{');
  return braceIdx > 0 ? text.slice(0, braceIdx).trim() : text.split('\n')[0].trim();
}

function extractPythonDefSignature(src: string, node: any): string {
  const text = nodeText(src, node);
  const colonIdx = text.indexOf(':');
  if (colonIdx > 0) return text.slice(0, colonIdx).trim();
  return text.split('\n')[0].trim();
}

function extractRustItemSignature(src: string, node: any): string {
  const text = nodeText(src, node);
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) return text.slice(0, braceIdx).trim();
  const semiIdx = text.indexOf(';');
  if (semiIdx > 0) return text.slice(0, semiIdx).trim();
  return text.split('\n')[0].trim();
}

function extractGoFuncSignature(src: string, node: any): string {
  const text = nodeText(src, node);
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) return text.slice(0, braceIdx).trim();
  return text.split('\n')[0].trim();
}

/** Walk the tree and attach docstrings + collect calls. */
function walkForCalls(
  root: any,
  src: string,
  drafts: SymbolDraft[],
  symbols: ParsedSymbol[],
  calls: ParsedCall[],
): void {
  // Build a sorted list of (start, end, idx) ranges for fast innermost-lookup.
  const ranges = drafts
    .map((d, idx) => ({ start: d.bodyStartIndex, end: d.bodyEndIndex, idx }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // Docstrings already attached at draft creation time; copy across.
  for (let i = 0; i < drafts.length; i++) {
    symbols[i].docstring = drafts[i].docstring;
  }

  function innermostIdx(pos: number): number | null {
    let best: number | null = null;
    let bestSize = Infinity;
    for (const r of ranges) {
      if (r.start <= pos && pos < r.end) {
        const size = r.end - r.start;
        if (size < bestSize) {
          bestSize = size;
          best = r.idx;
        }
      } else if (r.start > pos) {
        break;
      }
    }
    return best;
  }

  // Iterative traversal collecting call_expression / call nodes.
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    const t = node.type;
    // tree-sitter languages name these slightly differently.
    if (t === 'call_expression' || t === 'call' || t === 'method_invocation') {
      const callee =
        node.childForFieldName?.('function') ??
        node.childForFieldName?.('name') ??
        null;
      if (callee) {
        let calleeName: string | null = null;
        if (callee.type === 'identifier') {
          calleeName = nodeText(src, callee);
        } else if (callee.type === 'member_expression' || callee.type === 'attribute') {
          const prop =
            callee.childForFieldName?.('property') ??
            callee.childForFieldName?.('attribute');
          if (prop) calleeName = nodeText(src, prop);
        } else if (callee.type === 'selector_expression') {
          // Go: x.Foo(...)
          const field = callee.childForFieldName?.('field');
          if (field) calleeName = nodeText(src, field);
        } else if (callee.type === 'scoped_identifier' || callee.type === 'field_expression') {
          // Rust: foo::bar(...) — take last segment.
          const text = nodeText(src, callee);
          const last = text.split(/::|\./).pop();
          if (last) calleeName = last;
        }
        if (calleeName) {
          const callerIdx = innermostIdx(node.startIndex);
          if (callerIdx !== null) {
            calls.push({
              callerId: symbols[callerIdx].id,
              calleeName,
              callLine: (node.startPosition?.row ?? 0) + 1,
            });
          }
        }
      }
    }

    const children = node.namedChildren ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
}
