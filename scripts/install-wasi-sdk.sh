#!/usr/bin/env bash
# Installs the pinned WASI SDK (clang, libc++ and wasi-libc for WebAssembly),
# which builds Google's Ink Stroke Modeler (C++) into the web app's
# WebAssembly. Usage: scripts/install-wasi-sdk.sh [destination]
# The destination defaults to $WASI_SDK_PATH, or .wasi-sdk in the repository.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=25
DEST="${1:-${WASI_SDK_PATH:-$PWD/.wasi-sdk}}"
if [ -x "$DEST/bin/clang++" ]; then
  echo "WASI SDK already in $DEST"
  exit 0
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ARCH=x86_64-linux;  SHA=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c ;;
  Darwin-arm64)  ARCH=arm64-macos;   SHA=e1e529ea226b1db0b430327809deae9246b580fa3cae32d31c82dfe770233587 ;;
  Darwin-x86_64) ARCH=x86_64-macos;  SHA=55e3ff3fee1a15678a16eeccba0129276c9f6be481bc9c283e7f9f65bf055c11 ;;
  *) echo "No pinned WASI SDK for $(uname -s) $(uname -m); install wasi-sdk-$VERSION and set WASI_SDK_PATH" >&2; exit 1 ;;
esac
NAME="wasi-sdk-$VERSION.0-$ARCH"
URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$VERSION/$NAME.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
curl -fsSL --retry 4 -o "$TMP/sdk.tar.gz" "$URL"
GOT="$( (command -v sha256sum >/dev/null && sha256sum "$TMP/sdk.tar.gz" || shasum -a 256 "$TMP/sdk.tar.gz") | cut -d' ' -f1)"
if [ "$GOT" != "$SHA" ]; then
  echo "Checksum mismatch for $NAME: expected $SHA, got $GOT" >&2
  exit 1
fi
mkdir -p "$DEST"
tar -xzf "$TMP/sdk.tar.gz" -C "$DEST" --strip-components=1
echo "WASI SDK $VERSION installed in $DEST"
