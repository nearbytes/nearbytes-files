import type { Hash } from 'nearbytes-crypto';
import { EventType } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventLogEntry, Log } from 'nearbytes-log';
import {
  type Channel,
  openChannel,
  loadEventLog,
  verifyEventLog,
} from 'nearbytes-log';
import type { DirectoryMetadata } from './fileEvents.js';
import {
  materialize,
  type CanonicalEntry,
  type CanonicalEvent,
} from './fileMaterializer.js';

/**
 * Volume is a channel identity used by the file protocol.
 * @deprecated Prefer `Channel` from `nearbytes-log` for generic replay.
 */
export type Volume = Channel;

/**
 * @deprecated Prefer `openChannel` from `nearbytes-log`.
 */
export const openVolume = openChannel;

export { loadEventLog, verifyEventLog };

/**
 * File metadata stored in the volume (low-level, from file-event replay).
 */
export interface VolumeFileMetadata {
  readonly path: string;
  readonly contentAddress: Hash;
  readonly eventHash: Hash;
}

/**
 * Materialized file system state after applying file events to a replayed
 * log. The map of directories is *non-empty* if any file lives at a nested
 * path (implicit ancestors) or if any MKDIR event has been replayed.
 */
export interface VolumeFileSystemState {
  readonly files: ReadonlyMap<string, VolumeFileMetadata>;
  readonly directories: ReadonlyMap<string, DirectoryMetadata>;
}

/**
 * Projects file-domain events into the materialized volume state.
 *
 * Replay order is the file-events-v0.4 total order: timestamp → log
 * sequence → event hash. `entries` is assumed to already be sorted by
 * `nearbytes-log`'s `loadEventLog` (which guarantees a stable hash-based
 * order) and the per-event timestamp is the primary key here.
 */
export function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState {
  const canonical: CanonicalEntry[] = entries
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

  const fs = materialize(canonical);

  const files = new Map<string, VolumeFileMetadata>();
  for (const [, meta] of fs.files) {
    const origin = fs.fileOrigins.get(meta.path);
    if (origin === undefined) {
      throw new Error(`Materialized file "${meta.path}" has no originating CREATE_FILE event`);
    }
    files.set(meta.path, {
      path: meta.path,
      contentAddress: meta.blobHash as Hash,
      eventHash: origin as Hash,
    });
  }

  return { files, directories: new Map(fs.directories) };
}

/**
 * Loads the channel log, verifies signatures, and materializes file state.
 */
export async function materializeVolume(
  volume: Volume,
  channelStorage: Log,
  crypto: CryptoOperations,
): Promise<VolumeFileSystemState> {
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);
  return replayEvents(entries);
}

export function getFile(
  fileSystemState: VolumeFileSystemState,
  path: string,
): VolumeFileMetadata | undefined {
  return fileSystemState.files.get(path);
}

export function listFiles(fileSystemState: VolumeFileSystemState): VolumeFileMetadata[] {
  const files = Array.from(fileSystemState.files.values());
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function listDirectories(state: VolumeFileSystemState): DirectoryMetadata[] {
  const dirs = Array.from(state.directories.values());
  dirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return dirs;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
  return {
    kind: 'OTHER',
    verb: String(payload.type),
    timestamp: extractTimestamp(entry, 0),
  };
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

