import { EventType, createSecret, bytesToHex } from 'nearbytes-crypto';
import { createSignedEvent } from 'nearbytes-log';
import { createIdentityRecord, serializeIdentityRecord, verifyIdentityRecord, } from '../chatCodec.js';
import { green, dim, bold, cyan } from './output.js';
import { persistConfig } from './configStore.js';
export async function cmdProfileInit(ctx, profileSecret) {
    const wasOffline = !ctx.config.profileSecret;
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(profileSecret));
    const publicKey = bytesToHex(keyPair.publicKey);
    await persistConfig(ctx, { ...ctx.config, profileSecret });
    console.log(green('✓ Profile secret saved to config'));
    console.log(`${bold('Profile public key:')} ${publicKey}`);
    if (wasOffline) {
        console.log(green('✓ Sync activated — discovery + friend carriage are now live.'));
    }
    console.log(dim('  This is your sync identity — share it for `friend add`. Run `profile publish` to write a display name to the log.'));
}
export async function cmdProfileShow(ctx) {
    if (!ctx.config.profileSecret) {
        throw new Error('No profile secret — run `profile init <secret>` first');
    }
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(ctx.config.profileSecret));
    const publicKey = bytesToHex(keyPair.publicKey);
    console.log(`${bold('Profile public key:')} ${publicKey}`);
    console.log(dim('  Sync joins this profile topic so followers can pull your cache.'));
}
export async function cmdProfilePublish(ctx, displayName, bio) {
    if (!ctx.config.profileSecret) {
        throw new Error('No profile secret — run `profile init <secret>` first');
    }
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
        throw new Error('displayName must be non-empty');
    }
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(ctx.config.profileSecret));
    const publicKey = bytesToHex(keyPair.publicKey);
    const record = await createIdentityRecord(ctx.skeleton.crypto, keyPair, { displayName: trimmed, ...(bio ? { bio } : {}) }, Date.now());
    if (!(await verifyIdentityRecord(ctx.skeleton.crypto, record))) {
        throw new Error('Identity record signature check failed');
    }
    const recordJson = serializeIdentityRecord(record);
    const payload = {
        type: EventType.APP_RECORD,
        protocol: 'nb.identity.record.v1',
        authorPublicKey: publicKey,
        record: recordJson,
        publishedAt: Date.now(),
    };
    const signedEvent = await createSignedEvent(ctx.skeleton.crypto, keyPair, payload, []);
    const eventHash = await ctx.skeleton.log.events.storeEvent(keyPair.publicKey, signedEvent);
    console.log(green(`✓ Published profile “${trimmed}”`));
    console.log(`  Channel:   ${cyan(publicKey)}`);
    console.log(`  Event hash: ${eventHash}`);
    console.log(dim('  Publication is local+log; followers learn your key out-of-band, not from this record alone.'));
}
//# sourceMappingURL=profileCommands.js.map