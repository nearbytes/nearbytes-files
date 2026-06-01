/**
 * Regression: local writes, local closes, remote opens alone, local reopens.
 * Remote must catch the write from local's reception journal on reconnect.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, reloadVolumeFromDisk } from '../dist/cli/context.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = process.env.NBF_OFFLINE_PROFILE_SECRET ?? 'offline-profile:secret';
const VOLUME_SECRET = process.env.NBF_OFFLINE_VOLUME_SECRET ?? 'test:test';
const PROFILE = { name: 'offline', secret: PROFILE_SECRET };
const TARGET = process.env.NBF_OFFLINE_TARGET ?? 'offline-catchup.txt';
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
  console.error(
    `${label}: peer=${ctx.skeleton.sync.peerId.slice(0, 8)} ` +
      `inst=${ctx.skeleton.sync.instancePublicKey.slice(0, 8)}`,
  );
  return ctx;
}

async function listNames(ctx) {
  await reloadVolumeFromDisk(ctx, VOLUME_SECRET);
  return (await ctx.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPeer(ctx, label) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctx.skeleton.sync.snapshot().connectedPeers > 0) {
      console.error(`${label}: peer ok`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: no peer within ${PEER_TIMEOUT_MS}ms`);
}

async function waitForFile(ctx, path, label) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    last = await listNames(ctx);
    if (last.includes(path)) {
      console.error(`${label}: ok [${last.join(',')}]`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: wanted ${path}, last [${last.join(',')}]`);
}

async function closeContext(ctx) {
  if (ctx !== null) {
    await ctx.destroy();
  }
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-offline-reopen-'));
const keep = process.env.NBF_OFFLINE_KEEP === '1';
let local = null;
let remote = null;

try {
  const localDir = join(root, 'local');
  const remoteDir = join(root, 'remote');

  local = await makeContext(localDir, 'local-1');
  await local.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from('written while local up'));
  await waitForFile(local, TARGET, 'local has write');

  await closeContext(local);
  local = null;
  console.error('local: closed');

  remote = await makeContext(remoteDir, 'remote-alone');
  await sleep(2000);
  if (remote.skeleton.sync.snapshot().connectedPeers > 0) {
    throw new Error('remote-alone: unexpected peer before local reopens');
  }
  console.error('remote: up alone, no peer');

  local = await makeContext(localDir, 'local-2-reopen');
  await waitForPeer(local, 'local sees remote');
  await waitForPeer(remote, 'remote sees local');
  await waitForFile(remote, TARGET, 'remote catches after local reopens');

  console.log(JSON.stringify({ ok: true, root, target: TARGET }));
} finally {
  await closeContext(remote);
  await closeContext(local);
  if (!keep) {
    await rm(root, { recursive: true, force: true });
  }
}

process.exit(0);
