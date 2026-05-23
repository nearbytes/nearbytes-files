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
  console.log(`[sender] discovery wait ${warmupMs}ms…`);
  await sleep(warmupMs);

  await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

  const latency: LatencyResult[] = [];
  const trials: TrialManifestEntry[] = [];

  for (const sizeBytes of BENCH_PAYLOAD_SIZES) {
    for (let repeat = 0; repeat < BENCH_LATENCY_REPEATS; repeat++) {
      const name = `bench-lat-${sizeBytes}-${repeat}.bin`;
      const t0 = hrtimeMs();
      const data = makePayload(sizeBytes, repeat + sizeBytes);
      await ctx.fileService.addFile(BENCH_CREDENTIALS.volume, name, data);
      const publishCpuMs = hrtimeMs() - t0;
      const publishWallMs = Date.now();
      trials.push({ name, sizeBytes, repeat, publishWallMs, publishCpuMs });
      latency.push({ sizeBytes, repeat, name, publishWallMs, publishCpuMs });
      console.log(`[sender] published ${name} (${sizeBytes} B) cpu=${publishCpuMs.toFixed(1)}ms`);
      await sleep(Number(process.env['NEARBYTES_BENCH_INTER_TRIAL_MS'] ?? '3000'));
    }
  }

  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-latency-complete.txt',
    Buffer.from('latency phase complete\n'),
  );
  console.log('[sender] latency phase complete marker published');
  await sleep(5000);

  const tpCount = BENCH_THROUGHPUT_FILE_COUNT;
  const tpBytes = BENCH_THROUGHPUT_FILE_BYTES;
  const publishStartMs = hrtimeMs();
  for (let i = 0; i < tpCount; i++) {
    const name = `bench-tp-${tpBytes}-${i}.bin`;
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      name,
      makePayload(tpBytes, i * 997),
    );
  }
  const publishEndMs = hrtimeMs();
  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-throughput-complete.txt',
    Buffer.from('throughput phase complete\n'),
  );
  console.log(`[sender] throughput: ${tpCount}×${tpBytes} B in ${(publishEndMs - publishStartMs).toFixed(0)}ms`);

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
  console.log(`[receiver] discovery wait ${warmupMs}ms…`);
  await sleep(warmupMs);
  await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

  const receivedAt = new Map<string, { wallMs: number; cpuMs: number }>();
  const latency: LatencyResult[] = [];

  const deadline = Date.now() + Number(process.env['NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS'] ?? '600000');

  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!receivedAt.has(name)) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
      }
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

  console.log(
    `[receiver] latency files seen: ${latency.filter((l) => l.receiveWallMs !== undefined).length}/${expectedLatencyTrials}`,
  );

  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!receivedAt.has(name)) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
      }
    }
    if (receivedAt.has('bench-phase-throughput-complete.txt')) {
      break;
    }
    await sleep(250);
  }

  const tpNames = Array.from({ length: BENCH_THROUGHPUT_FILE_COUNT }, (_, i) =>
    `bench-tp-${BENCH_THROUGHPUT_FILE_BYTES}-${i}.bin`,
  );
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
    console.log(
      `[receiver] throughput goodput ≈ ${goodputMbps.toFixed(2)} Mb/s (${durationMs.toFixed(0)}ms for ${tpNames.length} files)`,
    );
  }

  return { latency, throughput };
}

async function main(): Promise<void> {
  const role = benchRoleFromEnv();
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const runStartMs = hrtimeMs();

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
    console.log(`[${role}] profile published in ${profilePublishMs.toFixed(1)}ms`);

    try {
      const peerMarker = await waitForBenchEvent(
        ctx.skeleton.log,
        'peer-connected',
        wallStart,
        Number(process.env['NEARBYTES_BENCH_SWARM_TIMEOUT_MS'] ?? '120000'),
      );
      swarmFormationMs = peerMarker.t - wallStart;
      console.log(`[${role}] swarm peer connected at +${swarmFormationMs}ms (${peerMarker.fields['transport']})`);
    } catch (err) {
      console.warn(`[${role}] swarm formation not observed: ${String(err)}`);
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
    console.log(`[${role}] grace ${graceMs}ms…`);
    await sleep(graceMs);

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
    console.log(`[${role}] wrote ${outPath} (run ${(hrtimeMs() - runStartMs).toFixed(0)}ms)`);

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
