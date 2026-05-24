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
import { BENCH_CREDENTIALS } from './benchmark-credentials.js';
import { getBenchProfile, type BenchProfile } from './benchmark-config.js';
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
    readonly quick: boolean;
    readonly mode: string;
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
    readonly mode: 'batch' | 'stream' | 'none';
    readonly fileCount: number;
    readonly fileBytes: number;
    readonly publishStartWallMs?: number;
    readonly publishEndWallMs?: number;
    readonly publishStartMs: number;
    readonly publishEndMs: number;
    readonly receiveCompleteMs?: number;
    readonly goodputMbps?: number;
    readonly inboundDurationMs?: number;
    readonly bytesReceived?: number;
  } | null;
  readonly markers: readonly BenchMarker[];
  readonly receptionTail: readonly string[];
  readonly activityLog: readonly string[];
  readonly phases: {
    readonly bootMs: number;
    readonly profilePublishMs: number;
    readonly discoveryWaitMs: number;
    readonly friendSessionMs: number | null;
    readonly publishMs: number | null;
    readonly receiveMs: number | null;
    readonly graceMs: number;
    readonly totalWallMs: number;
  };
}

async function runLatencyWarmup(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
): Promise<void> {
  if (profile.latencyWarmupRepeats <= 0) return;
  const sizeBytes = profile.payloadSizes[0] ?? 4096;
  benchProgress(
    'sender',
    `latency warmup (${profile.latencyWarmupRepeats}×${sizeBytes} B, discarded)`,
  );
  for (let repeat = 0; repeat < profile.latencyWarmupRepeats; repeat++) {
    const name = `bench-lat-warm-${sizeBytes}-${repeat}.bin`;
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      name,
      makePayload(sizeBytes, repeat + 0x7a),
    );
    if (profile.interTrialMs > 0) {
      await sleep(profile.interTrialMs);
    }
  }
}

async function runSender(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
  trials: TrialManifestEntry[];
}> {
  const latency: LatencyResult[] = [];
  const trials: TrialManifestEntry[] = [];
  const totalTrials = profile.payloadSizes.length * profile.latencyRepeats;
  let trialIdx = 0;

  await runLatencyWarmup(ctx, profile);

  benchProgress('sender', `phase 3/4 — latency sweep (${totalTrials} payloads)`);
  for (const sizeBytes of profile.payloadSizes) {
    for (let repeat = 0; repeat < profile.latencyRepeats; repeat++) {
      trialIdx++;
      const name = `bench-lat-${sizeBytes}-${repeat}.bin`;
      const t0 = hrtimeMs();
      const publishWallMs = Date.now();
      const data = makePayload(sizeBytes, repeat + sizeBytes);
      await ctx.fileService.addFile(BENCH_CREDENTIALS.volume, name, data);
      const publishCpuMs = hrtimeMs() - t0;
      await ctx.skeleton.log.sync.appendMarker(
        `bench ${JSON.stringify({ bench: 'file-published', name, sizeBytes, t: publishWallMs })}`,
      );
      trials.push({ name, sizeBytes, repeat, publishWallMs, publishCpuMs });
      latency.push({ sizeBytes, repeat, name, publishWallMs, publishCpuMs });
      benchProgress(
        'sender',
        `latency ${trialIdx}/${totalTrials}: ${name} (${sizeBytes} B, cpu ${publishCpuMs.toFixed(1)}ms)`,
      );
      if (profile.interTrialMs > 0) {
        await sleepWithProgress(
          'sender',
          `inter-trial pause before ${trialIdx + 1}/${totalTrials}`,
          profile.interTrialMs,
          Math.min(1000, profile.interTrialMs),
        );
      }
    }
  }

  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-latency-complete.txt',
    Buffer.from('latency phase complete\n'),
  );
  benchProgress('sender', 'latency phase complete');

  if (profile.throughputMode === 'none') {
    return { latency, throughput: null, trials };
  }

  const preTpPause = profile.quick ? 500 : profile.mode === 'paper' ? 1000 : 5000;
  await sleepWithProgress('sender', 'pause before throughput phase', preTpPause, 500);

  if (profile.throughputMode === 'stream') {
    const streamBytes = profile.throughputStreamBytes;
    benchProgress('sender', `phase 4/4 — sustained stream ${streamBytes} B`);
    const phaseStartWall = Date.now();
    await ctx.skeleton.log.sync.appendMarker(
      `bench ${JSON.stringify({ bench: 'throughput-phase-start', bytes: streamBytes, t: phaseStartWall })}`,
    );
    const publishStartMs = hrtimeMs();
    const publishStartWallMs = Date.now();
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      'bench-tp-stream.bin',
      makePayload(streamBytes, 0x5154),
    );
    const publishEndWallMs = Date.now();
    const publishEndMs = hrtimeMs();
    await ctx.skeleton.log.sync.appendMarker(
      `bench ${JSON.stringify({ bench: 'throughput-phase-end', bytes: streamBytes, t: publishEndWallMs })}`,
    );
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      'bench-phase-throughput-complete.txt',
      Buffer.from('throughput phase complete\n'),
    );
    benchProgress(
      'sender',
      `stream published ${streamBytes} B in ${(publishEndMs - publishStartMs).toFixed(0)}ms cpu`,
    );
    return {
      latency,
      throughput: {
        mode: 'stream',
        fileCount: 1,
        fileBytes: streamBytes,
        publishStartWallMs,
        publishEndWallMs,
        publishStartMs,
        publishEndMs,
      },
      trials,
    };
  }

  const tpCount = profile.throughputFileCount;
  const tpBytes = profile.throughputFileBytes;
  benchProgress('sender', `phase 4/4 — throughput batch ${tpCount}×${tpBytes} B`);
  const publishStartWallMs = Date.now();
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'throughput-phase-start', bytes: tpBytes * tpCount, t: publishStartWallMs })}`,
  );
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
  const publishEndWallMs = Date.now();
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'throughput-phase-end', bytes: tpBytes * tpCount, t: publishEndWallMs })}`,
  );
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
      mode: 'batch',
      fileCount: tpCount,
      fileBytes: tpBytes,
      publishStartWallMs,
      publishEndWallMs,
      publishStartMs,
      publishEndMs,
    },
    trials,
  };
}

