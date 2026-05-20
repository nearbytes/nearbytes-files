import { createSecret } from 'nearbytes-crypto';
import { createEncryptedData, EMPTY_HASH, EventType, createHash } from 'nearbytes-crypto';
import { DecryptionError } from 'nearbytes-crypto';
import { serializeEvent, serializeEventEnvelope, serializeInnerEventPayloadJson } from 'nearbytes-log';
import { createSignedEvent } from 'nearbytes-log';
import { openVolume, loadEventLog, verifyEventLog } from './volume.js';
import { parseChatMessageJson, parseIdentityRecordJson, parseIdentitySnapshotJson, } from './chatCodec.js';
import { createRecipientKeyCapsule, decryptFileForVolume, encryptFileForVolume, publicKeyFromVolumeId, unwrapFileKeyForVolume, unwrapRecipientKeyCapsule, volumeIdFromPublicKey, wrapFileKeyForVolume, } from './fileCrypto.js';
import { decodeWrappedKey, encodeWrappedKey, parseRecipientReferenceBundle, parseSourceReferenceBundle, serializeRecipientReferenceBundle, serializeSourceReferenceBundle, } from './fileReferenceCodec.js';
import { dedupeOrderedFilenames, resolveImportedFilename } from './fileCommands.js';
/**
 * Creates a dependency-injected file service for testing or custom storage.
 * @param dependencies - Crypto, storage, log, and optional path mapper/time source
 * @returns File service implementation
 */
