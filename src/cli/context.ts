/**
 * CLI session context — shared mutable state for both immediate and REPL mode.
 *
 * Layering:
 *   createContext  →  createSkeleton(storage)  →  { crypto, log }
 *                 →  createFileService({ log, crypto })
 *                 →  createReactiveVolume(secret, crypto, log)  [on demand]
 *
 * The volume cache (open ReactiveVolumes, keyed by public-key hex) lives here
 * rather than in the skeleton — the skeleton is a stateless protocol layer.
 * Commands use ctx.fileService for all file I/O, ctx.skeleton.crypto for key
 * derivation, and ctx.volumes / ctx.watchers for reactive state.
 */

import { createFileService, type FileService } from '../fileService.js';
import { createReactiveVolume, type ReactiveVolume } from '../reactiveVolume.js';
import { FilesystemStorageBackend } from 'nearbytes-storage';
import {
  createSkeleton,
  type NearbytesSkeleton,
  createFilesystemWatcher,
  type VolumeWatcher,
  initializeStorageRoot,
  type NearbytesConfig,
} from 'nearbytes-skeleton';
import { createSecret, bytesToHex } from 'nearbytes-crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Context {
  readonly config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  /**
   * High-level file service — the correct entry point for all file operations.
   * Internally wired to skeleton.log and skeleton.crypto.
   */
  readonly fileService: FileService;
  /** Currently "active" volume in the REPL (set with `use <key>`). */
  activeVolume: ReactiveVolume | null;
  /** Open ReactiveVolumes keyed by public-key hex. */
  readonly volumes: Map<string, ReactiveVolume>;
  /** Filesystem watchers keyed by public-key hex — cleaned up on REPL exit. */
  readonly watchers: Map<string, VolumeWatcher>;
  /** Tear down all watchers. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a CLI context for the given config.
 *
 * Initialises the storage root on disk, then wires the full service stack:
 *
 *   FilesystemStorageBackend
 *     → createSkeleton  →  { crypto, log }
 *       → createFileService
 *
 * @param config - Nearbytes configuration (data directory, pre-configured volumes).
 */
export async function createContext(config: NearbytesConfig): Promise<Context> {
  await initializeStorageRoot(config.dataDir);

  const storage = new FilesystemStorageBackend(config.dataDir);
  const skeleton = createSkeleton(storage);
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();

  return {
    config,
    skeleton,
    fileService,
    activeVolume: null,
    volumes,
    watchers,

    destroy(): void {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Volume helpers
// ---------------------------------------------------------------------------

/**
 * Opens a volume (or returns the cached instance) and optionally installs a
 * filesystem watcher that refreshes it whenever the storage directory changes.
 */
export async function openAndWatch(
  ctx: Context,
  secret: string,
  watch = true,
): Promise<ReactiveVolume> {
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);

  const cached = ctx.volumes.get(keyHex);
  if (cached !== undefined) return cached;

  const rv = await createReactiveVolume(createSecret(secret), ctx.skeleton.crypto, ctx.skeleton.log);
  ctx.volumes.set(keyHex, rv);

  if (watch && !ctx.watchers.has(keyHex)) {
    const watcher = createFilesystemWatcher(ctx.config.dataDir, rv);
    ctx.watchers.set(keyHex, watcher);
  }

  return rv;
}

/**
 * If the volume for this secret is already cached, refresh its materialised
 * state immediately so REPL subscribers see the latest data.
 * No-op when the volume has not been opened yet (e.g. immediate-mode CLI).
 */
export async function refreshIfOpen(ctx: Context, secret: string): Promise<void> {
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  const rv = ctx.volumes.get(keyHex);
  if (rv !== undefined) await rv.refresh();
}
