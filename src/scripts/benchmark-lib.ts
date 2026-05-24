import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCryptoOperations, createSecret, bytesToHex, EventType } from 'nearbytes-crypto';
import type { AppRecordPayload } from 'nearbytes-crypto';
import { createSignedEvent, type Log } from 'nearbytes-log';
import { writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import {
  createIdentityRecord,
  serializeIdentityRecord,
  verifyIdentityRecord,
} from '../chatCodec.js';
import { createContext, openAndWatch, type Context } from '../cli/context.js';
import { BENCH_CREDENTIALS } from './benchmark-credentials.js';

export type BenchRole = 'sender' | 'receiver';

export interface BenchMarker {
  readonly event: string;
  readonly t: number;
  readonly fields: Record<string, string | number | boolean>;
}

/** Wall-clock phases for paper tables (per process). */
export interface RunPhaseTiming {
  readonly bootMs: number;
  readonly profilePublishMs: number;
  readonly discoveryWaitMs: number;
  readonly friendSessionMs: number | null;
  readonly publishMs: number | null;
  readonly receiveMs: number | null;
  readonly graceMs: number;
  readonly totalWallMs: number;
}

export function markerOffsetMs(
  markers: readonly BenchMarker[],
  event: string,
  sinceMs: number,
): number | null {
  const hit = markers.find((m) => m.event === event && m.t >= sinceMs);
  return hit !== undefined ? hit.t - sinceMs : null;
}

export interface TrialManifestEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly repeat: number;
  readonly publishWallMs: number;
  readonly publishCpuMs: number;
}

export function benchRoleFromEnv(): BenchRole {
  const raw = process.env['NEARBYTES_BENCH_ROLE']?.toLowerCase();
  if (raw === 'sender' || raw === 'alice') return 'sender';
  if (raw === 'receiver' || raw === 'bob') return 'receiver';
  throw new Error('Set NEARBYTES_BENCH_ROLE=sender|receiver (or alice|bob)');
}

export function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function makePayload(sizeBytes: number, seed: number): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i + seed) & 0xff;
  }
  return buf;
}

export async function profilePublicKeyHex(secret: string): Promise<string> {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

export function benchRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

export function defaultBenchWorkBase(): string {
  return path.join(benchRepoRoot(), '.local', 'bench', 'work');
}

export function benchWorkDir(role: BenchRole): string {
  const base = process.env['NEARBYTES_BENCH_BASE'] ?? defaultBenchWorkBase();
  return path.join(base, role === 'sender' ? 'alice' : 'bob');
}

export async function setupBenchConfig(role: BenchRole): Promise<{
  config: NearbytesConfig;
  configPath: string;
  profileSecret: string;
}> {
  const workDir = benchWorkDir(role);
  const configPath = path.join(workDir, 'config.json');
  const dataDir = path.join(workDir, 'data');
  const alicePk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileAlice);
  const bobPk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileBob);
  const profileSecret =
    role === 'sender' ? BENCH_CREDENTIALS.profileAlice : BENCH_CREDENTIALS.profileBob;
  const friends = role === 'sender' ? [bobPk] : [alicePk];

  const { mkdir, rm } = await import('fs/promises');
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const config: NearbytesConfig = {
    dataDir,
    volumes: [],
    friends,
    profileSecret,
  };
  process.env['NEARBYTES_CONFIG'] = configPath;
  process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
  await writeConfig(config, configPath);
  return { config, configPath, profileSecret };
}

export async function publishProfile(
  ctx: Context,
  displayName: string,
  bio: string,
): Promise<{ publicKey: string; eventHash: string; publishMs: number }> {
  if (!ctx.config.profileSecret) {
    throw new Error('profile secret required');
  }
  const t0 = hrtimeMs();
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(ctx.config.profileSecret));
  const publicKey = bytesToHex(keyPair.publicKey);
  const record = await createIdentityRecord(
    ctx.skeleton.crypto,
    keyPair,
    { displayName, bio },
    Date.now(),
  );
  if (!(await verifyIdentityRecord(ctx.skeleton.crypto, record))) {
    throw new Error('profile record verification failed');
  }
  const payload: AppRecordPayload = {
    type: EventType.APP_RECORD,
    protocol: 'nb.identity.record.v1',
    authorPublicKey: publicKey,
    record: serializeIdentityRecord(record),
    publishedAt: Date.now(),
  };
  const signedEvent = await createSignedEvent(ctx.skeleton.crypto, keyPair, payload, []);
  const eventHash = await ctx.skeleton.log.events.storeEvent(keyPair.publicKey, signedEvent);
  const publishMs = hrtimeMs() - t0;
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'profile-published', t: Date.now(), displayName, eventHash: eventHash.slice(0, 16) })}`,
  );
  return { publicKey, eventHash, publishMs };
}

export async function readBenchMarkers(log: Log): Promise<BenchMarker[]> {
  const lines = await log.sync.readMarkers();
  const out: BenchMarker[] = [];
  for (const line of lines) {
    if (!line.startsWith('bench ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        bench: string;
        t: number;
        [key: string]: string | number | boolean;
      };
      const { bench: event, t, ...rest } = parsed;
      out.push({ event, t, fields: rest });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function waitForBenchEvent(
  log: Log,
  event: string,
  sinceWallMs: number,
  timeoutMs: number,
): Promise<BenchMarker> {
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    const markers = await readBenchMarkers(log);
    const hit = markers.find((m) => m.event === event && m.t >= sinceWallMs);
    if (hit) return hit;
    if (Date.now() - lastBeat >= 3000) {
      const leftSec = Math.ceil((deadline - Date.now()) / 1000);
      benchProgress('sync', `waiting for ${event} (${leftSec}s timeout left)`);
      lastBeat = Date.now();
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for bench event "${event}"`);
}

