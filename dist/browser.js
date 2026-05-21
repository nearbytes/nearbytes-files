/**
 * Browser-safe exports (no Node.js fs/os/path, no nearbytes-skeleton).
 * Use this entry from Vite/renderer code instead of the package root.
 */
export { serializeSourceReferenceBundle, parseSourceReferenceBundle, serializeRecipientReferenceBundle, parseRecipientReferenceBundle, encodeWrappedKey, decodeWrappedKey, canonicalJsonBytes, canonicalJsonString, parseSourceFileReferenceValue, parseSourceReferenceJson, parseRecipientReferenceJson, } from './fileReferenceCodec.js';
//# sourceMappingURL=browser.js.map