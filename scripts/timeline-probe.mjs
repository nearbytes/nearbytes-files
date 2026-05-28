#!/usr/bin/env node
/**
 * Probe replay file counts at timeline positions (no REPL required).
 * Usage: node scripts/timeline-probe.mjs [-d dataDir] <volumeName> [event#|live]
 */
import { readFileSync } from 'node:fs';
import { createFilesystemSkeletonFromConfig } from 'nearbytes-skeleton';
import { createFileService } from '../dist/fileService.js';
import { replayContextThrough } from '../dist/fileEmit.js';

function parseArgs(argv) {
  let dataDir;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-d' && argv[i + 1]) {
      dataDir = argv[++i];
      i += 1;
      continue;
    }
    rest.push(argv[i]);
  }
  return { dataDir, volumeName: rest[0] ?? 'test2', selector: rest[1] ?? 'live' };
}

const { dataDir, volumeName, selector } = parseArgs(process.argv.slice(2));
const configPath = process.env.NEARBYTES_CONFIG ?? `${process.env.HOME}/.nearbytes/config.json`;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (dataDir) config.dataDir = dataDir;

const sessionPath = `${config.dataDir}/.nearbytes/volume-session.json`;
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
const vol = session.volumes.find((v) => v.name === volumeName);
if (!vol) {
  console.error(`Volume "${volumeName}" not in session`);
  process.exit(1);
}

const skeleton = await createFilesystemSkeletonFromConfig(config);
const files = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
const secret = vol.secret;

const live = await files.getReplayContext(secret, { enrichSizes: false });
console.error(`dataDir: ${config.dataDir}`);
console.error(`secret: ${volumeName}`);
console.error(`live: ${live.orderedEntries.length} events, ${live.fs.files.size} files, ${live.fs.directories.size} dirs`);

if (selector === 'live') {
  await skeleton.destroy();
  process.exit(0);
}

const n = Number.parseInt(selector, 10);
let hash;
if (Number.isFinite(n) && String(n) === selector) {
  if (n < 1 || n > live.orderedEntries.length) {
    console.error(`#${n} out of range 1..${live.orderedEntries.length}`);
    process.exit(1);
  }
  hash = live.orderedEntries[n - 1].eventHash;
} else {
  hash = selector;
}

const at = replayContextThrough(live, hash);
console.error(`cursor: event #${live.orderedEntries.findIndex((e) => e.eventHash === hash) + 1}`);
console.error(`hash: ${hash}`);
console.error(`at cursor: ${at.orderedEntries.length} events, ${at.fs.files.size} files, ${at.fs.directories.size} dirs`);
if (at.fs.files.size > 0 && at.fs.files.size <= 10) {
  for (const f of at.fs.files.values()) console.error(`  file: ${f.path}`);
}

await skeleton.destroy();
