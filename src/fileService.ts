import type { KeyPair, Secret } from 'nearbytes-crypto';
import { createSecret } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { EventPayload, Hash, EncryptedData, SerializedEvent, CreateFilePayload } from 'nearbytes-crypto';
import { EventType, createHash } from 'nearbytes-crypto';
import { DecryptionError } from 'nearbytes-crypto';
import { type Log } from 'nearbytes-log';
import { serializeEvent, serializeEventEnvelope, serializeInnerEventPayloadJson } from 'nearbytes-log';
import type { EventLogEntry } from 'nearbytes-log';
import { openChannel, loadEventLog, verifyEventLog } from 'nearbytes-log';
import type { DirectoryMetadata, FileMetadata } from './fileEvents.js';
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
import {
  type MaterializedFileSystem,
  type MaterializedShadow,
} from './fileMaterializer.js';
import { observedLogHead, orderEventLogEntries, toCanonicalEntries } from './fileLogEntries.js';
import {
  emitFileEvent,
  extendFileReplayContext,
  type CausalLineage,
  loadFileReplayContext,
  replayContextThrough,
  lineagesForRename,
  lineageAtPath,
} from './fileEmit.js';
import { rememberBlobPlaintextSize } from './fileBlobSizes.js';
import { normalizeVolumePath } from './pathUtils.js';
import { runMaterialization } from './materialization.js';

export interface SnapshotSummary {
  generatedAt: number;
  eventCount: number;
  fileCount: number;
  directoryCount: number;
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
  /** Primary path the event acts on (CREATE_FILE/MKDIR/DELETE target, RENAME source). */
  path: string;
  timestamp: number;
  protocol?: string;
  /** Rename destination (RENAME only). */
  toPath?: string;
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
  /**
   * Materializer rejection record for this event. When set, the event was
   * recorded on the timeline but did *not* affect the materialized
   * filesystem state — it is a conflict that the caller may surface to
   * users or use to drive merge/branch decisions later.
   */
  shadow?: MaterializedShadow['reject'];
}

export interface EventDetail {
  eventHash: string;
  event: SerializedEvent;
  decryptedPayload?: ReturnType<typeof serializeInnerEventPayloadJson>;
}

export interface RenameSummary {
  fromPath: string;
  toPath: string;
}

/**
 * Optional knobs for {@link FileService.addFile}. The struct is kept
 * future-open so new keys can be added (e.g. `attributes`, `acl`) without
 * a breaking signature change.
 */
export interface AddFileOptions {
  /** MIME type hint. */
  readonly mimeType?: string;
  /**
   * Override the destination directory. When set, the file is placed at
   * `<destinationDir>/<basename(path)>` regardless of the directory
   * implied by `path`.
   */
  readonly destinationDir?: string;
  /** Override the basename of the stored file. */
  readonly name?: string;
}

/** Dependencies injected into `createFileService`. */
export interface FileServiceDependencies {
  log: Log;
  crypto: CryptoOperations;
  /** Clock override — useful in tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * High-level file API for a Nearbytes volume.
 *
 * The protocol-level primitives are intentionally small (CREATE_FILE,
 * MKDIR, DELETE, RENAME); all cascade behavior — implicit ancestors,
 * recursive DELETE, prefix-swap RENAME, conflict resolution — lives in
 * the materializer (see `fileMaterializer.ts`).
 */
export interface FileService {
  /**
   * Encrypts `data` and appends a `CREATE_FILE` event to the volume.
   * The full path may contain `/` separators; missing ancestor directories
   * become implicit on replay and disappear automatically when the last
   * descendant file is removed.
   *
   * @param path - Volume path (e.g. `notes/2026/may.txt`).
   * @param opts - See {@link AddFileOptions}.
   */
  addFile(
    secret: string,
    path: string,
    data: Buffer,
    opts?: AddFileOptions,
  ): Promise<FileMetadata>;

  /**
   * Appends an `MKDIR` event creating an explicit (possibly empty)
   * directory at `path`. All ancestor dirs are also created in the same
   * event's cascade.
   */
  mkdir(secret: string, path: string): Promise<DirectoryMetadata>;

  /**
   * Appends a `DELETE` event removing `path`. On replay, if `path` is a
   * directory the materializer recursively removes every descendant.
   */
  delete(secret: string, path: string): Promise<void>;

  /**
   * Appends a `RENAME` event. If `fromPath` is a directory the
   * materializer prefix-swaps every descendant from `fromPath/` to
   * `toPath/`. Conflicts (different-kind target, non-empty same-kind
   * target, ancestor-is-file) are recorded as timeline shadows and leave
   * the state unchanged.
   */
  rename(secret: string, fromPath: string, toPath: string): Promise<RenameSummary>;

