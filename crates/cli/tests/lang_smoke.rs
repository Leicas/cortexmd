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
