import type { KeyPair, Secret } from 'nearbytes-crypto';
import { createSecret } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventPayload, Hash, EncryptedData, SerializedEvent, CreateFilePayload, RenameFilePayload } from 'nearbytes-crypto';
import { EventType, createHash } from 'nearbytes-crypto';
import { DecryptionError } from 'nearbytes-crypto';
import { type Log } from 'nearbytes-log';
import { serializeEvent, serializeEventEnvelope, serializeInnerEventPayloadJson } from 'nearbytes-log';
import type { EventLogEntry } from 'nearbytes-log';
import { createSignedEvent } from 'nearbytes-log';
import { openChannel, loadEventLog, verifyEventLog } from 'nearbytes-log';
import type { FileMetadata } from './fileEvents.js';
import {
  parseChatMessageJson,
  parseIdentityRecordJson,
  parseIdentitySnapshotJson,
  type ChatMessage,
  type IdentityRecord,
} from './chatCodec.js';
import {
  createRecipientKeyCapsule,
  decryptFileForVolume,
  encryptFileForVolume,
  publicKeyFromVolumeId,
  unwrapFileKeyForVolume,
  unwrapRecipientKeyCapsule,
  volumeIdFromPublicKey,
  wrapFileKeyForVolume,
} from './fileCrypto.js';
import {
  decodeWrappedKey,
  encodeWrappedKey,
  parseRecipientReferenceBundle,
  parseSourceReferenceBundle,
  serializeRecipientReferenceBundle,
  serializeSourceReferenceBundle,
  type FileContentType,
  type RecipientReferenceBundle,
  type SourceReferenceBundle,
} from './fileReferenceCodec.js';
import { dedupeOrderedFilenames, resolveImportedFilename } from './fileCommands.js';

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
  addFile(
    secret: string,
    filename: string,
    data: Buffer,
    mimeType?: string
  ): Promise<FileMetadata>;

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
  renameFolder(
    secret: string,
    fromFolder: string,
    toFolder: string,
    options?: { merge?: boolean }
  ): Promise<RenameFolderSummary>;

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
  exportSourceReferences(
    secret: string,
    filenames: string[]
  ): Promise<ReferenceExportResult<SourceReferenceBundle>>;

  /**
   * Imports a source reference bundle into a destination volume.
   *
   * @param destinationSecret - Volume secret of the import target.
   * @param bundle            - Parsed bundle object (or raw JSON).
   * @param sourceSecret      - Secret of the originating volume (for key unwrapping).
   */
  importSourceReferences(
    destinationSecret: string,
    bundle: unknown,
    sourceSecret: string
  ): Promise<SourceImportResult>;

  /**
   * Exports a reference bundle encrypted for a specific recipient volume.
   *
   * @param secret            - Source volume secret.
   * @param filenames         - Files to share.
   * @param recipientVolumeId - Public key hex of the recipient's volume.
   */
  exportRecipientReferences(
    secret: string,
    filenames: string[],
    recipientVolumeId: string
  ): Promise<ReferenceExportResult<RecipientReferenceBundle>>;

  /**
   * Imports a recipient reference bundle into the caller's volume.
   *
   * @param secret - Volume secret of the recipient.
   * @param bundle - Parsed bundle object (or raw JSON).
   */
  importRecipientReferences(
    secret: string,
    bundle: unknown
  ): Promise<RecipientImportResult>;
}

interface StoredFileRecord extends FileMetadata {
  encryptedKey: EncryptedData;
  contentType: FileContentType;
}

