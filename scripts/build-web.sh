#!/usr/bin/env bash
# Builds the Rust canvas to WebAssembly and places it in apps/web/pkg.
# Requires: rustup target add wasm32-unknown-unknown
#           cargo install wasm-bindgen-cli --version 0.2.130
# The WASI SDK (for the C++ Ink Stroke Modeler) is installed on first use
# into .wasi-sdk, unless WASI_SDK_PATH points at one already.
set -euo pipefail
cd "$(dirname "$0")/.."
export WASI_SDK_PATH="${WASI_SDK_PATH:-$PWD/.wasi-sdk}"
[ -x "$WASI_SDK_PATH/bin/clang++" ] || scripts/install-wasi-sdk.sh "$WASI_SDK_PATH"
PROFILE="${1:-release}"
FLAG=""
[ "$PROFILE" = "release" ] && FLAG="--release"
cargo build -p bedrock-web --target wasm32-unknown-unknown $FLAG
wasm-bindgen --target web --no-typescript --out-dir apps/web/pkg \
  "target/wasm32-unknown-unknown/$PROFILE/bedrock_web.wasm"
if command -v wasm-opt >/dev/null 2>&1 && [ "$PROFILE" = "release" ]; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int \
    apps/web/pkg/bedrock_web_bg.wasm -o apps/web/pkg/bedrock_web_bg.wasm
fi
ls -lh apps/web/pkg
