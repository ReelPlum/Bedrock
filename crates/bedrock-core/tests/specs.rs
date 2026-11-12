//! Keeps the living specs in `openspec/specs/` honest: every scenario that
//! names its proving test with `<!-- test: name -->` must point at a test
//! function that still exists somewhere under `crates/`. Renaming or deleting
//! a test without updating the spec fails here.

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

#[test]
fn every_test_named_in_a_spec_exists() {
    let root = repo_root();
    let mut specs = Vec::new();
    files_with_ext(&root.join("openspec/specs"), "md", &mut specs);
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
fn cited_tests_are_parsed() {
    let spec = "x\n<!-- test: a_test -->\n<!-- test: b_test (regression) -->\n";
    assert_eq!(cited_tests(spec), vec!["a_test", "b_test"]);
}
