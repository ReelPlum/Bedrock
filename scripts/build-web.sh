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
# Two modules, built one at a time so the app's does not pick up PDF
# support: bedrock_web (the app) and bedrock_pdf (PDF import, loaded the
# first time a PDF is opened).
for crate in bedrock-web bedrock-pdf; do
  cargo build -p "$crate" --target wasm32-unknown-unknown $FLAG
  wasm-bindgen --target web --no-typescript --out-dir apps/web/pkg \
    "target/wasm32-unknown-unknown/$PROFILE/${crate//-/_}.wasm"
done
# binaryen's wasm-opt: about 7% less to download and a fifth less to compile.
# CI sets BEDROCK_REQUIRE_WASM_OPT=1 so a missing wasm-opt fails the build
# instead of publishing an unoptimised app.
if [ "$PROFILE" = "release" ]; then
  if command -v wasm-opt >/dev/null 2>&1; then
    for wasm in apps/web/pkg/*_bg.wasm; do
      wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int "$wasm" -o "$wasm"
    done
  elif [ "${BEDROCK_REQUIRE_WASM_OPT:-}" = "1" ]; then
    echo "wasm-opt (binaryen) is required but was not found" >&2
    exit 1
  else
    echo "note: wasm-opt (binaryen) not found; the WebAssembly is not optimised" >&2
  fi
fi
ls -lh apps/web/pkg
