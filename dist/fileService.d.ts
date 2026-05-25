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
/** Dependencies injected into `createFileService`. */
export interface FileServiceDependencies {
    /** Event log + block store (from `nearbytes-log`). */
    log: Log;
    /** Cryptographic operations (from `nearbytes-crypto`). */
    crypto: CryptoOperations;
    /** Clock override — useful in tests. Defaults to `Date.now`. */
    now?: () => number;
}
/**
 * High-level file API for a Nearbytes volume.
 *
 * All methods accept a `secret` string that identifies the volume. The service
 * derives keys from the secret on every call — there is no session state and
 * no pre-opened volume required.
 *
 * Obtain an instance with `createFileService({ log, crypto })`.
 */
export interface FileService {
    /**
     * Encrypts `data` and appends a `CREATE_FILE` event to the volume.
     *
     * @param secret   - Volume secret (`"name:password"` format).
     * @param filename - Name to store the file under.
     * @param data     - Raw file contents.
     * @param mimeType - Optional MIME type hint.
     * @returns Metadata describing the stored file.
     */
    addFile(secret: string, filename: string, data: Buffer, mimeType?: string): Promise<FileMetadata>;
    /**
     * Appends a `DELETE_FILE` event to the volume.
     *
     * @param secret   - Volume secret.
     * @param filename - Name of the file to delete.
     * @throws Error if the file does not exist in the current volume state.
     */
    deleteFile(secret: string, filename: string): Promise<void>;
    /**
     * Replays the event log and returns metadata for every live file.
     *
     * @param secret - Volume secret.
     * @returns Array of file metadata, sorted alphabetically by filename.
     */
    listFiles(secret: string): Promise<FileMetadata[]>;
    /**
     * Retrieves and decrypts a file by its content-address (blob hash).
     *
     * Use `listFiles` to look up the `blobHash` for a filename.
     *
     * @param secret   - Volume secret.
     * @param blobHash - SHA-256 content-address of the encrypted block.
     * @returns Decrypted file contents.
     */
    getFile(secret: string, blobHash: string): Promise<Buffer>;
    /**
     * Appends a `RENAME_FILE` event to the volume.
     *
     * @param secret   - Volume secret.
     * @param fromName - Current filename.
     * @param toName   - New filename.
     */
    renameFile(secret: string, fromName: string, toName: string): Promise<RenameFileSummary>;
    /**
     * Renames all files whose path starts with `fromFolder/` to `toFolder/`,
     * appending a `RENAME_FILE` event for each.
     *
     * @param secret     - Volume secret.
     * @param fromFolder - Source folder path (no leading or trailing slashes).
     * @param toFolder   - Destination folder path.
     * @param options    - `merge`: allow merging into an existing destination folder.
     */
    renameFolder(secret: string, fromFolder: string, toFolder: string, options?: {
        merge?: boolean;
    }): Promise<RenameFolderSummary>;
    /**
     * Returns a lightweight summary of the volume's current state.
     *
     * @param secret - Volume secret.
     */
    computeSnapshot(secret: string): Promise<SnapshotSummary>;
    /**
     * Returns the full ordered event timeline for the volume.
     *
     * @param secret - Volume secret.
     */
    getTimeline(secret: string): Promise<TimelineEvent[]>;
    /**
     * Returns events that occurred after `afterEventHash`, suitable for
     * incremental sync.
     *
     * @param secret        - Volume secret.
     * @param afterEventHash - Cursor from a previous call; `null` or omitted
     *                         to start from the beginning.
     */
    getTimelineDelta(secret: string, afterEventHash?: string | null): Promise<TimelineDelta>;
    /**
     * Returns the raw (optionally decrypted) detail for a single event.
     *
     * @param secret    - Volume secret.
     * @param eventHash - Content-address of the event.
     */
    getEvent(secret: string, eventHash: string): Promise<EventDetail>;
    /**
     * Exports a portable reference bundle for the given files so they can be
     * imported into another volume owned by the same key pair.
     *
     * @param secret    - Source volume secret.
     * @param filenames - Files to include in the bundle.
     */
    exportSourceReferences(secret: string, filenames: string[]): Promise<ReferenceExportResult<SourceReferenceBundle>>;
    /**
     * Imports a source reference bundle into a destination volume.
     *
     * @param destinationSecret - Volume secret of the import target.
     * @param bundle            - Parsed bundle object (or raw JSON).
     * @param sourceSecret      - Secret of the originating volume (for key unwrapping).
     */
    importSourceReferences(destinationSecret: string, bundle: unknown, sourceSecret: string): Promise<SourceImportResult>;
    /**
     * Exports a reference bundle encrypted for a specific recipient volume.
     *
     * @param secret            - Source volume secret.
     * @param filenames         - Files to share.
     * @param recipientVolumeId - Public key hex of the recipient's volume.
     */
    exportRecipientReferences(secret: string, filenames: string[], recipientVolumeId: string): Promise<ReferenceExportResult<RecipientReferenceBundle>>;
    /**
     * Imports a recipient reference bundle into the caller's volume.
     *
     * @param secret - Volume secret of the recipient.
     * @param bundle - Parsed bundle object (or raw JSON).
     */
    importRecipientReferences(secret: string, bundle: unknown): Promise<RecipientImportResult>;
}
/**
 * Creates a dependency-injected file service for testing or custom storage.
 * @param dependencies - Crypto, storage, log, and optional path mapper/time source
 * @returns File service implementation
 */
export declare function createFileService(dependencies: FileServiceDependencies): FileService;
//# sourceMappingURL=fileService.d.ts.map