import type { Hash } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventLogEntry, Log } from 'nearbytes-log';
import {
  type Channel,
  openChannel,
  loadEventLog,
  verifyEventLog,
} from 'nearbytes-log';
import type { DirectoryMetadata } from './fileEvents.js';
import type { MaterializedFileSystem } from './fileMaterializer.js';
import { toCanonicalEntries } from './fileLogEntries.js';
import { runMaterialization } from './materialization.js';

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
 * Replay order follows file-events-v0.5: topological order over the
 * observed-log-head parent, then timestamp/hash among currently ready events.
 */
export function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState {
  const fs = runMaterialization(toCanonicalEntries(entries));

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

/** Projects {@link MaterializedFileSystem} into {@link VolumeFileSystemState} (same shape as {@link replayEvents}). */
export function volumeStateFromMaterialized(fs: MaterializedFileSystem): VolumeFileSystemState {
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
