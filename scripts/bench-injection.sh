#!/bin/sh
# Manual-only injection benchmark (§5.4.6). Never run from the normal CI path.
set -eu

if [ "${MINDCODE_BENCH_APPROVED:-}" != "1" ]; then
  echo "refusing injection benchmark: set MINDCODE_BENCH_APPROVED=1 after owner consent" >&2
  exit 2
fi

cargo test -p mindcode-worker --test injection_bench --locked -- --ignored --nocapture
