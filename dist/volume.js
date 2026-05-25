import { EventType } from 'nearbytes-crypto';
import { openChannel, loadEventLog, verifyEventLog, } from 'nearbytes-log';
/**
 * @deprecated Prefer `openChannel` from `nearbytes-log`.
 */
export const openVolume = openChannel;
export { loadEventLog, verifyEventLog };
/**
 * Projects file-domain events into a filename → metadata map.
 */
export function replayEvents(entries) {
    const files = new Map();
    for (const entry of entries) {
        const { signedEvent } = entry;
        const { payload } = signedEvent;
        if (payload.type === EventType.CREATE_FILE) {
            const contentAddress = payload.content.protocol === 'nb.content.single.v1'
                ? payload.content.blockHash
                : payload.content.manifestHash;
            files.set(payload.filename, {
                name: payload.filename,
                contentAddress,
                eventHash: entry.eventHash,
            });
        }
        else if (payload.type === EventType.DELETE_FILE) {
            files.delete(payload.filename);
        }
        else if (payload.type === EventType.RENAME_FILE) {
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
export async function materializeVolume(volume, channelStorage, crypto) {
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    return replayEvents(entries);
}
export function getFile(fileSystemState, fileName) {
    return fileSystemState.files.get(fileName);
}
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