import type { Secret, PublicKey, Hash } from 'nearbytes-crypto';
import { EventType } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventLogEntry } from 'nearbytes-log';
import { type Log } from 'nearbytes-log';
import { serializeEventEnvelope } from 'nearbytes-log';
import { eventEnvelopePublicKeyMatches, hydrateSignedEvent } from 'nearbytes-log';

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
export async function openVolume(
  secret: Secret,
  crypto: CryptoOperations
): Promise<Volume> {
  // Derive key pair from secret (deterministic)
  const keyPair = await crypto.deriveKeys(secret);

  return {
    publicKey: keyPair.publicKey,
    secret,
  };
}

/**
 * Loads all events from a volume's event log
 * Events are loaded from storage and returned in deterministic order
 *
 * @param volume - Volume to load events from
 * @param channelStorage - Channel storage instance
 * @returns Array of event log entries, sorted by event hash (deterministic)
 */
export async function loadEventLog(
  volume: Volume,
  channelStorage: Log,
  crypto: CryptoOperations
): Promise<EventLogEntry[]> {
  const keyPair = await crypto.deriveKeys(volume.secret);
  // List all event hashes
  const eventHashes = await channelStorage.events.listEvents(keyPair.publicKey);

  // Load all events
  const entries: EventLogEntry[] = [];
  for (const eventHash of eventHashes) {
    try {
      const signedEvent = await channelStorage.events.retrieveEvent(keyPair.publicKey, eventHash);
      if (!eventEnvelopePublicKeyMatches(signedEvent, keyPair.publicKey)) {
        continue;
      }
      entries.push({
        eventHash,
        signedEvent: await hydrateSignedEvent(crypto, keyPair.privateKey, signedEvent),
      });
    } catch {
      // Skip unreadable/corrupt event files so a single bad entry does not make the whole volume unreadable.
      continue;
    }
  }

  // Sort by event hash (deterministic ordering)
  entries.sort((a, b) => {
    if (a.eventHash < b.eventHash) return -1;
    if (a.eventHash > b.eventHash) return 1;
    return 0;
  });

  return entries;
}

/**
 * Verifies all events in the event log
 * Checks that all events are signed by the volume's public key
 *
 * @param entries - Event log entries to verify
 * @param volume - Volume (contains public key)
 * @param crypto - Cryptographic operations
 * @throws Error if any event signature is invalid
 */
export async function verifyEventLog(
  entries: EventLogEntry[],
  volume: Volume,
  crypto: CryptoOperations
): Promise<void> {
  for (const entry of entries) {
    const payloadBytes = serializeEventEnvelope(entry.signedEvent.envelope);
    const isValid = await crypto.verifyPU(
      payloadBytes,
      entry.signedEvent.signature,
      volume.publicKey
    );

    if (!isValid) {
      throw new Error(
        `Event signature verification failed for event ${entry.eventHash}`
      );
    }
  }
}

/**
 * Replays events to materialize the file system state
 * Processes events in order and builds the final file system state
 *
 * This is a pure function: deterministic replay produces deterministic state
 *
 * @param entries - Event log entries (must be sorted and verified)
 * @returns Materialized file system state
 */
export function replayEvents(entries: EventLogEntry[]): VolumeFileSystemState {
  const files = new Map<string, VolumeFileMetadata>();

  for (const entry of entries) {
    const { signedEvent } = entry;
    const { payload } = signedEvent;

    if (payload.type === EventType.CREATE_FILE) {
      // Resolve the content address from the content descriptor
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
      // Remove file (idempotent: no-op if file doesn't exist)
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
    files: new Map(files), // Make immutable
  };
}

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
export async function materializeVolume(
  volume: Volume,
  channelStorage: Log,
  crypto: CryptoOperations
): Promise<VolumeFileSystemState> {
  // 1. Load all events
  const entries = await loadEventLog(volume, channelStorage, crypto);

  // 2. Verify all event signatures
  await verifyEventLog(entries, volume, crypto);

  // 3. Replay events to materialize state
  return replayEvents(entries);
}

/**
 * Gets a file from a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @param fileName - Name of the file to get
 * @returns File metadata, or undefined if file doesn't exist
 */
export function getFile(
  fileSystemState: VolumeFileSystemState,
  fileName: string
): VolumeFileMetadata | undefined {
  return fileSystemState.files.get(fileName);
}

/**
 * Lists all files in a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @returns Array of file metadata, sorted by file name
 */
export function listFiles(fileSystemState: VolumeFileSystemState): VolumeFileMetadata[] {
  const files = Array.from(fileSystemState.files.values());
  files.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return files;
}
