/**
 * Research-grade friend-sync benchmark (Impl.~0: Hyperswarm + mDNS, global delta).
 *
 *   NEARBYTES_BENCH_ROLE=sender|receiver  node dist/scripts/sync-benchmark.js
 *
 * Writes JSON to NEARBYTES_BENCH_OUT or <workDir>/benchmark-result.json
 */

import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  BENCH_CREDENTIALS,
  BENCH_LATENCY_REPEATS,
  BENCH_PAYLOAD_SIZES,
  BENCH_THROUGHPUT_FILE_BYTES,
  BENCH_THROUGHPUT_FILE_COUNT,
} from './benchmark-credentials.js';
import {
  benchRoleFromEnv,
  benchWorkDir,
  createBenchContext,
  hrtimeMs,
  listBenchFilenames,
  makePayload,
  publishProfile,
  readActivityRaw,
  readBenchMarkers,
  readReceptionTail,
  setupBenchConfig,
  sleep,
  sleepWithProgress,
  benchProgress,
  resetProgressClock,
  waitForBenchEvent,
  type BenchMarker,
  type TrialManifestEntry,
} from './benchmark-lib.js';
import { openAndWatch } from '../cli/context.js';

interface LatencyResult {
  readonly sizeBytes: number;
  readonly repeat: number;
  readonly name: string;
  readonly publishWallMs?: number;
  readonly publishCpuMs?: number;
  readonly receiveWallMs?: number;
  readonly receiveCpuMs?: number;
}

interface BenchmarkResult {
  readonly meta: {
    readonly role: string;
    readonly hostname: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly impl: 'nearbytes-sync-v0-hyperswarm-mdns';
  };
  readonly warmup: {
    readonly discoveryWaitMs: number;
    readonly swarmFormationMs: number | null;
    readonly profilePublishMs: number;
    readonly profileEventHash: string;
    readonly profilePublicKey: string;
  };
  readonly latency: readonly LatencyResult[];
  readonly throughput: {
    readonly fileCount: number;
    readonly fileBytes: number;
    readonly publishStartMs: number;
    readonly publishEndMs: number;
    readonly receiveCompleteMs?: number;
    readonly goodputMbps?: number;
  } | null;
  readonly markers: readonly BenchMarker[];
  readonly receptionTail: readonly string[];
  readonly activityLog: readonly string[];
}

async function runSender(ctx: Awaited<ReturnType<typeof createBenchContext>>): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
  trials: TrialManifestEntry[];
}> {
  const warmupMs = Number(process.env['NEARBYTES_BENCH_DISCOVERY_MS'] ?? '15000');
  await sleepWithProgress('sender', 'phase 2/4 — discovery / swarm warmup', warmupMs);

  await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

  const latency: LatencyResult[] = [];
  const trials: TrialManifestEntry[] = [];
  const totalTrials = BENCH_PAYLOAD_SIZES.length * BENCH_LATENCY_REPEATS;
  let trialIdx = 0;

  benchProgress('sender', `phase 3/4 — latency sweep (${totalTrials} payloads)`);
  for (const sizeBytes of BENCH_PAYLOAD_SIZES) {
    for (let repeat = 0; repeat < BENCH_LATENCY_REPEATS; repeat++) {
      trialIdx++;
      const name = `bench-lat-${sizeBytes}-${repeat}.bin`;
      const t0 = hrtimeMs();
      const data = makePayload(sizeBytes, repeat + sizeBytes);
      await ctx.fileService.addFile(BENCH_CREDENTIALS.volume, name, data);
      const publishCpuMs = hrtimeMs() - t0;
      const publishWallMs = Date.now();
      trials.push({ name, sizeBytes, repeat, publishWallMs, publishCpuMs });
      latency.push({ sizeBytes, repeat, name, publishWallMs, publishCpuMs });
      benchProgress(
        'sender',
        `latency ${trialIdx}/${totalTrials}: ${name} (${sizeBytes} B, cpu ${publishCpuMs.toFixed(1)}ms)`,
      );
      await sleepWithProgress(
        'sender',
        `inter-trial pause before ${trialIdx + 1}/${totalTrials}`,
        Number(process.env['NEARBYTES_BENCH_INTER_TRIAL_MS'] ?? '2500'),
        1000,
      );
    }
  }

  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-latency-complete.txt',
    Buffer.from('latency phase complete\n'),
  );
  benchProgress('sender', 'latency phase complete');
  await sleepWithProgress('sender', 'pause before throughput phase', 5000, 1000);

  const tpCount = BENCH_THROUGHPUT_FILE_COUNT;
  const tpBytes = BENCH_THROUGHPUT_FILE_BYTES;
  benchProgress('sender', `phase 4/4 — throughput ${tpCount}×${tpBytes} B`);
  const publishStartMs = hrtimeMs();
  for (let i = 0; i < tpCount; i++) {
    const name = `bench-tp-${tpBytes}-${i}.bin`;
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      name,
      makePayload(tpBytes, i * 997),
    );
    benchProgress('sender', `throughput file ${i + 1}/${tpCount}: ${name}`);
  }
  const publishEndMs = hrtimeMs();
  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-throughput-complete.txt',
    Buffer.from('throughput phase complete\n'),
  );
  benchProgress(
    'sender',
    `throughput published ${tpCount}×${tpBytes} B in ${(publishEndMs - publishStartMs).toFixed(0)}ms`,
  );

  return {
    latency,
    throughput: {
      fileCount: tpCount,
      fileBytes: tpBytes,
      publishStartMs,
      publishEndMs,
    },
    trials,
  };
}

