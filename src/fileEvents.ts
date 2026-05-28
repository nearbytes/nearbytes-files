/**
 * File-level event types for the Nearbytes file layer.
 *
 * Each event is *pure syntax*: it carries exactly one full path (or two for
 * RENAME) and never implies sibling events. All cascade semantics — implicit
 * ancestor directories, recursive DELETE, prefix-swap RENAME, conflict
 * latest-wins resolution between the file and directory namespaces — live in the
 * materializer (`fileState.ts` and `volume.ts`).
 */
export type FileEvent =
  | CreateFileEvent
  | MkdirEvent
  | DeleteEvent
  | RenameEvent;

/**
 * Event emitted when a file is created or updated. `path` may contain `/`
 * separators; implicit ancestor directories are created by the materializer.
 */
export interface CreateFileEvent {
  type: 'CREATE_FILE';
  path: string;
  blobHash: string;
  contentType: 'b' | 'm';
  size: number;
  mimeType?: string;
  createdAt: number;
}

/**
 * Event emitted when an *explicit* directory is created. Implicit directories
 * arise automatically from CREATE_FILE on a nested path; MKDIR is only needed
 * to materialize an empty directory or to "pin" a directory so it survives
 * the deletion of all its files.
 */
export interface MkdirEvent {
  type: 'MKDIR';
  path: string;
  createdAt: number;
}

/**
 * Event emitted to delete a path. If `path` resolves to a directory, the
 * materializer recursively removes every descendant (file or directory).
 */
export interface DeleteEvent {
  type: 'DELETE';
  path: string;
  deletedAt: number;
}

/**
 * Event emitted to rename a path. If `fromPath` resolves to a directory, the
 * materializer prefix-swaps every descendant from `fromPath/` to `toPath/`.
 * Valid conflicts with the target namespace are latest-wins in replay order.
 * Invalid operations, such as renaming a directory into itself, remain timeline
 * rows without changing the live state.
 */
export interface RenameEvent {
  type: 'RENAME';
  fromPath: string;
  toPath: string;
  renamedAt: number;
}

/**
 * Materialized metadata for a file in the reconstructed state.
 * `path` is the full `/`-separated path; the basename is `path.split('/').pop()`.
 */
export interface FileMetadata {
  path: string;
  blobHash: string;
  contentType?: 'b' | 'm';
  size: number;
  mimeType?: string;
  createdAt: number;
}

/**
 * Materialized metadata for a directory in the reconstructed state.
 * `explicit` is true iff the directory was created by an MKDIR event (or
 * promoted by one); implicit directories are created on demand by
 * CREATE_FILE events on nested paths and disappear when their last live
 * descendant is removed.
 */
export interface DirectoryMetadata {
  path: string;
  createdAt: number;
  explicit: boolean;
}