export function createFileService(dependencies) {
    const channelStorage = dependencies.log;
    const now = dependencies.now ?? (() => Date.now());
    return {
        addFile: async (secret, filename, data, mimeType) => addFileWithDeps(secret, filename, data, mimeType, dependencies.crypto, channelStorage, now),
        deleteFile: async (secret, filename) => deleteFileWithDeps(secret, filename, dependencies.crypto, channelStorage, now),
        listFiles: async (secret) => listFilesWithDeps(secret, dependencies.crypto, channelStorage),
        getFile: async (secret, blobHash) => getFileWithDeps(secret, blobHash, dependencies.crypto, channelStorage),
        renameFile: async (secret, fromName, toName) => renameFileWithDeps(secret, fromName, toName, dependencies.crypto, channelStorage, now),
        renameFolder: async (secret, fromFolder, toFolder, options) => renameFolderWithDeps(secret, fromFolder, toFolder, options?.merge ?? false, dependencies.crypto, channelStorage, now),
        computeSnapshot: async (secret) => computeSnapshotWithDeps(secret, dependencies.crypto, channelStorage, now),
        getTimeline: async (secret) => getTimelineWithDeps(secret, dependencies.crypto, channelStorage),
        getTimelineDelta: async (secret, afterEventHash) => getTimelineDeltaWithDeps(secret, afterEventHash, dependencies.crypto, channelStorage),
        getEvent: async (secret, eventHash) => getEventWithDeps(secret, eventHash, dependencies.crypto, channelStorage),
        exportSourceReferences: async (secret, filenames) => exportSourceReferencesWithDeps(secret, filenames, dependencies.crypto, channelStorage, now),
        importSourceReferences: async (destinationSecret, bundle, sourceSecret) => importSourceReferencesWithDeps(destinationSecret, bundle, sourceSecret, dependencies.crypto, channelStorage, now),
        exportRecipientReferences: async (secret, filenames, recipientVolumeId) => exportRecipientReferencesWithDeps(secret, filenames, recipientVolumeId, dependencies.crypto, channelStorage, now),
        importRecipientReferences: async (secret, bundle) => importRecipientReferencesWithDeps(secret, bundle, dependencies.crypto, channelStorage, now),
    };
}
async function addFileWithDeps(secret, filename, data, mimeType, crypto, channelStorage, now) {
    assertNonEmptyFilename(filename);
    const normalizedSecret = normalizeSecret(secret);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, data);
    await channelStorage.blocks.store(encrypted.blobHash, encrypted.encryptedData, true, keyPair.publicKey);
    const createdAt = now();
    await appendCreateEvent(channelStorage, crypto, keyPair, {
        filename,
        blobHash: encrypted.blobHash,
        encryptedKey: encrypted.encryptedKey,
        contentType: encrypted.contentType,
        size: data.length,
        mimeType,
        createdAt,
    });
    return {
        filename,
        blobHash: encrypted.blobHash,
        contentType: encrypted.contentType,
        size: data.length,
        mimeType,
        createdAt,
    };
}
async function deleteFileWithDeps(secret, filename, crypto, channelStorage, now) {
    assertNonEmptyFilename(filename);
    const normalizedSecret = normalizeSecret(secret);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    const deletedAt = now();
    await appendDeleteEvent(channelStorage, crypto, keyPair, filename, deletedAt);
}
async function renameFolderWithDeps(secret, fromFolder, toFolder, merge, crypto, channelStorage, now) {
    const normalizedFrom = normalizeFolderPath(fromFolder);
    const normalizedTo = normalizeFolderPath(toFolder);
    if (normalizedFrom.length === 0 || normalizedTo.length === 0) {
        throw new Error('Folder names are required');
    }
    if (normalizedFrom === normalizedTo) {
        throw new Error('Source and destination folders are the same');
    }
    const normalizedSecret = normalizeSecret(secret);
    const volume = await openVolume(normalizedSecret, crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    const files = materializeFilesFromEntries(entries);
    const sourceFiles = files.filter((file) => file.filename.startsWith(`${normalizedFrom}/`));
    if (sourceFiles.length === 0) {
        throw new Error(`Folder "${normalizedFrom}" is empty or does not exist`);
    }
    const existingByName = new Map(files.map((file) => [file.filename, file]));
    const sourceNameSet = new Set(sourceFiles.map((file) => file.filename));
    const plan = sourceFiles
        .map((file) => ({
        fromName: file.filename,
        toName: `${normalizedTo}/${file.filename.slice(normalizedFrom.length + 1)}`,
        file,
    }))
        .sort((left, right) => left.fromName.localeCompare(right.fromName));
    const duplicateTargets = new Set();
    const targetSet = new Set();
    for (const item of plan) {
        if (targetSet.has(item.toName)) {
            duplicateTargets.add(item.toName);
            continue;
        }
        targetSet.add(item.toName);
    }
    if (duplicateTargets.size > 0) {
        throw new Error('Rename would produce duplicate target paths');
    }
    const conflicts = plan.filter((item) => {
        const existing = existingByName.get(item.toName);
        if (!existing)
            return false;
        return !sourceNameSet.has(item.toName);
    });
    if (conflicts.length > 0 && !merge) {
        throw new Error(`Destination folder already contains ${conflicts.length} file(s). Retry with merge enabled.`);
    }
    const timeline = mapEntriesToTimeline(entries);
    const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
    const baseTimestamp = Math.max(now(), maxTimestamp + 1);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    let cursor = baseTimestamp;
    for (const item of plan) {
        await appendRenameEvent(channelStorage, crypto, keyPair, item.fromName, item.toName, cursor);
        cursor += 1;
    }
    return {
        fromFolder: normalizedFrom,
        toFolder: normalizedTo,
        movedFiles: plan.length,
        mergedConflicts: conflicts.length,
    };
}
async function renameFileWithDeps(secret, fromName, toName, crypto, channelStorage, now) {
    assertNonEmptyFilename(fromName);
    assertNonEmptyFilename(toName);
    if (fromName === toName) {
        throw new Error('Source and destination file names are the same');
    }
    const normalizedSecret = normalizeSecret(secret);
    const volume = await openVolume(normalizedSecret, crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    const files = materializeFilesFromEntries(entries);
    if (!files.some((file) => file.filename === fromName)) {
        throw new Error(`File "${fromName}" does not exist`);
    }
    if (files.some((file) => file.filename === toName)) {
        throw new Error(`File "${toName}" already exists`);
    }
    const timeline = mapEntriesToTimeline(entries);
    const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
    const renamedAt = Math.max(now(), maxTimestamp + 1);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    await appendRenameEvent(channelStorage, crypto, keyPair, fromName, toName, renamedAt);
    return {
        fromName,
        toName,
    };
}
async function listFilesWithDeps(secret, crypto, channelStorage) {
    const volume = await openVolume(normalizeSecret(secret), crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    return materializeFilesFromEntries(entries);
}
async function getFileWithDeps(secret, blobHash, crypto, channelStorage) {
    const normalizedSecret = normalizeSecret(secret);
    const volume = await openVolume(normalizedSecret, crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    const currentFile = materializeStoredFilesFromEntries(entries).find((file) => file.blobHash === blobHash);
    if (!currentFile) {
        throw new DecryptionError('File is not available in the active volume');
    }
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    const encryptedData = await channelStorage.blocks.retrieve(blobHash, keyPair.publicKey);
    const plaintext = await decryptFileForVolume(crypto, keyPair.privateKey, encryptedData, currentFile.encryptedKey);
    return Buffer.from(plaintext);
}
async function computeSnapshotWithDeps(secret, crypto, channelStorage, now) {
    const volume = await openVolume(normalizeSecret(secret), crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    const generatedAt = now();
    const files = materializeFilesFromEntries(entries);
    const lastEventHash = entries.length > 0 ? entries[entries.length - 1].eventHash : null;
    return {
        generatedAt,
        eventCount: entries.length,
        fileCount: files.length,
        lastEventHash,
    };
}
async function getTimelineWithDeps(secret, crypto, channelStorage) {
    const volume = await openVolume(normalizeSecret(secret), crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    return mapEntriesToTimeline(entries);
}
async function getTimelineDeltaWithDeps(secret, afterEventHash, crypto, channelStorage) {
    // docs/specs/application/hash-cursor-refresh-v0.1.md
    const volume = await openVolume(normalizeSecret(secret), crypto);
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    const timeline = mapEntriesToTimeline(entries);
    const requestedCursor = normalizeTimelineCursor(afterEventHash);
    const nextCursor = timeline.at(-1)?.eventHash ?? null;
    if (!requestedCursor) {
        return {
            requestedCursor: null,
            acceptedCursor: null,
            nextCursor,
            reset: true,
            eventCount: timeline.length,
            totalEventCount: timeline.length,
            events: timeline,
        };
    }
    const cursorIndex = timeline.findIndex((event) => event.eventHash === requestedCursor);
    if (cursorIndex < 0) {
        return {
            requestedCursor,
            acceptedCursor: null,
            nextCursor,
            reset: true,
            eventCount: timeline.length,
            totalEventCount: timeline.length,
            events: timeline,
        };
    }
    const events = timeline.slice(cursorIndex + 1);
    return {
        requestedCursor,
        acceptedCursor: requestedCursor,
        nextCursor,
        reset: false,
        eventCount: events.length,
        totalEventCount: timeline.length,
        events,
    };
}
function normalizeTimelineCursor(afterEventHash) {
    const normalized = afterEventHash?.trim().toLowerCase() ?? '';
    if (!normalized) {
        return null;
    }
    return normalized;
}
async function getEventWithDeps(secret, eventHash, crypto, channelStorage) {
    const volume = await openVolume(normalizeSecret(secret), crypto);
    const hash = createHash(eventHash);
    const keyPair = await crypto.deriveKeys(volume.secret);
    const signedEvent = await channelStorage.events.retrieveEvent(keyPair.publicKey, hash);
    const payloadBytes = serializeEventEnvelope(signedEvent.envelope);
    const isValid = await crypto.verifyPU(payloadBytes, signedEvent.signature, volume.publicKey);
    if (!isValid) {
        throw new Error(`Event signature verification failed for event ${hash}`);
    }
    const entries = await loadEventLog(volume, channelStorage, crypto);
    const entry = entries.find((candidate) => candidate.eventHash === hash);
    return {
        eventHash: hash,
        event: serializeEvent(signedEvent),
        decryptedPayload: entry ? serializeInnerEventPayloadJson(entry.signedEvent.payload) : undefined,
    };
}
async function exportSourceReferencesWithDeps(secret, filenames, crypto, channelStorage, now) {
    const normalizedSecret = normalizeSecret(secret);
    const orderedFilenames = dedupeOrderedFilenames(filenames);
    if (orderedFilenames.length === 0) {
        throw new Error('At least one filename is required');
    }
    const volume = await openVolume(normalizedSecret, crypto);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    let { files } = await loadVolumeFiles(crypto, channelStorage, volume);
    let upgradedCount = 0;
    upgradedCount += await upgradeLegacyFilesForExport(orderedFilenames, files, keyPair, crypto, channelStorage, now);
    if (upgradedCount > 0) {
        ({ files } = await loadVolumeFiles(crypto, channelStorage, volume));
    }
    const fileMap = new Map(files.map((file) => [file.filename, file]));
    const bundle = {
        p: 'nb.src.refs.v1',
        s: volumeIdFromPublicKey(keyPair.publicKey),
        items: orderedFilenames.map((filename) => {
            const file = requireStoredFile(fileMap, filename);
            return {
                name: file.filename,
                mime: file.mimeType,
                createdAt: file.createdAt,
                ref: {
                    p: 'nb.src.ref.v1',
                    s: volumeIdFromPublicKey(keyPair.publicKey),
                    c: {
                        t: file.contentType,
                        h: file.blobHash,
                        z: file.size,
                    },
                    x: encodeWrappedKey(file.encryptedKey),
                },
            };
        }),
    };
    return {
        bundle,
        serialized: serializeSourceReferenceBundle(bundle),
        upgradedCount,
    };
}
async function importSourceReferencesWithDeps(destinationSecret, bundleValue, sourceSecret, crypto, channelStorage, now) {
    const bundle = parseSourceReferenceBundle(bundleValue);
    const normalizedDestinationSecret = normalizeSecret(destinationSecret);
    const normalizedSourceSecret = normalizeSecret(sourceSecret);
    const destinationKeyPair = await crypto.deriveKeys(normalizedDestinationSecret);
    const sourceKeyPair = await crypto.deriveKeys(normalizedSourceSecret);
    const sourceVolumeId = volumeIdFromPublicKey(sourceKeyPair.publicKey);
    if (bundle.s !== sourceVolumeId) {
        throw new Error('Source reference bundle does not match the provided source volume');
    }
    const destinationVolume = await openVolume(normalizedDestinationSecret, crypto);
    const { entries, files } = await loadVolumeFiles(crypto, channelStorage, destinationVolume);
    const imported = await importSourceBundleItems(bundle, files, entries, destinationKeyPair, sourceKeyPair, crypto, channelStorage, now);
    return { imported };
}
async function exportRecipientReferencesWithDeps(secret, filenames, recipientVolumeId, crypto, channelStorage, now) {
    const normalizedSecret = normalizeSecret(secret);
    const orderedFilenames = dedupeOrderedFilenames(filenames);
    if (orderedFilenames.length === 0) {
        throw new Error('At least one filename is required');
    }
    publicKeyFromVolumeId(recipientVolumeId);
    const volume = await openVolume(normalizedSecret, crypto);
    const keyPair = await crypto.deriveKeys(normalizedSecret);
    let { files } = await loadVolumeFiles(crypto, channelStorage, volume);
    let upgradedCount = 0;
    upgradedCount += await upgradeLegacyFilesForExport(orderedFilenames, files, keyPair, crypto, channelStorage, now);
    if (upgradedCount > 0) {
        ({ files } = await loadVolumeFiles(crypto, channelStorage, volume));
    }
    const fileMap = new Map(files.map((file) => [file.filename, file]));
    const items = [];
    for (const filename of orderedFilenames) {
        const file = requireStoredFile(fileMap, filename);
        const fileKey = await unwrapFileKeyForVolume(crypto, keyPair.privateKey, file.encryptedKey);
        const capsule = await createRecipientKeyCapsule(fileKey, recipientVolumeId, {
            t: file.contentType,
            h: file.blobHash,
            z: file.size,
        });
        items.push({
            name: file.filename,
            mime: file.mimeType,
            createdAt: file.createdAt,
            ref: {
                p: 'nb.ref.v1',
                c: {
                    t: file.contentType,
                    h: file.blobHash,
                    z: file.size,
                },
                k: {
                    r: capsule.recipientVolumeId,
                    e: capsule.ephemeralPublicKey,
                    n: capsule.nonce,
                    w: capsule.wrappedKey,
                },
            },
        });
    }
    const bundle = {
        p: 'nb.refs.v1',
        r: recipientVolumeId.toLowerCase(),
        items,
    };
    return {
        bundle,
        serialized: serializeRecipientReferenceBundle(bundle),
        upgradedCount,
    };
}
async function importRecipientReferencesWithDeps(secret, bundleValue, crypto, channelStorage, now) {
    const bundle = parseRecipientReferenceBundle(bundleValue);
    const normalizedSecret = normalizeSecret(secret);
    const destinationKeyPair = await crypto.deriveKeys(normalizedSecret);
    const activeVolumeId = volumeIdFromPublicKey(destinationKeyPair.publicKey);
    if (bundle.r !== activeVolumeId) {
        throw new Error('Recipient reference bundle does not match the active volume');
    }
    const destinationVolume = await openVolume(normalizedSecret, crypto);
    const { entries, files } = await loadVolumeFiles(crypto, channelStorage, destinationVolume);
    const takenNames = new Set(files.map((file) => file.filename));
    const imported = [];
    let nextTimestamp = nextCreateTimestamp(entries, now());
    for (const item of bundle.items) {
        const finalName = resolveImportedFilename(item.name, takenNames);
        takenNames.add(finalName);
        const descriptor = item.ref.c;
        const fileKey = await unwrapRecipientKeyCapsule(destinationKeyPair.privateKey, activeVolumeId, descriptor, item.ref.k);
        await ensureDestinationBlockAvailable(channelStorage, descriptor.h, destinationKeyPair.publicKey);
        const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
        const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);
        await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
            filename: finalName,
            blobHash: descriptor.h,
            encryptedKey,
            contentType: descriptor.t,
            size: descriptor.z,
            mimeType: item.mime,
            createdAt,
        });
        imported.push({
            filename: finalName,
            blobHash: descriptor.h,
            contentType: descriptor.t,
            size: descriptor.z,
            mimeType: item.mime,
            createdAt,
        });
        nextTimestamp = createdAt + 1;
    }
    return { imported };
}
function materializeFilesFromEntries(entries) {
    const files = materializeStoredFilesFromEntries(entries).map((file) => ({
        filename: file.filename,
        blobHash: file.blobHash,
        contentType: file.contentType,
        size: file.size,
        mimeType: file.mimeType,
        createdAt: file.createdAt,
    }));
    files.sort((a, b) => {
        if (a.createdAt !== b.createdAt)
            return a.createdAt - b.createdAt;
        if (a.filename < b.filename)
            return -1;
        if (a.filename > b.filename)
            return 1;
        return 0;
    });
    return files;
}
function mapEntriesToTimeline(entries) {
    return buildTimelineRows(entries).map((row) => ({
        eventHash: row.eventHash,
        type: row.type,
        filename: row.filename,
        timestamp: row.timestamp,
        protocol: row.protocol,
        toFilename: row.toFilename,
        blobHash: row.blobHash,
        contentType: row.contentType,
        size: row.size,
        mimeType: row.mimeType,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
        renamedAt: row.renamedAt,
        publishedAt: row.publishedAt,
        authorPublicKey: row.authorPublicKey,
        displayName: row.displayName,
        body: row.body,
        summary: row.summary,
        record: row.record,
        message: row.message,
    }));
}
function materializeStoredFilesFromEntries(entries) {
    const files = new Map();
    for (const row of buildTimelineRows(entries)) {
        if (row.type === 'CREATE_FILE') {
            if (row.blobHash === undefined ||
                row.encryptedKey === undefined ||
                row.size === undefined ||
                row.createdAt === undefined) {
                continue;
            }
            files.set(row.filename, {
                filename: row.filename,
                blobHash: row.blobHash,
                encryptedKey: row.encryptedKey,
                contentType: row.contentType ?? 'b',
                size: row.size,
                mimeType: row.mimeType,
                createdAt: row.createdAt,
            });
            continue;
        }
        if (row.type === 'DELETE_FILE') {
            files.delete(row.filename);
            continue;
        }
        if (!row.toFilename) {
            continue;
        }
        const existing = files.get(row.filename);
        if (!existing) {
            continue;
        }
        files.delete(row.filename);
        files.set(row.toFilename, {
            ...existing,
            filename: row.toFilename,
        });
    }
    return Array.from(files.values()).sort((left, right) => {
        if (left.createdAt !== right.createdAt)
            return left.createdAt - right.createdAt;
        return left.filename.localeCompare(right.filename);
    });
}
function buildTimelineRows(entries) {
    const rows = [];
    for (let sequence = 0; sequence < entries.length; sequence += 1) {
        const entry = entries[sequence];
        const payload = entry.signedEvent.payload;
        if (payload.type === EventType.CREATE_FILE) {
            const inferredTimestamp = payload.createdAt ?? sequence;
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.CREATE_FILE,
                filename: payload.fileName,
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: payload.createdAt !== undefined,
                sequence,
                blobHash: payload.hash,
                encryptedKey: payload.encryptedKey,
                contentType: payload.contentType ?? 'b',
                size: payload.size ?? 0,
                mimeType: payload.mimeType,
                createdAt: inferredTimestamp,
            });
            continue;
        }
        if (payload.type === EventType.DELETE_FILE) {
            const inferredTimestamp = payload.deletedAt ?? sequence;
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.DELETE_FILE,
                filename: payload.fileName,
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: payload.deletedAt !== undefined,
                sequence,
                deletedAt: inferredTimestamp,
            });
            continue;
        }
        if (payload.type === EventType.RENAME_FILE) {
            const inferredTimestamp = payload.renamedAt ?? sequence;
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.RENAME_FILE,
                filename: payload.fileName,
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: payload.renamedAt !== undefined,
                sequence,
                toFilename: payload.toFileName,
                renamedAt: inferredTimestamp,
            });
            continue;
        }
        if (payload.type === EventType.DECLARE_IDENTITY) {
            const inferredTimestamp = payload.publishedAt ?? sequence;
            const identityRecord = payload.record ? parseIdentityRecordJson(payload.record) : null;
            const displayName = identityRecord?.profile.displayName;
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.DECLARE_IDENTITY,
                filename: '',
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: payload.publishedAt !== undefined,
                sequence,
                publishedAt: inferredTimestamp,
                authorPublicKey: payload.authorPublicKey,
                displayName,
                summary: displayName ? `Published ${displayName}` : 'Published identity',
                record: identityRecord ?? undefined,
            });
            continue;
        }
        if (payload.type === EventType.CHAT_MESSAGE) {
            const inferredTimestamp = payload.publishedAt ?? sequence;
            const chatMessage = payload.message ? parseChatMessageJson(payload.message) : null;
            const body = timelineSnippet(chatMessage?.body);
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.CHAT_MESSAGE,
                filename: '',
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: payload.publishedAt !== undefined,
                sequence,
                publishedAt: inferredTimestamp,
                authorPublicKey: payload.authorPublicKey,
                body,
                summary: body ?? 'Chat message',
                message: chatMessage ?? undefined,
            });
            continue;
        }
        if (payload.type === EventType.APP_RECORD &&
            payload.authorPublicKey &&
            payload.publishedAt !== undefined &&
            payload.protocol &&
            payload.record) {
            const inferredTimestamp = payload.publishedAt ?? sequence;
            if (payload.protocol === 'nb.identity.record.v1') {
                const identityRecord = parseIdentityRecordJson(payload.record);
                const displayName = identityRecord?.profile.displayName;
                rows.push({
                    eventHash: entry.eventHash,
                    type: EventType.APP_RECORD,
                    filename: '',
                    timestamp: inferredTimestamp,
                    hasExplicitTimestamp: true,
                    sequence,
                    protocol: payload.protocol,
                    publishedAt: inferredTimestamp,
                    authorPublicKey: payload.authorPublicKey,
                    displayName,
                    summary: displayName ? `Published ${displayName}` : 'Published identity',
                    record: identityRecord ?? undefined,
                });
                continue;
            }
            if (payload.protocol === 'nb.identity.snapshot.v1') {
                const snapshot = parseIdentitySnapshotJson(payload.record);
                const identityRecord = snapshot?.record;
                const displayName = identityRecord?.profile.displayName;
                rows.push({
                    eventHash: entry.eventHash,
                    type: EventType.APP_RECORD,
                    filename: '',
                    timestamp: inferredTimestamp,
                    hasExplicitTimestamp: true,
                    sequence,
                    protocol: payload.protocol,
                    publishedAt: inferredTimestamp,
                    authorPublicKey: payload.authorPublicKey,
                    displayName,
                    summary: displayName ? `Synced ${displayName}` : 'Synced identity',
                    record: identityRecord ?? undefined,
                });
                continue;
            }
            if (payload.protocol === 'nb.chat.message.v1') {
                const chatMessage = parseChatMessageJson(payload.record);
                const body = timelineSnippet(chatMessage?.body);
                rows.push({
                    eventHash: entry.eventHash,
                    type: EventType.APP_RECORD,
                    filename: '',
                    timestamp: inferredTimestamp,
                    hasExplicitTimestamp: true,
                    sequence,
                    protocol: payload.protocol,
                    publishedAt: inferredTimestamp,
                    authorPublicKey: payload.authorPublicKey,
                    body,
                    summary: body ?? 'Chat message',
                    message: chatMessage ?? undefined,
                });
                continue;
            }
            rows.push({
                eventHash: entry.eventHash,
                type: EventType.APP_RECORD,
                filename: '',
                timestamp: inferredTimestamp,
                hasExplicitTimestamp: true,
                sequence,
                protocol: payload.protocol,
                publishedAt: inferredTimestamp,
                authorPublicKey: payload.authorPublicKey,
                summary: payload.protocol,
            });
        }
    }
    rows.sort(compareTimelineRows);
    return rows;
}
async function loadVolumeFiles(crypto, channelStorage, volume) {
    const entries = await loadEventLog(volume, channelStorage, crypto);
    await verifyEventLog(entries, volume, crypto);
    return {
        entries,
        files: materializeStoredFilesFromEntries(entries),
    };
}
async function upgradeLegacyFilesForExport(filenames, files, keyPair, crypto, channelStorage, now) {
    const fileMap = new Map(files.map((file) => [file.filename, file]));
    let upgradedCount = 0;
    let timestamp = Math.max(now(), ...files.map((file) => file.createdAt + 1), 0);
    for (const filename of filenames) {
        const file = requireStoredFile(fileMap, filename);
        if (file.encryptedKey.length > 0) {
            continue;
        }
        const encryptedData = await channelStorage.blocks.retrieve(file.blobHash, keyPair.publicKey);
        const plaintext = await decryptFileForVolume(crypto, keyPair.privateKey, encryptedData, file.encryptedKey);
        const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, plaintext);
        await channelStorage.blocks.store(encrypted.blobHash, encrypted.encryptedData, true, keyPair.publicKey);
        await appendCreateEvent(channelStorage, crypto, keyPair, {
            filename: file.filename,
            blobHash: encrypted.blobHash,
            encryptedKey: encrypted.encryptedKey,
            contentType: encrypted.contentType,
            size: file.size,
            mimeType: file.mimeType,
            createdAt: timestamp,
        });
        upgradedCount += 1;
        timestamp += 1;
    }
    return upgradedCount;
}
async function importSourceBundleItems(bundle, existingFiles, entries, destinationKeyPair, sourceKeyPair, crypto, channelStorage, now) {
    const takenNames = new Set(existingFiles.map((file) => file.filename));
    const imported = [];
    let nextTimestamp = nextCreateTimestamp(entries, now());
    for (const item of bundle.items) {
        const finalName = resolveImportedFilename(item.name, takenNames);
        takenNames.add(finalName);
        const fileKey = await unwrapFileKeyForVolume(crypto, sourceKeyPair.privateKey, decodeWrappedKey(item.ref.x, 'Source reference wrapped key'));
        await ensureDestinationBlockAvailable(channelStorage, item.ref.c.h, destinationKeyPair.publicKey);
        const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
        const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);
        await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
            filename: finalName,
            blobHash: item.ref.c.h,
            encryptedKey,
            contentType: item.ref.c.t,
            size: item.ref.c.z,
            mimeType: item.mime,
            createdAt,
        });
        imported.push({
            filename: finalName,
            blobHash: item.ref.c.h,
            contentType: item.ref.c.t,
            size: item.ref.c.z,
            mimeType: item.mime,
            createdAt,
        });
        nextTimestamp = createdAt + 1;
    }
    return imported;
}
async function ensureDestinationBlockAvailable(channelStorage, blobHash, destinationPublicKey) {
    // Retrieve validates the block bytes; then re-store under the destination channel
    const encryptedData = await channelStorage.blocks.retrieve(blobHash, undefined);
    await channelStorage.blocks.store(blobHash, encryptedData, false, destinationPublicKey);
}
function nextCreateTimestamp(entries, fallbackNow) {
    const timeline = mapEntriesToTimeline([...entries]);
    const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
    return Math.max(fallbackNow, maxTimestamp + 1);
}
function resolveImportedCreatedAt(preferredCreatedAt, minimumCreatedAt) {
    if (preferredCreatedAt === undefined) {
        return minimumCreatedAt;
    }
    return Math.max(preferredCreatedAt, minimumCreatedAt);
}
function requireStoredFile(files, filename) {
    const file = files.get(filename);
    if (!file) {
        throw new Error(`File "${filename}" does not exist`);
    }
    return file;
}
function compareTimelineRows(left, right) {
    if (left.hasExplicitTimestamp !== right.hasExplicitTimestamp) {
        return left.sequence - right.sequence;
    }
    if (left.hasExplicitTimestamp && right.hasExplicitTimestamp) {
        if (left.timestamp !== right.timestamp) {
            return left.timestamp - right.timestamp;
        }
    }
    else if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
    }
    if (left.filename < right.filename)
        return -1;
    if (left.filename > right.filename)
        return 1;
    const leftTie = left.type === 'CREATE_FILE'
        ? `C:${left.blobHash ?? ''}`
        : left.type === 'RENAME_FILE'
            ? `R:${left.toFilename ?? ''}`
            : left.type === 'DELETE_FILE'
                ? 'D'
                : left.type === EventType.DECLARE_IDENTITY
                    ? `I:${left.displayName ?? left.authorPublicKey ?? ''}`
                    : `M:${left.body ?? left.authorPublicKey ?? ''}`;
    const rightTie = right.type === 'CREATE_FILE'
        ? `C:${right.blobHash ?? ''}`
        : right.type === 'RENAME_FILE'
            ? `R:${right.toFilename ?? ''}`
            : right.type === 'DELETE_FILE'
                ? 'D'
                : right.type === EventType.DECLARE_IDENTITY
                    ? `I:${right.displayName ?? right.authorPublicKey ?? ''}`
                    : `M:${right.body ?? right.authorPublicKey ?? ''}`;
    if (leftTie < rightTie)
        return -1;
    if (leftTie > rightTie)
        return 1;
    if (left.eventHash < right.eventHash)
        return -1;
    if (left.eventHash > right.eventHash)
        return 1;
    return 0;
}
function timelineSnippet(value, limit = 72) {
    if (!value) {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized === '') {
        return undefined;
    }
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
function assertNonEmptyFilename(filename) {
    if (!filename || filename.trim().length === 0) {
        throw new Error('File name cannot be empty');
    }
}
function normalizeFolderPath(folder) {
    return folder
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/{2,}/g, '/');
}
async function appendCreateEvent(channelStorage, crypto, keyPair, input) {
    const payload = {
        type: EventType.CREATE_FILE,
        fileName: input.filename,
        hash: input.blobHash,
        encryptedKey: input.encryptedKey,
        contentType: input.contentType,
        size: input.size,
        mimeType: input.mimeType,
        createdAt: input.createdAt,
    };
    const event = await createSignedEvent(crypto, keyPair, payload, [input.blobHash]);
    await channelStorage.events.storeEvent(keyPair.publicKey, event);
}
async function appendDeleteEvent(channelStorage, crypto, keyPair, filename, deletedAt) {
    const payload = {
        type: EventType.DELETE_FILE,
        fileName: filename,
        hash: EMPTY_HASH,
        encryptedKey: createEncryptedData(new Uint8Array(0)),
        deletedAt,
    };
    const event = await createSignedEvent(crypto, keyPair, payload, []);
    await channelStorage.events.storeEvent(keyPair.publicKey, event);
}
async function appendRenameEvent(channelStorage, crypto, keyPair, fromName, toName, renamedAt) {
    const payload = {
        type: EventType.RENAME_FILE,
        fileName: fromName,
        toFileName: toName,
        hash: EMPTY_HASH,
        encryptedKey: createEncryptedData(new Uint8Array(0)),
        renamedAt,
    };
    const event = await createSignedEvent(crypto, keyPair, payload, []);
    await channelStorage.events.storeEvent(keyPair.publicKey, event);
}
function normalizeSecret(secret) {
    return createSecret(secret);
}
//# sourceMappingURL=fileService.js.map