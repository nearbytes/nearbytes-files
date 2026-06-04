/**
 * Sibling late-join: local has data before remote dataDir exists; remote must catch up.
 * Fast defaults: peer≤3s, sync≤2s, hard wall 20s (~5s when sync is healthy).
 *
 * Env: NBF_PEER_TIMEOUT_MS, NBF_SYNC_TIMEOUT_MS, NBF_WALL_MS, NBF_POLL_MS
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, reloadVolumeFromDisk } from '../dist/probeRuntime.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = 'remote-join-profile:secret';
const VOLUME_SECRET = 'test:test';
const PROFILE = { name: 'join', secret: PROFILE_SECRET };
const TARGET_A = 'join-a.txt';
const TARGET_B = 'join-b.txt';
const POLL_MS = Number(process.env.NBF_POLL_MS ?? 25);
const PEER_TIMEOUT_MS = Number(process.env.NBF_PEER_TIMEOUT_MS ?? 3_000);
const SYNC_TIMEOUT_MS = Number(process.env.NBF_SYNC_TIMEOUT_MS ?? 2_000);
const WALL_MS = Number(process.env.NBF_WALL_MS ?? 20_000);
const SHUTDOWN_MS = Number(process.env.NBF_SHUTDOWN_MS ?? 500);

const wallStart = Date.now();
let exitCode = 0;
function assertWall(label) {
  if (Date.now() - wallStart > WALL_MS) {
    throw new Error(`${label}: wall ${WALL_MS}ms exceeded`);
  }
}

function config(dataDir) {
  return {
    dataDir,
    volumes: [{ label: 'test', secret: VOLUME_SECRET }],
    friends: [],
    profiles: [PROFILE],
    activeProfile: PROFILE.name,
  };
}

async function makeContext(dataDir, label) {
  assertWall(`makeContext ${label}`);
  const ctx = await createContext(config(dataDir));
  ctx.volumeRegistry.set('test', VOLUME_SECRET);
  console.error(`${label}: inst=${ctx.skeleton.sync.instancePublicKey.slice(0, 8)}`);
  return ctx;
}

async function listNames(ctx) {
  await reloadVolumeFromDisk(ctx, VOLUME_SECRET);
  return (await ctx.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function destroyCtx(ctx, label) {
  if (!ctx) return;
  await Promise.race([
    ctx.destroy(),
    sleep(SHUTDOWN_MS).then(() => {
      console.error(`${label}: destroy timed out after ${SHUTDOWN_MS}ms`);
    }),
  ]);
}

async function waitForPeer(a, b) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertWall('waitForPeer');
    if (a.skeleton.sync.snapshot().connectedPeers > 0 && b.skeleton.sync.snapshot().connectedPeers > 0) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`no peer within ${PEER_TIMEOUT_MS}ms`);
}

async function waitForFiles(ctx, expected, label) {
  const want = [...expected].sort().join(',');
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    assertWall(`waitForFiles ${label}`);
    last = await listNames(ctx);
    if (last.join(',') === want) {
      console.error(`${label}: ok [${last.join(',')}]`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: wanted [${want}], last [${last.join(',')}] after ${SYNC_TIMEOUT_MS}ms`);
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-remote-join-'));
let local = null;
let remote = null;

try {
  local = await makeContext(join(root, 'local'), 'local');
  await local.fileService.addFile(VOLUME_SECRET, TARGET_A, Buffer.from('a'));
  await local.fileService.addFile(VOLUME_SECRET, TARGET_B, Buffer.from('b'));
  await waitForFiles(local, [TARGET_A, TARGET_B], 'local');

  remote = await makeContext(join(root, 'remote'), 'remote');
  await waitForPeer(local, remote);
  await waitForFiles(remote, [TARGET_A, TARGET_B], 'remote after join');

  console.log(
    JSON.stringify({ ok: true, wallMs: Date.now() - wallStart, root }),
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, wallMs: Date.now() - wallStart, error: msg }));
  exitCode = 1;
} finally {
  await Promise.race([
    Promise.all([
      destroyCtx(local, 'local'),
      destroyCtx(remote, 'remote'),
      rm(root, { recursive: true, force: true }),
    ]),
    sleep(SHUTDOWN_MS),
  ]);
}
process.exit(exitCode);
