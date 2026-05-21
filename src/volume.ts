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
  readonly name: string;
  readonly contentAddress: Hash;
  readonly eventHash: Hash;
}

/**
 * Materialized file system state after applying file events to a replayed log.
 */
export interface VolumeFileSystemState {
  readonly files: ReadonlyMap<string, VolumeFileMetadata>;
}

/**
 * Projects file-domain events into a filename → metadata map.
 */
export function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState {
  const files = new Map<string, VolumeFileMetadata>();

  for (const entry of entries) {
    const { signedEvent } = entry;
    const { payload } = signedEvent;

    if (payload.type === EventType.CREATE_FILE) {
      const contentAddress =
        payload.content.protocol === 'nb.content.single.v1'
          ? payload.content.blockHash
          : payload.content.manifestHash;
      files.set(payload.filename, {
        name: payload.filename,
        contentAddress,
        eventHash: entry.eventHash,
      });
    } else if (payload.type === EventType.DELETE_FILE) {
      files.delete(payload.filename);
    } else if (payload.type === EventType.RENAME_FILE) {
      const existing = files.get(payload.filename);
      if (!existing) {
        continue;
      }
      files.delete(payload.filename);
      files.set(payload.toFilename, {
        ...existing,
        name: payload.toFilename,
        eventHash: entry.eventHash,
      });
    }
  }

  return {
    files: new Map(files),
  };
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
  fileName: string,
): VolumeFileMetadata | undefined {
  return fileSystemState.files.get(fileName);
}

export function listFiles(fileSystemState: VolumeFileSystemState): VolumeFileMetadata[] {
  const files = Array.from(fileSystemState.files.values());
  files.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return files;
}