  /**
   * Replays the event log and returns metadata for every live file,
   * sorted by full path.
   */
  listFiles(secret: string): Promise<FileMetadata[]>;

  /**
   * Replays the event log and returns metadata for every live directory
   * (explicit and implicit), sorted by full path.
   */
  listDirectories(secret: string): Promise<DirectoryMetadata[]>;

  /**
   * Retrieves and decrypts a file by its content-address (blob hash).
   * Use `listFiles` to look up the `blobHash` for a path.
   */
  getFile(secret: string, blobHash: string): Promise<Buffer>;
  getFileByPath(secret: string, path: string): Promise<Buffer>;
  /** Read file bytes from a specific replay snapshot (e.g. historical timeline cursor). */
  readFileAtReplay(
    secret: string,
    path: string,
    replay: import('./fileEmit.js').FileReplayContext,
  ): Promise<Buffer>;
  getReplayContext(
    secret: string,
    opts?: { readonly enrichSizes?: boolean; readonly throughEventHash?: string },
  ): Promise<import('./fileEmit.js').FileReplayContext>;
  /** Drop in-memory replay; next read reloads from storage (e.g. after external sync). */
  markReplayStale(secret: string): void;

  computeSnapshot(secret: string): Promise<SnapshotSummary>;
  getTimeline(secret: string): Promise<TimelineEvent[]>;
  getTimelineDelta(secret: string, afterEventHash?: string | null): Promise<TimelineDelta>;
  getEvent(secret: string, eventHash: string): Promise<EventDetail>;

