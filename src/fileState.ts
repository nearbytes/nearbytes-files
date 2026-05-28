import type { FileEvent, FileMetadata } from './fileEvents.js';
import type { CanonicalEntry } from './fileMaterializer.js';
import { runMaterialization } from './materialization.js';

/**
 * Reconstructs the current file state by replaying an append-only event log.
 *
 * The materializer enforces FILES cascade semantics — implicit directories,
 * recursive DELETE, prefix-swap RENAME, latest-wins target replacement —
 * shared with `volume.ts`'s live replay path.
 */
export function reconstructFileState(events: FileEvent[]): Map<string, FileMetadata> {
  const ordered = [...events].sort((a, b) => {
    const timeDiff = getEventTimestamp(a) - getEventTimestamp(b);
    if (timeDiff !== 0) return timeDiff;
    const nameDiff = compareStrings(getEventPrimaryPath(a), getEventPrimaryPath(b));
    if (nameDiff !== 0) return nameDiff;
    return compareStrings(eventTieBreaker(a), eventTieBreaker(b));
  });

  const entries: CanonicalEntry[] = ordered.map((event, sequence) => ({
    tiebreak: String(sequence),
    event: toCanonical(event),
  }));

  return new Map(runMaterialization(entries).files);
}

function toCanonical(event: FileEvent): CanonicalEntry['event'] {
  if (event.type === 'CREATE_FILE') {
    return {
      kind: 'CREATE_FILE',
      path: event.path,
      blobHash: event.blobHash,
      contentType: event.contentType,
      size: event.size,
      mimeType: event.mimeType,
      createdAt: event.createdAt,
    };
  }
  if (event.type === 'MKDIR') {
    return { kind: 'MKDIR', path: event.path, createdAt: event.createdAt };
  }
  if (event.type === 'DELETE') {
    return { kind: 'DELETE', path: event.path, deletedAt: event.deletedAt };
  }
  return {
    kind: 'RENAME',
    fromPath: event.fromPath,
    toPath: event.toPath,
    renamedAt: event.renamedAt,
  };
}

function getEventTimestamp(event: FileEvent): number {
  if (event.type === 'CREATE_FILE' || event.type === 'MKDIR') return event.createdAt;
  if (event.type === 'DELETE') return event.deletedAt;
  return event.renamedAt;
}

function getEventPrimaryPath(event: FileEvent): string {
  if (event.type === 'RENAME') return event.fromPath;
  return event.path;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function eventTieBreaker(event: FileEvent): string {
  if (event.type === 'CREATE_FILE') return `C:${event.blobHash}`;
  if (event.type === 'MKDIR') return 'M';
  if (event.type === 'RENAME') return `R:${event.toPath}`;
  return 'D';
}
