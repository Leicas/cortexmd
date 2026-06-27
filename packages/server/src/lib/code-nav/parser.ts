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
let TS_Lang_cpp: any = null;
let TS_Lang_c: any = null;
let TS_Lang_java: any = null;
let TS_Lang_kotlin: any = null;
let TS_Lang_ruby: any = null;
let TS_Lang_php: any = null;
let TS_Lang_dart: any = null;
let parsersReady = false;
const parserLoadErrors: Record<string, string> = {};

export type Language =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'cpp'
  | 'c'
  | 'java'
  | 'kotlin'
  | 'ruby'
  | 'php'
  | 'dart';

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

  // Single-export grammars: the module (or its default) is the Language itself.
  const loadSimple = async (lang: Language, mod: string): Promise<any | null> => {
    try {
      const m: any = await import(mod);
      return m.default ?? m;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parserLoadErrors[lang] = `${lang} grammar unavailable: ${msg}`;
      logger.warn(`Failed to load ${mod}`, { error: msg });
      return null;
    }
  };

  TS_Lang_cpp = await loadSimple('cpp', 'tree-sitter-cpp');
  TS_Lang_c = await loadSimple('c', 'tree-sitter-c');
  TS_Lang_java = await loadSimple('java', 'tree-sitter-java');
  TS_Lang_kotlin = await loadSimple('kotlin', 'tree-sitter-kotlin');
  TS_Lang_ruby = await loadSimple('ruby', 'tree-sitter-ruby');
  TS_Lang_dart = await loadSimple('dart', 'tree-sitter-dart');

  // tree-sitter-php exposes { php, php_only }; the full grammar handles `<?php`.
  try {
    const phpMod: any = await import('tree-sitter-php');
    const phpExp: any = phpMod.default ?? phpMod;
    TS_Lang_php = phpExp.php ?? phpExp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parserLoadErrors['php'] = `php grammar unavailable: ${msg}`;
    logger.warn('Failed to load tree-sitter-php', { error: msg });
  }

  // Some grammars publish a newer ABI than the pinned tree-sitter runtime can
  // load (e.g. tree-sitter-dart@1.0 needs a newer core; bumping it would break
  // the `{ bufferSize }` parse API the other grammars rely on). Validate each
  // newly-added grammar with a throwaway setLanguage so an incompatible one
  // degrades to a clean "unavailable" error instead of throwing deep inside
  // parseFile. The Rust CLI indexer still handles every language regardless.
  const validate = (lang: Language, grammar: any): any => {
    if (!grammar) return null;
    try {
      const p = new TS_Parser();
      p.setLanguage(grammar);
      return grammar;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parserLoadErrors[lang] = `${lang} grammar incompatible with tree-sitter runtime: ${msg}`;
      logger.warn(`tree-sitter grammar ${lang} failed ABI validation`, { error: msg });
      return null;
    }
  };
  TS_Lang_cpp = validate('cpp', TS_Lang_cpp);
  TS_Lang_c = validate('c', TS_Lang_c);
  TS_Lang_java = validate('java', TS_Lang_java);
  TS_Lang_kotlin = validate('kotlin', TS_Lang_kotlin);
  TS_Lang_ruby = validate('ruby', TS_Lang_ruby);
  TS_Lang_php = validate('php', TS_Lang_php);
  TS_Lang_dart = validate('dart', TS_Lang_dart);

  parsersReady = true;
  logger.info('Code-nav: tree-sitter parsers loaded', {
    typescript: !!TS_Lang_typescript,
    tsx: !!TS_Lang_tsx,
    javascript: !!TS_Lang_javascript,
    python: !!TS_Lang_python,
    rust: !!TS_Lang_rust,
    go: !!TS_Lang_go,
    cpp: !!TS_Lang_cpp,
    c: !!TS_Lang_c,
    java: !!TS_Lang_java,
    kotlin: !!TS_Lang_kotlin,
    ruby: !!TS_Lang_ruby,
    php: !!TS_Lang_php,
    dart: !!TS_Lang_dart,
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
    case 'cpp':        return TS_Lang_cpp;
    case 'c':          return TS_Lang_c;
    case 'java':       return TS_Lang_java;
    case 'kotlin':     return TS_Lang_kotlin;
    case 'ruby':       return TS_Lang_ruby;
    case 'php':        return TS_Lang_php;
    case 'dart':       return TS_Lang_dart;
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
        drafted.kind === 'impl' ||
        drafted.kind === 'union' ||
        drafted.kind === 'namespace' ||
        drafted.kind === 'module' ||
        drafted.kind === 'object' ||
        drafted.kind === 'mixin' ||
        drafted.kind === 'extension'
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

  // ── C / C++ ──────────────────────────────────────────────────────────────
  // Mirrors crates/cli/src/lang/{c,cpp}.rs.
  if (language === 'c' || language === 'cpp') {
    if (t === 'function_definition') {
      const name = language === 'cpp' ? cppFunctionName(node, src) : cFunctionName(node, src);
      if (!name) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(name, kind, funcSigToBody(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'struct_specifier') return cTypeDraft(node, src, 'struct', parentIdx, namespace, language);
    if (t === 'union_specifier') return cTypeDraft(node, src, 'union', parentIdx, namespace, language);
    if (t === 'enum_specifier') return cTypeDraft(node, src, 'enum', parentIdx, namespace, language);
    if (language === 'cpp') {
      if (t === 'class_specifier') return cTypeDraft(node, src, 'class', parentIdx, namespace, language);
      if (t === 'namespace_definition') {
        const n = node.childForFieldName('name');
        if (!n) return null;
        const name = nodeText(src, n);
        // Namespaces are treated as class-like containers (matches cpp.rs).
        return makeDraft(name, 'class', `namespace ${name}`, node, parentIdx, namespace, src);
      }
    }
    return null;
  }

  // ── Java ─────────────────────────────────────────────────────────────────
  if (language === 'java') {
    if (t === 'class_declaration') return javaContainer(node, src, 'class', parentIdx, namespace);
    if (t === 'interface_declaration' || t === 'annotation_type_declaration')
      return javaContainer(node, src, 'interface', parentIdx, namespace);
    if (t === 'enum_declaration') return javaContainer(node, src, 'enum', parentIdx, namespace);
    if (t === 'record_declaration') return javaContainer(node, src, 'class', parentIdx, namespace);
    if (t === 'method_declaration' || t === 'constructor_declaration') {
      const n = node.childForFieldName('name');
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'method', declSigToBody(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── Kotlin ───────────────────────────────────────────────────────────────
  if (language === 'kotlin') {
    if (t === 'class_declaration') {
      const name = kotlinName(node, src);
      if (!name) return null;
      return makeDraft(name, kotlinClassKind(src, node), upToBraceOrLine(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'object_declaration') {
      const name = kotlinName(node, src);
      if (!name) return null;
      return makeDraft(name, 'object', upToBraceOrLine(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'function_declaration') {
      const name = kotlinName(node, src);
      if (!name) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(name, kind, upToBraceOrLine(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────
  if (language === 'ruby') {
    if (t === 'method' || t === 'singleton_method') {
      const n = node.childForFieldName('name');
      if (!n) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(nodeText(src, n), kind, firstLine(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'class' || t === 'singleton_class') {
      const n = node.childForFieldName('name');
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'class', firstLine(src, node), node, parentIdx, namespace, src);
    }
    if (t === 'module') {
      const n = node.childForFieldName('name');
      if (!n) return null;
      return makeDraft(nodeText(src, n), 'module', firstLine(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── PHP ──────────────────────────────────────────────────────────────────
  if (language === 'php') {
    const phpKind: Record<string, string> = {
      function_definition: 'function',
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      trait_declaration: 'trait',
      enum_declaration: 'enum',
      namespace_definition: 'namespace',
    };
    const k = phpKind[t];
    if (k) {
      const n = node.childForFieldName('name');
      if (!n) return null;
      return makeDraft(nodeText(src, n), k, declSigToBody(src, node), node, parentIdx, namespace, src);
    }
    return null;
  }

  // ── Dart ─────────────────────────────────────────────────────────────────
  if (language === 'dart') {
    if (t === 'class_declaration') return dartNamed(node, src, 'class', parentIdx, namespace);
    if (t === 'enum_declaration') return dartNamed(node, src, 'enum', parentIdx, namespace);
    if (t === 'mixin_declaration') return dartNamed(node, src, 'mixin', parentIdx, namespace);
    if (t === 'extension_declaration') return dartNamed(node, src, 'extension', parentIdx, namespace);
    if (
      t === 'function_signature' ||
      t === 'getter_signature' ||
      t === 'setter_signature' ||
      t === 'constructor_signature' ||
      t === 'factory_constructor_signature'
    ) {
      const name = dartIdent(node, src);
      if (!name) return null;
      const kind = namespace.length > 0 ? 'method' : 'function';
      return makeDraft(name, kind, upToBraceOrLine(src, node), node, parentIdx, namespace, src);
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
    } else if (language === 'cpp' || language === 'c') {
      if (t === 'preproc_include') {
        const pathNode = node.childForFieldName?.('path');
        if (pathNode) {
          const raw = nodeText(src, pathNode).trim();
          let inner = raw;
          if (raw.startsWith('<') && raw.endsWith('>')) inner = raw.slice(1, -1);
          else if (raw.startsWith('"') && raw.endsWith('"')) inner = raw.slice(1, -1);
          if (inner && !seen.has(inner)) {
            seen.add(inner);
            const basename = (inner.split('/').pop() ?? inner).split('.')[0];
            out.push({ importedName: basename, sourceModule: inner });
          }
        }
      }
    } else if (language === 'java') {
      if (t === 'import_declaration') {
        const path = (node.namedChildren ?? []).find(
          (c: any) => c.type === 'scoped_identifier' || c.type === 'identifier',
        );
        if (path) {
          const module = nodeText(src, path);
          const parts = module.split('.').filter((s) => s !== '*');
          const last = parts.length ? parts[parts.length - 1] : module;
          const key = `${last}|${module}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ importedName: last, sourceModule: module });
          }
        }
      }
    } else if (language === 'kotlin') {
      if (t === 'import' || t === 'import_header') {
        const id = (node.namedChildren ?? []).find(
          (c: any) => c.type === 'qualified_identifier' || c.type === 'identifier',
        );
        if (id) {
          const module = nodeText(src, id);
          const last = module.split('.').pop() ?? module;
          const key = `${last}|${module}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ importedName: last, sourceModule: module });
          }
        }
      }
    } else if (language === 'ruby') {
      if (t === 'call') {
        const m = node.childForFieldName?.('method');
        const mname = m ? nodeText(src, m) : null;
        if (mname === 'require' || mname === 'require_relative') {
          const args = node.childForFieldName?.('arguments');
          const arg = args?.namedChildren?.[0];
          if (arg && arg.type === 'string') {
            const content = (arg.namedChildren ?? []).find((c: any) => c.type === 'string_content');
            const module = content ? nodeText(src, content) : stripQuotes(nodeText(src, arg));
            if (module) {
              const name = module.split('/').pop() ?? module;
              const key = `${name}|${module}`;
              if (!seen.has(key)) {
                seen.add(key);
                out.push({ importedName: name, sourceModule: module });
              }
            }
          }
        }
      }
    } else if (language === 'php') {
      if (t === 'namespace_use_declaration') {
        const inner = [...(node.namedChildren ?? [])];
        while (inner.length > 0) {
          const child = inner.pop();
          if (!child) continue;
          if (child.type === 'qualified_name' || child.type === 'name') {
            const module = nodeText(src, child).replace(/^\\+/, '');
            const last = module.split('\\').pop() ?? module;
            const key = `${last}|${module}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ importedName: last, sourceModule: module });
            }
            continue;
          }
          for (const ch of child.namedChildren ?? []) inner.push(ch);
        }
      }
    } else if (language === 'dart') {
      if (t.includes('import')) {
        const uri = dartFindUri(node, src);
        if (uri) {
          const name = (uri.split('/').pop() ?? uri).replace(/\.dart$/, '');
          const key = `${name}|${uri}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ importedName: name, sourceModule: uri });
          }
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

// ── Helpers for C/C++/Java/Kotlin/Ruby/PHP/Dart ──────────────────────────────
// These mirror the per-language adapters in crates/cli/src/lang/*.rs so that
// (name, kind, normalizedSignature) — and therefore symbol IDs — match exactly.

/** Signature from the node start up to its `body`, else the first line. */
function funcSigToBody(src: string, node: any): string {
  const body = node.childForFieldName?.('body');
  if (body) return src.slice(node.startIndex, body.startIndex).trim();
  return nodeText(src, node).split('\n')[0].trim();
}

/** Header up to `body`, else up to `{`, else the first line. */
function declSigToBody(src: string, node: any): string {
  const body = node.childForFieldName?.('body');
  if (body) return src.slice(node.startIndex, body.startIndex).trim();
  return upToBraceOrLine(src, node);
}

/** Text up to the first `{`, else the first line. */
function upToBraceOrLine(src: string, node: any): string {
  const text = nodeText(src, node);
  const i = text.indexOf('{');
  if (i >= 0) return text.slice(0, i).trim();
  return text.split('\n')[0].trim();
}

function firstLine(src: string, node: any): string {
  return nodeText(src, node).split('\n')[0].trim();
}

/** C function name: unwrap the declarator chain to the identifier. */
function cFunctionName(node: any, src: string): string | null {
  let decl = node.childForFieldName?.('declarator');
  while (decl) {
    if (decl.type === 'function_declarator') {
      const inner = decl.childForFieldName?.('declarator');
      return inner ? cDeclId(inner, src) : null;
    }
    if (
      decl.type === 'pointer_declarator' ||
      decl.type === 'array_declarator' ||
      decl.type === 'parenthesized_declarator'
    ) {
      decl = decl.childForFieldName?.('declarator');
      continue;
    }
    return null;
  }
  return null;
}

function cDeclId(node: any, src: string): string | null {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
      return nodeText(src, node);
    case 'pointer_declarator':
    case 'parenthesized_declarator':
    case 'function_declarator': {
      const d = node.childForFieldName?.('declarator');
      return d ? cDeclId(d, src) : null;
    }
    default:
      return null;
  }
}

/** C++ function name: handles qualified (Foo::bar), operator, destructor names. */
function cppFunctionName(node: any, src: string): string | null {
  let decl = node.childForFieldName?.('declarator');
  while (decl) {
    if (decl.type === 'function_declarator') {
      const inner = decl.childForFieldName?.('declarator');
      return inner ? cppDeclId(inner, src) : null;
    }
    if (decl.type === 'pointer_declarator' || decl.type === 'reference_declarator') {
      decl = decl.childForFieldName?.('declarator');
      continue;
    }
    return null;
  }
  return null;
}

function cppDeclId(node: any, src: string): string | null {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'destructor_name':
    case 'operator_name':
      return nodeText(src, node);
    case 'qualified_identifier':
    case 'scoped_identifier':
    case 'template_function': {
      const parts = nodeText(src, node).split('::');
      return parts[parts.length - 1];
    }
    default:
      return null;
  }
}

/** struct/union/enum/class draft. C synthesizes `kind name`; C++ takes the header. */
function cTypeDraft(
  node: any,
  src: string,
  kind: string,
  parentIdx: number | null,
  namespace: string[],
  language: Language,
): SymbolDraft | null {
  const n = node.childForFieldName?.('name');
  if (!n) return null;
  const name = nodeText(src, n);
  const sig = language === 'c' ? `${kind} ${name}` : upToBraceOrLine(src, node);
  return makeDraft(name, kind, sig, node, parentIdx, namespace, src);
}

function javaContainer(
  node: any,
  src: string,
  kind: string,
  parentIdx: number | null,
  namespace: string[],
): SymbolDraft | null {
  const n = node.childForFieldName?.('name');
  if (!n) return null;
  return makeDraft(nodeText(src, n), kind, declSigToBody(src, node), node, parentIdx, namespace, src);
}

// The identifier node kind differs by Kotlin grammar lineage: kotlin-ng (Rust)
// uses `identifier`; fwcd (npm) uses `simple_identifier` / `type_identifier`.
const KOTLIN_NAME_KINDS = ['identifier', 'type_identifier', 'simple_identifier'];

function kotlinName(node: any, src: string): string | null {
  const n = (node.namedChildren ?? []).find((c: any) => KOTLIN_NAME_KINDS.includes(c.type));
  return n ? nodeText(src, n) : null;
}

function kotlinClassKind(src: string, node: any): string {
  const head = nodeText(src, node).split('\n')[0];
  if (head.includes('interface')) return 'interface';
  if (head.includes('enum')) return 'enum';
  return 'class';
}

function dartNamed(
  node: any,
  src: string,
  kind: string,
  parentIdx: number | null,
  namespace: string[],
): SymbolDraft | null {
  const name = dartIdent(node, src);
  if (!name) return null;
  return makeDraft(name, kind, upToBraceOrLine(src, node), node, parentIdx, namespace, src);
}

function dartIdent(node: any, src: string): string | null {
  const n = (node.namedChildren ?? []).find((c: any) => c.type === 'identifier');
  return n ? nodeText(src, n) : null;
}

function dartFindUri(node: any, src: string): string | null {
  const stack: any[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.type === 'string_literal' || cur.type === 'uri') {
      return stripQuotes(nodeText(src, cur));
    }
    for (const ch of cur.namedChildren ?? []) stack.push(ch);
  }
  return null;
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