async function runReceiver(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  expectedLatencyTrials: number,
): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
}> {
  const warmupMs = Number(process.env['NEARBYTES_BENCH_DISCOVERY_MS'] ?? '15000');
  await sleepWithProgress('receiver', 'phase 2/4 — discovery / swarm warmup', warmupMs);
  await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

  const receivedAt = new Map<string, { wallMs: number; cpuMs: number }>();
  const latency: LatencyResult[] = [];

  const deadline = Date.now() + Number(process.env['NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS'] ?? '600000');
  benchProgress('receiver', `phase 3/4 — waiting for ${expectedLatencyTrials} latency payloads…`);

  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!receivedAt.has(name)) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
      }
    }
    if (Date.now() - lastBeat >= 5000) {
      const leftSec = Math.ceil((deadline - Date.now()) / 1000);
      benchProgress(
        'receiver',
        `latency wait… ${receivedAt.size} artifacts, ${leftSec}s left`,
      );
      lastBeat = Date.now();
    }
    if (receivedAt.has('bench-phase-latency-complete.txt')) {
      break;
    }
    await sleep(250);
  }

  for (const sizeBytes of BENCH_PAYLOAD_SIZES) {
    for (let repeat = 0; repeat < BENCH_LATENCY_REPEATS; repeat++) {
      const name = `bench-lat-${sizeBytes}-${repeat}.bin`;
      const recv = receivedAt.get(name);
      latency.push({
        sizeBytes,
        repeat,
        name,
        receiveWallMs: recv?.wallMs,
        receiveCpuMs: recv?.cpuMs,
      });
    }
  }

  const latSeen = latency.filter((l) => l.receiveWallMs !== undefined).length;
  benchProgress('receiver', `latency complete: ${latSeen}/${expectedLatencyTrials} files seen`);

  const tpNames = Array.from({ length: BENCH_THROUGHPUT_FILE_COUNT }, (_, i) =>
    `bench-tp-${BENCH_THROUGHPUT_FILE_BYTES}-${i}.bin`,
  );
  benchProgress('receiver', 'phase 4/4 — waiting for throughput batch…');
  lastBeat = Date.now();
  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!receivedAt.has(name)) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
        if (name.startsWith('bench-tp-')) {
          benchProgress('receiver', `saw ${name}`);
        }
      }
    }
    if (Date.now() - lastBeat >= 5000) {
      const tpSeen = tpNames.filter((n) => receivedAt.has(n)).length;
      benchProgress('receiver', `throughput wait… ${tpSeen}/${BENCH_THROUGHPUT_FILE_COUNT} files`);
      lastBeat = Date.now();
    }
    if (receivedAt.has('bench-phase-throughput-complete.txt')) {
      break;
    }
    await sleep(250);
  }

  const firstTp = tpNames.map((n) => receivedAt.get(n)).find((t) => t !== undefined);
  const lastTp = [...tpNames].reverse().map((n) => receivedAt.get(n)).find((t) => t !== undefined);

  let throughput: BenchmarkResult['throughput'] = null;
  if (firstTp !== undefined && lastTp !== undefined) {
    const totalBytes = BENCH_THROUGHPUT_FILE_BYTES * BENCH_THROUGHPUT_FILE_COUNT;
    const durationMs = lastTp.wallMs - firstTp.wallMs;
    const goodputMbps = durationMs > 0 ? (totalBytes * 8) / (durationMs * 1000) : 0;
    throughput = {
      fileCount: BENCH_THROUGHPUT_FILE_COUNT,
      fileBytes: BENCH_THROUGHPUT_FILE_BYTES,
      publishStartMs: 0,
      publishEndMs: 0,
      receiveCompleteMs: lastTp.cpuMs,
      goodputMbps,
    };
    benchProgress(
      'receiver',
      `throughput goodput ≈ ${goodputMbps.toFixed(2)} Mb/s (${durationMs.toFixed(0)}ms span)`,
    );
  }

  return { latency, throughput };
}

