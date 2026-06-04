/**
 * One-shot: boot sync, wait for a sibling peer, then print test:test replay state.
 * Used to verify parent-event repair after deploying nearbytes-sync fixes.
 */
import { readConfig } from 'nearbytes-skeleton';
import { createContext, openAndWatch, reloadVolumeFromDisk } from '../dist/probeRuntime.js';

const SECRET = 'test:test';
const PEER_WAIT_MS = 90_000;
const POLL_MS = 500;

const config = await readConfig();
const ctx = await createContext(config);
await openAndWatch(ctx, SECRET);

const writerOnly = ctx.skeleton.sync.daemon !== undefined;
if (writerOnly) {
  console.error('sync-repair-probe: another process holds the sync lock (stop yarn repl first)');
  process.exit(2);
}

const deadline = Date.now() + PEER_WAIT_MS;
let sawPeer = false;

while (Date.now() < deadline) {
  const snap = ctx.skeleton.sync.snapshot();
  if (snap.connectedPeers > 0) {
    sawPeer = true;
    await reloadVolumeFromDisk(ctx, SECRET);
    const replay = await ctx.fileService.getReplayContext(SECRET);
    const names = [...replay.fs.files.keys()].sort();
    console.log(
      JSON.stringify({
        connectedPeers: snap.connectedPeers,
        events: replay.orderedEntries.length,
        files: names,
      }),
    );
    if (replay.orderedEntries.length >= 2 && names.length >= 2) {
      await ctx.destroy();
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

await reloadVolumeFromDisk(ctx, SECRET);
const replay = await ctx.fileService.getReplayContext(SECRET);
console.log(
  JSON.stringify({
    sawPeer,
    events: replay.orderedEntries.length,
    files: [...replay.fs.files.keys()].sort(),
    timeout: true,
  }),
);
await ctx.destroy();
process.exit(sawPeer && replay.orderedEntries.length >= 2 ? 0 : 1);
