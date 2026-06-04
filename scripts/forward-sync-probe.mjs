/**
 * One-shot: boot sync, open volume, wait for a named file to appear via peer sync.
 */
import { readConfig } from 'nearbytes-skeleton';
import { createContext, openAndWatch, reloadVolumeFromDisk } from '../dist/probeRuntime.js';

const SECRET = process.env.NBF_VOLUME_SECRET ?? 'test:test';
const TARGET = process.env.NBF_TARGET_FILE ?? 'e2e-forward.txt';
const PEER_WAIT_MS = 90_000;
const POLL_MS = 500;

const config = await readConfig();
const ctx = await createContext(config);
await openAndWatch(ctx, SECRET);

const writerOnly = ctx.skeleton.sync.daemon !== undefined;
if (writerOnly) {
  console.error('forward-sync-probe: another process holds the sync lock');
  process.exit(2);
}

const deadline = Date.now() + PEER_WAIT_MS;
let sawPeer = false;

while (Date.now() < deadline) {
  const snap = ctx.skeleton.sync.snapshot();
  if (snap.connectedPeers > 0) {
    sawPeer = true;
  }
  await reloadVolumeFromDisk(ctx, SECRET);
  const replay = await ctx.fileService.getReplayContext(SECRET);
  const names = [...replay.fs.files.keys()].sort();
  if (names.includes(TARGET)) {
    console.log(
      JSON.stringify({
        ok: true,
        connectedPeers: snap.connectedPeers,
        events: replay.orderedEntries.length,
        files: names,
      }),
    );
    await ctx.destroy();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

await reloadVolumeFromDisk(ctx, SECRET);
const replay = await ctx.fileService.getReplayContext(SECRET);
console.log(
  JSON.stringify({
    ok: false,
    sawPeer,
    events: replay.orderedEntries.length,
    files: [...replay.fs.files.keys()].sort(),
    timeout: true,
  }),
);
await ctx.destroy();
process.exit(sawPeer ? 1 : 2);
