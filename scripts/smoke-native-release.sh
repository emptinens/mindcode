#!/bin/sh
# Smoke-test the single `mindcode` executable with an empty PATH so no
# Bun/Node runtime can be resolved: this proves the core, daemon and TUI
# command surface run without a JS runtime.
set -eu

cd "$(dirname "$0")/.."

BIN="${1:-dist/mindcode-linux-x64}"
if [ ! -x "$BIN" ]; then
  echo "missing executable: $BIN (run scripts/build-native-release.sh first)" >&2
  exit 1
fi

TMP_HOME="$(mktemp -d)"
TMP_XDG="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME" "$TMP_XDG"' EXIT

run_clean() {
  env -i HOME="$TMP_HOME" XDG_CONFIG_HOME="$TMP_XDG" "$BIN" "$@"
}

# Version and help need no configuration and no JS runtime.
run_clean --version | grep -q "mindcode 0.1.4"
run_clean --help | grep -q "tui"

# First run has no provider profiles: every provider is a custom profile,
# so the provider table is empty and `auth status` fails closed.
run_clean provider list | grep -q '^\[\]$'
run_clean settings show | grep -q '"active_provider":null'
if run_clean auth status 2>/dev/null; then
  echo "auth status should fail closed with no active provider" >&2
  exit 1
fi

# The daemon is in-process; verify its entrypoint parses without a JS runtime.
run_clean daemon --help | grep -q "mindcode daemon"

echo "native release smoke passed"
