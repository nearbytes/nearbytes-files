/**
 * Encodes a FileEvent into a UTF-8 JSON byte array.
 * @param event - FileEvent to encode
 * @returns Encoded bytes
 * @throws Error if the event does not match the FileEvent schema
 */
export function encodeFileEvent(event) {
    if (!isFileEvent(event)) {
        throw new Error('Invalid FileEvent: cannot encode');
    }
    const json = JSON.stringify(event);
    return new TextEncoder().encode(json);
}
/**
 * Decodes a FileEvent from a UTF-8 JSON byte array.
 * @param data - Encoded FileEvent bytes
 * @returns Decoded FileEvent
 * @throws Error if the data is not valid JSON or does not match the FileEvent schema
 */
export function decodeFileEvent(data) {
    let parsed;
    try {
        const json = new TextDecoder().decode(data);
        parsed = JSON.parse(json);
    }
    catch (error) {
        throw new Error(`Failed to decode FileEvent: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!isFileEvent(parsed)) {
        throw new Error('Invalid FileEvent: schema validation failed');
    }
    return parsed;
}
/**
 * Runtime validator for FileEvent objects.
 * @param obj - Value to validate
 * @returns True if the value conforms to FileEvent
 */
export function isFileEvent(obj) {
    if (!isRecord(obj)) {
        return false;
    }
    if (obj.type === 'CREATE_FILE') {
        return (typeof obj.filename === 'string' &&
            typeof obj.blobHash === 'string' &&
            isFiniteUint(obj.size) &&
            isFiniteUint(obj.createdAt) &&
            (obj.mimeType === undefined || typeof obj.mimeType === 'string'));
    }
    if (obj.type === 'DELETE_FILE') {
        return typeof obj.filename === 'string' && isFiniteUint(obj.deletedAt);
    }
    if (obj.type === 'RENAME_FILE') {
        return (typeof obj.filename === 'string' &&
            typeof obj.toFilename === 'string' &&
            isFiniteUint(obj.renamedAt));
    }
    return false;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isFiniteUint(value) {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
//# sourceMappingURL=fileEventCodec.js.map