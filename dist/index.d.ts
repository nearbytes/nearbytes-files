export type { FileMetadata, FileEvent, CreateFileEvent, DeleteFileEvent, RenameFileEvent } from './fileEvents.js';
export type { FileService, FileServiceDependencies, TimelineEvent, TimelineDelta, EventDetail, SnapshotSummary, ReferenceExportResult, SourceImportResult, RecipientImportResult, RenameFileSummary, RenameFolderSummary, } from './fileService.js';
export type { SourceReferenceBundle, RecipientReferenceBundle, FileContentType, ContentDescriptor, RecipientKeyCapsule, SourceFileReference, RecipientFileReference, } from './fileReferenceCodec.js';
export type { IdentityRecord, IdentitySnapshot, ChatMessage, IdentityProfile, } from './chatCodec.js';
export type { EncryptedFileWrite, RecipientKeyCapsuleBytes } from './fileCrypto.js';
export { createFileService } from './fileService.js';
export { encryptFileForVolume, decryptFileForVolume, volumeIdFromPublicKey, publicKeyFromVolumeId, wrapFileKeyForVolume, unwrapFileKeyForVolume, createRecipientKeyCapsule, unwrapRecipientKeyCapsule, } from './fileCrypto.js';
export { serializeSourceReferenceBundle, parseSourceReferenceBundle, serializeRecipientReferenceBundle, parseRecipientReferenceBundle, encodeWrappedKey, decodeWrappedKey, canonicalJsonBytes, canonicalJsonString, parseSourceFileReferenceValue, parseSourceReferenceJson, parseRecipientReferenceJson, } from './fileReferenceCodec.js';
export { reconstructFileState } from './fileState.js';
export { isFileEvent, encodeFileEvent, decodeFileEvent } from './fileEventCodec.js';
export { dedupeOrderedFilenames, resolveImportedFilename } from './fileCommands.js';
export type { Volume, VolumeFileMetadata, VolumeFileSystemState } from './volume.js';
export { openVolume, loadEventLog, verifyEventLog, replayEvents, materializeVolume, getFile, listFiles, } from './volume.js';
export { storeData, retrieveData, storeDataDeduplicated, deleteFile, setupChannel, } from './operations.js';
export { createIdentityRecord, verifyIdentityRecord, createChatMessage, verifyChatMessage, createIdentitySnapshot, verifyIdentitySnapshot, parseChatMessageJson, parseIdentityRecordJson, parseIdentitySnapshotJson, parseChatMessage, parseIdentityRecord, parseIdentitySnapshot, serializeIdentityRecord, serializeChatMessage, serializeIdentitySnapshot, publicKeyFromHex, } from './chatCodec.js';
//# sourceMappingURL=index.d.ts.map