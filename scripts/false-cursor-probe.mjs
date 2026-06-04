/**
 * Regression: stale fetch cursor ahead of locally applied reception must recover on reconnect.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import {
  createEngineRuntime,
  openAndWatch,
  reloadVolumeFromDisk,
  attachSyncInboundRefresh,
} from '../../nearbytes-engine/dist/index.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = 'false-cursor-profile:secret';
const VOLUME_SECRET = 'test:test';
const PROFILE = { name: 'fc', secret: PROFILE_SECRET };
const TARGET = 'false-cursor-file.txt';
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
  const rt = await createEngineRuntime(config(dataDir));
  
  console.error(`${label}: inst=${rt.skeleton.sync.instancePublicKey.slice(0, 8)}`);
  return rt;
}

async function listNames(rt) {
  await reloadVolumeFromDisk(rt, VOLUME_SECRET);
  return (await rt.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForPeer(a, b, la, lb) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (a.skeleton.sync.snapshot().connectedPeers > 0 && b.skeleton.sync.snapshot().connectedPeers > 0) {
      console.error(`${la}/${lb}: peer ok`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error('no peer');
}

async function waitForFile(rt, path, label) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    last = await listNames(rt);
    if (last.includes(path)) {
      console.error(`${label}: ok`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: wanted ${path}, last [${last.join(',')}]`);
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-false-cursor-'));
let local = null;
let remote = null;

try {
  const localDir = join(root, 'local');
  const remoteDir = join(root, 'remote');

  local = await makeContext(localDir, 'local');
  await local.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from('payload'));
  await waitForFile(local, TARGET, 'local write');
  const localInst = local.skeleton.sync.instancePublicKey;
  const localProfile = bytesToHex(
    (await local.skeleton.crypto.deriveKeys(createSecret(PROFILE_SECRET))).publicKey,
  );
  await local.destroy();
  local = null;

  remote = await makeContext(remoteDir, 'remote');
  await sleep(1500);

  await mkdir(join(remoteDir, 'sync'), { recursive: true });
  await mkdir(join(remoteDir, 'sync', 'fetch-cursors'), { recursive: true });
  await writeFile(
    join(remoteDir, 'sync', 'fetch-cursors', `${localInst.toLowerCase()}.json`),
    `${JSON.stringify(
      {
        version: 1,
        remoteProfilePublicKey: localProfile.toLowerCase(),
        remoteInstancePublicKey: localInst.toLowerCase(),
        cursor: '99999',
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.error('remote: planted false fetch cursor 99999');

  local = await makeContext(localDir, 'local-reopen');
  await waitForPeer(local, remote, 'local', 'remote');
  await waitForFile(remote, TARGET, 'remote recovers false cursor');

  console.log(JSON.stringify({ ok: true }));
} finally {
  if (local) await local.destroy();
  if (remote) await remote.destroy();
  await rm(root, { recursive: true, force: true });
}