async function runReceiver(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
  expectedLatencyTrials: number,
): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
}> {
  const receivedAt = new Map<string, { wallMs: number; cpuMs: number }>();
  const latency: LatencyResult[] = [];

  const deadline = Date.now() + profile.receiveTimeoutMs;
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
    if (Date.now() - lastBeat >= 2000) {
      const leftSec = Math.ceil((deadline - Date.now()) / 1000);
      benchProgress(
        'receiver',
        `latency wait… ${receivedAt.size} artifacts, ${leftSec}s left`,
      );
      lastBeat = Date.now();
    }
    const latencyNames = profile.payloadSizes.flatMap((sizeBytes) =>
      Array.from({ length: profile.latencyRepeats }, (_, repeat) =>
        `bench-lat-${sizeBytes}-${repeat}.bin`,
      ),
    );
    const allLatencySeen = latencyNames.every((n) => receivedAt.has(n));
    if (
      receivedAt.has('bench-phase-latency-complete.txt') ||
      (profile.latencyOnly && allLatencySeen)
    ) {
      break;
    }
    await sleep(profile.receiverPollMs);
  }

  for (const sizeBytes of profile.payloadSizes) {
    for (let repeat = 0; repeat < profile.latencyRepeats; repeat++) {
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

  if (profile.throughputMode === 'none') {
    return { latency, throughput: null };
  }

  const streamBytes = profile.throughputStreamBytes;
  const tpNames =
    profile.throughputMode === 'stream'
      ? ['bench-tp-stream.bin']
      : Array.from({ length: profile.throughputFileCount }, (_, i) =>
          `bench-tp-${profile.throughputFileBytes}-${i}.bin`,
        );

  benchProgress(
    'receiver',
    profile.throughputMode === 'stream'
      ? `phase 4/4 — waiting for ${streamBytes} B stream…`
      : 'phase 4/4 — waiting for throughput batch…',
  );
  lastBeat = Date.now();
  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!receivedAt.has(name)) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
        if (name.startsWith('bench-tp')) {
          benchProgress('receiver', `saw ${name}`);
        }
      }
    }
    if (Date.now() - lastBeat >= 5000) {
      const tpSeen = tpNames.filter((n) => receivedAt.has(n)).length;
      benchProgress('receiver', `throughput wait… ${tpSeen}/${tpNames.length} files`);
      lastBeat = Date.now();
    }
    if (receivedAt.has('bench-phase-throughput-complete.txt')) {
      break;
    }
    await sleep(profile.receiverPollMs);
  }

  const nominalBytes =
    profile.throughputMode === 'stream'
      ? streamBytes
      : profile.throughputFileBytes * profile.throughputFileCount;

  let throughput: BenchmarkResult['throughput'] = null;
  if (tpNames.every((n) => receivedAt.has(n))) {
    throughput = {
      mode: profile.throughputMode,
      fileCount: profile.throughputMode === 'stream' ? 1 : profile.throughputFileCount,
      fileBytes:
        profile.throughputMode === 'stream' ? streamBytes : profile.throughputFileBytes,
      publishStartMs: 0,
      publishEndMs: 0,
    };
    benchProgress('receiver', `throughput files complete (${nominalBytes} B nominal); goodput at merge`);
  }

  return { latency, throughput };
}

