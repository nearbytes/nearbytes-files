import type { Secret, PublicKey, Hash } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventLogEntry } from 'nearbytes-log';
import { type Log } from 'nearbytes-log';
/**
 * Volume represents a Nearbytes volume
 * A volume is deterministically derived from a secret seed
 * and materializes a file system through event log replay
 */
export interface Volume {
    readonly publicKey: PublicKey;
    readonly secret: Secret;
}
/**
 * File metadata stored in the volume (low-level, from volume replay)
 * Represents a file that exists in the materialized file system
 */
export interface VolumeFileMetadata {
    readonly name: string;
    readonly contentAddress: Hash;
    readonly eventHash: Hash;
}
/**
 * Materialized file system state
 * Represents the current state of files in a volume after replaying all events
 */
export interface VolumeFileSystemState {
    readonly files: ReadonlyMap<string, VolumeFileMetadata>;
}
/**
 * Opens a volume from a secret
 * Derives keys and returns a volume object (no storage concerns)
 *
 * This is a pure function: same secret always produces same volume
 *
 * @param secret - Volume secret
 * @param crypto - Cryptographic operations
 * @returns Volume object
 */
export declare function openVolume(secret: Secret, crypto: CryptoOperations): Promise<Volume>;
/**
 * Loads all events from a volume's event log
 * Events are loaded from storage and returned in deterministic order
 *
 * @param volume - Volume to load events from
 * @param channelStorage - Channel storage instance
 * @returns Array of event log entries, sorted by event hash (deterministic)
 */
export declare function loadEventLog(volume: Volume, channelStorage: Log, crypto: CryptoOperations): Promise<EventLogEntry[]>;
/**
 * Verifies all events in the event log
 * Checks that all events are signed by the volume's public key
 *
 * @param entries - Event log entries to verify
 * @param volume - Volume (contains public key)
 * @param crypto - Cryptographic operations
 * @throws Error if any event signature is invalid
 */
export declare function verifyEventLog(entries: EventLogEntry[], volume: Volume, crypto: CryptoOperations): Promise<void>;
/**
 * Replays events to materialize the file system state
 * Processes events in order and builds the final file system state
 *
 * This is a pure function: deterministic replay produces deterministic state
 *
 * @param entries - Event log entries (must be sorted and verified)
 * @returns Materialized file system state
 */
export declare function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState;
/**
 * Materializes a volume's file system state
 * Loads event log, verifies signatures, and replays events
 *
 * This is the main function for getting the current state of a volume
 *
 * @param volume - Volume to materialize
 * @param channelStorage - Channel storage instance
 * @param crypto - Cryptographic operations
 * @returns Materialized file system state
 */
export declare function materializeVolume(volume: Volume, channelStorage: Log, crypto: CryptoOperations): Promise<VolumeFileSystemState>;
/**
 * Gets a file from a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @param fileName - Name of the file to get
 * @returns File metadata, or undefined if file doesn't exist
 */
export declare function getFile(fileSystemState: VolumeFileSystemState, fileName: string): VolumeFileMetadata | undefined;
/**
 * Lists all files in a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @returns Array of file metadata, sorted by file name
 */
export declare function listFiles(fileSystemState: VolumeFileSystemState): VolumeFileMetadata[];
//# sourceMappingURL=volume.d.ts.map