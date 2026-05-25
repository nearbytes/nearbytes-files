#!/usr/bin/env bash
# Clone / pull / build every Nearbytes repo so that a plain
# `yarn install && yarn run repl` (or `yarn bench:*`) in any consumer
# repo Just Works.
#
# Internal deps use the `file:../<pkg>` protocol, which Yarn resolves to
# the sibling directory at install time. This script keeps that flat
# sibling layout in sync with each repo's `main` branch and builds every
# library's `dist/` so that consumers always link against fresh code.
#
# Idempotent: run it after every `git pull` (or instead of it).
#
# Usage:
#   ./update.sh
#   NEARBYTES_ROOT=/some/other/path ./update.sh
#
# Default root is the parent of this script (so the script is expected
# to live alongside the other nearbytes-* repos).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${NEARBYTES_ROOT:-$(cd "$script_dir/.." && pwd)}"

REPOS=(
  nearbytes-crypto
  nearbytes-log
  nearbytes-sync
  nearbytes-skeleton
  nearbytes-files
  nearbytes-benchmarks
)

# Build order respects the dep DAG: each repo here only imports from
# repos earlier in the list. nearbytes-benchmarks is a consumer; we
# install but don't `yarn build` it here because some of its scripts
# need optional runtime config.
BUILD_ORDER=(
  nearbytes-crypto
  nearbytes-log
  nearbytes-sync
  nearbytes-skeleton
  nearbytes-files
)

mkdir -p "$ROOT"
cd "$ROOT"

echo "== git: clone or fast-forward each repo against origin/main =="
for r in "${REPOS[@]}"; do
  if [ -d "$r/.git" ]; then
    sha_before=$(git -C "$r" rev-parse --short HEAD)
    git -C "$r" fetch --quiet origin main
    git -C "$r" checkout --quiet main
    git -C "$r" pull --ff-only --quiet
    sha_after=$(git -C "$r" rev-parse --short HEAD)
    if [ "$sha_before" = "$sha_after" ]; then
      printf "  %-26s %s (no change)\n" "$r" "$sha_after"
    else
      printf "  %-26s %s -> %s\n" "$r" "$sha_before" "$sha_after"
    fi
  else
    echo "  $r — cloning"
    git clone --quiet "https://github.com/nearbytes/$r.git"
  fi
done

echo
echo "== yarn install + yarn build (topological order) =="
# If the user has a stray ~/package.json + ~/yarn.lock (or any parent
# project above $ROOT), Yarn auto-discovers it and refuses to install
# in a child dir unless that child has its own lockfile to mark a fresh
# project boundary. Touch an empty yarn.lock in each repo to make every
# install hermetic regardless of the environment above $ROOT.
for r in "${BUILD_ORDER[@]}" nearbytes-benchmarks ; do
  [ -d "$ROOT/$r" ] || continue
  [ -f "$ROOT/$r/yarn.lock" ] || : > "$ROOT/$r/yarn.lock"
done

for r in "${BUILD_ORDER[@]}"; do
  echo "-- $r --"
  cd "$ROOT/$r"
  yarn install
  yarn build
done

# nearbytes-benchmarks: install only; build is optional and slow.
if [ -d "$ROOT/nearbytes-benchmarks" ]; then
  echo "-- nearbytes-benchmarks --"
  cd "$ROOT/nearbytes-benchmarks"
  yarn install
fi

echo
echo "Done."