interface StoredTimelineRow {
  eventHash: string;
  type: EventType;
  filename: string;
  timestamp: number;
  hasExplicitTimestamp: boolean;
  sequence: number;
  protocol?: string;
  toFilename?: string;
  blobHash?: string;
  encryptedKey?: EncryptedData;
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

/**
 * Creates a dependency-injected file service for testing or custom storage.
 * @param dependencies - Crypto, storage, log, and optional path mapper/time source
 * @returns File service implementation
 */
export function createFileService(dependencies: FileServiceDependencies): FileService {
  const channelStorage = dependencies.log;
  const now = dependencies.now ?? (() => Date.now());

  return {
    addFile: async (secret, filename, data, mimeType) =>
      addFileWithDeps(
        secret,
        filename,
        data,
        mimeType,
        dependencies.crypto,
        channelStorage,
        now
      ),
    deleteFile: async (secret, filename) =>
      deleteFileWithDeps(
        secret,
        filename,
        dependencies.crypto,
        channelStorage,
        now
      ),
    listFiles: async (secret) =>
      listFilesWithDeps(secret, dependencies.crypto, channelStorage),
    getFile: async (secret, blobHash) =>
      getFileWithDeps(
        secret,
        blobHash,
        dependencies.crypto,
        channelStorage
      ),
    renameFile: async (secret, fromName, toName) =>
      renameFileWithDeps(
        secret,
        fromName,
        toName,
        dependencies.crypto,
        channelStorage,
        now
      ),
    renameFolder: async (secret, fromFolder, toFolder, options) =>
      renameFolderWithDeps(
        secret,
        fromFolder,
        toFolder,
        options?.merge ?? false,
        dependencies.crypto,
        channelStorage,
        now
      ),
    computeSnapshot: async (secret) =>
      computeSnapshotWithDeps(
        secret,
        dependencies.crypto,
        channelStorage,
        now
      ),
    getTimeline: async (secret) =>
      getTimelineWithDeps(secret, dependencies.crypto, channelStorage),
    getTimelineDelta: async (secret, afterEventHash) =>
      getTimelineDeltaWithDeps(
        secret,
        afterEventHash,
        dependencies.crypto,
        channelStorage
      ),
    getEvent: async (secret, eventHash) =>
      getEventWithDeps(
        secret,
        eventHash,
        dependencies.crypto,
        channelStorage
      ),
    exportSourceReferences: async (secret, filenames) =>
      exportSourceReferencesWithDeps(
        secret,
        filenames,
        dependencies.crypto,
        channelStorage,
        now
      ),
    importSourceReferences: async (destinationSecret, bundle, sourceSecret) =>
      importSourceReferencesWithDeps(
        destinationSecret,
        bundle,
        sourceSecret,
        dependencies.crypto,
        channelStorage,
        now
      ),
    exportRecipientReferences: async (secret, filenames, recipientVolumeId) =>
      exportRecipientReferencesWithDeps(
        secret,
        filenames,
        recipientVolumeId,
        dependencies.crypto,
        channelStorage,
        now
      ),
    importRecipientReferences: async (secret, bundle) =>
      importRecipientReferencesWithDeps(
        secret,
        bundle,
        dependencies.crypto,
        channelStorage,
        now
      ),
  };
}

async function addFileWithDeps(
  secret: string,
  filename: string,
  data: Buffer,
  mimeType: string | undefined,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<FileMetadata> {
  assertNonEmptyFilename(filename);
  const normalizedSecret = normalizeSecret(secret);

  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, data);
  const blobHash = await channelStorage.blocks.store(encrypted.encryptedData, true);

  const createdAt = now();
  await appendCreateEvent(channelStorage, crypto, keyPair, {
    filename,
    blobHash,
    encryptedKey: encrypted.encryptedKey,
    contentType: encrypted.contentType,
    mimeType,
    createdAt,
  });

  return {
    filename,
    blobHash,
    contentType: encrypted.contentType,
    size: data.length,
    mimeType,
    createdAt,
  };
}

async function deleteFileWithDeps(
  secret: string,
  filename: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<void> {
  assertNonEmptyFilename(filename);
  const normalizedSecret = normalizeSecret(secret);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const deletedAt = now();
  await appendDeleteEvent(channelStorage, crypto, keyPair, filename, deletedAt);
}

async function renameFolderWithDeps(
  secret: string,
  fromFolder: string,
  toFolder: string,
  merge: boolean,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<RenameFolderSummary> {
  const normalizedFrom = normalizeFolderPath(fromFolder);
  const normalizedTo = normalizeFolderPath(toFolder);
  if (normalizedFrom.length === 0 || normalizedTo.length === 0) {
    throw new Error('Folder names are required');
  }
  if (normalizedFrom === normalizedTo) {
    throw new Error('Source and destination folders are the same');
  }

  const normalizedSecret = normalizeSecret(secret);
  const volume = await openChannel(normalizedSecret, crypto);
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);

  const files = materializeFilesFromEntries(entries);
  const sourceFiles = files.filter((file) => file.filename.startsWith(`${normalizedFrom}/`));
  if (sourceFiles.length === 0) {
    throw new Error(`Folder "${normalizedFrom}" is empty or does not exist`);
  }

  const existingByName = new Map<string, FileMetadata>(files.map((file) => [file.filename, file]));
  const sourceNameSet = new Set(sourceFiles.map((file) => file.filename));

  const plan = sourceFiles
    .map((file) => ({
      fromName: file.filename,
      toName: `${normalizedTo}/${file.filename.slice(normalizedFrom.length + 1)}`,
      file,
    }))
    .sort((left, right) => left.fromName.localeCompare(right.fromName));

  const duplicateTargets = new Set<string>();
  const targetSet = new Set<string>();
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
    if (!existing) return false;
    return !sourceNameSet.has(item.toName);
  });

