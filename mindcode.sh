#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)
case "$HOST_OS-$HOST_ARCH" in
  Darwin-arm64) TARGET=mindcode-darwin-arm64 ;;
  Darwin-x86_64|Darwin-amd64) TARGET=mindcode-darwin-x64 ;;
  Linux-x86_64|Linux-amd64) TARGET=mindcode-linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=mindcode-linux-arm64 ;;
  MINGW*-x86_64|MINGW*-amd64|MSYS*-x86_64|MSYS*-amd64|CYGWIN*-x86_64|CYGWIN*-amd64|MINGW*-arm64|MSYS*-arm64|CYGWIN*-arm64)
    TARGET=mindcode.exe
    ;;
  *)
    print -u2 -- "Unsupported platform: $HOST_OS-$HOST_ARCH"
    exit 1
    ;;
esac
CLI="$SCRIPT_DIR/dist/$TARGET"

VEXZY_API_KEY=${VEXZY_API_KEY:-}
if [[ -z "$VEXZY_API_KEY" || "$VEXZY_API_KEY" != forge-* || "$VEXZY_API_KEY" == forge- || "$VEXZY_API_KEY" == *[[:space:]]* ]]; then
  print -u2 -- 'VEXZY_API_KEY must start with forge-'
  exit 1
fi

# Do not let provider-specific credentials or selectors reach the VEXZY-only
# runtime. The key itself is never interpolated into diagnostics.
for name in ${(k)parameters}; do
  case "$name" in
    ANTHROPIC_*|CLAUDE_*) unset "$name" ;;
  esac
done
unset MINDCODE_USE_BEDROCK MINDCODE_USE_VERTEX MINDCODE_USE_FOUNDRY

export MINDCODE_EXPERIMENTAL_AGENT_TEAMS="1"
export MINDCODE_DELEGATION_FIRST="1"
export MINDCODE_SUBAGENT_MODEL="gpt-5.6-luna"
export MINDCODE_COMPACT_MODEL="gpt-5.6-luna"
export MINDCODE_AUTOCOMPACT_PCT_OVERRIDE="95"
export MINDCODE_DISABLE_COMPACT_CACHE_SHARING="1"
unset MINDCODE_SIMPLE DISABLE_COMPACT DISABLE_AUTO_COMPACT

menu_requested=0
after_separator=0
model_already_selected=0
effort_already_selected=0
selected_model_id=''

typeset -a FORWARD_ARGS
FORWARD_ARGS=()
typeset -a TRAILING_ARGS
TRAILING_ARGS=()
typeset -a MENU_ARGS
MENU_ARGS=()
typeset -a EFFORT_VALUES
EFFORT_VALUES=(none low medium high xhigh max)

