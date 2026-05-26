/**
 * File-events-v0.4 materializer.
 *
 * The materializer is the only place where the "cascade" semantics of the
 * file protocol live: implicit ancestor directories, recursive DELETE,
 * prefix-swap RENAME, and conflict resolution between the file and
 * directory namespaces. Protocol events are pure syntax — every event
 * carries one user intent and no implicit dependencies.
 *
 * Conflict resolution is *first-event wins*: in deterministic replay
 * order, whichever event establishes a name in the file or directory
 * namespace claims it. Later events that would collide with that name
 * (e.g. `mkdir foo` after `put foo` was already a file, or
 * `rename foo bar` when `bar` already exists as something incompatible)
 * are recorded as `shadow` rows on the timeline and leave the
 * materialized state unchanged. Conflicts are normal — replay the
 * timeline at any point and you will see the same outcome.
 *
 * Unknown event types are tolerated: the materializer warns once per
 * verb-string per replay and records a `{ kind: 'unknown' }` shadow row.
 */

import type { DirectoryMetadata, FileMetadata } from './fileEvents.js';
import {
  ancestorPaths,
  isSelfOrDescendant,
  isStrictDescendant,
  pathChain,
  rewritePrefix,
} from './pathUtils.js';

/** Per-directory tracking. `fileCount` is the number of live files in the subtree rooted here. */
interface DirInfo {
  createdAt: number;
  explicit: boolean;
  fileCount: number;
}

/**
 * A row recorded in the timeline because an event was *replayed* — either
 * it was applied to state (`reject` undefined) or it was rejected as a
 * conflict (`reject` set). All replay rows preserve the original event
 * payload fields so callers can render the protocol intent verbatim.
 */
export interface MaterializedShadow {
  reject:
    | { kind: 'unknown'; verb: string }
    | { kind: 'file-where-dir'; path: string }
    | { kind: 'dir-where-file'; path: string }
    | { kind: 'ancestor-is-file'; path: string; conflictingAncestor: string }
    | { kind: 'target-exists-different-kind'; target: string }
    | { kind: 'target-non-empty'; target: string }
    | { kind: 'source-missing'; source: string }
    | { kind: 'rename-into-self'; source: string; target: string };
}

export type CanonicalEventKind = 'CREATE_FILE' | 'MKDIR' | 'DELETE' | 'RENAME' | 'OTHER';

/**
 * Canonical, codec-agnostic view of a file-events-v0.4 event.
 * Callers translate their wire format (encrypted `EventPayload`, plain
 * `FileEvent`, etc.) to this shape before feeding the materializer.
 *
 * `kind === 'OTHER'` (chat/identity/app records or unknown verbs) is
 * passed through so the timeline preserves them but does not affect
 * file-system state.
 */
export type CanonicalEvent =
  | {
      readonly kind: 'CREATE_FILE';
      readonly path: string;
      readonly blobHash: string;
      readonly contentType: 'b' | 'm';
      readonly size: number;
      readonly mimeType: string | undefined;
      readonly createdAt: number;
    }
  | { readonly kind: 'MKDIR'; readonly path: string; readonly createdAt: number }
  | { readonly kind: 'DELETE'; readonly path: string; readonly deletedAt: number }
  | {
      readonly kind: 'RENAME';
      readonly fromPath: string;
      readonly toPath: string;
      readonly renamedAt: number;
    }
  | { readonly kind: 'OTHER'; readonly verb: string; readonly timestamp: number };

export interface CanonicalEntry {
  /** Stable identifier (event hash, sequence index, etc.) — used as a sort tiebreaker. */
  readonly tiebreak: string;
  readonly event: CanonicalEvent;
}

export interface MaterializedFileSystem {
  readonly files: ReadonlyMap<string, FileMetadata>;
  readonly directories: ReadonlyMap<string, DirectoryMetadata>;
  /**
   * For each live file, the `tiebreak` of the CREATE_FILE event whose
   * content the path currently holds. Survives RENAME (the lineage stays
   * pointed at the original CREATE) and is updated by overwriting
   * CREATE_FILE events. Useful for consumers that need to look up the
   * source event without re-walking the timeline.
   */
  readonly fileOrigins: ReadonlyMap<string, string>;
  /** Replay rejections, in the order they occurred. */
  readonly shadows: ReadonlyArray<{ readonly tiebreak: string; readonly reject: MaterializedShadow['reject'] }>;
}

