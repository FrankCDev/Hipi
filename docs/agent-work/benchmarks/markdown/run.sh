#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo 'Usage: bash run.sh /path/to/Hipi [cases|sizes] [case-name]' >&2
  exit 2
fi
export HIPI_REPO_ROOT="$(cd "$1" && pwd)"
export BENCHMARK_MODE="${2:-cases}"
export MARKDOWN_CASE="${3:-}"
harness_dir="$(cd "$(dirname "$0")" && pwd)"
export BENCHMARK_OUTPUT_DIR="${BENCHMARK_OUTPUT_DIR:-$harness_dir}"
mkdir -p "$BENCHMARK_OUTPUT_DIR"
if [[ ! -e "$harness_dir/node_modules" ]]; then
  ln -s "$HIPI_REPO_ROOT/node_modules" "$harness_dir/node_modules"
  trap 'rm "$harness_dir/node_modules"' EXIT
fi
export NODE_OPTIONS=--max-old-space-size=768
cd "$HIPI_REPO_ROOT/apps/hipi-work-ui"
timeout --signal=TERM --kill-after=5s 90s node "$HIPI_REPO_ROOT/node_modules/vitest/dist/cli.js" run --config "$harness_dir/vitest.config.mts" "$harness_dir/render-cost.test.tsx"
