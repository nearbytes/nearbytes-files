import type { Hash } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventLogEntry, Log } from 'nearbytes-log';
import { type Channel, openChannel, loadEventLog, verifyEventLog } from 'nearbytes-log';
/**
 * Volume is a channel identity used by the file protocol.
 * @deprecated Prefer `Channel` from `nearbytes-log` for generic replay.
 */
export type Volume = Channel;
/**
 * @deprecated Prefer `openChannel` from `nearbytes-log`.
 */
export declare const openVolume: typeof openChannel;
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
export declare function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState;
/**
 * Loads the channel log, verifies signatures, and materializes file state.
 */
export declare function materializeVolume(volume: Volume, channelStorage: Log, crypto: CryptoOperations): Promise<VolumeFileSystemState>;
export declare function getFile(fileSystemState: VolumeFileSystemState, fileName: string): VolumeFileMetadata | undefined;
export declare function listFiles(fileSystemState: VolumeFileSystemState): VolumeFileMetadata[];
//# sourceMappingURL=volume.d.ts.map