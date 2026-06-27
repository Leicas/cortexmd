import { describe, it, expect } from 'vitest';
import { parseFile, getParserError, type Language } from '../code-nav/parser.js';

const REPO = '0123456789abcdef';

async function symbols(lang: Language, name: string, src: string) {
  const r = await parseFile(REPO, name, lang, src);
  return r.symbols.map((s) => ({ kind: s.kind, name: s.name }));
}

describe('code-nav parser: newly added languages', () => {
  it('C: struct, function, #include', async () => {
    const r = await parseFile(
      REPO,
      'a.c',
      'c',
      '#include <stdio.h>\nstruct Point { int x; };\nint add(int a, int b) { return a + b; }\n',
    );
    const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
    expect(s).toContainEqual({ kind: 'struct', name: 'Point' });
    expect(s).toContainEqual({ kind: 'function', name: 'add' });
    expect(r.imports.map((i) => i.sourceModule)).toContain('stdio.h');
  });

  // C++ was supported by the Rust CLI but not the TS server — this guards the
  // drift fix.
  it('C++: namespace, class, method, #include', async () => {
    const src = `#include <vector>
namespace ns {
class Greeter { public: int hello() { return 1; } };
}
`;
    const s = await symbols('cpp', 'a.cpp', src);
    expect(s).toContainEqual({ kind: 'class', name: 'ns' });
    expect(s).toContainEqual({ kind: 'class', name: 'Greeter' });
    expect(s).toContainEqual({ kind: 'method', name: 'hello' });
  });

  it('Java: class, method, interface, import', async () => {
    const src = `package com.example;
import java.util.List;
public class Greeter { public String hello() { return "hi"; } }
interface Shape { double area(); }
`;
    const r = await parseFile(REPO, 'A.java', 'java', src);
    const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
    expect(s).toContainEqual({ kind: 'class', name: 'Greeter' });
    expect(s).toContainEqual({ kind: 'method', name: 'hello' });
    expect(s).toContainEqual({ kind: 'interface', name: 'Shape' });
    expect(r.imports.map((i) => i.importedName)).toContain('List');
  });

  it('Kotlin: class, object, function, import', async () => {
    const src = `package com.example
import com.example.foo.Bar
class Greeter(val name: String) { fun hello(): String { return "hi" } }
object Singleton {
    fun instance() {}
}
fun topLevel(x: Int): Int { return x + 1 }
`;
    const r = await parseFile(REPO, 'a.kt', 'kotlin', src);
    const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
    expect(s).toContainEqual({ kind: 'class', name: 'Greeter' });
    expect(s).toContainEqual({ kind: 'method', name: 'hello' });
    expect(s).toContainEqual({ kind: 'object', name: 'Singleton' });
    expect(s).toContainEqual({ kind: 'function', name: 'topLevel' });
    expect(r.imports.map((i) => i.importedName)).toContain('Bar');
  });

  it('Ruby: class, method, top-level function, require', async () => {
    const src = "require 'json'\nclass Greeter\n  def hello\n    'hi'\n  end\nend\ndef top\n  1\nend\n";
    const r = await parseFile(REPO, 'a.rb', 'ruby', src);
    const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
    expect(s).toContainEqual({ kind: 'class', name: 'Greeter' });
    expect(s).toContainEqual({ kind: 'method', name: 'hello' });
    expect(s).toContainEqual({ kind: 'function', name: 'top' });
    expect(r.imports.map((i) => i.sourceModule)).toContain('json');
  });

  it('PHP: namespace, class, method, function, use', async () => {
    const src = `<?php
namespace App;
use App\\Models\\User;
class Greeter { public function hello() { return "hi"; } }
function top() { return 1; }
`;
    const r = await parseFile(REPO, 'a.php', 'php', src);
    const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
    expect(s).toContainEqual({ kind: 'class', name: 'Greeter' });
    expect(s).toContainEqual({ kind: 'method', name: 'hello' });
    expect(s).toContainEqual({ kind: 'function', name: 'top' });
    expect(r.imports.map((i) => i.importedName)).toContain('User');
  });

  // Dart's npm grammar (tree-sitter-dart@1.0) targets a newer ABI than the
  // pinned tree-sitter runtime. On runtimes where it can't load, parseFile must
  // surface a clean error (the Rust CLI still indexes Dart). Where it does load,
  // it must produce the expected symbols.
  it('Dart: loads with correct symbols, or degrades cleanly', async () => {
    const src = `import 'package:flutter/material.dart';
class Counter {
  void increment() {}
}
enum Color { red, green }
int topLevel(int a) => a + 1;
`;
    try {
      const r = await parseFile(REPO, 'a.dart', 'dart', src);
      const s = r.symbols.map((x) => ({ kind: x.kind, name: x.name }));
      expect(s).toContainEqual({ kind: 'class', name: 'Counter' });
      expect(s).toContainEqual({ kind: 'method', name: 'increment' });
      expect(s).toContainEqual({ kind: 'enum', name: 'Color' });
      expect(s).toContainEqual({ kind: 'function', name: 'topLevel' });
    } catch (err) {
      // Acceptable only when the grammar genuinely could not be loaded.
      expect(getParserError('dart')).toBeTruthy();
    }
  });
});
