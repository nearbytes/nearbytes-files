/**
 * Node/browser-capable file service entry (no nearbytes-skeleton / reactive volume).
 */

export type {
  FileService,
  FileServiceDependencies,
  TimelineEvent,
  TimelineDelta,
  EventDetail,
  SnapshotSummary,
  ReferenceExportResult,
  SourceImportResult,
  RecipientImportResult,
  RenameFileSummary,
  RenameFolderSummary,
} from './fileService.js';

export { createFileService } from './fileService.js';

export {
  volumeIdFromPublicKey,
  publicKeyFromVolumeId,
} from './fileCrypto.js';
