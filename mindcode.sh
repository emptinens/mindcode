#!/bin/sh
# MindCode launcher: exec the Rust-first native binary.
#
# No Bun, Node, or zsh is required at startup. The 0.1.3 release artifact is
# a single native `mindcode` executable built by scripts/build-native-release.sh;
# this wrapper only locates it and forwards arguments.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)
case "$HOST_OS-$HOST_ARCH" in
  Linux-x86_64|Linux-amd64) TARGET=mindcode-linux-x64 ;;
  Darwin-arm64) TARGET=mindcode-darwin-arm64 ;;
  Darwin-x86_64|Darwin-amd64) TARGET=mindcode-darwin-x64 ;;
  *)
    echo "mindcode: unsupported platform: $HOST_OS-$HOST_ARCH" >&2
    exit 1
    ;;
esac

CLI="$SCRIPT_DIR/dist/$TARGET"
if [ ! -x "$CLI" ]; then
  echo "mindcode: binary not found: $CLI (run scripts/build-native-release.sh first)" >&2
  exit 1
fi

exec "$CLI" "$@"
