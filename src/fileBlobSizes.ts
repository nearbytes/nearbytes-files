/**
 * In-process cache of plaintext byte lengths keyed by content block hash.
 * Populated on write and on first decrypt during WebDAV size enrichment.
 */

const plaintextSizeByBlobHash = new Map<string, number>();

export function rememberBlobPlaintextSize(blobHash: string, size: number): void {
  if (size < 0) return;
  plaintextSizeByBlobHash.set(blobHash, size);
}

export function cachedBlobPlaintextSize(blobHash: string): number | undefined {
  return plaintextSizeByBlobHash.get(blobHash);
}
