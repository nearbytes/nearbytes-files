#!/usr/bin/env bash
# Research benchmark: receiver on pc-ciancia, sender on this Mac.
# Line-buffered output + heartbeats on every long wait (never looks stuck).
set -euo pipefail

if [[ -z "${BENCH_NO_REEXEC:-}" ]] && command -v stdbuf >/dev/null 2>&1; then
  export BENCH_NO_REEXEC=1
  exec stdbuf -oL -eL bash "$0" "$@"
fi

export NODE_NO_WARNINGS=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="${NEARBYTES_REMOTE_HOST:-pc-ciancia}"
REPOS_BASE="${NEARBYTES_REPOS:-https://github.com/nearbytes}"
BENCH_BASE_LOCAL="${NEARBYTES_BENCH_BASE:-/tmp/nearbytes-sync-benchmark}"
BENCH_BASE_REMOTE="${NEARBYTES_BENCH_BASE_REMOTE:-/tmp/nearbytes-sync-benchmark}"
OUT_DIR="${NEARBYTES_BENCH_OUTDIR:-$ROOT/benchmark-output}"
TOTAL_STEPS=7
STEP=0
RUN_START=$SECONDS

progress() {
  STEP=$((STEP + 1))
  local elapsed=$((SECONDS - RUN_START))
  printf '\n[%02d:%02d] ═══ STEP %d/%d: %s ═══\n' "$((elapsed / 60))" "$((elapsed % 60))" "$STEP" "$TOTAL_STEPS" "$1"
}

heartbeat() {
  local elapsed=$((SECONDS - RUN_START))
  printf '[%02d:%02d] … %s\n' "$((elapsed / 60))" "$((elapsed % 60))" "$1"
}

countdown() {
  local secs=$1
  local label=$2
  local i
  for ((i = secs; i >= 1; i--)); do
    heartbeat "${label} — starting in ${i}s"
    sleep 1
  done
}

wait_pid_with_heartbeat() {
  local pid=$1
  local label=$2
  local t0=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    heartbeat "${label} — still running ($((SECONDS - t0))s elapsed)"
    sleep 5
  done
  wait "$pid"
}

run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "$@"; else corepack prepare yarn@4.5.1 --activate && yarn "$@"; fi
}

stream_lines() {
  local prefix=$1
  while IFS= read -r line; do
    printf '%s %s\n' "$prefix" "$line"
  done
}

progress "Kill stray benchmark processes"
pkill -f 'sync-benchmark|run-sync-benchmark' 2>/dev/null || true
ssh -o BatchMode=yes "$REMOTE_HOST" 'pkill -f sync-benchmark 2>/dev/null || true' 2>/dev/null || true

progress "Build sender (local nearbytes-files)"
cd "$ROOT"
heartbeat "yarn install (local)"
run_yarn install
heartbeat "yarn build (local)"
run_yarn build

progress "Pull + build receiver repos on ${REMOTE_HOST} (nearbytes-log must include 10df209)"
ssh "$REMOTE_HOST" "bash -s" 2>&1 | stream_lines '[remote-build]' <<REMOTE
set -euo pipefail
REPOS_BASE="${REPOS_BASE}"
BENCH_BASE="${BENCH_BASE_REMOTE}"
run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "\$@"; else export COREPACK_HOME="\$BENCH_BASE/.corepack"; mkdir -p "\$COREPACK_HOME"; corepack prepare yarn@4.5.1 --activate; corepack yarn "\$@"; fi
}
build_repo() {
  local dir="\$1"
  echo "START \$(basename "\$dir")"
  cd "\$dir"
  if [[ -f yarn.lock ]]; then run_yarn install && run_yarn build; else npm install --no-fund --no-audit && npm run build; fi
  echo "DONE \$(basename "\$dir")"
}
mkdir -p "\$BENCH_BASE/repos"
cd "\$BENCH_BASE/repos"
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  if [[ ! -d "\$repo/.git" ]]; then
    echo "CLONE \$repo"
    git clone --depth 1 "\$REPOS_BASE/\${repo}.git" "\$repo"
  else
    echo "PULL \$repo"
    git -C "\$repo" pull --ff-only
  fi
