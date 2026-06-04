/**
 * Measure holder → joiner propagation: block-received, event-received, and
 * `ls`-style visibility (reloadVolumeFromDisk + listFiles).
 *
 * Roles (NEARBYTES_PROP_ROLE):
 *   joiner — volume open, waits for peer, then measures after stdin `go`
 *   holder — waits for peer, publishes TARGET on `go`
 *
 * Orchestrator sends one line to both stdin:
 *   {"cmd":"go","t0":<ms>}
 *
 * Stdout: JSON lines only. Stderr: diagnostics.
 */
import { createInterface } from 'node:readline';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, createSecret, createCryptoOperations } from 'nearbytes-crypto';
import { initializeStorageRoot } from 'nearbytes-skeleton';
import { applyDebugOption } from '../dist/debug.js';
import {
  createEngineRuntime,
  openAndWatch,
  reloadVolumeFromDisk,
  attachSyncInboundRefresh,
} from '../../nearbytes-engine/dist/index.js';

if (process.env.NEARBYTES_DEBUG) {
  applyDebugOption(process.env.NEARBYTES_DEBUG);
}

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const ROLE = process.env.NBF_PROP_ROLE;
if (ROLE !== 'holder' && ROLE !== 'joiner') {
  console.error('Set NBF_PROP_ROLE=holder|joiner');
  process.exit(2);
}

const MODE = process.env.NBF_PROP_MODE ?? 'friends';
const VOLUME_SECRET = process.env.NBF_PROP_VOLUME_SECRET ?? 'test:test';
const TARGET =
  process.env.NBF_PROP_TARGET ?? `prop-${Date.now()}.txt`;
const POLL_MS = Number(process.env.NBF_PROP_POLL_MS ?? 25);
const PEER_TIMEOUT_MS = Number(process.env.NBF_PROP_PEER_TIMEOUT_MS ?? 3_000);
const MEASURE_TIMEOUT_MS = Number(process.env.NBF_PROP_MEASURE_TIMEOUT_MS ?? 2_000);

const FRIEND_SECRETS = {
  holder: process.env.NBF_PROP_HOLDER_PROFILE ?? 'nearbytes-prop-alice:secret',
  joiner: process.env.NBF_PROP_JOINER_PROFILE ?? 'nearbytes-prop-bob:secret',
};
const SIBLING_SECRET =
  process.env.NBF_PROP_PROFILE_SECRET ?? 'event-propagation-sibling:secret';

async function profilePublicKey(secret) {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey).toLowerCase();
}

async function buildConfig(dataDir) {
  if (MODE === 'sibling') {
    return {
      dataDir,
      volumes: [{ label: 'test', secret: VOLUME_SECRET }],
      friends: [],
      profiles: [{ name: 'sibling', secret: SIBLING_SECRET }],
      activeProfile: 'sibling',
    };
  }
  const mySecret = ROLE === 'holder' ? FRIEND_SECRETS.holder : FRIEND_SECRETS.joiner;
  const peerSecret = ROLE === 'holder' ? FRIEND_SECRETS.joiner : FRIEND_SECRETS.holder;
  const peerPk = await profilePublicKey(peerSecret);
  return {
    dataDir,
    volumes: [{ label: 'test', secret: VOLUME_SECRET }],
    friends: [peerPk],
    profiles: [{ name: ROLE, secret: mySecret }],
    activeProfile: ROLE,
  };
}

function out(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function diag(line) {
  process.stderr.write(`[${ROLE}] ${line}\n`);
}

async function volumeChannelHex(rt) {
  const kp = await rt.skeleton.crypto.deriveKeys(createSecret(VOLUME_SECRET));
  return bytesToHex(kp.publicKey).toLowerCase();
}

async function listNames(rt) {
  await reloadVolumeFromDisk(rt, VOLUME_SECRET);
  return (await rt.fileService.listFiles(VOLUME_SECRET)).map((f) => f.path).sort();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForPeer(rt) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (rt.skeleton.sync.snapshot().connectedPeers > 0) {
      return Date.now();
    }
    await sleep(POLL_MS);
  }
  throw new Error(`no peer within ${PEER_TIMEOUT_MS}ms`);
}

async function waitForGo() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Error(`bad go line: ${text.slice(0, 80)}`);
    }
    if (msg.cmd === 'go' && typeof msg.t0 === 'number') {
      return msg.t0;
    }
    throw new Error(`expected {"cmd":"go","t0":...}, got ${text.slice(0, 80)}`);
  }
  throw new Error('stdin closed before go');
}

async function makeContext(dataDir) {
  if (!existsSync(dataDir)) {
    await initializeStorageRoot(dataDir);
  }
  const rt = await createEngineRuntime(await buildConfig(dataDir));
  diag(`mode=${MODE}`);
  if (ROLE === 'joiner') {
    attachSyncInboundRefresh(rt);
  }
  
  const inst = rt.skeleton.sync.instancePublicKey.slice(0, 8);
  diag(`inst=${inst} dataDir=${dataDir}`);
  return rt;
}

