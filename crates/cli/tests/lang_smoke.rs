//! Synthetic smoke tests — one tiny source per language, assert at least one
//! expected symbol kind appears.

use cortexmd_cli::parser::parse_file;
use cortexmd_cli::payload::Language;

const REPO_ID: &str = "0123456789abcdef";

fn parse(lang: Language, name: &str, src: &str) -> cortexmd_cli::parser::ParseResult {
    parse_file(REPO_ID, name, lang, src).expect("parse should succeed")
}

#[test]
fn typescript_function_and_interface() {
    let src = r#"
export interface Foo { x: number; }
export function bar(a: number): number { return a + 1; }
"#;
    let r = parse(Language::Typescript, "a.ts", src);
    assert!(r.symbols.iter().any(|s| s.kind == "interface" && s.name == "Foo"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "bar"));
}

#[test]
fn body_simhash_populated_for_non_trivial_bodies() {
    // bar() has enough tokens for a fingerprint; tiny constants don't.
    let src = r#"
export function bar(a: number): number {
  const sum = a + 1;
  const doubled = sum * 2;
  return doubled - 3;
}
"#;
    let r = parse(Language::Typescript, "a.ts", src);
    let bar = r
        .symbols
        .iter()
        .find(|s| s.kind == "function" && s.name == "bar")
        .expect("bar should be in symbols");
    let fp = bar.body_simhash.as_ref().expect("bar should have a body_simhash");
    assert_eq!(fp.len(), 16, "fingerprint must be 16 hex chars: {fp}");
    assert!(
        fp.chars().all(|c| c.is_ascii_hexdigit()),
        "fingerprint must be hex: {fp}"
    );
}

#[test]
fn tsx_const_export_arrow() {
    let src = r#"
export const Comp = (props: any) => <div>hello</div>;
"#;
    let r = parse(Language::Tsx, "a.tsx", src);
    assert!(
        r.symbols.iter().any(|s| s.kind == "const-export" && s.name == "Comp"),
        "expected const-export Comp, got: {:?}",
        r.symbols.iter().map(|s| (&s.name, &s.kind)).collect::<Vec<_>>()
    );
}

#[test]
fn javascript_class_with_method() {
    let src = r#"
class Greeter {
  hello() { return "hi"; }
}
"#;
    let r = parse(Language::Javascript, "a.js", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"));
}

#[test]
fn python_class_method_and_function() {
    let src = "
def top():
    return 1

class C:
    def m(self):
        return 2
";
    let r = parse(Language::Python, "a.py", src);
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "top"));
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "C"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "m"));
}

#[test]
fn rust_struct_impl_method() {
    let src = r#"
struct Foo { x: i32 }
impl Foo {
    fn bar(&self) -> i32 { self.x }
}
fn standalone() {}
"#;
    let r = parse(Language::Rust, "a.rs", src);
    assert!(r.symbols.iter().any(|s| s.kind == "struct" && s.name == "Foo"));
    assert!(r.symbols.iter().any(|s| s.kind == "impl" && s.name == "Foo"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "bar"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "standalone"));
}

#[test]
fn go_struct_and_method() {
    let src = r#"
package main

type Foo struct { X int }

func (f Foo) Bar() int { return f.X }

func TopLevel() int { return 0 }
"#;
    let r = parse(Language::Go, "a.go", src);
    assert!(r.symbols.iter().any(|s| s.kind == "struct" && s.name == "Foo"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "Bar"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "TopLevel"));
}

#[test]
fn cpp_class_method_and_namespace() {
    let src = r#"
#include <vector>
#include "local.hpp"

namespace ns {

class Greeter {
public:
    int hello() { return 1; }
};

int top() { return 2; }

} // namespace ns
"#;
    let r = parse(Language::Cpp, "a.cpp", src);
    assert!(
        r.symbols.iter().any(|s| s.kind == "class" && s.name == "ns"),
        "expected namespace ns as class container; got: {:?}",
        r.symbols.iter().map(|s| (&s.name, &s.kind)).collect::<Vec<_>>()
    );
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(
        r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"),
        "expected method hello inside Greeter; got: {:?}",
        r.symbols.iter().map(|s| (&s.name, &s.kind)).collect::<Vec<_>>()
    );
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "top"));
    // Imports: "vector" (system) and "local" (local).
    assert!(r.imports.iter().any(|i| i.imported_name == "vector"));
    assert!(r.imports.iter().any(|i| i.imported_name == "local"));
}

