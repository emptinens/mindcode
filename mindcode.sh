#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=mindcode-darwin-arm64 ;;
  Darwin-x86_64) TARGET=mindcode-darwin-x64 ;;
  Linux-x86_64) TARGET=mindcode-linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=mindcode-linux-arm64 ;;
  *)
    print -u2 -- "Unsupported platform: $(uname -s)-$(uname -m)"
    exit 1
    ;;
esac
CLI="$SCRIPT_DIR/dist/$TARGET"

if [[ "${VEXZY_API_KEY:-}" != forge-?* || "${VEXZY_API_KEY:-}" == *[[:space:]]* ]]; then
  print -u2 -- 'VEXZY_API_KEY must start with forge-'
  exit 1
fi
export ANTHROPIC_BASE_URL="https://api.echogate.one"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-gpt-5.6-luna}"
export MINDCODE_EXPERIMENTAL_AGENT_TEAMS="1"
export MINDCODE_SUBAGENT_MODEL="gpt-5.6-luna"
export MINDCODE_COMPACT_MODEL="gpt-5.6-luna"
export MINDCODE_MAX_WORKERS="${MINDCODE_MAX_WORKERS:-20}"
export MINDCODE_DELEGATION_FIRST="1"
export MINDCODE_AUTOCOMPACT_PCT_OVERRIDE="${MINDCODE_AUTOCOMPACT_PCT_OVERRIDE:-95}"
export MINDCODE_DISABLE_COMPACT_CACHE_SHARING="1"
unset MINDCODE_SIMPLE DISABLE_COMPACT DISABLE_AUTO_COMPACT

if [[ ! -x "$CLI" ]]; then
  print -u2 -- "MindCode binary not found: $CLI"
  exit 1
fi

exec "$CLI" "$@"
