#!/usr/bin/env bash
# Research benchmark: receiver on pc-ciancia, sender on this Mac.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="${NEARBYTES_REMOTE_HOST:-pc-ciancia}"
REPOS_BASE="${NEARBYTES_REPOS:-https://github.com/nearbytes}"
BENCH_BASE_LOCAL="${NEARBYTES_BENCH_BASE:-/tmp/nearbytes-sync-benchmark}"
BENCH_BASE_REMOTE="${NEARBYTES_BENCH_BASE_REMOTE:-/tmp/nearbytes-sync-benchmark}"
OUT_DIR="${NEARBYTES_BENCH_OUTDIR:-$ROOT/benchmark-output}"

run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "$@"; else corepack prepare yarn@4.5.1 --activate && yarn "$@"; fi
}

echo "==> Build sender (local)"
cd "$ROOT"
run_yarn install
run_yarn build

echo "==> Sync + build receiver on $REMOTE_HOST"
ssh "$REMOTE_HOST" "bash -s" <<REMOTE
set -euo pipefail
REPOS_BASE="${REPOS_BASE}"
BENCH_BASE="${BENCH_BASE_REMOTE}"
run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "\$@"; else export COREPACK_HOME="\$BENCH_BASE/.corepack"; mkdir -p "\$COREPACK_HOME"; corepack prepare yarn@4.5.1 --activate; corepack yarn "\$@"; fi
}
build_repo() {
  local dir="\$1"
  cd "\$dir"
  if [[ -f yarn.lock ]]; then run_yarn install && run_yarn build; else npm install --no-fund --no-audit && npm run build; fi
}
mkdir -p "\$BENCH_BASE/repos"
cd "\$BENCH_BASE/repos"
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  if [[ ! -d "\$repo/.git" ]]; then git clone --depth 1 "\$REPOS_BASE/\${repo}.git" "\$repo"; else git -C "\$repo" pull --ff-only; fi
done
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  build_repo "\$BENCH_BASE/repos/\$repo"
done
REMOTE

echo "==> Start receiver (bob) on $REMOTE_HOST"
ssh "$REMOTE_HOST" "cd ${BENCH_BASE_REMOTE}/repos/nearbytes-files && NEARBYTES_BENCH_ROLE=receiver NEARBYTES_BENCH_BASE=${BENCH_BASE_REMOTE} NEARBYTES_BENCH_OUT=${BENCH_BASE_REMOTE}/bob/benchmark-result.json NEARBYTES_BENCH_DISCOVERY_MS=18000 NEARBYTES_BENCH_SWARM_TIMEOUT_MS=120000 NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS=900000 node dist/scripts/sync-benchmark.js" &
RECV_PID=$!
sleep 12

echo "==> Start sender (alice) locally"
NEARBYTES_BENCH_ROLE=sender \
NEARBYTES_BENCH_BASE="${BENCH_BASE_LOCAL}" \
NEARBYTES_BENCH_OUT="${BENCH_BASE_LOCAL}/alice/benchmark-result.json" \
NEARBYTES_BENCH_DISCOVERY_MS=18000 \
NEARBYTES_BENCH_SWARM_TIMEOUT_MS=120000 \
NEARBYTES_BENCH_INTER_TRIAL_MS=2500 \
NEARBYTES_BENCH_GRACE_MS=35000 \
  node "$ROOT/dist/scripts/sync-benchmark.js"
SENDER_EXIT=$?

wait "$RECV_PID" || RECV_EXIT=$?
RECV_EXIT=${RECV_EXIT:-0}

echo "==> Fetch receiver results"
mkdir -p "$OUT_DIR"
scp "${REMOTE_HOST}:${BENCH_BASE_REMOTE}/bob/benchmark-result.json" "$OUT_DIR/receiver-result.json"

SENDER_JSON="${BENCH_BASE_LOCAL}/alice/benchmark-result.json"
MANIFEST_JSON="${BENCH_BASE_LOCAL}/alice/trial-manifest.json"
RECEIVER_JSON="$OUT_DIR/receiver-result.json"

node "$ROOT/scripts/merge-benchmark-results.mjs" \
  --sender "$SENDER_JSON" \
  --manifest "$MANIFEST_JSON" \
  --receiver "$RECEIVER_JSON" \
  --out "$OUT_DIR/bench-report.json" | tee "$OUT_DIR/bench-report.txt"

PAPER_FIG="${NEARBYTES_PAPER_FIGURES:-$ROOT/../../NEARBYTES-PAPERS/paper-nearbytes-hypercore/figures}"
node "$ROOT/scripts/render-benchmark-figures.mjs" \
  --report "$OUT_DIR/bench-report.json" \
  --outdir "$PAPER_FIG"

if [[ "$SENDER_EXIT" -ne 0 || "$RECV_EXIT" -ne 0 ]]; then
  echo "Benchmark process exit: sender=$SENDER_EXIT receiver=$RECV_EXIT"
  exit 1
fi
echo "Benchmark complete. Report: $OUT_DIR/bench-report.json"
