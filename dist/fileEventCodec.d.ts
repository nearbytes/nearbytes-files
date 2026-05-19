import type { FileEvent } from './fileEvents.js';
/**
 * Encodes a FileEvent into a UTF-8 JSON byte array.
 * @param event - FileEvent to encode
 * @returns Encoded bytes
 * @throws Error if the event does not match the FileEvent schema
 */
export declare function encodeFileEvent(event: FileEvent): Uint8Array;
/**
 * Decodes a FileEvent from a UTF-8 JSON byte array.
 * @param data - Encoded FileEvent bytes
 * @returns Decoded FileEvent
 * @throws Error if the data is not valid JSON or does not match the FileEvent schema
 */
export declare function decodeFileEvent(data: Uint8Array): FileEvent;
/**
 * Runtime validator for FileEvent objects.
 * @param obj - Value to validate
 * @returns True if the value conforms to FileEvent
 */
export declare function isFileEvent(obj: unknown): obj is FileEvent;
//# sourceMappingURL=fileEventCodec.d.ts.map