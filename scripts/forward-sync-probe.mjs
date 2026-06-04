/**
 * One-shot: boot sync, open volume, wait for a named file to appear via peer sync.
 */
import { readConfig } from 'nearbytes-skeleton';
import {
  createEngineRuntime,
  openAndWatch,
  reloadVolumeFromDisk,
  attachSyncInboundRefresh,
} from '../../nearbytes-engine/dist/index.js';

const SECRET = process.env.NBF_VOLUME_SECRET ?? 'test:test';
const TARGET = process.env.NBF_TARGET_FILE ?? 'e2e-forward.txt';
const PEER_WAIT_MS = 90_000;
const POLL_MS = 500;

const config = await readConfig();
const rt = await createEngineRuntime(config);
  attachSyncInboundRefresh(rt);
await openAndWatch(rt, SECRET);

const writerOnly = rt.skeleton.sync.daemon !== undefined;
if (writerOnly) {
  console.error('forward-sync-probe: another process holds the sync lock');
  process.exit(2);
}

const deadline = Date.now() + PEER_WAIT_MS;
let sawPeer = false;

while (Date.now() < deadline) {
  const snap = rt.skeleton.sync.snapshot();
  if (snap.connectedPeers > 0) {
    sawPeer = true;
  }
  await reloadVolumeFromDisk(rt, SECRET);
  const replay = await rt.fileService.getReplayContext(SECRET);
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
    await rt.destroy();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

await reloadVolumeFromDisk(rt, SECRET);
const replay = await rt.fileService.getReplayContext(SECRET);
console.log(
  JSON.stringify({
    ok: false,
    sawPeer,
    events: replay.orderedEntries.length,
    files: [...replay.fs.files.keys()].sort(),
    timeout: true,
  }),
);
await rt.destroy();
process.exit(sawPeer ? 1 : 2);
