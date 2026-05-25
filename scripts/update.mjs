#!/usr/bin/env node
// Clone / pull / build every Nearbytes repo so that a plain
// `yarn install && yarn run repl` (or `yarn bench:*`) in any consumer
// repo Just Works.
//
// Internal deps use the `file:../<pkg>` protocol, which Yarn resolves
// to the sibling directory at install time. This script keeps that
// flat sibling layout in sync with each repo's `main` branch and
// builds every library's `dist/` so consumers always link against
// fresh code.
//
// Idempotent: run after every `git pull` (or instead of it).
//
// Bootstrap (first time on a new machine):
//   git clone https://github.com/nearbytes/nearbytes-files.git
//   node nearbytes-files/scripts/update.mjs
//
// Thereafter:
//   yarn update
//
// Environment:
//   NEARBYTES_ROOT  parent dir holding the sibling repos
//                   (default: the parent of this script).
//
// Pure Node (>=18); no third-party deps; portable to macOS, Linux, and
// Windows.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env['NEARBYTES_ROOT']
  ? resolve(process.env['NEARBYTES_ROOT'])
  : resolve(__dirname, '..', '..');

const REPOS = [
  'nearbytes-crypto',
  'nearbytes-log',
  'nearbytes-sync',
  'nearbytes-skeleton',
  'nearbytes-files',
  'nearbytes-benchmarks',
];

// Build order respects the dep DAG: each repo here only imports from
// repos earlier in the list. nearbytes-benchmarks is a consumer; we
// install but don't `yarn build` it because some scripts need optional
// runtime config.
const BUILD_ORDER = [
  'nearbytes-crypto',
  'nearbytes-log',
  'nearbytes-sync',
  'nearbytes-skeleton',
  'nearbytes-files',
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: false,
    ...opts,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

console.log(`Nearbytes root: ${ROOT}`);
mkdirSync(ROOT, { recursive: true });

console.log('\n== git: clone or fast-forward each repo against origin/main ==');
for (const r of REPOS) {
  const dir = join(ROOT, r);
  if (isDir(join(dir, '.git'))) {
    const before = gitOut(dir, ['rev-parse', '--short', 'HEAD']);
    run('git', ['-C', dir, 'fetch', '--quiet', 'origin', 'main']);
    run('git', ['-C', dir, 'checkout', '--quiet', 'main']);
    run('git', ['-C', dir, 'pull', '--ff-only', '--quiet']);
    const after = gitOut(dir, ['rev-parse', '--short', 'HEAD']);
    const note = before === after ? `${after} (no change)` : `${before} -> ${after}`;
    console.log(`  ${r.padEnd(26)} ${note}`);
  } else {
    console.log(`  ${r} — cloning`);
    run('git', ['clone', '--quiet', `https://github.com/nearbytes/${r}.git`, dir]);
  }
}

// Touch an empty yarn.lock in each repo to mark a project boundary.
// Without this, Yarn auto-discovers any parent project (e.g. a stray
// ~/package.json + ~/yarn.lock) and refuses to install in the child.
for (const r of REPOS) {
  const dir = join(ROOT, r);
  const lock = join(dir, 'yarn.lock');
  if (isDir(dir) && !existsSync(lock)) writeFileSync(lock, '');
}

console.log('\n== yarn install + yarn build (topological order) ==');
// `yarn` resolves to `yarn.cmd` on Windows when invoked via npm-style
// shims; spawnSync handles that when shell:true. Use shell mode for
// the yarn invocations so PATHEXT applies on Windows.
function yarn(cwd, args) {
  const r = spawnSync('yarn', args, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const r of BUILD_ORDER) {
  console.log(`-- ${r} --`);
  const dir = join(ROOT, r);
  yarn(dir, ['install']);
  yarn(dir, ['build']);
}

if (isDir(join(ROOT, 'nearbytes-benchmarks'))) {
  console.log('-- nearbytes-benchmarks --');
  yarn(join(ROOT, 'nearbytes-benchmarks'), ['install']);
}

console.log('\nDone.');
