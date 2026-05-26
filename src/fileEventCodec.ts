import type { FileEvent } from './fileEvents.js';

/**
 * Encodes a FileEvent into a UTF-8 JSON byte array.
 * @throws Error if the event does not match the FileEvent schema.
 */
export function encodeFileEvent(event: FileEvent): Uint8Array {
  if (!isFileEvent(event)) {
    throw new Error('Invalid FileEvent: cannot encode');
  }
  return new TextEncoder().encode(JSON.stringify(event));
}

/**
 * Decodes a FileEvent from a UTF-8 JSON byte array.
 * @throws Error if the data is not valid JSON or does not match the schema.
 */
export function decodeFileEvent(data: Uint8Array): FileEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    throw new Error(
      `Failed to decode FileEvent: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (!isFileEvent(parsed)) {
    throw new Error('Invalid FileEvent: schema validation failed');
  }
  return parsed;
}

/**
 * Runtime validator for FileEvent objects. Recognizes the four file-events-v0.4
 * variants: CREATE_FILE, MKDIR, DELETE, RENAME.
 */
export function isFileEvent(obj: unknown): obj is FileEvent {
  if (!isRecord(obj)) return false;

  if (obj.type === 'CREATE_FILE') {
    return (
      typeof obj.path === 'string' &&
      typeof obj.blobHash === 'string' &&
      isFiniteUint(obj.size) &&
      isFiniteUint(obj.createdAt) &&
      (obj.mimeType === undefined || typeof obj.mimeType === 'string')
    );
  }
  if (obj.type === 'MKDIR') {
    return typeof obj.path === 'string' && isFiniteUint(obj.createdAt);
  }
  if (obj.type === 'DELETE') {
    return typeof obj.path === 'string' && isFiniteUint(obj.deletedAt);
  }
  if (obj.type === 'RENAME') {
    return (
      typeof obj.fromPath === 'string' &&
      typeof obj.toPath === 'string' &&
      isFiniteUint(obj.renamedAt)
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