async function main(): Promise<void> {
  const profile = getBenchProfile();
  const role = benchRoleFromEnv();
  const roleLabel = role === 'sender' ? 'sender' : 'receiver';
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const runStartMs = hrtimeMs();
  resetProgressClock();
  benchProgress(
    roleLabel,
    profile.mode === 'paper'
      ? `phase 1/4 — setup (PAPER: ${profile.latencyRepeats}×${profile.payloadSizes.length} sizes, ${profile.throughputStreamBytes} B stream)`
      : profile.latencyOnly
        ? `phase 1/4 — setup (LATENCY-ONLY, ${profile.payloadSizes.length} payloads, no throughput)`
        : profile.quick
          ? 'phase 1/4 — setup (QUICK profile, target ≤30s)'
          : 'phase 1/4 — setup config and start sync',
  );

  const { config } = await setupBenchConfig(role);
  const bootEnd = Date.now();
  const ctx = await createBenchContext(config);
  const bootMs = bootEnd - wallStart;

  let swarmFormationMs: number | null = null;
  let publishPhaseMs: number | null = null;
  let receivePhaseMs: number | null = null;
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

    const published = await publishProfile(ctx, displayName, bio);
    profilePublishMs = published.publishMs;
    profileEventHash = published.eventHash;
    profilePublicKey = published.publicKey;
    benchProgress(roleLabel, `profile published (${profilePublishMs.toFixed(1)}ms cpu)`);

    benchProgress(roleLabel, 'phase 2/4 — discovery / swarm warmup');
    await sleepWithProgress(
      roleLabel,
      'discovery / swarm warmup',
      profile.discoveryMs,
    );
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

    try {
      const peerMarker = await waitForBenchEvent(
        ctx.skeleton.log,
        'friend-session-attached',
        wallStart,
        profile.swarmTimeoutMs,
      );
      swarmFormationMs = peerMarker.t - wallStart;
      benchProgress(
        roleLabel,
        `swarm connected +${swarmFormationMs}ms (transport=${peerMarker.fields['transport']})`,
      );
    } catch (err) {
      benchProgress(roleLabel, `swarm not observed: ${String(err)}`);
    }

    const expectedLatency = profile.payloadSizes.length * profile.latencyRepeats;
    const transferStart = Date.now();
    const senderLatency =
      role === 'sender'
        ? await runSender(ctx, profile)
        : { latency: [], throughput: null, trials: [] };
    const receiverLatency =
      role === 'receiver'
        ? await runReceiver(ctx, profile, expectedLatency)
        : { latency: [], throughput: null };
    const transferEnd = Date.now();
    if (role === 'sender') {
      publishPhaseMs = transferEnd - transferStart;
    } else {
      receivePhaseMs = transferEnd - transferStart;
    }

    await sleepWithProgress(
      roleLabel,
      'grace hold for peer pull before teardown',
      profile.graceMs,
      profile.quick ? 1000 : 5000,
    );

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
        quick: profile.quick,
        mode: profile.mode,
      },
      warmup: {
        discoveryWaitMs: profile.discoveryMs,
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
      phases: {
        bootMs,
        profilePublishMs,
        discoveryWaitMs: profile.discoveryMs,
        friendSessionMs: swarmFormationMs,
        publishMs: role === 'sender' ? publishPhaseMs : null,
        receiveMs: role === 'receiver' ? receivePhaseMs : null,
        graceMs: profile.graceMs,
        totalWallMs: Date.now() - wallStart,
      },
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

    void ctx.destroy().catch(() => {});
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
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
