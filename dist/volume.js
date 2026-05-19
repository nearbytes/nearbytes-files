import { EventType } from 'nearbytes-crypto';
import { serializeEventEnvelope } from 'nearbytes-log';
import { eventEnvelopePublicKeyMatches, hydrateSignedEvent } from 'nearbytes-log';
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
export async function openVolume(secret, crypto) {
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
export async function loadEventLog(volume, channelStorage, crypto) {
    const keyPair = await crypto.deriveKeys(volume.secret);
    // List all event hashes
    const eventHashes = await channelStorage.events.listEvents(keyPair.publicKey);
    // Load all events
    const entries = [];
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
        }
        catch {
            // Skip unreadable/corrupt event files so a single bad entry does not make the whole volume unreadable.
            continue;
        }
    }
    // Sort by event hash (deterministic ordering)
    entries.sort((a, b) => {
        if (a.eventHash < b.eventHash)
            return -1;
        if (a.eventHash > b.eventHash)
            return 1;
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
export async function verifyEventLog(entries, volume, crypto) {
    for (const entry of entries) {
        const payloadBytes = serializeEventEnvelope(entry.signedEvent.envelope);
        const isValid = await crypto.verifyPU(payloadBytes, entry.signedEvent.signature, volume.publicKey);
        if (!isValid) {
            throw new Error(`Event signature verification failed for event ${entry.eventHash}`);
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
export function replayEvents(entries) {
    const files = new Map();
    for (const entry of entries) {
        const { signedEvent } = entry;
        const { type, fileName, hash } = signedEvent.payload;
        if (type === EventType.CREATE_FILE) {
            // Add or update file
            files.set(fileName, {
                name: fileName,
                contentAddress: hash,
                eventHash: entry.eventHash,
            });
        }
        else if (type === EventType.DELETE_FILE) {
            // Remove file (idempotent: no-op if file doesn't exist)
            files.delete(fileName);
        }
        else if (type === EventType.RENAME_FILE) {
            const existing = files.get(fileName);
            if (!existing) {
                continue;
            }
            files.delete(fileName);
            files.set(signedEvent.payload.toFileName ?? fileName, {
                ...existing,
                name: signedEvent.payload.toFileName ?? fileName,
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
export async function materializeVolume(volume, channelStorage, crypto) {
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
export function getFile(fileSystemState, fileName) {
    return fileSystemState.files.get(fileName);
}
/**
 * Lists all files in a materialized volume
 *
 * @param fileSystemState - Materialized file system state
 * @returns Array of file metadata, sorted by file name
 */
export function listFiles(fileSystemState) {
    const files = Array.from(fileSystemState.files.values());
    files.sort((a, b) => {
        if (a.name < b.name)
            return -1;
        if (a.name > b.name)
            return 1;
        return 0;
    });
    return files;
}
//# sourceMappingURL=volume.js.map