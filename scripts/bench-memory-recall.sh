#!/usr/bin/env sh
set -eu

if [ "${MINDCODE_BENCH_APPROVED:-}" != "1" ]; then
  echo "memory-recall benchmark is disabled; set MINDCODE_BENCH_APPROVED=1 after owner consent" >&2
  exit 2
fi

MINDCODE_MEMORY_RECALL_GATE=1 cargo test -p mindcode-state --test memory_recall_bench --locked -- --ignored --nocapture
