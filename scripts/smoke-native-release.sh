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
run_clean --version | grep -q "mindcode 0.1.3"
run_clean --help | grep -q "tui"

# First-run seeds the built-in VEXZY profile (active, env credential).
run_clean provider list | grep -q '"id":"vexzy"'
run_clean auth status | grep -q '"apiProvider":"vexzy"'
run_clean settings show | grep -q '"active_provider":"vexzy"'

# The daemon is in-process; verify its entrypoint parses without a JS runtime.
run_clean daemon --help | grep -q "mindcode daemon"

echo "native release smoke passed"
