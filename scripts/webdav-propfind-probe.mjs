#!/usr/bin/env node
/** Simulate PROPFIND file listing at live vs historical cursor. */
import { readFileSync } from 'node:fs';
import { createFilesystemSkeletonFromConfig } from 'nearbytes-skeleton';
import { createFileService } from '../dist/fileService.js';
import { replayContextThrough } from '../dist/fileEmit.js';

const config = JSON.parse(
  readFileSync(process.env.NEARBYTES_CONFIG ?? `${process.env.HOME}/.nearbytes/config.json`, 'utf8'),
);
const session = JSON.parse(
  readFileSync(`${config.dataDir}/.nearbytes/volume-session.json`, 'utf8'),
);
const vol = session.volumes.find((v) => v.name === 'test2');
if (!vol) throw new Error('test2 not in session');
const secret = vol.secret;

const skeleton = await createFilesystemSkeletonFromConfig(config);
const files = createFileService({ log: skeleton.log, crypto: skeleton.crypto });

const live = await files.getReplayContext(secret);
const at32 = replayContextThrough(live, live.orderedEntries[31].eventHash);

for (const [label, snap] of [
  ['live', live],
  ['event#32', at32],
]) {
  const names = [...snap.fs.files.values()].map((f) => f.path).sort();
  console.log(`${label}: ${names.length} files`);
  for (const p of names) console.log(`  ${p}`);
}

await skeleton.destroy();
