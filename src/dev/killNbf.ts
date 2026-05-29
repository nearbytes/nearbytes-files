/**
 * Stop leftover nearbytes-files CLI listeners before starting the REPL.
 * Used by `yarn dev` / `nbf --dev-inspect` (via runRepl). Does not touch nbsync.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KillStaleNbfOptions {
  readonly repoRoot?: string;
  readonly webdavPort?: number;
  readonly devInspectPort?: number;
}

function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../..');
}

function pidsOnPort(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\s+/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function pidsByArgvNeedle(needle: string): number[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const space = trimmed.indexOf(' ');
      if (space < 0) continue;
      const pid = Number.parseInt(trimmed.slice(0, space), 10);
      const cmd = trimmed.slice(space + 1);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (cmd.includes(needle)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

function signalPids(pids: readonly number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @returns PIDs that were signalled (empty if nothing to kill). */
export function killStaleNbfProcesses(options: KillStaleNbfOptions = {}): number[] {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const webdavPort = options.webdavPort ?? Number.parseInt(process.env.NBF_WEBDAV_PORT ?? '9843', 10);
  const devInspectPort =
    options.devInspectPort ?? Number.parseInt(process.env.NBF_DEV_INSPECT_PORT ?? '9845', 10);

  const needles = [
    `${repoRoot}/dist/cli/index.js`,
    `${repoRoot}/scripts/webdav-serve.mjs`,
  ];
  const targets = [
    ...new Set([
      ...pidsOnPort(webdavPort),
      ...pidsOnPort(devInspectPort),
      ...needles.flatMap((n) => pidsByArgvNeedle(n)),
    ]),
  ].filter((pid) => pid !== process.pid);

  if (targets.length === 0) return [];

  console.error(`kill-nbf: stopping ${targets.length} process(es): ${targets.join(', ')}`);
  signalPids(targets, 'SIGTERM');
  sleepMs(400);

  const survivors = targets.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  if (survivors.length > 0) {
    console.error(`kill-nbf: SIGKILL ${survivors.join(', ')}`);
    signalPids(survivors, 'SIGKILL');
  }

  for (const port of [webdavPort, devInspectPort]) {
    const left = pidsOnPort(port);
    if (left.length > 0) {
      console.error(`kill-nbf: warning — port ${port} still held by pid ${left.join(', ')}`);
    }
  }

  return targets;
}