done
LOG_HEAD=\$(git -C nearbytes-log log -1 --oneline)
echo "nearbytes-log at: \$LOG_HEAD"
case "\$LOG_HEAD" in
  *10df209*) echo "OK reception-journal fix present" ;;
  *) echo "WARN: expected 10df209 on nearbytes-log — benchmark may fail" ;;
esac
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  build_repo "\$BENCH_BASE/repos/\$repo"
done
echo "ALL_BUILDS_DONE"
REMOTE

progress "Start receiver (bob) on ${REMOTE_HOST}"
ssh "$REMOTE_HOST" "cd ${BENCH_BASE_REMOTE}/repos/nearbytes-files && \
  NEARBYTES_BENCH_ROLE=receiver \
  NEARBYTES_BENCH_BASE=${BENCH_BASE_REMOTE} \
  NEARBYTES_BENCH_OUT=${BENCH_BASE_REMOTE}/bob/benchmark-result.json \
  NEARBYTES_BENCH_DISCOVERY_MS=18000 \
  NEARBYTES_BENCH_SWARM_TIMEOUT_MS=120000 \
  NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS=900000 \
  node dist/scripts/sync-benchmark.js" 2>&1 | stream_lines '[remote]' &
RECV_PID=$!
heartbeat "receiver PID ${RECV_PID}"
countdown 12 "sender start"

progress "Start sender (alice) on this machine"
set +e
NEARBYTES_BENCH_ROLE=sender \
NEARBYTES_BENCH_BASE="${BENCH_BASE_LOCAL}" \
NEARBYTES_BENCH_OUT="${BENCH_BASE_LOCAL}/alice/benchmark-result.json" \
NEARBYTES_BENCH_DISCOVERY_MS=18000 \
NEARBYTES_BENCH_SWARM_TIMEOUT_MS=120000 \
NEARBYTES_BENCH_INTER_TRIAL_MS=2500 \
NEARBYTES_BENCH_GRACE_MS=35000 \
  node "$ROOT/dist/scripts/sync-benchmark.js" 2>&1 | stream_lines '[local]'
SENDER_EXIT=$?
set -e

progress "Wait for receiver to finish"
if wait_pid_with_heartbeat "$RECV_PID" "receiver (bob)"; then RECV_EXIT=0; else RECV_EXIT=$?; fi

progress "Fetch receiver JSON + merge results"
mkdir -p "$OUT_DIR"
heartbeat "scp receiver-result.json"
scp "${REMOTE_HOST}:${BENCH_BASE_REMOTE}/bob/benchmark-result.json" "$OUT_DIR/receiver-result.json"

SENDER_JSON="${BENCH_BASE_LOCAL}/alice/benchmark-result.json"
MANIFEST_JSON="${BENCH_BASE_LOCAL}/alice/trial-manifest.json"
RECEIVER_JSON="$OUT_DIR/receiver-result.json"

heartbeat "merge results"
node "$ROOT/scripts/merge-benchmark-results.mjs" \
  --sender "$SENDER_JSON" \
  --manifest "$MANIFEST_JSON" \
  --receiver "$RECEIVER_JSON" \
  --out "$OUT_DIR/bench-report.json" | stream_lines '[merge]'

PAPER_FIG="${NEARBYTES_PAPER_FIGURES:-$ROOT/../../NEARBYTES-PAPERS/paper-nearbytes-hypercore/figures}"
heartbeat "render LaTeX figures"
node "$ROOT/scripts/render-benchmark-figures.mjs" \
  --report "$OUT_DIR/bench-report.json" \
  --outdir "$PAPER_FIG"

progress "Done"
if [[ "$SENDER_EXIT" -ne 0 || "$RECV_EXIT" -ne 0 ]]; then
  echo "FAILED: sender exit=$SENDER_EXIT receiver exit=$RECV_EXIT"
  exit 1
fi
echo "SUCCESS: report at $OUT_DIR/bench-report.json (total $((SECONDS - RUN_START))s)"
