import { EventType } from 'nearbytes-crypto';
import type { EventLogEntry } from 'nearbytes-log';
import type { CanonicalEntry, CanonicalEvent } from './fileMaterializer.js';

export function toCanonicalEntries(entries: EventLogEntry[]): CanonicalEntry[] {
  return entries
    .map((entry, sequence) => ({
      timestamp: extractTimestamp(entry, sequence),
      sequence,
      tiebreak: entry.eventHash,
      entry,
    }))
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      return left.tiebreak < right.tiebreak ? -1 : left.tiebreak > right.tiebreak ? 1 : 0;
    })
    .map(({ entry, tiebreak }) => ({ tiebreak, event: toCanonicalEvent(entry) }));
}

function toCanonicalEvent(entry: EventLogEntry): CanonicalEvent {
  const payload = entry.signedEvent.payload;
  if (payload.type === EventType.CREATE_FILE) {
    const blobHash =
      payload.content.protocol === 'nb.content.single.v1'
        ? payload.content.blockHash
        : payload.content.manifestHash;
    const contentType: 'b' | 'm' =
      payload.content.protocol === 'nb.content.manifest.v1' ? 'm' : 'b';
    return {
      kind: 'CREATE_FILE',
      path: payload.path,
      blobHash,
      contentType,
      size: 0,
      mimeType: payload.mimeType,
      createdAt: payload.createdAt,
    };
  }
  if (payload.type === EventType.MKDIR) {
    return { kind: 'MKDIR', path: payload.path, createdAt: payload.createdAt };
  }
  if (payload.type === EventType.DELETE) {
    return { kind: 'DELETE', path: payload.path, deletedAt: payload.deletedAt };
  }
  if (payload.type === EventType.RENAME) {
    return {
      kind: 'RENAME',
      fromPath: payload.fromPath,
      toPath: payload.toPath,
      renamedAt: payload.renamedAt,
    };
  }
  return { kind: 'OTHER', verb: String(payload.type), timestamp: extractTimestamp(entry, 0) };
}

function extractTimestamp(entry: EventLogEntry, fallback: number): number {
  const payload = entry.signedEvent.payload;
  if (payload.type === EventType.CREATE_FILE) return payload.createdAt;
  if (payload.type === EventType.MKDIR) return payload.createdAt;
  if (payload.type === EventType.DELETE) return payload.deletedAt;
  if (payload.type === EventType.RENAME) return payload.renamedAt;
  if (payload.type === EventType.DECLARE_IDENTITY) return payload.publishedAt ?? fallback;
  if (payload.type === EventType.CHAT_MESSAGE) return payload.publishedAt ?? fallback;
  if (payload.type === EventType.APP_RECORD) return payload.publishedAt;
  return fallback;
}
