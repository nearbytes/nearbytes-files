#!/usr/bin/env bash
# Run bidirectional sync: this machine = alice, pc-ciancia = bob.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="${NEARBYTES_REMOTE_HOST:-pc-ciancia}"
REMOTE_DIR="${NEARBYTES_REMOTE_DIR:-~/nearbytes-sync-test}"
REPOS_BASE="${NEARBYTES_REPOS:-https://github.com/nearbytes}"

clone_deps() {
  local dir="$1"
  mkdir -p "$dir"
  for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
    if [[ ! -d "$dir/$repo/.git" ]]; then
      git clone --depth 1 "$REPOS_BASE/${repo}.git" "$dir/$repo"
    else
      git -C "$dir/$repo" pull --ff-only || true
    fi
  done
}

echo "==> Local build (alice)"
clone_deps "$ROOT/../.."
cd "$ROOT"
yarn install
yarn build

echo "==> Remote setup (bob) on $REMOTE_HOST"
ssh "$REMOTE_HOST" "bash -s" <<REMOTE
set -euo pipefail
REMOTE_DIR="${REMOTE_DIR}"
REPOS_BASE="${REPOS_BASE}"
mkdir -p "\$REMOTE_DIR"
cd "\$REMOTE_DIR"
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  if [[ ! -d "\$repo/.git" ]]; then
    git clone --depth 1 "\$REPOS_BASE/\${repo}.git" "\$repo"
  else
    git -C "\$repo" pull --ff-only || true
  fi
done
cd nearbytes-files
corepack enable 2>/dev/null || true
yarn install
yarn build
REMOTE

echo "==> Starting bob on $REMOTE_HOST (background)"
ssh "$REMOTE_HOST" "cd ${REMOTE_DIR}/nearbytes-files && NEARBYTES_TEST_ROLE=bob NEARBYTES_TEST_TIMEOUT_MS=240000 node dist/scripts/sync-bidirectional-test.js" &
BOB_PID=$!
sleep 8

echo "==> Starting alice (this machine)"
NEARBYTES_TEST_ROLE=alice NEARBYTES_TEST_TIMEOUT_MS=240000 \
  node "$ROOT/dist/scripts/sync-bidirectional-test.js"
ALICE_EXIT=$?

wait "$BOB_PID" || BOB_EXIT=$?
BOB_EXIT=${BOB_EXIT:-0}

if [[ "$BOB_EXIT" -ne 0 || "$ALICE_EXIT" -ne 0 ]]; then
  echo "Remote bidirectional test failed: alice=$ALICE_EXIT bob=$BOB_EXIT"
  exit 1
fi
echo "Remote bidirectional sync test passed."