  if (conflicts.length > 0 && !merge) {
    throw new Error(
      `Destination folder already contains ${conflicts.length} file(s). Retry with merge enabled.`
    );
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

async function renameFileWithDeps(
  secret: string,
  fromName: string,
  toName: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<RenameFileSummary> {
  assertNonEmptyFilename(fromName);
  assertNonEmptyFilename(toName);
  if (fromName === toName) {
    throw new Error('Source and destination file names are the same');
  }

  const normalizedSecret = normalizeSecret(secret);
  const volume = await openChannel(normalizedSecret, crypto);
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

async function listFilesWithDeps(
  secret: string,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<FileMetadata[]> {
  const volume = await openChannel(normalizeSecret(secret), crypto);
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);
  return materializeFilesFromEntries(entries);
}

async function getFileWithDeps(
  secret: string,
  blobHash: string,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<Buffer> {
  const normalizedSecret = normalizeSecret(secret);
  const volume = await openChannel(normalizedSecret, crypto);
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);

  const currentFile = materializeStoredFilesFromEntries(entries).find((file) => file.blobHash === blobHash);
  if (!currentFile) {
    throw new DecryptionError('File is not available in the active volume');
  }

  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const encryptedData = await channelStorage.blocks.retrieve(blobHash as Hash);
  const plaintext = await decryptFileForVolume(
    crypto,
    keyPair.privateKey,
    encryptedData,
    currentFile.encryptedKey
  );
  return Buffer.from(plaintext);
}

async function computeSnapshotWithDeps(
  secret: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<SnapshotSummary> {
  const volume = await openChannel(normalizeSecret(secret), crypto);
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

async function getTimelineWithDeps(
  secret: string,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<TimelineEvent[]> {
  const volume = await openChannel(normalizeSecret(secret), crypto);
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);
  return mapEntriesToTimeline(entries);
}

async function getTimelineDeltaWithDeps(
  secret: string,
  afterEventHash: string | null | undefined,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<TimelineDelta> {
  // docs/specs/application/hash-cursor-refresh-v0.1.md
  const volume = await openChannel(normalizeSecret(secret), crypto);
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

function normalizeTimelineCursor(afterEventHash: string | null | undefined): string | null {
  const normalized = afterEventHash?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return null;
  }
  return normalized;
}

async function getEventWithDeps(
  secret: string,
  eventHash: string,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<EventDetail> {
  const volume = await openChannel(normalizeSecret(secret), crypto);
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

async function exportSourceReferencesWithDeps(
  secret: string,
  filenames: string[],
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<ReferenceExportResult<SourceReferenceBundle>> {
  const normalizedSecret = normalizeSecret(secret);
  const orderedFilenames = dedupeOrderedFilenames(filenames);
  if (orderedFilenames.length === 0) {
    throw new Error('At least one filename is required');
  }

  const volume = await openChannel(normalizedSecret, crypto);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  let { files } = await loadVolumeFiles(crypto, channelStorage, volume);
  let upgradedCount = 0;

  upgradedCount += await upgradeLegacyFilesForExport(
    orderedFilenames,
    files,
    keyPair,
    crypto,
    channelStorage,
    now
  );
  if (upgradedCount > 0) {
    ({ files } = await loadVolumeFiles(crypto, channelStorage, volume));
  }

  const fileMap = new Map(files.map((file) => [file.filename, file]));
  const bundle: SourceReferenceBundle = {
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

async function importSourceReferencesWithDeps(
  destinationSecret: string,
  bundleValue: unknown,
  sourceSecret: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<SourceImportResult> {
  const bundle = parseSourceReferenceBundle(bundleValue);
  const normalizedDestinationSecret = normalizeSecret(destinationSecret);
  const normalizedSourceSecret = normalizeSecret(sourceSecret);
  const destinationKeyPair = await crypto.deriveKeys(normalizedDestinationSecret);
  const sourceKeyPair = await crypto.deriveKeys(normalizedSourceSecret);
  const sourceVolumeId = volumeIdFromPublicKey(sourceKeyPair.publicKey);
  if (bundle.s !== sourceVolumeId) {
    throw new Error('Source reference bundle does not match the provided source volume');
  }

  const destinationVolume = await openChannel(normalizedDestinationSecret, crypto);
  const { entries, files } = await loadVolumeFiles(crypto, channelStorage, destinationVolume);
  const imported = await importSourceBundleItems(
    bundle,
    files,
    entries,
    destinationKeyPair,
    sourceKeyPair,
    crypto,
    channelStorage,
    now
  );

  return { imported };
}

async function exportRecipientReferencesWithDeps(
  secret: string,
  filenames: string[],
  recipientVolumeId: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<ReferenceExportResult<RecipientReferenceBundle>> {
  const normalizedSecret = normalizeSecret(secret);
  const orderedFilenames = dedupeOrderedFilenames(filenames);
  if (orderedFilenames.length === 0) {
    throw new Error('At least one filename is required');
  }

  publicKeyFromVolumeId(recipientVolumeId);

  const volume = await openChannel(normalizedSecret, crypto);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  let { files } = await loadVolumeFiles(crypto, channelStorage, volume);
  let upgradedCount = 0;

  upgradedCount += await upgradeLegacyFilesForExport(
    orderedFilenames,
    files,
    keyPair,
    crypto,
    channelStorage,
    now
  );
  if (upgradedCount > 0) {
    ({ files } = await loadVolumeFiles(crypto, channelStorage, volume));
  }

  const fileMap = new Map(files.map((file) => [file.filename, file]));
  const items: RecipientReferenceBundle['items'] = [];
  for (const filename of orderedFilenames) {
    const file = requireStoredFile(fileMap, filename);
    const fileKey = await unwrapFileKeyForVolume(crypto, keyPair.privateKey, file.encryptedKey);
    const capsule = await createRecipientKeyCapsule(
      fileKey,
      recipientVolumeId,
      {
        t: file.contentType,
        h: file.blobHash,
        z: file.size,
      }
    );
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

  const bundle: RecipientReferenceBundle = {
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

async function importRecipientReferencesWithDeps(
  secret: string,
  bundleValue: unknown,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<RecipientImportResult> {
  const bundle = parseRecipientReferenceBundle(bundleValue);
  const normalizedSecret = normalizeSecret(secret);
  const destinationKeyPair = await crypto.deriveKeys(normalizedSecret);
  const activeVolumeId = volumeIdFromPublicKey(destinationKeyPair.publicKey);
  if (bundle.r !== activeVolumeId) {
    throw new Error('Recipient reference bundle does not match the active volume');
  }

  const destinationVolume = await openChannel(normalizedSecret, crypto);
  const { entries, files } = await loadVolumeFiles(crypto, channelStorage, destinationVolume);
  const takenNames = new Set(files.map((file) => file.filename));
  const imported: FileMetadata[] = [];
  let nextTimestamp = nextCreateTimestamp(entries, now());

  for (const item of bundle.items) {
    const finalName = resolveImportedFilename(item.name, takenNames);
    takenNames.add(finalName);

    const descriptor = item.ref.c;
    const fileKey = await unwrapRecipientKeyCapsule(
      destinationKeyPair.privateKey,
      activeVolumeId,
      descriptor,
      item.ref.k
    );
    await ensureDestinationBlockAvailable(channelStorage, descriptor.h);
    const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
    const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);

    await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
      filename: finalName,
      blobHash: descriptor.h,
      encryptedKey,
      contentType: descriptor.t,
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

function materializeFilesFromEntries(entries: EventLogEntry[]): FileMetadata[] {
  const files = materializeStoredFilesFromEntries(entries).map((file) => ({
    filename: file.filename,
    blobHash: file.blobHash,
    contentType: file.contentType,
    size: file.size,
    mimeType: file.mimeType,
    createdAt: file.createdAt,
  }));
  files.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.filename < b.filename) return -1;
    if (a.filename > b.filename) return 1;
    return 0;
  });
  return files;
}

function mapEntriesToTimeline(entries: EventLogEntry[]): TimelineEvent[] {
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

function materializeStoredFilesFromEntries(entries: EventLogEntry[]): StoredFileRecord[] {
  const files = new Map<string, StoredFileRecord>();

  for (const row of buildTimelineRows(entries)) {
    if (row.type === 'CREATE_FILE') {
      if (
        row.blobHash === undefined ||
        row.encryptedKey === undefined ||
        row.createdAt === undefined
      ) {
        continue;
      }
      files.set(row.filename, {
        filename: row.filename,
        blobHash: row.blobHash,
        encryptedKey: row.encryptedKey,
        contentType: row.contentType ?? 'b',
        size: row.size ?? 0,
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
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.filename.localeCompare(right.filename);
  });
}

function buildTimelineRows(entries: EventLogEntry[]): StoredTimelineRow[] {
  const rows: StoredTimelineRow[] = [];

  for (let sequence = 0; sequence < entries.length; sequence += 1) {
    const entry = entries[sequence];
    const payload = entry.signedEvent.payload;

    if (payload.type === EventType.CREATE_FILE) {
      const p = payload as CreateFilePayload;
      const inferredTimestamp = p.createdAt ?? sequence;
      const blobHash =
        p.content.protocol === 'nb.content.single.v1'
          ? p.content.blockHash
          : p.content.manifestHash;
      const contentType: 'b' | 'm' =
        p.content.protocol === 'nb.content.manifest.v1' ? 'm' : 'b';
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.CREATE_FILE,
        filename: p.filename,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        blobHash,
        encryptedKey: p.wrappedKey,
        contentType,
        size: 0,
        mimeType: p.mimeType,
        createdAt: inferredTimestamp,
      });
      continue;
    }

    if (payload.type === EventType.DELETE_FILE) {
      const inferredTimestamp = payload.deletedAt ?? sequence;
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.DELETE_FILE,
        filename: payload.filename,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        deletedAt: inferredTimestamp,
      });
      continue;
    }

    if (payload.type === EventType.RENAME_FILE) {
      const p = payload as RenameFilePayload;
      const inferredTimestamp = p.renamedAt ?? sequence;
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.RENAME_FILE,
        filename: p.filename,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        toFilename: p.toFilename,
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

    if (
      payload.type === EventType.APP_RECORD &&
      payload.authorPublicKey &&
      payload.publishedAt !== undefined &&
      payload.protocol &&
      payload.record
    ) {
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

async function loadVolumeFiles(
  crypto: CryptoOperations,
  channelStorage: Log,
  volume: Awaited<ReturnType<typeof openChannel>>
): Promise<{ entries: EventLogEntry[]; files: StoredFileRecord[] }> {
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);
  return {
    entries,
    files: materializeStoredFilesFromEntries(entries),
  };
}

async function upgradeLegacyFilesForExport(
  filenames: readonly string[],
  files: readonly StoredFileRecord[],
  keyPair: KeyPair,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<number> {
  const fileMap = new Map(files.map((file) => [file.filename, file]));
  let upgradedCount = 0;
  let timestamp = Math.max(
    now(),
    ...files.map((file) => file.createdAt + 1),
    0
  );

  for (const filename of filenames) {
    const file = requireStoredFile(fileMap, filename);
    if (file.encryptedKey.length > 0) {
      continue;
    }

    const encryptedData = await channelStorage.blocks.retrieve(file.blobHash as Hash);
    const plaintext = await decryptFileForVolume(crypto, keyPair.privateKey, encryptedData, file.encryptedKey);
    const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, plaintext);
    const blobHash = await channelStorage.blocks.store(encrypted.encryptedData, true);
    await appendCreateEvent(channelStorage, crypto, keyPair, {
      filename: file.filename,
      blobHash,
      encryptedKey: encrypted.encryptedKey,
      contentType: encrypted.contentType,
      mimeType: file.mimeType,
      createdAt: timestamp,
    });

    upgradedCount += 1;
    timestamp += 1;
  }

  return upgradedCount;
}

async function importSourceBundleItems(
  bundle: SourceReferenceBundle,
  existingFiles: readonly StoredFileRecord[],
  entries: readonly EventLogEntry[],
  destinationKeyPair: KeyPair,
  sourceKeyPair: KeyPair,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number
): Promise<FileMetadata[]> {
  const takenNames = new Set(existingFiles.map((file) => file.filename));
  const imported: FileMetadata[] = [];
  let nextTimestamp = nextCreateTimestamp(entries, now());

  for (const item of bundle.items) {
    const finalName = resolveImportedFilename(item.name, takenNames);
    takenNames.add(finalName);

    const fileKey = await unwrapFileKeyForVolume(
      crypto,
      sourceKeyPair.privateKey,
      decodeWrappedKey(item.ref.x, 'Source reference wrapped key')
    );
    await ensureDestinationBlockAvailable(channelStorage, item.ref.c.h);
    const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
    const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);

    await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
      filename: finalName,
      blobHash: item.ref.c.h,
      encryptedKey,
      contentType: item.ref.c.t,
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

async function ensureDestinationBlockAvailable(
  channelStorage: Log,
  blobHash: string,
): Promise<void> {
  // Mirror the block across the channel storage's writable roots: `retrieve`
  // returns the bytes from whichever root currently holds them (verifying
  // the digest in the process), and `store` re-hashes the bytes and writes
  // them to every writable root, which is a no-op for roots that already
  // hold the block. The streaming `storeAlreadyVerified` fast path is
  // reserved for `nearbytes-sync` per `nearbytes-specs/storage/log-api-v1.md`
  // §2.3, so callers outside that package MUST use `store`.
  const encryptedData = await channelStorage.blocks.retrieve(blobHash as Hash);
  await channelStorage.blocks.store(encryptedData);
}

function nextCreateTimestamp(entries: readonly EventLogEntry[], fallbackNow: number): number {
  const timeline = mapEntriesToTimeline([...entries]);
  const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
  return Math.max(fallbackNow, maxTimestamp + 1);
}

function resolveImportedCreatedAt(
  preferredCreatedAt: number | undefined,
  minimumCreatedAt: number
): number {
  if (preferredCreatedAt === undefined) {
    return minimumCreatedAt;
  }
  return Math.max(preferredCreatedAt, minimumCreatedAt);
}

function requireStoredFile(
  files: ReadonlyMap<string, StoredFileRecord>,
  filename: string
): StoredFileRecord {
  const file = files.get(filename);
  if (!file) {
    throw new Error(`File "${filename}" does not exist`);
  }
  return file;
}

function compareTimelineRows(
  left: StoredTimelineRow,
  right: StoredTimelineRow
): number {
  if (left.hasExplicitTimestamp !== right.hasExplicitTimestamp) {
    return left.sequence - right.sequence;
  }

  if (left.hasExplicitTimestamp && right.hasExplicitTimestamp) {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
  } else if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  if (left.filename < right.filename) return -1;
  if (left.filename > right.filename) return 1;

  const leftTie =
    left.type === 'CREATE_FILE'
      ? `C:${left.blobHash ?? ''}`
      : left.type === 'RENAME_FILE'
        ? `R:${left.toFilename ?? ''}`
        : left.type === 'DELETE_FILE'
          ? 'D'
          : left.type === EventType.DECLARE_IDENTITY
            ? `I:${left.displayName ?? left.authorPublicKey ?? ''}`
            : `M:${left.body ?? left.authorPublicKey ?? ''}`;
  const rightTie =
    right.type === 'CREATE_FILE'
      ? `C:${right.blobHash ?? ''}`
      : right.type === 'RENAME_FILE'
        ? `R:${right.toFilename ?? ''}`
        : right.type === 'DELETE_FILE'
          ? 'D'
          : right.type === EventType.DECLARE_IDENTITY
            ? `I:${right.displayName ?? right.authorPublicKey ?? ''}`
            : `M:${right.body ?? right.authorPublicKey ?? ''}`;
  if (leftTie < rightTie) return -1;
  if (leftTie > rightTie) return 1;

  if (left.eventHash < right.eventHash) return -1;
  if (left.eventHash > right.eventHash) return 1;
  return 0;
}

function timelineSnippet(value: string | undefined, limit = 72): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') {
    return undefined;
  }
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function assertNonEmptyFilename(filename: string): void {
  if (!filename || filename.trim().length === 0) {
    throw new Error('File name cannot be empty');
  }
}

function normalizeFolderPath(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

async function appendCreateEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  input: {
    filename: string;
    blobHash: string;
    encryptedKey: EncryptedData;
    contentType: FileContentType;
    mimeType?: string;
    createdAt: number;
  }
): Promise<void> {
  const contentDescriptor =
    input.contentType === 'm'
      ? ({ protocol: 'nb.content.manifest.v1', manifestHash: input.blobHash as Hash } as const)
      : ({ protocol: 'nb.content.single.v1', blockHash: input.blobHash as Hash } as const);
  const payload: EventPayload = {
    type: EventType.CREATE_FILE,
    filename: input.filename,
    content: contentDescriptor,
    wrappedKey: input.encryptedKey,
    createdAt: input.createdAt,
    mimeType: input.mimeType,
  };
  const event = await createSignedEvent(crypto, keyPair, payload, [input.blobHash as Hash]);
  await channelStorage.events.storeEvent(keyPair.publicKey, event);
}

async function appendDeleteEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  filename: string,
  deletedAt: number
): Promise<void> {
  const payload: EventPayload = {
    type: EventType.DELETE_FILE,
    filename,
    deletedAt,
  };
  const event = await createSignedEvent(crypto, keyPair, payload, []);
  await channelStorage.events.storeEvent(keyPair.publicKey, event);
}

async function appendRenameEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  fromName: string,
  toName: string,
  renamedAt: number
): Promise<void> {
  const payload: EventPayload = {
    type: EventType.RENAME_FILE,
    filename: fromName,
    toFilename: toName,
    renamedAt,
  };
  const event = await createSignedEvent(crypto, keyPair, payload, []);
  await channelStorage.events.storeEvent(keyPair.publicKey, event);
}

function normalizeSecret(secret: string): Secret {
  return createSecret(secret);
}
