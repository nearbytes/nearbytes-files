/**
 * Browser-safe exports (no Node.js fs/os/path, no nearbytes-skeleton).
 * Use this entry from Vite/renderer code instead of the package root.
 */

export type {
  SourceReferenceBundle,
  RecipientReferenceBundle,
  FileContentType,
  ContentDescriptor,
  RecipientKeyCapsule,
  SourceFileReference,
  RecipientFileReference,
} from './fileReferenceCodec.js';

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
