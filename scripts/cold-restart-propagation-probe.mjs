/**
 * Measures the REPL workflow:
 *   1) write on local → exit
 *   2) start remote (empty; optional stale fetch cursor)
 *   3) restart local → peers connect → file visible on remote
 *
 * Latency: local restart → remote `ls` sees the file.
 *
 * Env: NBF_COLD_PEER_TIMEOUT_MS, NBF_COLD_SYNC_TIMEOUT_MS, NBF_COLD_TARGET_MS,
 *      NBF_COLD_WALL_MS, NBF_COLD_STALE_CURSOR=1
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

const PROFILE_SECRET = process.env.NBF_COLD_PROFILE_SECRET ?? 'cold-restart-profile:secret';
const VOLUME_SECRET = process.env.NBF_COLD_VOLUME_SECRET ?? 'test:test';
const PROFILE = { name: 'cold', secret: PROFILE_SECRET };
const TARGET =
  process.env.NBF_COLD_TARGET ?? `cold-${Date.now()}.txt`;
const POLL_MS = Number(process.env.NBF_COLD_POLL_MS ?? 25);
const PEER_TIMEOUT_MS = Number(process.env.NBF_COLD_PEER_TIMEOUT_MS ?? 15_000);
const SYNC_TIMEOUT_MS = Number(process.env.NBF_COLD_SYNC_TIMEOUT_MS ?? 15_000);
const TARGET_MS = Number(process.env.NBF_COLD_TARGET_MS ?? 3_000);
const WALL_MS = Number(process.env.NBF_COLD_WALL_MS ?? 30_000);
const STALE_CURSOR = process.env.NBF_COLD_STALE_CURSOR === '1';

const wallStart = Date.now();
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
    assertWall('waitForPeer');
    if (
      a.skeleton.sync.snapshot().connectedPeers > 0 &&
      b.skeleton.sync.snapshot().connectedPeers > 0
    ) {
      return Date.now();
    }
    await sleep(POLL_MS);
  }
  throw new Error(`no peer within ${PEER_TIMEOUT_MS}ms (${la}/${lb})`);
}

async function waitForFile(rt, path, label, sinceMs) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = [];
  let eventAt = null;
  let blockAt = null;
  const unsub = rt.skeleton.sync.onEvent((ev) => {
    const now = Date.now();
    if (ev.kind === 'event-received' && eventAt === null) eventAt = now;
    if (ev.kind === 'block-received' && blockAt === null) blockAt = now;
  });
  try {
    while (Date.now() < deadline) {
      assertWall(`waitForFile ${label}`);
      last = await listNames(rt);
      if (last.includes(path)) {
        const visibleAt = Date.now();
        return {
          visibleAt,
          restartToVisibleMs: visibleAt - sinceMs,
          eventMs: eventAt !== null ? eventAt - sinceMs : null,
          blockMs: blockAt !== null ? blockAt - sinceMs : null,
        };
      }
      await sleep(POLL_MS);
    }
    throw new Error(`${label}: wanted ${path}, last [${last.join(',')}] after ${SYNC_TIMEOUT_MS}ms`);
  } finally {
    unsub();
  }
}

async function plantStaleFetchCursor(remoteDir, localInst, localProfilePk) {
  await mkdir(join(remoteDir, 'sync'), { recursive: true });
  await mkdir(join(remoteDir, 'sync', 'fetch-cursors'), { recursive: true });
  await writeFile(
    join(remoteDir, 'sync', 'fetch-cursors', `${localInst.toLowerCase()}.json`),
    `${JSON.stringify(
      {
        version: 1,
        remoteProfilePublicKey: localProfilePk.toLowerCase(),
        remoteInstancePublicKey: localInst.toLowerCase(),
        cursor: '99999',
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.error('remote: stale fetch cursor 99999 planted');
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-cold-restart-'));
let local = null;
let remote = null;
let exitCode = 1;

try {
  const localDir = join(root, 'local');
  const remoteDir = join(root, 'remote');

  local = await makeContext(localDir, 'local');
  await local.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from(`cold ${Date.now()}\n`));
  if (!(await listNames(local)).includes(TARGET)) {
    throw new Error(`local write missing ${TARGET}`);
  }
  const localInst = local.skeleton.sync.instancePublicKey;
  const localProfilePk = bytesToHex(
    (await local.skeleton.crypto.deriveKeys(createSecret(PROFILE_SECRET))).publicKey,
  );
  console.error(`local: wrote ${TARGET}`);
  await local.destroy();
  local = null;

  remote = await makeContext(remoteDir, 'remote');
  if (STALE_CURSOR) {
    await plantStaleFetchCursor(remoteDir, localInst, localProfilePk);
  }
  attachSyncInboundRefresh(remote);
  await openAndWatch(remote, VOLUME_SECRET, false);
  console.error('remote: up (empty)');

  const localRestartAt = Date.now();
  local = await makeContext(localDir, 'local-restart');
  attachSyncInboundRefresh(local);
  await openAndWatch(local, VOLUME_SECRET, false);

  const peerAt = await waitForPeer(local, remote, 'local', 'remote');
  const sync = await waitForFile(remote, TARGET, 'remote', localRestartAt);
  const ok =
    sync.restartToVisibleMs <= TARGET_MS && sync.restartToVisibleMs < SYNC_TIMEOUT_MS;

  console.log(
    JSON.stringify({
      ok,
      scenario: STALE_CURSOR
        ? 'local-write-exit-remote-stale-cursor-local-restart'
        : 'local-write-exit-remote-up-local-restart',
      target: TARGET,
      targetMs: TARGET_MS,
      staleCursor: STALE_CURSOR,
      wallMs: Date.now() - wallStart,
      localRestartToPeerMs: peerAt - localRestartAt,
      localRestartToVisibleOnRemoteMs: sync.restartToVisibleMs,
      remoteEventMs: sync.eventMs,
      remoteBlockMs: sync.blockMs,
      timedOut: false,
    }),
  );
  exitCode = ok ? 0 : 1;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(
    JSON.stringify({
      ok: false,
      scenario: 'cold-restart',
      target: TARGET,
      targetMs: TARGET_MS,
      staleCursor: STALE_CURSOR,
      wallMs: Date.now() - wallStart,
      error: msg,
      timedOut: msg.includes('wall'),
    }),
  );
  exitCode = 1;
} finally {
  if (local) await local.destroy().catch(() => {});
  if (remote) await remote.destroy().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

process.exit(exitCode);
