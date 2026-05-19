import type { FileEvent, FileMetadata } from './fileEvents.js';
/**
 * Reconstructs the current file state by replaying an append-only event log.
 *
 * Event sourcing treats the log as the single source of truth. By deterministically
 * applying all file events in chronological order, the current state can always be
 * derived without any mutable index. This guarantees that the same event history
 * produces the same file listing on every machine.
 *
 * @param events - File events to replay
 * @returns Map of filename to reconstructed file metadata
 */
export declare function reconstructFileState(events: FileEvent[]): Map<string, FileMetadata>;
//# sourceMappingURL=fileState.d.ts.map