for ((index = 1; index <= $#; index++)); do
  argument="${@[$index]}"
  if (( after_separator )); then
    TRAILING_ARGS+=("$argument")
    continue
  fi
  if [[ "$argument" == -- ]]; then
    after_separator=1
    TRAILING_ARGS+=("$argument")
    continue
  fi
  if [[ "$argument" == --menu ]]; then
    menu_requested=1
    continue
  fi
  if [[ "$argument" == --model ]]; then
    model_already_selected=1
    FORWARD_ARGS+=("$argument")
    (( index++ ))
    if (( index > $# )); then
      print -u2 -- '--model requires a value'
      exit 2
    fi
    selected_model_id="${@[$index]}"
    FORWARD_ARGS+=("$selected_model_id")
    continue
  fi
  if [[ "$argument" == --model=* ]]; then
    model_already_selected=1
    selected_model_id="${argument#--model=}"
    FORWARD_ARGS+=("$argument")
    continue
  fi
  if [[ "$argument" == --effort ]]; then
    if (( effort_already_selected )); then
      print -u2 -- 'Duplicate --effort is not allowed'
      exit 2
    fi
    effort_already_selected=1
    (( index++ ))
    if (( index > $# )); then
      print -u2 -- '--effort requires one of: none, low, medium, high, xhigh, max'
      exit 2
    fi
    effort_value="${@[$index]}"
    if [[ " ${EFFORT_VALUES[*]} " != *" $effort_value "* ]]; then
      print -u2 -- '--effort must be one of: none, low, medium, high, xhigh, max'
      exit 2
    fi
    FORWARD_ARGS+=(--effort "$effort_value")
    continue
  fi
  if [[ "$argument" == --effort=* ]]; then
    if (( effort_already_selected )); then
      print -u2 -- 'Duplicate --effort is not allowed'
      exit 2
    fi
    effort_already_selected=1
    effort_value="${argument#--effort=}"
    if [[ " ${EFFORT_VALUES[*]} " != *" $effort_value "* ]]; then
      print -u2 -- '--effort must be one of: none, low, medium, high, xhigh, max'
      exit 2
    fi
    FORWARD_ARGS+=("$argument")
    continue
  fi
  if [[ "$argument" == --thinking || "$argument" == --thinking=* ]]; then
    print -u2 -- 'Use --effort none|low|medium|high|xhigh|max for reasoning.'
    exit 2
  fi
  FORWARD_ARGS+=("$argument")
done

typeset -a MENU_MODELS
typeset -a MENU_DETAILS
typeset -a MENU_EFFORTS

load_registry_models() {
  local registry_json
  local records
  local curl_api_key

  # Quote the header value for curl's config-file parser without putting the
  # credential in argv or diagnostics.
  curl_api_key=${VEXZY_API_KEY//\\/\\\\}
  curl_api_key=${curl_api_key//\"/\\\"}

  if ! registry_json=$(curl --silent --show-error --fail \
    --connect-timeout 3 --max-time 8 --config - 2>/dev/null <<EOF
header = "Authorization: Bearer $curl_api_key"
url = "https://api.echogate.one/v1/models"
EOF
  ); then
    return 1
  fi

  if ! records=$(printf '%s' "$registry_json" | python3 -c '
import json
import re
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)

items = payload.get("data", payload) if isinstance(payload, dict) else payload
if not isinstance(items, list):
    raise SystemExit(1)

for item in items:
    if not isinstance(item, dict):
        continue
    if item.get("available") is False:
        continue
    status = str(item.get("status", "")).lower()
    if status in {"unavailable", "offline", "maintenance", "deprecated", "disabled"}:
        continue
    model_id = item.get("id")
    if not isinstance(model_id, str) or not re.fullmatch(r"[^\x00-\x20\x7f]+", model_id):
        continue
    raw_efforts = item.get("supported_reasoning_efforts")
    efforts = []
    if isinstance(raw_efforts, list):
        efforts = [
            value
            for value in raw_efforts
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]+", value)
        ]
    detail_parts = []
    for key, label in (
        ("display_name", "name"),
        ("owned_by", "owner"),
        ("context_length", "context"),
        ("max_output_tokens", "max output"),
        ("supported_reasoning_efforts", "effort"),
    ):
        value = item.get(key)
        if value is not None:
            if isinstance(value, (list, dict)):
                value = json.dumps(value, separators=(",", ":"), sort_keys=True)
            detail_parts.append(f"{label}={value}")
    capabilities = item.get("capabilities")
    if capabilities:
        detail_parts.append("capabilities=" + json.dumps(capabilities, separators=(",", ":"), sort_keys=True))
    print(model_id + "\t" + (",".join(efforts) or "-") + "\t" + " | ".join(detail_parts))
') ; then
    return 1
  fi

  MENU_MODELS=()
  MENU_DETAILS=()
  MENU_EFFORTS=()
  while IFS=$'\t' read -r model_id model_efforts model_detail; do
    [[ -n "$model_id" ]] || continue
    MENU_MODELS+=("$model_id")
    MENU_EFFORTS+=("$model_efforts")
    MENU_DETAILS+=("${model_detail:-details unavailable}")
  done <<< "$records"
  (( ${#MENU_MODELS} > 0 ))
}

if (( menu_requested )); then
  if ! load_registry_models; then
    print -u2 -- 'VEXZY model registry unavailable; cannot select a Leader model.'
    exit 1
  fi

  selected_model_index=0
  if (( model_already_selected == 0 )); then
    print -- 'Leader model (Workers remain fixed at gpt-5.6-luna):'
    for ((index = 1; index <= ${#MENU_MODELS}; index++)); do
      print -- "$index) ${MENU_MODELS[$index]} — ${MENU_DETAILS[$index]}"
    done
    print -n -- 'Select model [1]: '
    selection=''
    read -r selection || true
    if [[ -z "$selection" ]]; then
      selection=1
    fi
    if [[ "$selection" != <-> || "$selection" -lt 1 || "$selection" -gt ${#MENU_MODELS} ]]; then
      print -u2 -- 'Invalid model selection; using model 1.'
      selection=1
    fi
    selected_model_index=$selection
    selected_model_id="${MENU_MODELS[$selected_model_index]}"
    MENU_ARGS+=(--model "$selected_model_id")
  else
    for ((index = 1; index <= ${#MENU_MODELS}; index++)); do
      if [[ "${MENU_MODELS[$index]}" == "$selected_model_id" ]]; then
        selected_model_index=$index
        break
      fi
    done
  fi

  if (( effort_already_selected == 0 )); then
    typeset -a SELECTED_EFFORTS
    SELECTED_EFFORTS=()
    if (( selected_model_index > 0 )) && [[ "${MENU_EFFORTS[$selected_model_index]}" != '-' ]]; then
      SELECTED_EFFORTS=("${(@s:,:)MENU_EFFORTS[$selected_model_index]}")
    fi
    if (( ${#SELECTED_EFFORTS} == 0 )); then
      SELECTED_EFFORTS=("${EFFORT_VALUES[@]}")
    fi

    print -- "Leader effort for ${selected_model_id:-selected model}:"
    default_effort_index=1
    for ((index = 1; index <= ${#SELECTED_EFFORTS}; index++)); do
      print -- "$index) ${SELECTED_EFFORTS[$index]}"
      if [[ "${SELECTED_EFFORTS[$index]}" == medium ]]; then
        default_effort_index=$index
      fi
    done
    print -n -- "Select effort [$default_effort_index]: "
    effort_selection=''
    read -r effort_selection || true
    if [[ -z "$effort_selection" ]]; then
      effort_selection=$default_effort_index
    fi
    if [[ "$effort_selection" != <-> || "$effort_selection" -lt 1 || "$effort_selection" -gt ${#SELECTED_EFFORTS} ]]; then
      print -u2 -- "Invalid effort selection; using effort $default_effort_index."
      effort_selection=$default_effort_index
    fi
    MENU_ARGS+=(--effort "${SELECTED_EFFORTS[$effort_selection]}")
  fi
fi

if [[ ! -x "$CLI" ]]; then
  print -u2 -- "MindCode binary not found: $CLI"
  exit 1
fi

exec "$CLI" "${FORWARD_ARGS[@]}" "${MENU_ARGS[@]}" "${TRAILING_ARGS[@]}"
