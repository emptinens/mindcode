#!/bin/sh
# Build the Rust-first single `mindcode` executable for Linux x86_64.
# No Bun or Node is required; this is the 0.1.4 release artifact.
set -eu

cd "$(dirname "$0")/.."

TARGET="${MINDCODE_RELEASE_TARGET:-mindcode-linux-x64}"

cargo build --release --package mindcode-native --locked

mkdir -p dist
cp target/release/mindcode "dist/$TARGET"
chmod +x "dist/$TARGET"

echo "built dist/$TARGET"
