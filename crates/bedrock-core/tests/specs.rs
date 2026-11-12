//! Keeps the living specs in `openspec/specs/` honest: every scenario that
//! names its proving test with `<!-- test: name -->` must point at a test
//! function that still exists somewhere under `crates/`. Renaming or deleting
//! a test without updating the spec fails here.
//!
//! Scenarios proved by a JavaScript test (the web app, the Obsidian plugin)
//! cite it as `<!-- test-js: apps/web/tests/x.test.mjs :: test title -->`;
//! that file must still hold `test('test title'`. Open changes in
//! `openspec/changes/` (not the archive) are checked too.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn files_with_ext(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_with_ext(&path, ext, out);
        } else if path.extension().is_some_and(|e| e == ext) {
            out.push(path);
        }
    }
}

/// Test names cited by `<!-- test: name ... -->` comments in a spec.
fn cited_tests(spec: &str) -> Vec<String> {
    spec.match_indices("<!-- test:")
        .filter_map(|(i, m)| {
            let rest = &spec[i + m.len()..];
            let name: String =
                rest.trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// `(file, title)` pairs cited by `<!-- test-js: file :: title -->` comments.
fn cited_js_tests(spec: &str) -> Vec<(String, String)> {
    spec.match_indices("<!-- test-js:")
        .filter_map(|(i, m)| {
            let rest = &spec[i + m.len()..];
            let body = &rest[..rest.find("-->")?];
            let (file, title) = body.split_once("::")?;
            Some((file.trim().to_string(), title.trim().to_string()))
        })
        .collect()
}

/// Spec files: the living specs and the delta specs of open changes.
fn spec_files(root: &Path) -> Vec<PathBuf> {
    let mut specs = Vec::new();
    files_with_ext(&root.join("openspec/specs"), "md", &mut specs);
    let mut changes = Vec::new();
    files_with_ext(&root.join("openspec/changes"), "md", &mut changes);
    let archive = root.join("openspec/changes/archive");
    specs.extend(changes.into_iter().filter(|p| !p.starts_with(&archive) && p.ends_with("spec.md")));
    specs
}

#[test]
fn every_js_test_named_in_a_spec_exists() {
    let root = repo_root();
    let mut missing = Vec::new();
    for spec in spec_files(&root) {
        let text = fs::read_to_string(&spec).unwrap();
        for (file, title) in cited_js_tests(&text) {
            let source = fs::read_to_string(root.join(&file)).unwrap_or_default();
            let quoted = [format!("test('{title}'"), format!("test(\"{title}\""), format!("test(`{title}`")];
            if !quoted.iter().any(|q| source.contains(q.as_str())) {
                missing.push(format!("{}: {file} :: {title}", spec.display()));
            }
        }
    }
    assert!(missing.is_empty(), "specs cite JavaScript tests that do not exist:\n{}", missing.join("\n"));
}

#[test]
fn cited_js_tests_are_parsed() {
    let spec = "<!-- test-js: apps/web/tests/a.test.mjs :: does a thing -->\n<!-- test: rust_one -->\n";
    assert_eq!(cited_js_tests(spec), vec![("apps/web/tests/a.test.mjs".to_string(), "does a thing".to_string())]);
    assert!(cited_tests(spec) == vec!["rust_one"]);
}

#[test]
fn every_test_named_in_a_spec_exists() {
    let root = repo_root();
    let specs = spec_files(&root);
    assert!(specs.iter().any(|p| p.starts_with(root.join("openspec/specs"))), "no specs found under openspec/specs");

    let mut sources = String::new();
    let mut rust = Vec::new();
    files_with_ext(&root.join("crates"), "rs", &mut rust);
    for file in rust {
        sources.push_str(&fs::read_to_string(file).unwrap());
    }

    let mut missing = Vec::new();
    for spec in &specs {
        let text = fs::read_to_string(spec).unwrap();
        for name in cited_tests(&text) {
            if !sources.contains(&format!("fn {name}(")) {
                missing.push(format!("{}: {name}", spec.display()));
            }
        }
    }
    assert!(missing.is_empty(), "specs cite tests that do not exist:\n{}", missing.join("\n"));
}

#[test]
fn cited_tests_are_parsed() {
    let spec = "x\n<!-- test: a_test -->\n<!-- test: b_test (regression) -->\n";
    assert_eq!(cited_tests(spec), vec!["a_test", "b_test"]);
}
