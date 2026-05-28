import { readFileSync } from 'node:fs';
import { createFilesystemSkeletonFromConfig } from 'nearbytes-skeleton';
import { createFileService } from '../dist/fileService.js';

const config = JSON.parse(readFileSync(`${process.env.HOME}/.nearbytes/config.json`, 'utf8'));
const sk = await createFilesystemSkeletonFromConfig(config);
const fs = createFileService({ log: sk.log, crypto: sk.crypto });
const secret = 'test2:test2';
const live = await fs.getReplayContext(secret);
const h = live.orderedEntries[31].eventHash;
const via = await fs.getReplayContext(secret, { throughEventHash: h, enrichSizes: true });
console.log('via getReplayContext:', via.fs.files.size, 'files');
await sk.destroy();