/**
 * Replay a stream of canonical events to produce the materialized
 * file-system state. Callers should pre-sort entries by the
 * file-events-v0.4 total order (timestamp → sequence → tiebreak); this
 * function applies them as given.
 */
export function materialize(entries: readonly CanonicalEntry[]): MaterializedFileSystem {
  const files = new Map<string, FileMetadata>();
  const dirs = new Map<string, DirInfo>();
  const fileOrigins = new Map<string, string>();
  const shadows: { tiebreak: string; reject: MaterializedShadow['reject'] }[] = [];
  const warnedVerbs = new Set<string>();

  const recordShadow = (
    tiebreak: string,
    reject: MaterializedShadow['reject'],
  ): void => {
    shadows.push({ tiebreak, reject });
  };

  for (const { tiebreak, event } of entries) {
    switch (event.kind) {
      case 'CREATE_FILE':
        applyCreateFile(event, files, dirs, fileOrigins, tiebreak, recordShadow.bind(null, tiebreak));
        break;
      case 'MKDIR':
        applyMkdir(event, files, dirs, recordShadow.bind(null, tiebreak));
        break;
      case 'DELETE':
        applyDelete(event, files, dirs, fileOrigins);
        break;
      case 'RENAME':
        applyRename(event, files, dirs, fileOrigins, recordShadow.bind(null, tiebreak));
        break;
      case 'OTHER': {
        if (!isKnownNonFileVerb(event.verb) && !warnedVerbs.has(event.verb)) {
          warnedVerbs.add(event.verb);
          process.stderr.write(
            `[nearbytes-files:materializer] warning: skipping unknown event verb "${event.verb}" — replay will continue\n`,
          );
          recordShadow(tiebreak, { kind: 'unknown', verb: event.verb });
        }
        break;
      }
    }
  }

  const directories = new Map<string, DirectoryMetadata>();
  for (const [path, info] of dirs) {
    directories.set(path, {
      path,
      createdAt: info.createdAt,
      explicit: info.explicit,
    });
  }

  return { files, directories, fileOrigins, shadows };
}

/** App-layer verbs that legitimately produce no filesystem effect. */
function isKnownNonFileVerb(verb: string): boolean {
  return (
    verb === 'DECLARE_IDENTITY' ||
    verb === 'CHAT_MESSAGE' ||
    verb === 'APP_RECORD'
  );
}

// ---------------------------------------------------------------------------
// CREATE_FILE
// ---------------------------------------------------------------------------

function applyCreateFile(
  event: Extract<CanonicalEvent, { kind: 'CREATE_FILE' }>,
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  fileOrigins: Map<string, string>,
  tiebreak: string,
  shadow: (reject: MaterializedShadow['reject']) => void,
): void {
  if (dirs.has(event.path)) {
    shadow({ kind: 'file-where-dir', path: event.path });
    return;
  }
  for (const ancestor of ancestorPaths(event.path)) {
    if (files.has(ancestor)) {
      shadow({ kind: 'ancestor-is-file', path: event.path, conflictingAncestor: ancestor });
      return;
    }
  }

  /**
   * CREATE_FILE on an existing file replaces it (CRDT-trivial — same path,
   * later event wins). The ancestor `fileCount` does not change, since the
   * count is "live files in the subtree" and we are swapping one for one.
   */
  const wasFile = files.has(event.path);

  files.set(event.path, {
    path: event.path,
    blobHash: event.blobHash,
    contentType: event.contentType,
    size: event.size,
    mimeType: event.mimeType,
    createdAt: event.createdAt,
  });
  fileOrigins.set(event.path, tiebreak);

  if (!wasFile) {
    for (const ancestor of ancestorPaths(event.path)) {
      ensureImplicitDir(dirs, ancestor, event.createdAt);
      dirs.get(ancestor)!.fileCount += 1;
    }
  }
}

function ensureImplicitDir(dirs: Map<string, DirInfo>, path: string, createdAt: number): void {
  const existing = dirs.get(path);
  if (existing !== undefined) return;
  dirs.set(path, { createdAt, explicit: false, fileCount: 0 });
}