async function main(): Promise<void> {
  const role = benchRoleFromEnv();
  const roleLabel = role === 'sender' ? 'sender' : 'receiver';
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const runStartMs = hrtimeMs();
  resetProgressClock();
  benchProgress(roleLabel, 'phase 1/4 — setup config and start sync');

  const { config } = await setupBenchConfig(role);
  const ctx = await createBenchContext(config);

  let swarmFormationMs: number | null = null;
  let profilePublishMs = 0;
  let profileEventHash = '';
  let profilePublicKey = '';

  try {
    const displayName =
      role === 'sender' ? BENCH_CREDENTIALS.displayAlice : BENCH_CREDENTIALS.displayBob;
    const bio =
      role === 'sender'
        ? 'NearBytes benchmark sender (profile channel)'
        : 'NearBytes benchmark receiver (profile channel)';

    const profile = await publishProfile(ctx, displayName, bio);
    profilePublishMs = profile.publishMs;
    profileEventHash = profile.eventHash;
    profilePublicKey = profile.publicKey;
    benchProgress(roleLabel, `profile published (${profilePublishMs.toFixed(1)}ms cpu)`);

    try {
      const peerMarker = await waitForBenchEvent(
        ctx.skeleton.log,
        'peer-connected',
        wallStart,
        Number(process.env['NEARBYTES_BENCH_SWARM_TIMEOUT_MS'] ?? '120000'),
      );
      swarmFormationMs = peerMarker.t - wallStart;
      benchProgress(
        roleLabel,
        `swarm connected +${swarmFormationMs}ms (transport=${peerMarker.fields['transport']})`,
      );
    } catch (err) {
      benchProgress(roleLabel, `swarm not observed: ${String(err)}`);
    }

    const discoveryWaitMs = Number(process.env['NEARBYTES_BENCH_DISCOVERY_MS'] ?? '15000');

    const expectedLatency = BENCH_PAYLOAD_SIZES.length * BENCH_LATENCY_REPEATS;
    const senderLatency =
      role === 'sender' ? await runSender(ctx) : { latency: [], throughput: null, trials: [] };
    const receiverLatency =
      role === 'receiver'
        ? await runReceiver(ctx, expectedLatency)
        : { latency: [], throughput: null };

    const graceMs = Number(process.env['NEARBYTES_BENCH_GRACE_MS'] ?? '30000');
    await sleepWithProgress(roleLabel, 'grace hold for peer pull before teardown', graceMs, 5000);

    const markers = await readBenchMarkers(ctx.skeleton.log);
    const receptionTail = await readReceptionTail(config.dataDir, 50);
    const activityLog = await readActivityRaw(config.dataDir);

    const result: BenchmarkResult = {
      meta: {
        role,
        hostname: os.hostname(),
        startedAt,
        finishedAt: new Date().toISOString(),
        impl: 'nearbytes-sync-v0-hyperswarm-mdns',
      },
      warmup: {
        discoveryWaitMs,
        swarmFormationMs,
        profilePublishMs,
        profileEventHash,
        profilePublicKey,
      },
      latency: role === 'sender' ? senderLatency.latency : receiverLatency.latency,
      throughput:
        role === 'sender' ? senderLatency.throughput : receiverLatency.throughput,
      markers,
      receptionTail,
      activityLog,
    };

    const outPath =
      process.env['NEARBYTES_BENCH_OUT'] ??
      path.join(benchWorkDir(role), 'benchmark-result.json');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
    benchProgress(roleLabel, `done — wrote ${outPath} (total ${(hrtimeMs() - runStartMs).toFixed(0)}ms cpu)`);

    if (role === 'sender' && senderLatency.trials.length > 0) {
      const trialPath = path.join(benchWorkDir(role), 'trial-manifest.json');
      await writeFile(trialPath, JSON.stringify(senderLatency.trials, null, 2));
    }
  } finally {
    try {
      await ctx.destroy();
    } catch {
      /* ignore teardown resets */
    }
  }
}

process.on('uncaughtException', (err) => {
  if (String(err).includes('ECONNRESET') || String(err).includes('connection reset')) return;
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (String(err).includes('ECONNRESET') || String(err).includes('connection reset')) return;
  console.error(err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
