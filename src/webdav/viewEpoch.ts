import type { FileReplayContext } from '../fileEmit.js';

/** Composite WebDAV validator so clients invalidate cache when the REPL view changes. */
export function webDavResourceEtag(viewEpoch: string, resourceTag: string | undefined): string {
  const tag = resourceTag ?? 'collection';
  return `${viewEpoch}::${tag}`;
}

/** Stable, monotonic last-modified for collection PROPFIND (changes when the replay prefix grows). */
export function snapshotViewLastModified(snapshot: FileReplayContext): Date {
  const n = snapshot.orderedEntries.length;
  return n > 0 ? new Date(n * 1000) : new Date(0);
}
