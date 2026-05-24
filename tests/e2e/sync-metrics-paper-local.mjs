#!/usr/bin/env node
/**
 * Conference-grade local benchmark (paper profile): warmup, 10× latency sweep, 32 MiB stream.
 * Target wall time ~60–120s depending on machine.
 *
 *   yarn e2e:paper:local
 */

import { mkdir, rm, access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getBenchPaths, getRepoRoot } from './lib/config.mjs';
import { spawnBench, sleep } from './lib/spawn-bench.mjs';

const PHASE_WALL_SEC = 240;
const repoRoot = getRepoRoot();
const paths = await getBenchPaths();
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runBase = path.join(paths.e2eWorkDir, runId, 'paper');
const reportDir = path.join(paths.benchReportsDir, 'e2e-paper-local');

async function ensureBuilt() {
  try {
    await access(path.join(repoRoot, 'dist/scripts/sync-benchmark.js'));
  } catch {
    console.log('Building nearbytes-files…');
    await new Promise((res, rej) => {
      const b = spawn('yarn', ['build'], { cwd: repoRoot, stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exit ${c}`))));
    });
  }
}

function spawnWithWall(role, envExtra) {
  const { child, wait } = spawnBench(role, envExtra);
  const wall = setTimeout(() => {
    console.error(`[${role}] paper phase wall ${PHASE_WALL_SEC}s — SIGTERM`);
    child.kill('SIGTERM');
  }, PHASE_WALL_SEC * 1000);
  return {
    wait: async () => {
      try {
        return await wait();
      } finally {
        clearTimeout(wall);
      }
    },
  };
}

await ensureBuilt();
await rm(runBase, { recursive: true, force: true });
await mkdir(runBase, { recursive: true });

const common = {
  NEARBYTES_BENCH_BASE: runBase,
  NEARBYTES_BENCH_PROFILE: 'paper',
  NEARBYTES_BENCH_SKIP_FIGURES: '1',
  NEARBYTES_BENCH_DISCOVERY_MS: '3000',
  NEARBYTES_BENCH_GRACE_MS: '5000',
};

console.log(`\n═══ paper profile (workdir ${runBase}) — target ~60–120s ═══\n`);

const bob = spawnWithWall('bob', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'receiver',
  NEARBYTES_BENCH_OUT: path.join(runBase, 'bob/benchmark-result.json'),
});
await sleep(250);
const alice = spawnWithWall('alice', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'sender',
  NEARBYTES_BENCH_OUT: path.join(runBase, 'alice/benchmark-result.json'),
});

await Promise.all([bob.wait(), alice.wait()]);

await mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, 'bench-report.json');
await new Promise((res, rej) => {
  const m = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/merge-benchmark-results.mjs'),
      '--sender',
      path.join(runBase, 'alice/benchmark-result.json'),
      '--manifest',
      path.join(runBase, 'alice/trial-manifest.json'),
      '--receiver',
      path.join(runBase, 'bob/benchmark-result.json'),
      '--out',
      reportPath,
      '--topology',
      'localhost paper profile (alice sender, bob receiver)',
      '--quiet',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  m.on('exit', (c) => (c === 0 ? res() : rej(new Error(`merge exit ${c}`))));
});

const paperFigures = path.join(
  repoRoot,
  '..',
  '..',
  'NEARBYTES-PAPERS',
  'paper-nearbytes-hypercore',
  'figures',
);

await new Promise((res, rej) => {
  const r = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/render-benchmark-figures.mjs'),
      '--report',
      reportPath,
      '--outdir',
      paperFigures,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  r.on('exit', (c) => (c === 0 ? res() : rej(new Error(`figures exit ${c}`))));
});

const raw = await import('fs/promises').then((fs) => fs.readFile(reportPath, 'utf-8'));
const report = JSON.parse(raw);
console.log('\n── Paper profile summary ──');
for (const row of report.syncLatencyTable ?? report.latencyTable ?? []) {
  const ci =
    row.ci95Low != null && row.n > 1
      ? ` CI=[${Math.round(row.ci95Low)},${Math.round(row.ci95High)}]`
      : '';
  console.log(`  ${row.sizeLabel}: p50=${row.p50}ms p95=${row.p95}ms n=${row.n}${ci}`);
}
if (report.throughput?.receiverGoodputMbps != null) {
  console.log(
    `  Goodput: ${report.throughput.receiverGoodputMbps.toFixed(2)} Mb/s (${report.throughput.nominalBytes / (1024 * 1024)} MiB stream)`,
  );
}
console.log(`\nReport: ${reportPath}`);
console.log(`LaTeX:  ${paperFigures}\n`);
