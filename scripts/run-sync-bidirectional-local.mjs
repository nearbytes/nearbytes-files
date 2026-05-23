#!/usr/bin/env node
/**
 * Run alice + bob bidirectional sync test on one machine (two isolated data dirs).
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const testJs = path.join(root, 'dist/scripts/sync-bidirectional-test.js');

const bob = spawn(process.execPath, [testJs], {
  cwd: root,
  env: { ...process.env, NEARBYTES_TEST_ROLE: 'bob', NEARBYTES_TEST_TIMEOUT_MS: '120000' },
  stdio: 'inherit',
});

await new Promise((r) => setTimeout(r, 8000));

const alice = spawn(process.execPath, [testJs], {
  cwd: root,
  env: { ...process.env, NEARBYTES_TEST_ROLE: 'alice', NEARBYTES_TEST_TIMEOUT_MS: '120000' },
  stdio: 'inherit',
});

const codes = await Promise.all([
  new Promise((res) => bob.on('exit', (c) => res(c ?? 1))),
  new Promise((res) => alice.on('exit', (c) => res(c ?? 1))),
]);

const [bobCode, aliceCode] = codes;
if (bobCode !== 0 || aliceCode !== 0) {
  console.error(`Local bidirectional test failed: bob=${bobCode} alice=${aliceCode}`);
  process.exit(1);
}
console.log('Local bidirectional sync test passed.');
