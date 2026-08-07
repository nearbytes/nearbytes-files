/**
 * Identity verification on the timeline read path (IDENT-20..23).
 *
 * `buildTimelineRows` can only *parse*; signature checking needs crypto and is
 * async, so it runs as a pass over the produced rows. If that pass is dropped,
 * a forged display name renders exactly like a genuine one and nothing else in
 * the system objects — the silent-failure class TEST-40 exists for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLog, openChannel, createSignedEvent } from 'nearbytes-log';
import { createCryptoOperations, createSecret, bytesToHex, EventType } from 'nearbytes-crypto';
import {
  createIdentityRecord,
  publishIdentitySnapshot,
  serializeIdentitySnapshot,
  parseIdentitySnapshotJson,
  IDENTITY_SNAPSHOT_PROTOCOL,
} from 'nearbytes-chat';
import { createFileService } from '../dist/fileService.js';

const HUB = 'hub:shared-secret';

/** Genuine publication plus a forged, newer one from another hub member. */
async function hubWithForgery() {
  const crypto = createCryptoOperations();
  const log = createInMemoryLog();
  const alice = await crypto.deriveKeys(createSecret('alice:secret'));
  const alicePk = bytesToHex(alice.publicKey);

  const record = await createIdentityRecord(crypto, alice, { displayName: 'Alice' }, 1000);
  const published = await publishIdentitySnapshot({ log, crypto }, HUB, alice, record, 'a'.repeat(64), 1000);

  const channel = await openChannel(createSecret(HUB), crypto);
  const hubKeys = await crypto.deriveKeys(channel.secret);
  const stolen = parseIdentitySnapshotJson(published.payload.record);
  const forged = { ...stolen, record: { ...stolen.record, profile: { displayName: 'Eve' } } };
  await log.events.storeEvent(
    hubKeys.publicKey,
    await createSignedEvent(crypto, hubKeys, {
      type: EventType.APP_RECORD,
      protocol: IDENTITY_SNAPSHOT_PROTOCOL,
      authorPublicKey: alicePk,
      record: serializeIdentitySnapshot(forged),
      publishedAt: 9999,
    }, []),
  );

  return { svc: createFileService({ log, crypto }), alicePk };
}

test('every identity row carries a verification verdict', async () => {
  const { svc } = await hubWithForgery();
  const rows = (await svc.getTimeline(HUB)).filter((e) => e.record !== undefined);
  assert.equal(rows.length, 2, 'both events appear on the timeline');
  assert.ok(rows.every((r) => typeof r.verified === 'boolean'), 'no row may be left unjudged');
});

test('a forged display name is rejected and cleared', async () => {
  const { svc } = await hubWithForgery();
  const timeline = await svc.getTimeline(HUB);
  const rows = timeline.filter((e) => e.record !== undefined);

  const rejected = rows.filter((r) => r.verified === false);
  assert.equal(rejected.length, 1, 'exactly the forgery fails verification');
  assert.equal(rejected[0].displayName, undefined, 'displayName must be cleared, not merely flagged');
  assert.match(rejected[0].summary ?? '', /Unverified/);
  assert.ok(!timeline.some((e) => e.displayName === 'Eve'), 'forged name appears nowhere');
});

test('the genuine record keeps its name', async () => {
  const { svc } = await hubWithForgery();
  const verified = (await svc.getTimeline(HUB)).filter((e) => e.verified === true);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].displayName, 'Alice');
});