// ---------------------------------------------------------------------------
// MKDIR
// ---------------------------------------------------------------------------

function applyMkdir(
  event: Extract<CanonicalEvent, { kind: 'MKDIR' }>,
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  shadow: (reject: MaterializedShadow['reject']) => void,
): void {
  /**
   * Reject the whole MKDIR if the target — or any ancestor — is currently a
   * file. Partial application would silently introduce inconsistent
   * intermediate dirs.
   */
  for (const segment of pathChain(event.path)) {
    if (files.has(segment)) {
      if (segment === event.path) {
        shadow({ kind: 'dir-where-file', path: event.path });
      } else {
        shadow({ kind: 'ancestor-is-file', path: event.path, conflictingAncestor: segment });
      }
      return;
    }
  }

  for (const segment of pathChain(event.path)) {
    const existing = dirs.get(segment);
    if (existing === undefined) {
      dirs.set(segment, {
        createdAt: event.createdAt,
        explicit: segment === event.path,
        fileCount: 0,
      });
    } else if (segment === event.path && !existing.explicit) {
      /**
       * Promote an implicit dir to explicit. Use the MKDIR timestamp as the
       * authoritative createdAt so timelines align with the user intent.
       */
      existing.explicit = true;
      existing.createdAt = Math.min(existing.createdAt, event.createdAt);
    }
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

function applyDelete(
  event: Extract<CanonicalEvent, { kind: 'DELETE' }>,
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  fileOrigins: Map<string, string>,
): void {
  if (files.has(event.path)) {
    files.delete(event.path);
    fileOrigins.delete(event.path);
    decrementAncestors(dirs, event.path, 1);
    return;
  }
  if (!dirs.has(event.path)) {
    /**
     * Idempotent no-op: deleting a path that does not exist is a valid event
     * (concurrent peers may both delete the same path). The timeline keeps
     * the event for audit; no shadow row is needed.
     */
    return;
  }

  let removedFileCount = 0;
  for (const fpath of [...files.keys()]) {
    if (isSelfOrDescendant(fpath, event.path)) {
      files.delete(fpath);
      fileOrigins.delete(fpath);
      removedFileCount += 1;
    }
  }
  for (const dpath of [...dirs.keys()]) {
    if (isSelfOrDescendant(dpath, event.path)) {
      dirs.delete(dpath);
    }
  }
  if (removedFileCount > 0) {
    decrementAncestors(dirs, event.path, removedFileCount);
  }
}

/**
 * Decrement `fileCount` on every strict ancestor of `path` by `delta`.
 * Implicit dirs whose count hits zero are removed.
 */
function decrementAncestors(dirs: Map<string, DirInfo>, path: string, delta: number): void {
  for (const ancestor of ancestorPaths(path)) {
    const info = dirs.get(ancestor);
    if (info === undefined) continue;
    info.fileCount = Math.max(0, info.fileCount - delta);
    if (info.fileCount === 0 && !info.explicit) {
      dirs.delete(ancestor);
    }
  }
}

// ---------------------------------------------------------------------------
// RENAME
// ---------------------------------------------------------------------------

function applyRename(
  event: Extract<CanonicalEvent, { kind: 'RENAME' }>,
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  fileOrigins: Map<string, string>,
  shadow: (reject: MaterializedShadow['reject']) => void,
): void {
  if (event.fromPath === event.toPath) return;

  const fromKind = files.has(event.fromPath)
    ? 'file'
    : dirs.has(event.fromPath)
      ? 'dir'
      : 'missing';
  if (fromKind === 'missing') {
    shadow({ kind: 'source-missing', source: event.fromPath });
    return;
  }

  if (fromKind === 'dir' && isStrictDescendant(event.toPath, event.fromPath)) {
    shadow({ kind: 'rename-into-self', source: event.fromPath, target: event.toPath });
    return;
  }

  /**
   * Every strict ancestor of `toPath` must NOT be a file. We check before
   * touching state so a rejected rename leaves no partial effect.
   */
  for (const ancestor of ancestorPaths(event.toPath)) {
    if (
      files.has(ancestor) &&
      !(fromKind === 'file' && ancestor === event.fromPath)
    ) {
      shadow({ kind: 'ancestor-is-file', path: event.toPath, conflictingAncestor: ancestor });
      return;
    }
  }

  const toExists = files.has(event.toPath) || dirs.has(event.toPath);

  if (toExists) {
    const toKind = files.has(event.toPath) ? 'file' : 'dir';
    if (fromKind !== toKind) {
      shadow({ kind: 'target-exists-different-kind', target: event.toPath });
      return;
    }
    if (toKind === 'dir') {
      const info = dirs.get(event.toPath)!;
      if (info.fileCount > 0) {
        shadow({ kind: 'target-non-empty', target: event.toPath });
        return;
      }
      /**
       * Target dir is empty (possibly implicit-collapsed-to-explicit). Drop
       * it so the source can take its place. Decrement ancestors — the
       * empty target's fileCount is 0 so this is a no-op, but we keep the
       * helper for symmetry with the file branch.
       */
      removeDirSubtree(dirs, event.toPath);
    } else {
      /**
       * file-over-file overwrite: POSIX rename(2) replaces the target
       * atomically. The source's ancestors will lose 1 (because the source
       * file goes away), the target's ancestors keep their count (the slot
       * stays occupied).
       */
      files.delete(event.toPath);
      fileOrigins.delete(event.toPath);
      decrementAncestors(dirs, event.toPath, 1);
    }
  }

  if (fromKind === 'file') {
    moveFile(files, dirs, fileOrigins, event.fromPath, event.toPath, event.renamedAt);
  } else {
    moveDir(files, dirs, fileOrigins, event.fromPath, event.toPath, event.renamedAt);
  }
}

function moveFile(
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  fileOrigins: Map<string, string>,
  fromPath: string,
  toPath: string,
  renamedAt: number,
): void {
  const meta = files.get(fromPath)!;
  const origin = fileOrigins.get(fromPath);
  files.delete(fromPath);
  fileOrigins.delete(fromPath);
  decrementAncestors(dirs, fromPath, 1);
  files.set(toPath, { ...meta, path: toPath });
  if (origin !== undefined) fileOrigins.set(toPath, origin);
  for (const ancestor of ancestorPaths(toPath)) {
    ensureImplicitDir(dirs, ancestor, renamedAt);
    dirs.get(ancestor)!.fileCount += 1;
  }
}

function moveDir(
  files: Map<string, FileMetadata>,
  dirs: Map<string, DirInfo>,
  fileOrigins: Map<string, string>,
  fromPath: string,
  toPath: string,
  renamedAt: number,
): void {
  const movedFiles: { meta: FileMetadata; origin: string | undefined }[] = [];
  for (const fpath of [...files.keys()]) {
    if (isSelfOrDescendant(fpath, fromPath)) {
      movedFiles.push({ meta: files.get(fpath)!, origin: fileOrigins.get(fpath) });
      files.delete(fpath);
      fileOrigins.delete(fpath);
    }
  }

  const movedDirs: { path: string; info: DirInfo }[] = [];
  for (const dpath of [...dirs.keys()]) {
    if (isSelfOrDescendant(dpath, fromPath)) {
      movedDirs.push({ path: dpath, info: dirs.get(dpath)! });
      dirs.delete(dpath);
    }
  }

  if (movedFiles.length > 0) {
    decrementAncestors(dirs, fromPath, movedFiles.length);
  }

  for (const { path, info } of movedDirs) {
    dirs.set(rewritePrefix(path, fromPath, toPath), info);
  }
  for (const { meta, origin } of movedFiles) {
    const newPath = rewritePrefix(meta.path, fromPath, toPath);
    files.set(newPath, { ...meta, path: newPath });
    if (origin !== undefined) fileOrigins.set(newPath, origin);
  }

  for (const ancestor of ancestorPaths(toPath)) {
    ensureImplicitDir(dirs, ancestor, renamedAt);
    dirs.get(ancestor)!.fileCount += movedFiles.length;
  }
}

function removeDirSubtree(dirs: Map<string, DirInfo>, path: string): void {
  for (const dpath of [...dirs.keys()]) {
    if (isSelfOrDescendant(dpath, path)) {
      dirs.delete(dpath);
    }
  }
}
