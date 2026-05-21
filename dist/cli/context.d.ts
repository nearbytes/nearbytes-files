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
import { type FileService } from '../fileService.js';
import { type ReactiveVolume } from '../reactiveVolume.js';
import { type NearbytesSkeleton, type VolumeWatcher, type NearbytesConfig } from 'nearbytes-skeleton';
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
export declare function createContext(config: NearbytesConfig): Promise<Context>;
/**
 * Opens a volume (or returns the cached instance) and optionally installs a
 * filesystem watcher that refreshes it whenever the storage directory changes.
 */
export declare function openAndWatch(ctx: Context, secret: string, watch?: boolean): Promise<ReactiveVolume>;
/**
 * If the volume for this secret is already cached, refresh its materialised
 * state immediately so REPL subscribers see the latest data.
 * No-op when the volume has not been opened yet (e.g. immediate-mode CLI).
 */
export declare function refreshIfOpen(ctx: Context, secret: string): Promise<void>;
//# sourceMappingURL=context.d.ts.map