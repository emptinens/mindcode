#!/bin/sh
# §13.4: supply-chain gate via cargo-deny (license allowlist, duplicate
# versions, security advisories). Fails closed when cargo-deny is absent.
set -eu

cd "$(dirname "$0")/.."

if ! command -v cargo-deny >/dev/null 2>&1; then
    echo "cargo-deny is not installed; install it with:" >&2
    echo "  cargo install cargo-deny --locked" >&2
    exit 1
fi

cargo deny check bans licenses advisories
