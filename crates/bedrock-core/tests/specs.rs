//! Keeps the specs honest: the living specs in `openspec/specs/` and the
//! delta specs of changes in progress (`openspec/changes/`, not the archive).
//! Every scenario that names its proving test must point at a test that
//! still exists: `<!-- test: name -->` a Rust test function under `crates/`,
//! `<!-- web test: "name" -->` a browser test (`test('name', …)`) under
//! `apps/*/tests/`. Renaming or deleting a test without updating the spec
//! fails here.

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

/// Browser test names cited by `<!-- web test: "name" -->` comments.
fn cited_web_tests(spec: &str) -> Vec<String> {
    spec.match_indices("<!-- web test:")
        .filter_map(|(i, m)| {
            let rest = spec[i + m.len()..].trim_start().strip_prefix('"')?;
            let end = rest.find("\" -->")?;
            Some(rest[..end].to_string())
        })
        .collect()
}

/// Living specs, and the delta specs of changes not yet archived.
fn all_specs(root: &Path) -> Vec<PathBuf> {
    let mut specs = Vec::new();
    files_with_ext(&root.join("openspec/specs"), "md", &mut specs);
    if let Ok(entries) = fs::read_dir(root.join("openspec/changes")) {
        for e in entries.flatten() {
            if e.file_name() != "archive" {
                files_with_ext(&e.path().join("specs"), "md", &mut specs);
            }
        }
    }
    specs
}

#[test]
fn every_test_named_in_a_spec_exists() {
    let root = repo_root();
    let specs = all_specs(&root);
    assert!(!specs.is_empty(), "no specs found under openspec/specs");

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
fn every_browser_test_named_in_a_spec_exists() {
    let root = repo_root();
    let mut sources = String::new();
    if let Ok(apps) = fs::read_dir(root.join("apps")) {
        for app in apps.flatten() {
            let mut js = Vec::new();
            files_with_ext(&app.path().join("tests"), "mjs", &mut js);
            for file in js {
                sources.push_str(&fs::read_to_string(file).unwrap());
            }
        }
    }
    let mut missing = Vec::new();
    for spec in all_specs(&root) {
        let text = fs::read_to_string(&spec).unwrap();
        for name in cited_web_tests(&text) {
            let quoted = [
                format!("test('{}'", name.replace('\'', "\\'")),
                format!("test(\"{}\"", name.replace('"', "\\\"")),
                format!("test(`{name}`"),
            ];
            if !quoted.iter().any(|q| sources.contains(q.as_str())) {
                missing.push(format!("{}: {name}", spec.display()));
            }
        }
    }
    assert!(missing.is_empty(), "specs cite browser tests that do not exist:\n{}", missing.join("\n"));
}

#[test]
fn cited_web_tests_are_parsed() {
    let spec = "<!-- web test: \"it's sent\" -->\n<!-- web test: \"two\" -->\n<!-- test: rust_one -->\n";
    assert_eq!(cited_web_tests(spec), vec!["it's sent", "two"]);
}

#[test]
fn cited_tests_are_parsed() {
    let spec = "x\n<!-- test: a_test -->\n<!-- test: b_test (regression) -->\n";
    assert_eq!(cited_tests(spec), vec!["a_test", "b_test"]);
}
