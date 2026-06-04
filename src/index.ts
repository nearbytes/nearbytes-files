// Reactive volume
export { createReactiveVolume } from './reactiveVolume.js';
export type { ReactiveVolume } from './reactiveVolume.js';

// Types
export type {
  FileMetadata,
  DirectoryMetadata,
  FileEvent,
  CreateFileEvent,
  MkdirEvent,
  DeleteEvent,
  RenameEvent,
} from './fileEvents.js';
export type {
  FileService,
  FileServiceDependencies,
  AddFileOptions,
  TimelineEvent,
  TimelineDelta,
  EventDetail,
  SnapshotSummary,
  ReferenceExportResult,
  SourceImportResult,
  RecipientImportResult,
  RenameSummary,
} from './fileService.js';
export type {
  SourceReferenceBundle,
  RecipientReferenceBundle,
  FileContentType,
  ContentDescriptor,
  RecipientKeyCapsule,
  SourceFileReference,
  RecipientFileReference,
} from './fileReferenceCodec.js';
export type {
  IdentityRecord,
  IdentitySnapshot,
  ChatMessage,
  IdentityProfile,
} from 'nearbytes-chat';
export type { EncryptedFileWrite, RecipientKeyCapsuleBytes } from './fileCrypto.js';

// Functions
export { createFileService } from './fileService.js';
export {
  encryptFileForVolume,
  decryptFileForVolume,
  volumeIdFromPublicKey,
  publicKeyFromVolumeId,
  wrapFileKeyForVolume,
  unwrapFileKeyForVolume,
  createRecipientKeyCapsule,
  unwrapRecipientKeyCapsule,
} from './fileCrypto.js';
export {
  serializeSourceReferenceBundle,
  parseSourceReferenceBundle,
  serializeRecipientReferenceBundle,
  parseRecipientReferenceBundle,
  encodeWrappedKey,
  decodeWrappedKey,
  canonicalJsonBytes,
  canonicalJsonString,
  parseSourceFileReferenceValue,
  parseSourceReferenceJson,
  parseRecipientReferenceJson,
} from './fileReferenceCodec.js';
export { reconstructFileState } from './fileState.js';
export { isFileEvent, encodeFileEvent, decodeFileEvent } from './fileEventCodec.js';
export { dedupeOrderedFilenames, resolveImportedFilename } from './fileCommands.js';
export type { FileReplayContext, LoadFileReplayContextOptions } from './fileEmit.js';
export {
  findEventIndex,
  formatTimelineGotoIndexError,
  loadFileReplayContext,
  replayContextThrough,
} from './fileEmit.js';
export type { Channel } from 'nearbytes-log';
export { openChannel, loadEventLog, verifyEventLog } from 'nearbytes-log';
export type { Volume, VolumeFileMetadata, VolumeFileSystemState } from './volume.js';
export {
  openVolume,
  replayEvents,
  materializeVolume,
  getFile,
  listFiles,
  listDirectories,
} from './volume.js';
export {
  storeData,
  retrieveData,
  storeDataDeduplicated,
  deletePath,
  setupChannel,
} from './operations.js';
export { normalizeVolumePath, basename, dirname } from './pathUtils.js';
export {
  attachSyncInboundRefresh,
  type SyncInboundRefreshHost,
  type SyncInboundRefreshOptions,
} from './syncInboundRefresh.js';
