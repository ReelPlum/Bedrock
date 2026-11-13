//! Builds Google's Ink Stroke Modeler and the parts of Abseil it uses.
//!
//! For WebAssembly the C++ is compiled with the WASI SDK's clang and C++
//! library (set `WASI_SDK_PATH`, default `/opt/wasi-sdk`): Rust's
//! `wasm32-unknown-unknown` target has no C++ library of its own. For tests
//! on the build machine the system C++ compiler is used.

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            sources(&p, out);
        } else if p.extension().is_some_and(|e| e == "cc") {
            out.push(p);
        }
    }
}

fn main() {
    let here = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let ism = here.join("third_party/ink-stroke-modeler");
    let absl = here.join("third_party/abseil-cpp");
    let mut files = vec![here.join("src/ism_c.cc"), here.join("src/absl_single_thread.cc")];
    sources(&ism, &mut files);
    sources(&absl, &mut files);
    files.sort();

    let mut build = cc::Build::new();
    build.cpp(true).std("c++20").include(&ism).include(&absl).define("NDEBUG", None).warnings(false);
    let wasm = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap() == "wasm32";
    if wasm {
        let sdk = PathBuf::from(std::env::var("WASI_SDK_PATH").unwrap_or_else(|_| "/opt/wasi-sdk".into()));
        let sysroot = sdk.join("share/wasi-sysroot");
        assert!(
            sysroot.is_dir(),
            "the WASI SDK is needed to build the Ink Stroke Modeler for WebAssembly: \
             set WASI_SDK_PATH (see scripts/install-wasi-sdk.sh); looked in {}",
            sdk.display()
        );
        build
            .compiler(sdk.join("bin/clang++"))
            .archiver(sdk.join("bin/llvm-ar"))
            .cpp_link_stdlib(None)
            .flag("--target=wasm32-wasip1")
            .flag(format!("--sysroot={}", sysroot.display()))
            .flag("-fno-exceptions")
            .flag("-Os");
        let lib = sysroot.join("lib/wasm32-wasip1");
        println!("cargo:rustc-link-search=native={}", lib.display());
        for l in ["c++", "c++abi", "c"] {
            println!("cargo:rustc-link-lib=static={l}");
        }
        let rt = std::fs::read_dir(sdk.join("lib/clang"))
            .ok()
            .and_then(|mut d| d.next())
            .and_then(|d| d.ok())
            .map(|d| d.path().join("lib/wasip1"))
            .expect("clang runtime in the WASI SDK");
        println!("cargo:rustc-link-search=native={}", rt.display());
        println!("cargo:rustc-link-lib=static=clang_rt.builtins-wasm32");
        println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    }
    for f in &files {
        build.file(f);
    }
    build.compile("ink_stroke_modeler");
    println!("cargo:rerun-if-changed=src/ism_c.cc");
    println!("cargo:rerun-if-changed=src/absl_single_thread.cc");
    println!("cargo:rerun-if-changed=third_party");
}
