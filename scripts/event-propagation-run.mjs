#!/usr/bin/env node
/**
 * Fast propagation bench (both peers on this machine).
 *   yarn probe:event-propagation
 *
 * Fast by default: ~5s happy path, 20s hard wall (override via env).
 *
 * Env: NBF_PROP_PEER_TIMEOUT_MS, NBF_PROP_MEASURE_TIMEOUT_MS, NBF_PROP_WALL_MS,
 *      NBF_PROP_SETTLE_MS (ms after both peers ready, before `go`; default 0).
 */
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDebugOption } from '../dist/debug.js';

if (process.env.NEARBYTES_DEBUG) {
  applyDebugOption(process.env.NEARBYTES_DEBUG);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'event-propagation-probe.mjs');

const PEER_MS = Number(process.env.NBF_PROP_PEER_TIMEOUT_MS ?? 3_000);
const MEASURE_MS = Number(process.env.NBF_PROP_MEASURE_TIMEOUT_MS ?? 2_000);
const WALL_MS = Number(process.env.NBF_PROP_WALL_MS ?? 20_000);
const POLL_MS = 20;

function spawnRole(role, base, target) {
  const child = spawn(process.execPath, [PROBE], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      NEARBYTES_SYNC_DISCOVERY: process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns',
      NBF_PROP_ROLE: role,
      NBF_PROP_BASE: base,
      NBF_PROP_TARGET: target,
      NBF_PROP_KEEP: '1',
      NBF_PROP_NO_THROW: '1',
      NBF_PROP_PEER_TIMEOUT_MS: String(PEER_MS),
      NBF_PROP_MEASURE_TIMEOUT_MS: String(MEASURE_MS),
      NBF_PROP_POLL_MS: '25',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const t = line.trim();
    if (t) lines.push(t);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return {
    child,
    lines,
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
  };
}

async function waitPhase(lines, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of lines) {
      try {
        if (JSON.parse(line).phase === phase) return JSON.parse(line);
      } catch {
        /* skip */
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timeout phase=${phase} after ${timeoutMs}ms`);
}

/** Joiner `measured` or `timeout` (grace so joiner can finish its poll loop). */
async function waitJoinerResult(lines, timeoutMs) {
  const graceMs = 400;
  const deadline = Date.now() + timeoutMs + graceMs;
  while (Date.now() < deadline) {
    const hit = findResult(lines);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

function findResult(lines) {
  for (const line of lines) {
    try {
      const p = JSON.parse(line).phase;
      if (p === 'measured' || p === 'timeout') return JSON.parse(line);
    } catch {
      /* skip */
    }
  }
  return null;
}

const target = `prop-${Date.now()}.txt`;
const base = join(HERE, '..', '.local', 'prop-bench', String(Date.now()));
await rm(base, { recursive: true, force: true });
await mkdir(base, { recursive: true });

const tStart = Date.now();
const settleAfterPeerMs = Number(process.env.NBF_PROP_SETTLE_MS ?? 0);
const holder = spawnRole('holder', base, target);
const joiner = spawnRole('joiner', base, target);
const killBoth = () => {
  joiner.child.kill('SIGTERM');
  holder.child.kill('SIGTERM');
};
const wall = setTimeout(killBoth, WALL_MS);

try {
  await Promise.all([
    waitPhase(joiner.lines, 'ready', PEER_MS),
    waitPhase(holder.lines, 'ready', PEER_MS),
  ]);
  if (settleAfterPeerMs > 0) {
    await new Promise((r) => setTimeout(r, settleAfterPeerMs));
  }
  const go = { cmd: 'go', t0: Date.now() };
  joiner.send(go);
  holder.send(go);
  await waitPhase(holder.lines, 'published', MEASURE_MS);
  const measured =
    (await waitJoinerResult(joiner.lines, MEASURE_MS)) ?? {
      phase: 'timeout',
      blockMs: null,
      eventMs: null,
      listMs: null,
      eventBeforeListMs: null,
      blockBeforeEventMs: null,
      files: [],
    };

  const report = {
    ok: measured.phase === 'measured',
    wallMs: Date.now() - tStart,
    target,
    blockMs: measured.blockMs,
    eventMs: measured.eventMs,
    listMs: measured.listMs,
    eventBeforeListMs: measured.eventBeforeListMs,
    blockBeforeEventMs: measured.blockBeforeEventMs,
    timedOut: measured.phase === 'timeout',
    files: measured.files,
  };
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
} finally {
  clearTimeout(wall);
  killBoth();
  if (process.env.NBF_PROP_KEEP !== '1') {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
