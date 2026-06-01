/**
 * Local is up with data; remote starts later — must catch up without remote writes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, reloadVolumeFromDisk } from '../dist/cli/context.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = 'remote-join-profile:secret';
const VOLUME_SECRET = 'test:test';
const PROFILE = { name: 'join', secret: PROFILE_SECRET };
const TARGET_A = 'join-a.txt';
const TARGET_B = 'join-b.txt';
const POLL_MS = 250;
const PEER_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 45_000;

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

async function waitForPeer(a, b) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (a.skeleton.sync.snapshot().connectedPeers > 0 && b.skeleton.sync.snapshot().connectedPeers > 0) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error('no peer');
}

async function waitForFiles(ctx, expected, label) {
  const want = [...expected].sort().join(',');
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    last = await listNames(ctx);
    if (last.join(',') === want) {
      console.error(`${label}: ok [${last.join(',')}]`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: wanted [${want}], last [${last.join(',')}]`);
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-remote-join-'));
let local = null;
let remote = null;

try {
  local = await makeContext(join(root, 'local'), 'local');
  await local.fileService.addFile(VOLUME_SECRET, TARGET_A, Buffer.from('a'));
  await local.fileService.addFile(VOLUME_SECRET, TARGET_B, Buffer.from('b'));
  await waitForFiles(local, [TARGET_A, TARGET_B], 'local');

  remote = await makeContext(join(root, 'remote'), 'remote-joins');
  await waitForPeer(local, remote);
  await waitForFiles(remote, [TARGET_A, TARGET_B], 'remote after join (no remote write)');

  console.log(JSON.stringify({ ok: true }));
} finally {
  if (local) await local.destroy();
  if (remote) await remote.destroy();
  await rm(root, { recursive: true, force: true });
}
