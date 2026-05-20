import type { CryptoOperations } from 'nearbytes-crypto';
import type { SerializedEvent } from 'nearbytes-crypto';
import { EventType } from 'nearbytes-crypto';
import { type Log } from 'nearbytes-log';
import { serializeInnerEventPayloadJson } from 'nearbytes-log';
import type { FileMetadata } from './fileEvents.js';
import { type ChatMessage, type IdentityRecord } from './chatCodec.js';
import { type FileContentType, type RecipientReferenceBundle, type SourceReferenceBundle } from './fileReferenceCodec.js';
export interface SnapshotSummary {
    generatedAt: number;
    eventCount: number;
    fileCount: number;
    lastEventHash: string | null;
}
export interface TimelineDelta {
    requestedCursor: string | null;
    acceptedCursor: string | null;
    nextCursor: string | null;
    reset: boolean;
    eventCount: number;
    totalEventCount: number;
    events: TimelineEvent[];
}
export interface ReferenceExportResult<TBundle> {
    bundle: TBundle;
    serialized: string;
    upgradedCount: number;
}
export interface SourceImportResult {
    imported: FileMetadata[];
}
export interface RecipientImportResult {
    imported: FileMetadata[];
}
export interface TimelineEvent {
    eventHash: string;
    type: EventType;
    filename: string;
    timestamp: number;
    protocol?: string;
    toFilename?: string;
    blobHash?: string;
    contentType?: FileContentType;
    size?: number;
    mimeType?: string;
    createdAt?: number;
    deletedAt?: number;
    renamedAt?: number;
    publishedAt?: number;
    authorPublicKey?: string;
    displayName?: string;
    body?: string;
    summary?: string;
    record?: IdentityRecord;
    message?: ChatMessage;
}
export interface EventDetail {
    eventHash: string;
    event: SerializedEvent;
    decryptedPayload?: ReturnType<typeof serializeInnerEventPayloadJson>;
}
export interface RenameFolderSummary {
    fromFolder: string;
    toFolder: string;
    movedFiles: number;
    mergedConflicts: number;
}
export interface RenameFileSummary {
    fromName: string;
    toName: string;
}
export interface FileServiceDependencies {
    log: Log;
    crypto: CryptoOperations;
    now?: () => number;
}
export interface FileService {
    addFile(secret: string, filename: string, data: Buffer, mimeType?: string): Promise<FileMetadata>;
    deleteFile(secret: string, filename: string): Promise<void>;
    listFiles(secret: string): Promise<FileMetadata[]>;
    getFile(secret: string, blobHash: string): Promise<Buffer>;
    renameFile(secret: string, fromName: string, toName: string): Promise<RenameFileSummary>;
    renameFolder(secret: string, fromFolder: string, toFolder: string, options?: {
        merge?: boolean;
    }): Promise<RenameFolderSummary>;
    computeSnapshot(secret: string): Promise<SnapshotSummary>;
    getTimeline(secret: string): Promise<TimelineEvent[]>;
    getTimelineDelta(secret: string, afterEventHash?: string | null): Promise<TimelineDelta>;
    getEvent(secret: string, eventHash: string): Promise<EventDetail>;
    exportSourceReferences(secret: string, filenames: string[]): Promise<ReferenceExportResult<SourceReferenceBundle>>;
    importSourceReferences(destinationSecret: string, bundle: unknown, sourceSecret: string): Promise<SourceImportResult>;
    exportRecipientReferences(secret: string, filenames: string[], recipientVolumeId: string): Promise<ReferenceExportResult<RecipientReferenceBundle>>;
    importRecipientReferences(secret: string, bundle: unknown): Promise<RecipientImportResult>;
}
/**
 * Creates a dependency-injected file service for testing or custom storage.
 * @param dependencies - Crypto, storage, log, and optional path mapper/time source
 * @returns File service implementation
 */
export declare function createFileService(dependencies: FileServiceDependencies): FileService;
//# sourceMappingURL=fileService.d.ts.map