import { base64UrlToBytes, bytesToBase64Url, hexToBytes } from 'nearbytes-crypto';
export function canonicalJsonString(value) {
    return JSON.stringify(sortJsonValue(value));
}
export function canonicalJsonBytes(value) {
    return new TextEncoder().encode(canonicalJsonString(value));
}
export function serializeSourceReferenceBundle(bundle) {
    return canonicalJsonString(bundle);
}
export function serializeRecipientReferenceBundle(bundle) {
    return canonicalJsonString(bundle);
}
export function parseSourceReferenceBundle(value) {
    const object = asObject(value, 'Source reference bundle must be an object');
    if (object.p !== 'nb.src.refs.v1') {
        throw new Error('Unsupported source reference bundle protocol');
    }
    const sourceVolumeId = parseVolumeId(object.s, 'Source bundle volume id is invalid');
    const itemsValue = object.items;
    if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
        throw new Error('Source reference bundle must contain at least one item');
    }
    const seenNames = new Set();
    const items = itemsValue.map((item, index) => {
        const parsed = parseSourceBundleItem(item, index);
        if (parsed.ref.s !== sourceVolumeId) {
            throw new Error(`Source reference item ${index} does not match bundle source volume`);
        }
        if (seenNames.has(parsed.name)) {
            throw new Error(`Duplicate source reference filename: ${parsed.name}`);
        }
        seenNames.add(parsed.name);
        return parsed;
    });
    return {
        p: 'nb.src.refs.v1',
        s: sourceVolumeId,
        items,
    };
}
export function parseRecipientReferenceBundle(value) {
    const object = asObject(value, 'Recipient reference bundle must be an object');
    if (object.p !== 'nb.refs.v1') {
        throw new Error('Unsupported recipient reference bundle protocol');
    }
    const recipientVolumeId = parseVolumeId(object.r, 'Recipient bundle volume id is invalid');
    const itemsValue = object.items;
    if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
        throw new Error('Recipient reference bundle must contain at least one item');
    }
    const seenNames = new Set();
    const items = itemsValue.map((item, index) => {
        const parsed = parseRecipientBundleItem(item, index);
        if (parsed.ref.k.r !== recipientVolumeId) {
            throw new Error(`Recipient reference item ${index} does not match bundle recipient volume`);
        }
        if (seenNames.has(parsed.name)) {
            throw new Error(`Duplicate recipient reference filename: ${parsed.name}`);
        }
        seenNames.add(parsed.name);
        return parsed;
    });
    return {
        p: 'nb.refs.v1',
        r: recipientVolumeId,
        items,
    };
}
export function parseSourceFileReferenceValue(value) {
    return parseSourceFileReference(value, 'Source reference');
}
export function parseSourceReferenceJson(text) {
    const parsed = parseJsonProtocol(text);
    if (!parsed || parsed.p !== 'nb.src.refs.v1') {
        return null;
    }
    return parseSourceReferenceBundle(parsed);
}
export function parseRecipientReferenceJson(text) {
    const parsed = parseJsonProtocol(text);
    if (!parsed || parsed.p !== 'nb.refs.v1') {
        return null;
    }
    return parseRecipientReferenceBundle(parsed);
}
export function encodeWrappedKey(bytes) {
    return bytesToBase64Url(bytes);
}
export function decodeWrappedKey(value, label) {
    const bytes = parseBase64Url(value, label);
    if (bytes.length === 0) {
        throw new Error(`${label} cannot be empty`);
    }
    return bytes;
}
function parseSourceBundleItem(value, index) {
    const object = asObject(value, `Source reference item ${index} must be an object`);
    return {
        name: parseFilename(object.name, `Source reference item ${index} name is invalid`),
        mime: parseOptionalString(object.mime, `Source reference item ${index} mime is invalid`),
        createdAt: parseOptionalTimestamp(object.createdAt, `Source reference item ${index} createdAt is invalid`),
        ref: parseSourceFileReference(object.ref, `Source reference item ${index}`),
    };
}
function parseRecipientBundleItem(value, index) {
    const object = asObject(value, `Recipient reference item ${index} must be an object`);
    return {
        name: parseFilename(object.name, `Recipient reference item ${index} name is invalid`),
        mime: parseOptionalString(object.mime, `Recipient reference item ${index} mime is invalid`),
        createdAt: parseOptionalTimestamp(object.createdAt, `Recipient reference item ${index} createdAt is invalid`),
        ref: parseRecipientFileReference(object.ref, `Recipient reference item ${index}`),
    };
}
function parseSourceFileReference(value, label) {
    const object = asObject(value, `${label} source reference must be an object`);
    if (object.p !== 'nb.src.ref.v1') {
        throw new Error(`${label} source reference protocol is invalid`);
    }
    return {
        p: 'nb.src.ref.v1',
        s: parseVolumeId(object.s, `${label} source volume id is invalid`),
        c: parseDescriptor(object.c, `${label} descriptor is invalid`),
        x: parseBase64UrlString(object.x, `${label} wrapped key is invalid`),
    };
}
function parseRecipientFileReference(value, label) {
    const object = asObject(value, `${label} recipient reference must be an object`);
    if (object.p !== 'nb.ref.v1') {
        throw new Error(`${label} recipient reference protocol is invalid`);
    }
    return {
        p: 'nb.ref.v1',
        c: parseDescriptor(object.c, `${label} descriptor is invalid`),
        k: parseRecipientKeyCapsule(object.k, `${label} key capsule is invalid`),
    };
}
function parseRecipientKeyCapsule(value, label) {
    const object = asObject(value, `${label} must be an object`);
    const recipient = parseVolumeId(object.r, `${label} recipient volume id is invalid`);
    const ephemeral = parseBase64Url(object.e, `${label} ephemeral public key is invalid`);
    if (ephemeral.length !== 65) {
        throw new Error(`${label} ephemeral public key must be 65 bytes`);
    }
    const nonce = parseBase64Url(object.n, `${label} nonce is invalid`);
    if (nonce.length !== 12) {
        throw new Error(`${label} nonce must be 12 bytes`);
    }
    const wrapped = parseBase64Url(object.w, `${label} wrapped FEK is invalid`);
    if (wrapped.length === 0) {
        throw new Error(`${label} wrapped FEK cannot be empty`);
    }
    return {
        r: recipient,
        e: bytesToBase64Url(ephemeral),
        n: bytesToBase64Url(nonce),
        w: bytesToBase64Url(wrapped),
    };
}
function parseDescriptor(value, label) {
    const object = asObject(value, `${label} must be an object`);
    const contentType = object.t;
    if (contentType !== 'b' && contentType !== 'm') {
        throw new Error(`${label} content type must be "b" or "m"`);
    }
    const hash = object.h;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
        throw new Error(`${label} hash must be 64 lowercase hex characters`);
    }
    const size = object.z;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new Error(`${label} size must be a non-negative integer`);
    }
    return {
        t: contentType,
        h: hash,
        z: size,
    };
}
function parseVolumeId(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    const normalized = value.toLowerCase();
    const bytes = hexToBytes(normalized);
    if (bytes.length !== 65) {
        throw new Error(message);
    }
    return normalized;
}
function parseFilename(value, message) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(message);
    }
    return value;
}
function parseOptionalString(value, message) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return value;
}
function parseOptionalTimestamp(value, message) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(message);
    }
    return value;
}
function parseBase64Url(value, message) {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    try {
        return base64UrlToBytes(value);
    }
    catch {
        throw new Error(message);
    }
}
function parseBase64UrlString(value, message) {
    const bytes = parseBase64Url(value, message);
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
        if (!parsed || typeof parsed !== 'object') {
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
function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sortJsonValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const sorted = {};
    const objectValue = value;
    for (const key of Object.keys(objectValue).sort((left, right) => left.localeCompare(right))) {
        sorted[key] = sortJsonValue(objectValue[key]);
    }
    return sorted;
}
//# sourceMappingURL=fileReferenceCodec.js.map