export async function readReceptionTail(
  dataDir: string,
  limit = 40,
): Promise<string[]> {
  const filePath = path.join(dataDir, 'sync', 'reception.jsonl');
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf-8');
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-limit);
}

export async function readActivityRaw(dataDir: string): Promise<string[]> {
  const filePath = path.join(dataDir, 'sync', 'activity.log');
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf-8');
  return text.trim().split('\n').filter(Boolean);
}

export interface BenchActivityEvent {
  readonly bench: string;
  readonly t: number;
  readonly kind?: string;
  readonly bytes?: number;
  readonly name?: string;
}

export function parseBenchActivityLines(activityLog: readonly string[]): BenchActivityEvent[] {
  const events: BenchActivityEvent[] = [];
  for (const line of activityLog) {
    if (!line.startsWith('bench ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as BenchActivityEvent);
    } catch {
      /* skip */
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Goodput from first-to-last inbound-stored block between throughput phase markers. */
export function goodputFromInboundMarkers(
  receiverLog: readonly string[],
  nominalBytes: number,
  senderLog: readonly string[] = [],
): {
  readonly goodputMbps: number;
  readonly durationMs: number;
  readonly bytesReceived: number;
} | null {
  const phaseEvents = parseBenchActivityLines(senderLog.length > 0 ? senderLog : receiverLog);
  const start = phaseEvents.find((e) => e.bench === 'throughput-phase-start');
  if (!start) return null;
  const t0 = start.t;
  const minBlockBytes =
    nominalBytes > 16 * 1024 * 1024
      ? 1024 * 1024
      : nominalBytes > 0
        ? Math.max(4096, Math.floor(nominalBytes / 16))
        : 4096;
  const events = parseBenchActivityLines(receiverLog);
  const blocks = events.filter(
    (e) =>
      e.bench === 'inbound-stored' &&
      e.kind === 'block' &&
      e.t >= t0 &&
      Number(e.bytes) >= minBlockBytes,
  );
  if (blocks.length === 0) return null;
  const first = blocks[0]!.t;
  const last = blocks[blocks.length - 1]!.t;
  const durationMs =
    blocks.length === 1 ? Math.max(1, last - t0) : Math.max(1, last - first);
  const bytesReceived = blocks.reduce((s, b) => s + (Number(b.bytes) || 0), 0);
  const effective =
    nominalBytes > 0 ? Math.min(nominalBytes, bytesReceived) : bytesReceived;
  return {
    goodputMbps: (effective * 8) / (durationMs * 1000),
    durationMs,
    bytesReceived,
  };
}

export async function listBenchFilenames(ctx: Context): Promise<string[]> {
  const files = await ctx.fileService.listFiles(BENCH_CREDENTIALS.volume);
  return files.map((f) => f.filename).filter((n) => n.startsWith('bench-'));
}

export async function waitForBenchFilename(
  ctx: Context,
  filename: string,
  timeoutMs: number,
): Promise<{ wallMs: number; cpuMs: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    if (names.includes(filename)) {
      return { wallMs: Date.now(), cpuMs: hrtimeMs() };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for bench file ${filename}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep with periodic heartbeats so long waits never look stuck. */
export async function sleepWithProgress(
  role: string,
  label: string,
  ms: number,
  tickMs = 3000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const leftSec = Math.max(1, Math.ceil((end - Date.now()) / 1000));
    benchProgress(role, `${label} — ${leftSec}s remaining`);
    await sleep(Math.min(tickMs, end - Date.now()));
  }
}

let progressOriginMs = Date.now();

export function resetProgressClock(): void {
  progressOriginMs = Date.now();
}

/** Line-buffered progress for long benchmark runs (visible in CI and remote SSH). */
export function benchProgress(role: string, message: string): void {
  const elapsed = ((Date.now() - progressOriginMs) / 1000).toFixed(1);
  process.stdout.write(`[bench ${role} +${elapsed}s] ${message}\n`);
}

export async function createBenchContext(config: NearbytesConfig): Promise<Context> {
  return createContext(config);
}
