#!/usr/bin/env node
/**
 * Start WebDAV only (smoke tests). Keeps process alive until SIGTERM.
 *
 * Options:
 *   --debug [areas]     cli, webdav, timing (comma-separated; all if omitted)
 *   --webdav-port <n>   listen port (default 9843)
 */
import { readFileSync } from 'node:fs';
import { createFilesystemSkeletonFromConfig } from 'nearbytes-skeleton';
import { applyDebugOption, parseWebDavPort } from '../dist/debug.js';
import { createFileService } from '../dist/fileService.js';
import { loadVolumeSession } from '../dist/cli/volumeSessionStore.js';
import { createStandaloneWebDavAccess } from '../dist/webdav/standaloneAccess.js';
import { startWebDavServer } from '../dist/webdav/index.js';

function parseArgs(argv) {
  let debugValue;
  let webdavPort = '9843';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        debugValue = next;
        i += 1;
      } else {
        debugValue = true;
      }
      continue;
    }
    if (arg === '--webdav-port' && argv[i + 1] !== undefined) {
      webdavPort = argv[i + 1];
      i += 1;
    }
  }
  return { debugValue, webdavPort };
}

const { debugValue, webdavPort } = parseArgs(process.argv.slice(2));
applyDebugOption(debugValue);

const configPath = process.env.NEARBYTES_CONFIG ?? `${process.env.HOME}/.nearbytes/config.json`;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const port = parseWebDavPort(webdavPort);

const skeleton = await createFilesystemSkeletonFromConfig(config);
const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
const session = await loadVolumeSession(config.dataDir);
const registry = new Map(session.volumes.map((v) => [v.name, v.secret]));
const server = await startWebDavServer({
  fileService,
  access: createStandaloneWebDavAccess(config, registry),
  port,
});
console.error(`WebDAV listening ${server.baseUrl}/ (${registry.size} registered volume(s))`);

const shutdown = async () => {
  await server.close();
  await skeleton.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
