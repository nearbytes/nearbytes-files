#!/usr/bin/env node
/**
 * Smoke test: PUT bytes, GET them back, PROPFIND reports non-zero getcontentlength.
 *
 * Usage:
 *   node scripts/webdav-roundtrip.mjs [baseUrl] [user] [password] [remotePath]
 *
 * Defaults: https://127.0.0.1:9843 test2 test2 webdav-roundtrip-test.txt
 */

const baseUrl = process.argv[2] ?? 'https://127.0.0.1:9843';
if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const user = process.argv[3] ?? 'test2';
const password = process.argv[4] ?? 'test2';
const remoteName = process.argv[5] ?? 'webdav-roundtrip-test.txt';

const payload = `NEARBYTES_WEBDAV_ROUNDTRIP_${Date.now()}\n`;
const remoteUrl = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(user)}/${encodeURIComponent(remoteName)}`;
const auth = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');

async function main() {
  const putRes = await fetch(remoteUrl, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}` },
    body: payload,
  });
  if (!putRes.ok) {
    console.error(`PUT failed: ${putRes.status} ${putRes.statusText}`);
    process.exit(1);
  }

  const getRes = await fetch(remoteUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const got = await getRes.text();
  if (!getRes.ok || got !== payload) {
    console.error(`GET failed: ${getRes.status} body=${JSON.stringify(got)}`);
    process.exit(1);
  }

  const propfindRes = await fetch(remoteUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: '0',
    },
  });
  const propXml = await propfindRes.text();
  if (!propfindRes.ok) {
    console.error(`PROPFIND failed: ${propfindRes.status}`);
    process.exit(1);
  }
  const lengthMatch = propXml.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/);
  const reported = lengthMatch ? Number(lengthMatch[1]) : -1;
  const expected = Buffer.byteLength(payload);
  if (reported !== expected) {
    console.error(`PROPFIND size mismatch: reported=${reported} expected=${expected}`);
    process.exit(1);
  }

  console.log(`OK PUT/GET/PROPFIND (${expected} bytes) at ${remoteUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
