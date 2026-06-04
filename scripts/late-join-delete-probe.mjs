/**
 * Directional regression: delete while peer offline, then start the other instance.
 * Joiner must see the delete quickly in both directions (symmetric cold path).
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, createSecret } from 'nearbytes-crypto';
import { initializeStorageRoot } from 'nearbytes-skeleton';
import { createContext, attachSyncInboundRefresh, reloadVolumeFromDisk } from '../dist/probeRuntime.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = 'late-join-delete-profile:secret';
const VOLUME_SECRET = 'test:test';
const PROFILE = { name: 'ljd', secret: PROFILE_SECRET };
const TARGET = 'late-join-delete-me.txt';
const POLL_MS = 50;
const PEER_TIMEOUT_MS = 30_000;
/** Both directions should catch up within this budget on LAN probes. */
const SYNC_BUDGET_MS = Number(process.env.NBF_LJD_BUDGET_MS ?? '2_500');

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
  await initializeStorageRoot(dataDir);
  const ctx = await createContext(config(dataDir));
  attachSyncInboundRefresh(ctx);
  ctx.volumeRegistry.set('test', VOLUME_SECRET);
  const inst = ctx.skeleton.sync.instancePublicKey.slice(0, 8);
  console.error(`${label}: inst=${inst}`);
  return ctx;
}

async function listNames(ctx) {
  await reloadVolumeFromDisk(ctx, VOLUME_SECRET);
  return (await ctx.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForPeer(ctx, label) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctx.skeleton.sync.snapshot().connectedPeers > 0) {
      return Date.now();
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: no peer within ${PEER_TIMEOUT_MS}ms`);
}

async function waitUntilGone(ctx, path, label, sinceMs = Date.now()) {
  const deadline = sinceMs + SYNC_BUDGET_MS;
  let last = [];
  while (Date.now() < deadline) {
    last = await listNames(ctx);
    if (!last.includes(path)) {
      const ms = Date.now() - sinceMs;
      console.error(`${label}: delete visible in ${ms}ms [${last.join(',')}]`);
      return ms;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `${label}: still has ${path} after ${SYNC_BUDGET_MS}ms (last [${last.join(',')}])`,
  );
}

async function profileKeys(ctx) {
  const pk = bytesToHex(
    (await ctx.skeleton.crypto.deriveKeys(createSecret(PROFILE_SECRET))).publicKey,
  );
  return { profile: pk.toLowerCase(), inst: ctx.skeleton.sync.instancePublicKey.toLowerCase() };
}

async function readFetchCursor(dataDir, profile, inst) {
  try {
    const raw = await readFile(
      join(dataDir, 'sync', 'fetch-cursors', `${inst.toLowerCase()}.json`),
      'utf8',
    );
    const file = JSON.parse(raw);
    if (
      String(file.remoteInstancePublicKey ?? '').toLowerCase() !== inst.toLowerCase() ||
      String(file.remoteProfilePublicKey ?? '').toLowerCase() !== profile.toLowerCase()
    ) {
      return null;
    }
    return typeof file.cursor === 'string' ? file.cursor : null;
  } catch {
    return null;
  }
}

async function holderWritesAndDeletes(holder) {
  await holder.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from('x'));
  const afterAdd = await listNames(holder);
  if (!afterAdd.includes(TARGET)) {
    throw new Error('holder: add failed');
  }
  await holder.fileService.delete(VOLUME_SECRET, TARGET);
  const afterDel = await listNames(holder);
  if (afterDel.includes(TARGET)) {
    throw new Error('holder: delete failed locally');
  }
  console.error('holder: file deleted locally');
}

/**
 * @param {'local'|'remote'} holderWhich
 * Holder stays up; joiner starts cold.
 */
async function runDirection(root, holderWhich) {
  const holderDir = join(root, holderWhich, 'holder');
  const joinerDir = join(root, holderWhich, 'joiner');
  const holderLabel = holderWhich === 'local' ? 'local-holder' : 'remote-holder';
  const joinerLabel = holderWhich === 'local' ? 'remote-joiner' : 'local-joiner';

  const holder = await makeContext(holderDir, holderLabel);
  await holderWritesAndDeletes(holder);
  const holderKeys = await profileKeys(holder);

  const joiner = await makeContext(joinerDir, joinerLabel);
  const joinerStartedAt = Date.now();

  const tPeer = await waitForPeer(joiner, joinerLabel);
  await waitForPeer(holder, holderLabel);
  const syncMs = await waitUntilGone(joiner, TARGET, joinerLabel, tPeer);
  const peerMs = tPeer - joinerStartedAt;

  const joinerKeys = await profileKeys(joiner);
  const cursor = await readFetchCursor(
    joinerDir,
    holderKeys.profile,
    holderKeys.inst,
  );
  console.error(
    `${joinerLabel}: fetch cursor for holder=${cursor} ` +
      `(joiner inst ${joinerKeys.inst.slice(0, 8)})`,
  );

  await holder.destroy();
  await joiner.destroy();

  return { direction: `${holderWhich}-holder`, syncMs, peerMs };
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-late-join-delete-'));
const keep = process.env.NBF_LJD_KEEP === '1';

try {
  const a = await runDirection(root, 'local');
  const b = await runDirection(root, 'remote');
  const ratio = b.syncMs / Math.max(a.syncMs, 1);
  console.error(
    `timing: local-holder=${a.syncMs}ms remote-holder=${b.syncMs}ms ratio=${ratio.toFixed(2)}`,
  );
  if (b.syncMs > SYNC_BUDGET_MS && a.syncMs <= SYNC_BUDGET_MS) {
    throw new Error(
      `asymmetric: remote-holder join slow (${b.syncMs}ms) vs local-holder (${a.syncMs}ms)`,
    );
  }
  if (a.syncMs > SYNC_BUDGET_MS) {
    throw new Error(`local-holder join slow: ${a.syncMs}ms`);
  }
  if (b.syncMs > SYNC_BUDGET_MS) {
    throw new Error(`remote-holder join slow: ${b.syncMs}ms`);
  }
  console.log(JSON.stringify({ ok: true, root, localHolderMs: a.syncMs, remoteHolderMs: b.syncMs }));
} finally {
  if (!keep) {
    await rm(root, { recursive: true, force: true });
  }
}

process.exit(0);
