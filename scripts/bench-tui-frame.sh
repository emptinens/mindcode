#!/bin/sh
# Manual-only TUI performance benchmark (§5.5.4). Never run from normal CI.
set -eu

if [ "${MINDCODE_BENCH_APPROVED:-}" != "1" ]; then
  echo "refusing TUI frame benchmark: set MINDCODE_BENCH_APPROVED=1 after owner consent" >&2
  exit 2
fi

cargo test -p mindcode-tui --lib tui_frame_benchmark_200_turns --locked -- --ignored --nocapture
