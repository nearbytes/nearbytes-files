import { createPublicKey } from 'nearbytes-crypto';
import { createHash, createSignature } from 'nearbytes-crypto';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes } from 'nearbytes-crypto';
import { canonicalJsonBytes, canonicalJsonString, } from './fileReferenceCodec.js';
export async function createIdentityRecord(crypto, keyPair, profile, timestamp) {
    const unsigned = canonicalIdentityRecord(keyPair.publicKey, profile, timestamp);
    const signature = await crypto.signPR(canonicalJsonBytes(unsigned), keyPair.privateKey);
    return {
        ...unsigned,
        sig: bytesToBase64Url(signature),
    };
}
export async function verifyIdentityRecord(crypto, record) {
    const publicKey = publicKeyFromHex(record.k);
    const unsigned = canonicalIdentityRecord(publicKey, record.profile, record.ts);
    return crypto.verifyPU(canonicalJsonBytes(unsigned), createSignature(base64UrlToBytes(record.sig)), publicKey);
}
export async function createChatMessage(crypto, keyPair, input) {
    const unsigned = canonicalChatMessage(keyPair.publicKey, input.body, input.timestamp);
    const signature = await crypto.signPR(canonicalJsonBytes(unsigned), keyPair.privateKey);
    return {
        ...unsigned,
        sig: bytesToBase64Url(signature),
    };
}
export async function verifyChatMessage(crypto, message) {
    const publicKey = publicKeyFromHex(message.k);
    const unsigned = canonicalChatMessage(publicKey, message.body, message.ts);
    return crypto.verifyPU(canonicalJsonBytes(unsigned), createSignature(base64UrlToBytes(message.sig)), publicKey);
}
export async function createIdentitySnapshot(crypto, keyPair, input) {
    const unsigned = canonicalIdentitySnapshot(keyPair.publicKey, input.record, input.ref, input.timestamp);
    const signature = await crypto.signPR(canonicalJsonBytes(unsigned), keyPair.privateKey);
    return {
        ...unsigned,
        sig: bytesToBase64Url(signature),
    };
}
export async function verifyIdentitySnapshot(crypto, snapshot) {
    const publicKey = publicKeyFromHex(snapshot.k);
    if (!(await verifyIdentityRecord(crypto, snapshot.record))) {
        return false;
    }
    const unsigned = canonicalIdentitySnapshot(publicKey, snapshot.record, snapshot.ref, snapshot.ts);
    return crypto.verifyPU(canonicalJsonBytes(unsigned), createSignature(base64UrlToBytes(snapshot.sig)), publicKey);
}
export function serializeIdentityRecord(record) {
    return canonicalJsonString(record);
}
export function serializeIdentitySnapshot(snapshot) {
    return canonicalJsonString(snapshot);
}
export function serializeChatMessage(message) {
    return canonicalJsonString(message);
}
export function parseIdentityRecord(value) {
    const object = asObject(value, 'Identity record must be an object');
    if (object.p !== 'nb.identity.record.v1') {
        throw new Error('Unsupported identity record protocol');
    }
    const publicKey = parsePublicKeyHex(object.k, 'Identity record public key is invalid');
    const ts = parseTimestamp(object.ts, 'Identity record timestamp is invalid');
    const profile = parseIdentityProfile(object.profile);
    const sig = parseBase64UrlString(object.sig, 'Identity record signature is invalid');
    return {
        p: 'nb.identity.record.v1',
        k: publicKey,
        ts,
        profile,
        sig,
    };
}
export function parseIdentityRecordJson(text) {
    const parsed = parseJsonProtocol(text);
    if (!parsed || parsed.p !== 'nb.identity.record.v1') {
        return null;
    }
    return parseIdentityRecord(parsed);
}
export function parseIdentitySnapshot(value) {
    const object = asObject(value, 'Identity snapshot must be an object');
    if (object.p !== 'nb.identity.snapshot.v1') {
        throw new Error('Unsupported identity snapshot protocol');
    }
    const publicKey = parsePublicKeyHex(object.k, 'Identity snapshot public key is invalid');
    const ts = parseTimestamp(object.ts, 'Identity snapshot timestamp is invalid');
    const ref = parseIdentitySnapshotRef(object.ref);
    const record = parseIdentityRecord(object.record);
    if (record.k !== publicKey) {
        throw new Error('Identity snapshot record key does not match snapshot public key');
    }
    if (ref.channel !== publicKey) {
        throw new Error('Identity snapshot channel does not match snapshot public key');
    }
    const sig = parseBase64UrlString(object.sig, 'Identity snapshot signature is invalid');
    return {
        p: 'nb.identity.snapshot.v1',
        k: publicKey,
        ts,
        ref,
        record,
        sig,
    };
}
export function parseIdentitySnapshotJson(text) {
    const parsed = parseJsonProtocol(text);
    if (!parsed || parsed.p !== 'nb.identity.snapshot.v1') {
        return null;
    }
    return parseIdentitySnapshot(parsed);
}
export function parseChatMessage(value) {
    const object = asObject(value, 'Chat message must be an object');
    if (object.p !== 'nb.chat.message.v1') {
        throw new Error('Unsupported chat message protocol');
    }
    const publicKey = parsePublicKeyHex(object.k, 'Chat message public key is invalid');
    const ts = parseTimestamp(object.ts, 'Chat message timestamp is invalid');
    const body = parseRequiredTrimmedString(object.body, 'Chat message body is required');
    const sig = parseBase64UrlString(object.sig, 'Chat message signature is invalid');
    return {
        p: 'nb.chat.message.v1',
        k: publicKey,
        ts,
        body,
        sig,
    };
}
export function parseChatMessageJson(text) {
    const parsed = parseJsonProtocol(text);
    if (!parsed || parsed.p !== 'nb.chat.message.v1') {
        return null;
    }
    return parseChatMessage(parsed);
}
function canonicalIdentityRecord(publicKey, profile, timestamp) {
    return {
        p: 'nb.identity.record.v1',
        k: bytesToHex(publicKey),
        ts: timestamp,
        profile: normalizeIdentityProfile(profile),
    };
}
function canonicalIdentitySnapshot(publicKey, record, ref, timestamp) {
    const normalizedRecord = parseIdentityRecord(record);
    const snapshotPublicKey = bytesToHex(publicKey);
    if (normalizedRecord.k !== snapshotPublicKey) {
        throw new Error('Identity snapshot record key does not match signer key');
    }
    const channel = parsePublicKeyHex(ref.channel, 'Identity snapshot channel is invalid');
    if (channel !== snapshotPublicKey) {
        throw new Error('Identity snapshot channel does not match signer key');
    }
    return {
        p: 'nb.identity.snapshot.v1',
        k: snapshotPublicKey,
        ts: timestamp,
        ref: {
            channel,
            eventHash: parseEventHashHex(ref.eventHash, 'Identity snapshot event hash is invalid'),
        },
        record: normalizedRecord,
    };
}
function canonicalChatMessage(publicKey, body, timestamp) {
    const normalizedBody = body.trim();
    if (!normalizedBody) {
        throw new Error('Chat message body must not be empty');
    }
    return {
        p: 'nb.chat.message.v1',
        k: bytesToHex(publicKey),
        ts: timestamp,
        body: normalizedBody,
    };
}
function normalizeIdentityProfile(profile) {
    const displayName = profile.displayName.trim();
    if (displayName.length === 0) {
        throw new Error('Identity displayName is required');
    }
    const bio = normalizeOptionalString(profile.bio);
    return bio ? { displayName, bio } : { displayName };
}
function parseIdentityProfile(value) {
    const object = asObject(value, 'Identity profile must be an object');
    return normalizeIdentityProfile({
        displayName: parseRequiredString(object.displayName, 'Identity display name is invalid'),
        bio: parseOptionalTrimmedString(object.bio, 'Identity bio is invalid'),
    });
}
function parseIdentitySnapshotRef(value) {
    const object = asObject(value, 'Identity snapshot ref must be an object');
    return {
        channel: parsePublicKeyHex(object.channel, 'Identity snapshot channel is invalid'),
        eventHash: parseEventHashHex(object.eventHash, 'Identity snapshot event hash is invalid'),
    };
}
function normalizeOptionalString(value) {
    if (value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function parsePublicKeyHex(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return bytesToHex(publicKeyFromHex(value));
}
function parseEventHashHex(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return createHash(value);
}
export function publicKeyFromHex(value) {
    const bytes = hexToBytes(value.toLowerCase());
    if (bytes.length !== 65) {
        throw new Error('Identity public key must be 65 bytes');
    }
    return createPublicKey(bytes);
}
function parseRequiredString(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return value;
}
function parseRequiredTrimmedString(value, message) {
    const s = parseRequiredString(value, message);
    const trimmed = s.trim();
    if (!trimmed) {
        throw new Error(message);
    }
    return trimmed;
}
function parseOptionalTrimmedString(value, message) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return normalizeOptionalString(value);
}
function parseTimestamp(value, message) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(message);
    }
    return value;
}
function parseBase64UrlString(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    const bytes = base64UrlToBytes(value);
    if (bytes.length === 0) {
        throw new Error(message);
    }
    return bytesToBase64Url(bytes);
}
function parseJsonProtocol(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function asObject(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(message);
    }
    return value;
}
//# sourceMappingURL=chatCodec.js.map