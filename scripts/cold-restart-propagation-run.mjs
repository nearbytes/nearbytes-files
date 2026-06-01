#!/usr/bin/env node
/**
 * Run cold-restart propagation scenarios (plain + stale fetch cursor).
 * Fails if any run exceeds NBF_COLD_TARGET_MS (default 3000).
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'cold-restart-propagation-probe.mjs');
const TARGET_MS = Number(process.env.NBF_COLD_TARGET_MS ?? 3_000);
const RUNS = Number(process.env.NBF_COLD_RUNS ?? 3);

function runProbe(envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE], {
      cwd: join(HERE, '..'),
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        resolve({ code, report: JSON.parse(line) });
      } catch {
        reject(new Error(`bad probe output: ${line.slice(0, 200)}`));
      }
    });
  });
}

const results = [];
for (let i = 0; i < RUNS; i += 1) {
  results.push(await runProbe());
}
results.push(await runProbe({ NBF_COLD_STALE_CURSOR: '1' }));

const summary = results.map((r) => r.report);
const failed = summary.filter((r) => !r.ok || r.localRestartToVisibleOnRemoteMs > TARGET_MS);
console.log(JSON.stringify({ ok: failed.length === 0, targetMs: TARGET_MS, runs: summary }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