  exportSourceReferences(
    secret: string,
    paths: string[],
  ): Promise<ReferenceExportResult<SourceReferenceBundle>>;
  importSourceReferences(
    destinationSecret: string,
    bundle: unknown,
    sourceSecret: string,
  ): Promise<SourceImportResult>;
  exportRecipientReferences(
    secret: string,
    paths: string[],
    recipientVolumeId: string,
  ): Promise<ReferenceExportResult<RecipientReferenceBundle>>;
  importRecipientReferences(
    secret: string,
    bundle: unknown,
  ): Promise<RecipientImportResult>;
}

interface StoredFileRecord extends FileMetadata {
  encryptedKey: EncryptedData;
  contentType: FileContentType;
}

interface StoredTimelineRow {
  eventHash: string;
  type: EventType;
  path: string;
  timestamp: number;
  hasExplicitTimestamp: boolean;
  sequence: number;
  protocol?: string;
  toPath?: string;
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
 */
export function createFileService(dependencies: FileServiceDependencies): FileService {
  const channelStorage = dependencies.log;
  const now = dependencies.now ?? (() => Date.now());
  type ReplayState = {
    context?: import('./fileEmit.js').FileReplayContext;
    pending?: Promise<import('./fileEmit.js').FileReplayContext>;
    stale: boolean;
  };
  const replayCache = new Map<string, ReplayState>();

  const getReplayContext = async (
    secret: string,
    opts?: { readonly enrichSizes?: boolean; readonly throughEventHash?: string },
  ): Promise<import('./fileEmit.js').FileReplayContext> => {
    const normalizedSecret = normalizeSecret(secret) as unknown as string;
    const through = opts?.throughEventHash;
    const state = replayCache.get(normalizedSecret);
    if (through !== undefined && state?.context !== undefined && !state.stale) {
      return replayContextThrough(state.context, through, { enrichSizes: opts?.enrichSizes === true });
    }
    if (through === undefined) {
      if (state !== undefined) {
        if (!state.stale && state.context !== undefined) return state.context;
        if (state.pending !== undefined) return state.pending;
      }
    }
    const seed = through === undefined && state?.stale ? state.context : undefined;
    const pending = loadFileReplayContext(normalizedSecret, dependencies.crypto, channelStorage, {
      seed,
      enrichSizes: opts?.enrichSizes === true,
      throughEventHash: through,
    }).then((context) => {
      if (through === undefined) {
        replayCache.set(normalizedSecret, { context, stale: false });
      }
      return context;
    });
    if (through === undefined) {
      replayCache.set(normalizedSecret, { context: state?.context, pending, stale: false });
    }
    return pending;
  };

  const markReplayStale = (secret: string): void => {
    const normalizedSecret = normalizeSecret(secret) as unknown as string;
    const state = replayCache.get(normalizedSecret);
    if (state === undefined) return;
    replayCache.set(normalizedSecret, { ...state, stale: true });
  };

  const commitReplayEntry = (
    secret: string,
    entry: import('nearbytes-log').EventLogEntry,
  ): void => {
    const normalizedSecret = normalizeSecret(secret) as unknown as string;
    const state = replayCache.get(normalizedSecret);
    if (state?.context === undefined) {
      if (state !== undefined) replayCache.set(normalizedSecret, { ...state, stale: true });
      return;
    }
    replayCache.set(normalizedSecret, {
      context: extendFileReplayContext(state.context, [entry]),
      stale: false,
    });
  };

  return {
    addFile: async (secret, path, data, opts) =>
      addFileWithDeps(
        secret,
        path,
        data,
        opts,
        dependencies.crypto,
        channelStorage,
        now,
        getReplayContext,
        commitReplayEntry,
      ),
    mkdir: async (secret, path) =>
      mkdirWithDeps(
        secret,
        path,
        dependencies.crypto,
        channelStorage,
        now,
        getReplayContext,
        commitReplayEntry,
      ),
    delete: async (secret, path) =>
      deletePathWithDeps(
        secret,
        path,
        dependencies.crypto,
        channelStorage,
        now,
        getReplayContext,
        commitReplayEntry,
      ),
    rename: async (secret, fromPath, toPath) =>
      renameWithDeps(
        secret,
        fromPath,
        toPath,
        dependencies.crypto,
        channelStorage,
        now,
        getReplayContext,
        commitReplayEntry,
      ),
    listFiles: async (secret) =>
      listFilesWithDeps(secret, getReplayContext),
    listDirectories: async (secret) =>
      listDirectoriesWithDeps(secret, getReplayContext),
    getFile: async (secret, blobHash) =>
      getFileWithDeps(secret, blobHash, dependencies.crypto, channelStorage, getReplayContext),
    getFileByPath: async (secret, path) =>
      getFileByPathWithDeps(secret, path, dependencies.crypto, channelStorage, getReplayContext),
    readFileAtReplay: async (secret, path, replay) => {
      const normalizedSecret = normalizeSecret(secret);
      const currentFile = replay.fs.files.get(path);
      if (currentFile === undefined) {
        throw new DecryptionError('File is not available in the active volume');
      }
      const encryptedKey = replay.liveEncryptedKeys.get(path);
      if (encryptedKey === undefined) {
        throw new DecryptionError('File key is not available in the active volume');
      }
      return decryptStoredFile(
        normalizedSecret,
        currentFile.blobHash,
        encryptedKey,
        dependencies.crypto,
        channelStorage,
      );
    },
    getReplayContext: async (secret, opts) => getReplayContext(secret, opts),
    markReplayStale: (secret) => markReplayStale(secret),
    computeSnapshot: async (secret) =>
      computeSnapshotWithDeps(secret, now, getReplayContext),
    getTimeline: async (secret) =>
      getTimelineWithDeps(secret, getReplayContext),
    getTimelineDelta: async (secret, afterEventHash) =>
      getTimelineDeltaWithDeps(secret, afterEventHash, getReplayContext),
    getEvent: async (secret, eventHash) =>
      getEventWithDeps(secret, eventHash, dependencies.crypto, channelStorage),
    exportSourceReferences: async (secret, paths) =>
      exportSourceReferencesWithDeps(secret, paths, dependencies.crypto, channelStorage, now),
    importSourceReferences: async (destinationSecret, bundle, sourceSecret) => {
      const result = await importSourceReferencesWithDeps(
        destinationSecret,
        bundle,
        sourceSecret,
        dependencies.crypto,
        channelStorage,
        now,
      );
      markReplayStale(normalizeSecret(destinationSecret) as unknown as string);
      return result;
    },
    exportRecipientReferences: async (secret, paths, recipientVolumeId) =>
      exportRecipientReferencesWithDeps(
        secret,
        paths,
        recipientVolumeId,
        dependencies.crypto,
        channelStorage,
        now,
      ),
    importRecipientReferences: async (secret, bundle) => {
      const result = await importRecipientReferencesWithDeps(
        secret,
        bundle,
        dependencies.crypto,
        channelStorage,
        now,
      );
      markReplayStale(normalizeSecret(secret) as unknown as string);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

async function addFileWithDeps(
  secret: string,
  rawPath: string,
  data: Buffer,
  opts: AddFileOptions | undefined,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
  commitReplayEntry: (secret: string, entry: import('nearbytes-log').EventLogEntry) => void,
): Promise<FileMetadata> {
  const path = resolveAddPath(rawPath, opts);
  const normalizedSecret = normalizeSecret(secret);

  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, data);
  const blobHash = await channelStorage.blocks.store(encrypted.encryptedData, true);
  rememberBlobPlaintextSize(blobHash, data.length);

  const createdAt = now();
  const { fs, observedHead } = await getReplayContext(normalizedSecret);
  const entry = await appendCreateEvent(channelStorage, crypto, keyPair, {
    path,
    blobHash,
    encryptedKey: encrypted.encryptedKey,
    contentType: encrypted.contentType,
    mimeType: opts?.mimeType,
    createdAt,
    observedHead,
    lineages: [lineageAtPath(fs, path)],
  });
  commitReplayEntry(normalizedSecret, entry);

  return {
    path,
    blobHash,
    contentType: encrypted.contentType,
    size: data.length,
    mimeType: opts?.mimeType,
    createdAt,
  };
}

function resolveAddPath(rawPath: string, opts: AddFileOptions | undefined): string {
  /**
   * Three ways to specify the destination, in increasing precedence:
   *   1. The raw `path` argument — taken verbatim (after normalization).
   *   2. `opts.destinationDir` — prepended; the basename comes from `rawPath`.
   *   3. `opts.name` — replaces the basename of (1) and (2).
   */
  const dir = opts?.destinationDir;
  const name = opts?.name;
  let candidate: string;
  if (dir !== undefined && name !== undefined) {
    candidate = `${dir}/${name}`;
  } else if (dir !== undefined) {
    candidate = `${dir}/${rawPath}`;
  } else if (name !== undefined) {
    const parent = rawPath.includes('/') ? rawPath.slice(0, rawPath.lastIndexOf('/')) : '';
    candidate = parent.length > 0 ? `${parent}/${name}` : name;
  } else {
    candidate = rawPath;
  }
  return normalizeVolumePath(candidate);
}

async function mkdirWithDeps(
  secret: string,
  rawPath: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
  commitReplayEntry: (secret: string, entry: import('nearbytes-log').EventLogEntry) => void,
): Promise<DirectoryMetadata> {
  const path = normalizeVolumePath(rawPath);
  const normalizedSecret = normalizeSecret(secret);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const createdAt = now();
  const { fs, observedHead } = await getReplayContext(normalizedSecret);
  const entry = await appendMkdirEvent(
    channelStorage,
    crypto,
    keyPair,
    path,
    createdAt,
    [lineageAtPath(fs, path)],
    observedHead,
  );
  commitReplayEntry(normalizedSecret, entry);
  return { path, createdAt, explicit: true };
}

async function deletePathWithDeps(
  secret: string,
  rawPath: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
  commitReplayEntry: (secret: string, entry: import('nearbytes-log').EventLogEntry) => void,
): Promise<void> {
  const path = normalizeVolumePath(rawPath);
  const normalizedSecret = normalizeSecret(secret);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const { fs, observedHead } = await getReplayContext(normalizedSecret);
  const entry = await appendDeleteEvent(
    channelStorage,
    crypto,
    keyPair,
    path,
    now(),
    [lineageAtPath(fs, path)],
    observedHead,
  );
  commitReplayEntry(normalizedSecret, entry);
}

async function renameWithDeps(
  secret: string,
  rawFrom: string,
  rawTo: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
  commitReplayEntry: (secret: string, entry: import('nearbytes-log').EventLogEntry) => void,
): Promise<RenameSummary> {
  const fromPath = normalizeVolumePath(rawFrom);
  const toPath = normalizeVolumePath(rawTo);
  if (fromPath === toPath) {
    throw new Error('Source and destination paths are the same');
  }

  const normalizedSecret = normalizeSecret(secret);
  const replay = await getReplayContext(normalizedSecret);
  const timeline = mapEntriesToTimeline([...replay.orderedEntries], replay.fs);
  const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
  const renamedAt = Math.max(now(), maxTimestamp + 1);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const fs = replay.fs;
  const entry = await appendRenameEvent(
    channelStorage,
    crypto,
    keyPair,
    fromPath,
    toPath,
    renamedAt,
    lineagesForRename(fs, fromPath, toPath),
    replay.observedHead,
  );
  commitReplayEntry(normalizedSecret, entry);

  return { fromPath, toPath };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function listFilesWithDeps(
  secret: string,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<FileMetadata[]> {
  const replay = await getReplayContext(normalizeSecret(secret));
  const files = [...replay.fs.files.values()];
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function listDirectoriesWithDeps(
  secret: string,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<DirectoryMetadata[]> {
  const replay = await getReplayContext(normalizeSecret(secret));
  return [...replay.fs.directories.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function getFileWithDeps(
  secret: string,
  blobHash: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<Buffer> {
  const normalizedSecret = normalizeSecret(secret);
  const replay = await getReplayContext(normalizedSecret);
  const currentPath = [...replay.fs.files.entries()].find(([, file]) => file.blobHash === blobHash)?.[0];
  if (currentPath === undefined) {
    throw new DecryptionError('File is not available in the active volume');
  }
  const encryptedKey = replay.liveEncryptedKeys.get(currentPath);
  const currentFile = replay.fs.files.get(currentPath);
  if (currentFile === undefined || encryptedKey === undefined) {
    throw new DecryptionError('File is not available in the active volume');
  }
  return decryptStoredFile(
    normalizedSecret,
    currentFile.blobHash,
    encryptedKey,
    crypto,
    channelStorage,
  );
}

async function getFileByPathWithDeps(
  secret: string,
  path: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<Buffer> {
  const normalizedSecret = normalizeSecret(secret);
  const replay = await getReplayContext(normalizedSecret);
  const currentFile = replay.fs.files.get(path);
  if (!currentFile) {
    throw new DecryptionError('File is not available in the active volume');
  }
  const encryptedKey = replay.liveEncryptedKeys.get(path);
  if (encryptedKey === undefined) throw new DecryptionError('File key is not available in the active volume');
  return decryptStoredFile(
    normalizedSecret,
    currentFile.blobHash,
    encryptedKey,
    crypto,
    channelStorage,
  );
}

async function decryptStoredFile(
  normalizedSecret: Secret,
  blobHash: string,
  encryptedKey: EncryptedData,
  crypto: CryptoOperations,
  channelStorage: Log,
): Promise<Buffer> {
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  const encryptedData = await channelStorage.blocks.retrieve(blobHash as Hash);
  const plaintext = await decryptFileForVolume(
    crypto,
    keyPair.privateKey,
    encryptedData,
    encryptedKey,
  );
  return Buffer.from(plaintext);
}

async function computeSnapshotWithDeps(
  secret: string,
  now: () => number,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<SnapshotSummary> {
  const replay = await getReplayContext(normalizeSecret(secret));
  const fs = replay.fs;
  const lastEventHash = replay.orderedEntries.length > 0 ? replay.orderedEntries[replay.orderedEntries.length - 1]!.eventHash : null;

  return {
    generatedAt: now(),
    eventCount: replay.orderedEntries.length,
    fileCount: fs.files.size,
    directoryCount: fs.directories.size,
    lastEventHash,
  };
}

async function getTimelineWithDeps(
  secret: string,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<TimelineEvent[]> {
  const replay = await getReplayContext(normalizeSecret(secret));
  return mapEntriesToTimeline([...replay.orderedEntries], replay.fs);
}

async function getTimelineDeltaWithDeps(
  secret: string,
  afterEventHash: string | null | undefined,
  getReplayContext: (secret: string) => Promise<import('./fileEmit.js').FileReplayContext>,
): Promise<TimelineDelta> {
  const replay = await getReplayContext(normalizeSecret(secret));
  const timeline = mapEntriesToTimeline([...replay.orderedEntries]);
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
  return normalized.length === 0 ? null : normalized;
}

async function getEventWithDeps(
  secret: string,
  eventHash: string,
  crypto: CryptoOperations,
  channelStorage: Log,
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
    decryptedPayload: entry
      ? serializeInnerEventPayloadJson(entry.signedEvent.payload)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Source / recipient reference bundles
// ---------------------------------------------------------------------------

async function exportSourceReferencesWithDeps(
  secret: string,
  paths: string[],
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
): Promise<ReferenceExportResult<SourceReferenceBundle>> {
  const normalizedSecret = normalizeSecret(secret);
  const orderedPaths = dedupeOrderedFilenames(paths);
  if (orderedPaths.length === 0) throw new Error('At least one path is required');

  const volume = await openChannel(normalizedSecret, crypto);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  let { entries, files } = await loadVolumeFiles(crypto, channelStorage, volume);
  let upgradedCount = 0;

  upgradedCount += await upgradeLegacyFilesForExport(
    orderedPaths,
    files,
    entries,
    keyPair,
    crypto,
    channelStorage,
    now,
  );
  if (upgradedCount > 0) {
    ({ files, entries } = await loadVolumeFiles(crypto, channelStorage, volume));
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const bundle: SourceReferenceBundle = {
    p: 'nb.src.refs.v1',
    s: volumeIdFromPublicKey(keyPair.publicKey),
    items: orderedPaths.map((path) => {
      const file = requireStoredFile(fileMap, path);
      return {
        name: file.path,
        mime: file.mimeType,
        createdAt: file.createdAt,
        ref: {
          p: 'nb.src.ref.v1',
          s: volumeIdFromPublicKey(keyPair.publicKey),
          c: { t: file.contentType, h: file.blobHash, z: file.size },
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
  now: () => number,
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
    now,
  );

  return { imported };
}

async function exportRecipientReferencesWithDeps(
  secret: string,
  paths: string[],
  recipientVolumeId: string,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
): Promise<ReferenceExportResult<RecipientReferenceBundle>> {
  const normalizedSecret = normalizeSecret(secret);
  const orderedPaths = dedupeOrderedFilenames(paths);
  if (orderedPaths.length === 0) throw new Error('At least one path is required');

  publicKeyFromVolumeId(recipientVolumeId);

  const volume = await openChannel(normalizedSecret, crypto);
  const keyPair = await crypto.deriveKeys(normalizedSecret);
  let { entries, files } = await loadVolumeFiles(crypto, channelStorage, volume);
  let upgradedCount = 0;

  upgradedCount += await upgradeLegacyFilesForExport(
    orderedPaths,
    files,
    entries,
    keyPair,
    crypto,
    channelStorage,
    now,
  );
  if (upgradedCount > 0) {
    ({ files, entries } = await loadVolumeFiles(crypto, channelStorage, volume));
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const items: RecipientReferenceBundle['items'] = [];
  for (const path of orderedPaths) {
    const file = requireStoredFile(fileMap, path);
    const fileKey = await unwrapFileKeyForVolume(crypto, keyPair.privateKey, file.encryptedKey);
    const capsule = await createRecipientKeyCapsule(fileKey, recipientVolumeId, {
      t: file.contentType,
      h: file.blobHash,
      z: file.size,
    });
    items.push({
      name: file.path,
      mime: file.mimeType,
      createdAt: file.createdAt,
      ref: {
        p: 'nb.ref.v1',
        c: { t: file.contentType, h: file.blobHash, z: file.size },
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
  now: () => number,
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
  const takenNames = new Set(files.map((file) => file.path));
  const imported: FileMetadata[] = [];
  let nextTimestamp = nextCreateTimestamp(entries, now());
  let observedHead = observedHashFromEntries(entries);

  for (const item of bundle.items) {
    const finalName = resolveImportedFilename(item.name, takenNames);
    takenNames.add(finalName);

    const descriptor = item.ref.c;
    const fileKey = await unwrapRecipientKeyCapsule(
      destinationKeyPair.privateKey,
      activeVolumeId,
      descriptor,
      item.ref.k,
    );
    await ensureDestinationBlockAvailable(channelStorage, descriptor.h);
    const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
    const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);

    const fs = runMaterialization(toCanonicalEntries(entries));
    const entry = await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
      path: finalName,
      blobHash: descriptor.h,
      encryptedKey,
      contentType: descriptor.t,
      mimeType: item.mime,
      createdAt,
      observedHead,
      lineages: [lineageAtPath(fs, finalName)],
    });
    observedHead = createHash(entry.eventHash);

    imported.push({
      path: finalName,
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

// ---------------------------------------------------------------------------
// Materialization helpers
// ---------------------------------------------------------------------------

function materializeStoredFilesFromEntries(entries: EventLogEntry[]): StoredFileRecord[] {
  const fs = runMaterialization(toCanonicalEntries(entries));

  /**
   * Index every CREATE_FILE event by its hash so we can recover the
   * StoredFileRecord shape (which carries the encrypted key needed for
   * decryption / export). The materializer's `fileOrigins` map gives us
   * the *exact* CREATE_FILE event that produced the live content for
   * each path — no timeline-walking heuristics, no brittle dir-rename
   * tracing.
   */
  const sourceByEventHash = new Map<string, StoredFileRecord>();
  for (const row of buildTimelineRows(entries)) {
    if (row.type !== EventType.CREATE_FILE) continue;
    if (
      row.blobHash === undefined ||
      row.encryptedKey === undefined ||
      row.createdAt === undefined
    ) {
      continue;
    }
    sourceByEventHash.set(row.eventHash, {
      path: row.path,
      blobHash: row.blobHash,
      encryptedKey: row.encryptedKey,
      contentType: row.contentType ?? 'b',
      size: row.size ?? 0,
      mimeType: row.mimeType,
      createdAt: row.createdAt,
    });
  }

  const results: StoredFileRecord[] = [];
  for (const [path, meta] of fs.files) {
    const origin = fs.fileOrigins.get(path);
    if (origin === undefined) continue;
    const src = sourceByEventHash.get(origin);
    if (!src) continue;
    results.push({
      ...src,
      path,
      blobHash: meta.blobHash,
      contentType: (meta.contentType ?? src.contentType) as FileContentType,
      createdAt: meta.createdAt,
      mimeType: meta.mimeType ?? src.mimeType,
    });
  }
  results.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.path.localeCompare(b.path);
  });
  return results;
}

function mapEntriesToTimeline(
  entries: EventLogEntry[],
  fs?: MaterializedFileSystem,
): TimelineEvent[] {
  const rows = buildTimelineRows(entries, fs !== undefined);
  const materialized = fs ?? runMaterialization(toCanonicalEntries(entries));
  const shadowsByTiebreak = new Map<string, MaterializedShadow['reject']>();
  for (const shadow of materialized.shadows) shadowsByTiebreak.set(shadow.tiebreak, shadow.reject);

  return rows.map((row) => {
    const out: TimelineEvent = {
      eventHash: row.eventHash,
      type: row.type,
      path: row.path,
      timestamp: row.timestamp,
      protocol: row.protocol,
      toPath: row.toPath,
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
    };
    const shadow = shadowsByTiebreak.get(row.eventHash);
    if (shadow) out.shadow = shadow;
    return out;
  });
}

function buildTimelineRows(entries: EventLogEntry[], alreadyOrdered = false): StoredTimelineRow[] {
  const rows: StoredTimelineRow[] = [];
  const orderedEntries = alreadyOrdered ? entries : orderEventLogEntries(entries);

  for (let sequence = 0; sequence < orderedEntries.length; sequence += 1) {
    const entry = orderedEntries[sequence]!;
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
        path: p.path,
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

    if (payload.type === EventType.MKDIR) {
      const inferredTimestamp = payload.createdAt ?? sequence;
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.MKDIR,
        path: payload.path,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        createdAt: inferredTimestamp,
      });
      continue;
    }

    if (payload.type === EventType.DELETE) {
      const inferredTimestamp = payload.deletedAt ?? sequence;
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.DELETE,
        path: payload.path,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        deletedAt: inferredTimestamp,
      });
      continue;
    }

    if (payload.type === EventType.RENAME) {
      const inferredTimestamp = payload.renamedAt ?? sequence;
      rows.push({
        eventHash: entry.eventHash,
        type: EventType.RENAME,
        path: payload.fromPath,
        timestamp: inferredTimestamp,
        hasExplicitTimestamp: true,
        sequence,
        toPath: payload.toPath,
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
        path: '',
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
        path: '',
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
          path: '',
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
          path: '',
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
          path: '',
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
        path: '',
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

  return rows;
}

async function loadVolumeFiles(
  crypto: CryptoOperations,
  channelStorage: Log,
  volume: Awaited<ReturnType<typeof openChannel>>,
): Promise<{ entries: EventLogEntry[]; files: StoredFileRecord[] }> {
  const entries = await loadEventLog(volume, channelStorage, crypto);
  await verifyEventLog(entries, volume, crypto);
  return { entries, files: materializeStoredFilesFromEntries(entries) };
}

async function upgradeLegacyFilesForExport(
  paths: readonly string[],
  files: readonly StoredFileRecord[],
  entries: EventLogEntry[],
  keyPair: KeyPair,
  crypto: CryptoOperations,
  channelStorage: Log,
  now: () => number,
): Promise<number> {
  const fileMap = new Map(files.map((file) => [file.path, file]));
  let upgradedCount = 0;
  let timestamp = Math.max(now(), ...files.map((file) => file.createdAt + 1), 0);
  let observedHead = observedHashFromEntries(entries);

  for (const path of paths) {
    const file = requireStoredFile(fileMap, path);
    if (file.encryptedKey.length > 0) continue;

    const encryptedData = await channelStorage.blocks.retrieve(file.blobHash as Hash);
    const plaintext = await decryptFileForVolume(
      crypto,
      keyPair.privateKey,
      encryptedData,
      file.encryptedKey,
    );
    const encrypted = await encryptFileForVolume(crypto, keyPair.privateKey, plaintext);
    const blobHash = await channelStorage.blocks.store(encrypted.encryptedData, true);
    const fs = runMaterialization(toCanonicalEntries(entries));
    const entry = await appendCreateEvent(channelStorage, crypto, keyPair, {
      path: file.path,
      blobHash,
      encryptedKey: encrypted.encryptedKey,
      contentType: encrypted.contentType,
      mimeType: file.mimeType,
      createdAt: timestamp,
      observedHead,
      lineages: [lineageAtPath(fs, file.path)],
    });
    observedHead = createHash(entry.eventHash);

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
  now: () => number,
): Promise<FileMetadata[]> {
  const takenNames = new Set(existingFiles.map((file) => file.path));
  const imported: FileMetadata[] = [];
  let nextTimestamp = nextCreateTimestamp(entries, now());
  let observedHead = observedHashFromEntries(entries);

  for (const item of bundle.items) {
    const finalName = resolveImportedFilename(item.name, takenNames);
    takenNames.add(finalName);

    const fileKey = await unwrapFileKeyForVolume(
      crypto,
      sourceKeyPair.privateKey,
      decodeWrappedKey(item.ref.x, 'Source reference wrapped key'),
    );
    await ensureDestinationBlockAvailable(channelStorage, item.ref.c.h);
    const encryptedKey = await wrapFileKeyForVolume(crypto, destinationKeyPair.privateKey, fileKey);
    const createdAt = resolveImportedCreatedAt(item.createdAt, nextTimestamp);

    const fs = runMaterialization(toCanonicalEntries([...entries]));
    const entry = await appendCreateEvent(channelStorage, crypto, destinationKeyPair, {
      path: finalName,
      blobHash: item.ref.c.h,
      encryptedKey,
      contentType: item.ref.c.t,
      mimeType: item.mime,
      createdAt,
      observedHead,
      lineages: [lineageAtPath(fs, finalName)],
    });
    observedHead = createHash(entry.eventHash);

    imported.push({
      path: finalName,
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
  // See `nearbytes-specs/storage/log-api-v1.md §2.3` — `store` is the
  // authoritative write path; `storeAlreadyVerified` is reserved for the
  // streaming sync fast path inside `nearbytes-sync`.
  const encryptedData = await channelStorage.blocks.retrieve(blobHash as Hash);
  await channelStorage.blocks.store(encryptedData);
}

function nextCreateTimestamp(entries: readonly EventLogEntry[], fallbackNow: number): number {
  const timeline = mapEntriesToTimeline([...entries]);
  const maxTimestamp = timeline.reduce((max, event) => Math.max(max, event.timestamp), 0);
  return Math.max(fallbackNow, maxTimestamp + 1);
}

function observedHashFromEntries(entries: readonly EventLogEntry[]): Hash | undefined {
  const head = observedLogHead(entries);
  return head !== undefined ? createHash(head) : undefined;
}

function resolveImportedCreatedAt(
  preferredCreatedAt: number | undefined,
  minimumCreatedAt: number,
): number {
  if (preferredCreatedAt === undefined) return minimumCreatedAt;
  return Math.max(preferredCreatedAt, minimumCreatedAt);
}

function requireStoredFile(
  files: ReadonlyMap<string, StoredFileRecord>,
  path: string,
): StoredFileRecord {
  const file = files.get(path);
  if (!file) throw new Error(`File "${path}" does not exist`);
  return file;
}

function timelineSnippet(value: string | undefined, limit = 72): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

// ---------------------------------------------------------------------------
// Event emit helpers
// ---------------------------------------------------------------------------

async function appendCreateEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  input: {
    path: string;
    blobHash: string;
    encryptedKey: EncryptedData;
    contentType: FileContentType;
    mimeType?: string;
    createdAt: number;
    observedHead?: Hash;
    lineages: readonly CausalLineage[];
  },
): Promise<EventLogEntry> {
  const contentDescriptor =
    input.contentType === 'm'
      ? ({ protocol: 'nb.content.manifest.v1', manifestHash: input.blobHash as Hash } as const)
      : ({ protocol: 'nb.content.single.v1', blockHash: input.blobHash as Hash } as const);
  const payload: EventPayload = {
    type: EventType.CREATE_FILE,
    path: input.path,
    content: contentDescriptor,
    wrappedKey: input.encryptedKey,
    createdAt: input.createdAt,
    mimeType: input.mimeType,
  };
  return emitFileEvent(crypto, keyPair, channelStorage, payload, input.observedHead, input.lineages, [
    input.blobHash as Hash,
  ]);
}

async function appendMkdirEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  path: string,
  createdAt: number,
  lineages: readonly CausalLineage[],
  observedHead?: Hash,
): Promise<EventLogEntry> {
  const payload: EventPayload = { type: EventType.MKDIR, path, createdAt };
  return emitFileEvent(crypto, keyPair, channelStorage, payload, observedHead, lineages, []);
}

async function appendDeleteEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  path: string,
  deletedAt: number,
  lineages: readonly CausalLineage[],
  observedHead?: Hash,
): Promise<EventLogEntry> {
  const payload: EventPayload = { type: EventType.DELETE, path, deletedAt };
  return emitFileEvent(crypto, keyPair, channelStorage, payload, observedHead, lineages, []);
}

async function appendRenameEvent(
  channelStorage: Log,
  crypto: CryptoOperations,
  keyPair: KeyPair,
  fromPath: string,
  toPath: string,
  renamedAt: number,
  lineages: readonly CausalLineage[],
  observedHead?: Hash,
): Promise<EventLogEntry> {
  const payload: EventPayload = { type: EventType.RENAME, fromPath, toPath, renamedAt };
  return emitFileEvent(crypto, keyPair, channelStorage, payload, observedHead, lineages, []);
}

function normalizeSecret(secret: string): Secret {
  return createSecret(secret);
}
