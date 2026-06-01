/**
 * Regression: inbound sync events must invalidate replay for `ls` even when the
 * volume was never opened via WebDAV/watch (no ReactiveVolume in ctx.volumes).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStorageRoot } from 'nearbytes-skeleton';
import { createContext, attachSyncInboundRefresh } from '../dist/cli/context.js';

process.env.NEARBYTES_SYNC_DISCOVERY = process.env.NEARBYTES_SYNC_DISCOVERY ?? 'mdns';

const PROFILE_SECRET = 'sync-replay-refresh-profile:secret';
const VOLUME_SECRET = 'test:test';
const PROFILE = { name: 'srr', secret: PROFILE_SECRET };
const TARGET = 'sync-replay-refresh.txt';
const POLL_MS = 50;
const PEER_TIMEOUT_MS = 30_000;
const SYNC_BUDGET_MS = 3_000;

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
  console.error(`${label}: inst=${ctx.skeleton.sync.instancePublicKey.slice(0, 8)}`);
  return ctx;
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

async function waitForFile(ctx, path, sinceMs) {
  const deadline = sinceMs + SYNC_BUDGET_MS;
  while (Date.now() < deadline) {
    const names = await ctx.fileService.listFiles(VOLUME_SECRET).then((f) =>
      f.map((x) => x.path).sort(),
    );
    if (names.includes(path)) {
      return Date.now() - sinceMs;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timeout waiting for ${path}`);
}

const root = await mkdtemp(join(tmpdir(), 'nearbytes-sync-replay-refresh-'));

try {
  const aDir = join(root, 'a');
  const bDir = join(root, 'b');
  const a = await makeContext(aDir, 'writer');
  const b = await makeContext(bDir, 'reader');

  await a.fileService.addFile(VOLUME_SECRET, TARGET, Buffer.from('payload'));
  await waitForPeer(a, b);
  const t0 = Date.now();
  const ms = await waitForFile(b, TARGET, t0);
  console.error(`reader sees write via listFiles (no openAndWatch): ${ms}ms`);
  if (ms > SYNC_BUDGET_MS) {
    throw new Error(`too slow: ${ms}ms`);
  }

  await a.destroy();
  await b.destroy();
  console.log(JSON.stringify({ ok: true, ms }));
} finally {
  await rm(root, { recursive: true, force: true });
}