#[test]
fn c_struct_function_and_include() {
    let src = r#"
#include <stdio.h>
#include "local.h"

struct Point { int x; int y; };

int add(int a, int b) { return add_impl(a, b); }
"#;
    let r = parse(Language::C, "a.c", src);
    assert!(r.symbols.iter().any(|s| s.kind == "struct" && s.name == "Point"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "add"));
    assert!(r.imports.iter().any(|i| i.imported_name == "stdio"));
    assert!(r.imports.iter().any(|i| i.imported_name == "local"));
    assert!(r.calls.iter().any(|c| c.callee_name == "add_impl"));
}

#[test]
fn java_class_interface_and_import() {
    let src = r#"
package com.example;

import java.util.List;

public class Greeter {
    public String hello() { return "hi"; }
}

interface Shape { double area(); }
"#;
    let r = parse(Language::Java, "A.java", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"));
    assert!(r.symbols.iter().any(|s| s.kind == "interface" && s.name == "Shape"));
    assert!(r.imports.iter().any(|i| i.imported_name == "List" && i.source_module == "java.util.List"));
}

#[test]
fn kotlin_class_object_function_and_import() {
    let src = r#"
package com.example

import com.example.foo.Bar

class Greeter(val name: String) {
    fun hello(): String { return "hi" }
}

interface Shape {
    fun area(): Double
}

object Singleton {
    fun instance() {}
}

fun topLevel(x: Int): Int { return x + 1 }
"#;
    let r = parse(Language::Kotlin, "a.kt", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"));
    assert!(r.symbols.iter().any(|s| s.kind == "interface" && s.name == "Shape"));
    assert!(r.symbols.iter().any(|s| s.kind == "object" && s.name == "Singleton"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "topLevel"));
    assert!(r.imports.iter().any(|i| i.imported_name == "Bar"));
}

#[test]
fn ruby_class_method_and_require() {
    let src = r#"
require 'json'

class Greeter
  def hello
    "hi"
  end
end

def top
  1
end
"#;
    let r = parse(Language::Ruby, "a.rb", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "top"));
    assert!(r.imports.iter().any(|i| i.imported_name == "json"));
}

#[test]
fn php_class_function_namespace_and_use() {
    let src = r#"<?php
namespace App;

use App\Models\User;

class Greeter {
    public function hello() { return "hi"; }
}

function top() { return 1; }
"#;
    let r = parse(Language::Php, "a.php", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Greeter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "hello"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "top"));
    assert!(
        r.imports.iter().any(|i| i.imported_name == "User"),
        "expected use import User; got: {:?}",
        r.imports.iter().map(|i| (&i.imported_name, &i.source_module)).collect::<Vec<_>>()
    );
}

#[test]
fn dart_class_method_enum_mixin_and_import() {
    let src = r#"
import 'package:flutter/material.dart';

class Counter {
  int value = 0;
  void increment() { value += 1; }
  int get current => value;
}

enum Color { red, green }

mixin Loggable { void log(String m) {} }

int topLevel(int a) => a + 1;
"#;
    let r = parse(Language::Dart, "a.dart", src);
    assert!(r.symbols.iter().any(|s| s.kind == "class" && s.name == "Counter"));
    assert!(r.symbols.iter().any(|s| s.kind == "method" && s.name == "increment"));
    assert!(r.symbols.iter().any(|s| s.kind == "enum" && s.name == "Color"));
    assert!(r.symbols.iter().any(|s| s.kind == "mixin" && s.name == "Loggable"));
    assert!(r.symbols.iter().any(|s| s.kind == "function" && s.name == "topLevel"));
    // No duplicate emission of the same method.
    let increments = r.symbols.iter().filter(|s| s.name == "increment").count();
    assert_eq!(increments, 1, "increment must be emitted exactly once");
    assert!(r.imports.iter().any(|i| i.imported_name == "material"));
}

#[test]
fn cpp_call_extraction() {
    let src = r#"
namespace ns {

int helper() { return 42; }

class Foo {
public:
    int run() {
        return helper() + this->member();
    }
    int member() { return 1; }
};

} // namespace ns
"#;
    let r = parse(Language::Cpp, "a.cpp", src);
    let call_names: Vec<&str> = r.calls.iter().map(|c| c.callee_name.as_str()).collect();
    assert!(
        call_names.contains(&"helper"),
        "expected call to helper; got: {:?}",
        call_names
    );
    assert!(
        call_names.contains(&"member"),
        "expected call to member via this->; got: {:?}",
        call_names
    );
}