async function runJoiner(rt) {
  const channel = await volumeChannelHex(rt);
  // Channel dir may not exist yet on a cold joiner; watcher needs the path (REPL opens volume first).
  await openAndWatch(rt, VOLUME_SECRET, false);

  const peerAt = await waitForPeer(rt);
  const startedAt = Number(process.env.NBF_PROP_STARTED_AT ?? peerAt);
  const contextReadyAt = Number(process.env.NBF_PROP_CONTEXT_READY_AT ?? startedAt);
  out({
    phase: 'ready',
    role: ROLE,
    target: TARGET,
    peerAt,
    startedAt,
    contextReadyAt,
    bootMs: contextReadyAt - startedAt,
    peerConnectMs: peerAt - startedAt,
    peerWaitMs: peerAt - contextReadyAt,
    channel,
  });

  let blockAt = null;
  let eventAt = null;
  const t0 = await waitForGo();
  diag(`go t0=${t0} target=${TARGET}`);

  const unsub = rt.skeleton.sync.onEvent((event) => {
    const now = Date.now();
    if (now < t0) return;
    if (event.kind === 'block-received' && blockAt === null) {
      blockAt = now;
    }
    if (
      event.kind === 'event-received' &&
      event.channel.toLowerCase() === channel &&
      eventAt === null
    ) {
      eventAt = now;
    }
  });

  const deadline = Date.now() + MEASURE_TIMEOUT_MS;
  let listAt = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const names = await listNames(rt);
    if (names.includes(TARGET)) {
      listAt = Date.now();
      break;
    }
    await sleep(POLL_MS);
  }
  unsub();

  const names = listAt === null ? await listNames(rt) : null;
  const timedOut = listAt === null;
  const result = {
    phase: timedOut ? 'timeout' : 'measured',
    role: ROLE,
    target: TARGET,
    t0,
    peerMs: peerAt - (process.env.NBF_PROP_STARTED_AT
      ? Number(process.env.NBF_PROP_STARTED_AT)
      : peerAt),
    blockMs: blockAt !== null ? blockAt - t0 : null,
    eventMs: eventAt !== null ? eventAt - t0 : null,
    listMs: listAt !== null ? listAt - t0 : null,
    eventBeforeListMs:
      eventAt !== null && listAt !== null ? listAt - eventAt : null,
    blockBeforeEventMs:
      blockAt !== null && eventAt !== null ? eventAt - blockAt : null,
    polls,
    files: timedOut ? names : undefined,
  };
  out(result);
  diag(
    `block=${result.blockMs}ms event=${result.eventMs}ms list=${result.listMs}ms ` +
      `(event→list ${result.eventBeforeListMs}ms)${timedOut ? ' TIMEOUT' : ''}`,
  );
  if (timedOut && process.env.NBF_PROP_NO_THROW !== '1') {
    throw new Error(
      `joiner: ${TARGET} not visible after ${MEASURE_TIMEOUT_MS}ms (have [${names.join(',')}])`,
    );
  }
  return result;
}

async function runHolder(rt) {
  
  const peerAt = await waitForPeer(rt);
  const startedAt = Number(process.env.NBF_PROP_STARTED_AT ?? peerAt);
  const contextReadyAt = Number(process.env.NBF_PROP_CONTEXT_READY_AT ?? startedAt);
  out({
    phase: 'ready',
    role: ROLE,
    target: TARGET,
    peerAt,
    startedAt,
    contextReadyAt,
    bootMs: contextReadyAt - startedAt,
    peerConnectMs: peerAt - startedAt,
    peerWaitMs: peerAt - contextReadyAt,
  });

  const t0 = await waitForGo();
  const publishedAt = Date.now();
  await rt.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from(`prop ${publishedAt}\n`));
  out({
    phase: 'published',
    role: ROLE,
    target: TARGET,
    t0,
    publishedAt,
    publishMs: publishedAt - t0,
  });
  diag(`published ${TARGET} in ${publishedAt - t0}ms`);
  const lingerMs =
    Number(process.env.NBF_PROP_HOLDER_LINGER_MS) ||
    MEASURE_TIMEOUT_MS + 500;
  await sleep(lingerMs);
}

const base =
  process.env.NBF_PROP_BASE ?? join(tmpdir(), `nearbytes-prop-${Date.now()}`);
const dataDir = join(base, ROLE);
await mkdir(dataDir, { recursive: true });
const startedAt = Date.now();
process.env.NBF_PROP_STARTED_AT = String(startedAt);

let rt;
try {
  if (existsSync(dataDir) && process.env.NBF_PROP_KEEP !== '1') {
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });
  }
  rt = await makeContext(dataDir);
  const contextReadyAt = Date.now();
  process.env.NBF_PROP_CONTEXT_READY_AT = String(contextReadyAt);
  if (ROLE === 'joiner') {
    await runJoiner(rt);
  } else {
    await runHolder(rt);
  }
} finally {
  if (rt) await rt.destroy().catch(() => {});
  if (process.env.NBF_PROP_KEEP !== '1' && process.env.NBF_PROP_BASE === undefined) {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

process.exit(0);
