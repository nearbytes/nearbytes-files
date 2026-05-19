import type { Secret } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { StorageBackend, ChannelPathMapper } from 'nearbytes-storage';
import type { Volume, FileSystemState, FileMetadata } from 'nearbytes-storage';
import type { EventLogEntry } from 'nearbytes-log';
import { type Log } from 'nearbytes-log';
/**
 * Opens a volume from a secret
 * Derives keys, creates volume object, and ensures storage directory exists
 *
 * This is a pure function: same secret always produces same volume
 *
 * @param secret - Volume secret
 * @param crypto - Cryptographic operations
 * @param storage - Storage backend
 * @param pathMapper - Function to map public key to volume path
 * @returns Volume object
 */
export declare function openVolume(secret: Secret, crypto: CryptoOperations, storage: StorageBackend, pathMapper?: ChannelPathMapper): Promise<Volume>;
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
export declare function replayEvents(entries: EventLogEntry[]): FileSystemState;
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
export declare function materializeVolume(volume: Volume, channelStorage: Log, crypto: CryptoOperations): Promise<FileSystemState>;
/**
 * Gets a file from a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @param fileName - Name of the file to get
 * @returns File metadata, or undefined if file doesn't exist
 */
export declare function getFile(fileSystemState: FileSystemState, fileName: string): FileMetadata | undefined;
/**
 * Lists all files in a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @returns Array of file metadata, sorted by file name
 */
export declare function listFiles(fileSystemState: FileSystemState): FileMetadata[];
//# sourceMappingURL=volume.d.ts.map