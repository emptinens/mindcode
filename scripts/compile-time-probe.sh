#!/usr/bin/env bash
set -euo pipefail

# Measure cold `cargo check` wall-clock time so each crate extraction is
# justified by a number (PLAN §6.1 step 4: do not split crates without a
# measurable compile-time win).
#
# Usage:
#   scripts/compile-time-probe.sh                 # whole workspace (wipes target/)
#   scripts/compile-time-probe.sh CRATE...        # clean only these crates
#
# The crate form cleans only the named crates and then checks the whole
# workspace, so the reported wall time is the cost of recompiling those crates
# plus everything downstream of them, with all unrelated dependencies cached.

if [ "$#" -eq 0 ]; then
  scope="workspace"
  echo "compile-time-probe: cleaning whole workspace"
  cargo clean
else
  scope="$*"
  echo "compile-time-probe: cleaning: $scope"
  cargo clean -p "$@"
fi

start_ms=$(date +%s%3N)
cargo check --workspace
end_ms=$(date +%s%3N)

echo "compile-time-probe: $scope => $((end_ms - start_ms)) ms"
