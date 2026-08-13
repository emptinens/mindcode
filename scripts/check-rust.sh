#!/bin/sh
# Rust verification gate for the native workspace.  This replaces the old
# `check:rust` package.json script; no Bun or Node is required.
set -eu

cd "$(dirname "$0")/.."

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets --locked
