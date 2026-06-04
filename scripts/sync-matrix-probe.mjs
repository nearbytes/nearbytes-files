/**
 * Regression probe for sibling sync startup order.
 *
 * Covers:
 *   - A has data before B's dataDir exists.
 *   - B writes after connecting and A receives it.
 *   - B restarts with an existing dataDir and catches writes missed offline.
 *   - Existing B starts before fresh C, and C bootstraps B's history.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngineRuntime,
  openAndWatch,
  reloadVolumeFromDisk,
  attachSyncInboundRefresh,
} from '../../nearbytes-engine/dist/index.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = process.env.NBF_MATRIX_PROFILE_SECRET ?? 'matrix-profile:secret';
const VOLUME_SECRET = process.env.NBF_MATRIX_VOLUME_SECRET ?? 'test:test';
const PROFILE = { name: 'matrix', secret: PROFILE_SECRET };
const POLL_MS = 250;
const PEER_TIMEOUT_MS = 20_000;
const SYNC_TIMEOUT_MS = 30_000;

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
  
  console.error(
    `${label}: peer=${rt.skeleton.sync.peerId.slice(0, 8)} ` +
      `inst=${rt.skeleton.sync.instancePublicKey.slice(0, 8)}`,
  );
  return rt;
}

async function listNames(rt) {
  await reloadVolumeFromDisk(rt, VOLUME_SECRET);
  return (await rt.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPeer(rt, label) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (rt.skeleton.sync.snapshot().connectedPeers > 0) {
      console.error(`${label}: peer ok`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: no peer within ${PEER_TIMEOUT_MS}ms`);
}

async function waitForFiles(rt, expected, label) {
  const want = [...expected].sort().join(',');
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    last = await listNames(rt);
    if (last.join(',') === want) {
      console.error(`${label}: ok [${last.join(',')}]`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: wanted [${want}], last [${last.join(',')}]`);
}

async function closeContext(rt) {
  if (rt !== null) {
    await rt.destroy();
  }
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-sync-matrix-'));
const keep = process.env.NBF_MATRIX_KEEP === '1';
let a = null;
let b = null;
let c = null;

try {
  const aDir = join(root, 'A');
  const bDir = join(root, 'B');
  const cDir = join(root, 'C');

  a = await makeContext(aDir, 'A1');
  await a.fileService.addFile(VOLUME_SECRET, 'a-before-b.txt', Buffer.from('A before B'));
  await waitForFiles(a, ['a-before-b.txt'], 'A local write');

  b = await makeContext(bDir, 'B1-fresh');
  await waitForPeer(a, 'A sees B');
  await waitForPeer(b, 'B sees A');
  await waitForFiles(b, ['a-before-b.txt'], 'B fresh catches A history');

  await b.fileService.addFile(VOLUME_SECRET, 'b-after-a.txt', Buffer.from('B after A'));
  await waitForFiles(a, ['a-before-b.txt', 'b-after-a.txt'], 'A catches B live write');

  await closeContext(b);
  b = null;
  await a.fileService.addFile(VOLUME_SECRET, 'a-while-b-down.txt', Buffer.from('A while B down'));
  await waitForFiles(
    a,
    ['a-before-b.txt', 'a-while-b-down.txt', 'b-after-a.txt'],
    'A offline write',
  );

  b = await makeContext(bDir, 'B2-existing-restart');
  await waitForPeer(b, 'B restart sees A');
  await waitForFiles(
    b,
    ['a-before-b.txt', 'a-while-b-down.txt', 'b-after-a.txt'],
    'B existing catches missed write',
  );

  await closeContext(a);
  a = null;
  await closeContext(b);
  b = null;

  b = await makeContext(bDir, 'B3-existing-first');
  await b.fileService.addFile(VOLUME_SECRET, 'b-before-c.txt', Buffer.from('B before C'));
  await waitForFiles(
    b,
    ['a-before-b.txt', 'a-while-b-down.txt', 'b-after-a.txt', 'b-before-c.txt'],
    'B pre-C write',
  );

  c = await makeContext(cDir, 'C1-fresh-second');
  await waitForPeer(c, 'C sees B');
  await waitForFiles(
    c,
    ['a-before-b.txt', 'a-while-b-down.txt', 'b-after-a.txt', 'b-before-c.txt'],
    'C fresh catches B history',
  );

  await c.fileService.addFile(VOLUME_SECRET, 'c-live.txt', Buffer.from('C live'));
  await waitForFiles(
    b,
    ['a-before-b.txt', 'a-while-b-down.txt', 'b-after-a.txt', 'b-before-c.txt', 'c-live.txt'],
    'B catches C live write',
  );

  console.log(JSON.stringify({ ok: true, root }));
} finally {
  await closeContext(c);
  await closeContext(b);
  await closeContext(a);
  if (!keep) {
    await rm(root, { recursive: true, force: true });
  }
}

process.exit(0);
