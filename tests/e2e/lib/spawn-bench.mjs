import { spawn } from 'child_process';
import path from 'path';
import { getRepoRoot } from './config.mjs';

export function benchScriptPath() {
  return path.join(getRepoRoot(), 'dist/scripts/sync-benchmark.js');
}

export function spawnBench(role, envExtra = {}) {
  const root = getRepoRoot();
  const child = spawn(process.execPath, [benchScriptPath()], {
    cwd: root,
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => {
    const t = d.toString();
    out += t;
    for (const line of t.split('\n').filter(Boolean)) {
      console.log(`[${role}] ${line}`);
    }
  });
  child.stderr?.on('data', (d) => {
    const t = d.toString();
    for (const line of t.split('\n').filter(Boolean)) {
      console.error(`[${role}] ${line}`);
    }
  });
  return {
    child,
    wait: () =>
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`${role} exited ${code}`));
        });
      }),
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
