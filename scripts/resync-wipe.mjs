#!/usr/bin/env node
/**
 * Wipe local events, blocks, and fetch cursors so the sync engine
 * will re-fetch everything from remote peers on next start.
 *
 * Preserves:
 *   sync/instance.json      — local peer identity
 *   sync/reception.jsonl    — this node's own reception history
 *   ~/.nearbytes/config.json — profile/volume secrets, friends
 *
 * Wipes:
 *   channels/               — stored events
 *   blocks/                 — stored blocks
 *   sync/fetch-cursors/     — per-remote cursor files (resume from seq 0)
 *   sync/fetch-cursors.json — legacy aggregate cursor file (if present)
 *
 * Usage:
 *   node scripts/resync-wipe.mjs [--data-dir /path/to/dataDir] [--dry-run]
 *
 * The NEARBYTES_STORAGE_DIR env var is also respected as the default.
 * The sync daemon or REPL MUST be stopped before running this.
 */

import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataDirIdx = args.indexOf('--data-dir');
const dataDir =
  dataDirIdx !== -1
    ? args[dataDirIdx + 1]
    : (process.env['NEARBYTES_STORAGE_DIR'] ?? join(homedir(), 'nearbytes', 'local'));

if (!dataDir) {
  console.error('error: could not determine dataDir (pass --data-dir or set NEARBYTES_STORAGE_DIR)');
  process.exit(1);
}

const targets = [
  { path: join(dataDir, 'channels'), label: 'channels/' },
  { path: join(dataDir, 'blocks'), label: 'blocks/' },
  { path: join(dataDir, 'sync', 'fetch-cursors'), label: 'sync/fetch-cursors/' },
  { path: join(dataDir, 'sync', 'fetch-cursors.json'), label: 'sync/fetch-cursors.json' },
];

console.log(`dataDir: ${dataDir}`);
if (dryRun) {
  console.log('(dry-run — nothing will be deleted)\n');
}

for (const target of targets) {
  const exists = await access(target.path).then(() => true).catch(() => false);
  if (!exists) {
    console.log(`skip   ${target.label}  (not found)`);
    continue;
  }
  if (dryRun) {
    console.log(`would  rm -rf  ${target.label}`);
    continue;
  }
  await rm(target.path, { recursive: true, force: true });
  console.log(`wiped  ${target.label}`);
}

if (!dryRun) {
  console.log('\nDone. Start the REPL or daemon — sync will re-fetch from seq 0.');
}
