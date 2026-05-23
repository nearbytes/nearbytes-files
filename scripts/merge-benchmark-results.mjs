#!/usr/bin/env node
/**
 * Merge sender + receiver benchmark JSON into a research report (stdout + JSON file).
 *
 * Usage:
 *   node scripts/merge-benchmark-results.mjs \
 *     --sender /path/alice/benchmark-result.json \
 *     --manifest /path/alice/trial-manifest.json \
 *     --receiver /path/bob/benchmark-result.json \
 *     --out bench-report.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: v[0],
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v[v.length - 1],
    mean: sum / v.length,
  };
}

async function loadJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'));
}

const senderPath = arg('--sender', '');
const manifestPath = arg('--manifest', '');
const receiverPath = arg('--receiver', '');
const outPath = arg('--out', 'bench-report.json');

if (!senderPath || !receiverPath) {
  console.error('Need --sender and --receiver benchmark-result.json paths');
  process.exit(1);
}

const sender = await loadJson(senderPath);
const receiver = await loadJson(receiverPath);
const manifest = manifestPath ? await loadJson(manifestPath) : [];

const recvByName = new Map();
for (const row of receiver.latency ?? []) {
  if (row.receiveWallMs !== undefined) {
    recvByName.set(row.name, row.receiveWallMs);
  }
}

const mergedTrials = [];
for (const trial of manifest) {
  const receiveWallMs = recvByName.get(trial.name);
  const oneWayMs =
    receiveWallMs !== undefined ? receiveWallMs - trial.publishWallMs : null;
  mergedTrials.push({
    ...trial,
    receiveWallMs,
    oneWayLatencyMs: oneWayMs,
  });
}

const bySize = new Map();
for (const t of mergedTrials) {
  if (!bySize.has(t.sizeBytes)) bySize.set(t.sizeBytes, []);
  if (t.oneWayLatencyMs !== null && t.oneWayLatencyMs >= 0) {
    bySize.get(t.sizeBytes).push(t.oneWayLatencyMs);
  }
}

const latencyTable = [...bySize.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([sizeBytes, values]) => ({
    sizeBytes,
    sizeLabel: sizeBytes >= 1024 * 1024 ? `${sizeBytes / (1024 * 1024)} MiB` : `${sizeBytes / 1024} KiB`,
    ...stats(values),
  }));

const clockOffsetMs =
  sender.warmup?.swarmFormationMs !== null &&
  receiver.warmup?.swarmFormationMs !== null
    ? receiver.warmup.swarmFormationMs - sender.warmup.swarmFormationMs
    : null;

const report = {
  generatedAt: new Date().toISOString(),
  topology: 'mac-alice to pc-ciancia-bob',
  impl: sender.meta?.impl,
  swarmFormation: {
    senderMs: sender.warmup?.swarmFormationMs ?? null,
    receiverMs: receiver.warmup?.swarmFormationMs ?? null,
    clockOffsetEstimateMs: clockOffsetMs,
  },
  profilePublishCpuMs: {
    sender: sender.warmup?.profilePublishMs,
    receiver: receiver.warmup?.profilePublishMs,
  },
  latencyTable,
  mergedTrials,
  throughput: {
    senderPublishMs:
      sender.throughput?.publishEndMs && sender.throughput?.publishStartMs
        ? sender.throughput.publishEndMs - sender.throughput.publishStartMs
        : null,
    receiverGoodputMbps: receiver.throughput?.goodputMbps ?? null,
  },
  senderMarkers: sender.markers?.filter((m) => m.event?.includes('peer') || m.event?.includes('inbound')) ?? [],
  receiverMarkers: receiver.markers?.filter((m) => m.event?.includes('peer') || m.event?.includes('inbound')) ?? [],
  senderReceptionTail: sender.receptionTail ?? [],
  receiverReceptionTail: receiver.receptionTail ?? [],
  senderActivity: sender.activityLog ?? [],
  receiverActivity: receiver.activityLog ?? [],
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
