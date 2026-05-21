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
import { createFileService } from '../fileService.js';
import { createReactiveVolume } from '../reactiveVolume.js';
import { FilesystemStorageBackend } from 'nearbytes-storage';
import { createSkeleton, createFilesystemWatcher, initializeStorageRoot, } from 'nearbytes-skeleton';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
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
export async function createContext(config) {
    await initializeStorageRoot(config.dataDir);
    const storage = new FilesystemStorageBackend(config.dataDir);
    const skeleton = createSkeleton(storage);
    const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
    const volumes = new Map();
    const watchers = new Map();
    return {
        config,
        skeleton,
        fileService,
        activeVolume: null,
        volumes,
        watchers,
        destroy() {
            for (const w of watchers.values())
                w.close();
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
export async function openAndWatch(ctx, secret, watch = true) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    const keyHex = bytesToHex(keyPair.publicKey);
    const cached = ctx.volumes.get(keyHex);
    if (cached !== undefined)
        return cached;
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
export async function refreshIfOpen(ctx, secret) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    const keyHex = bytesToHex(keyPair.publicKey);
    const rv = ctx.volumes.get(keyHex);
    if (rv !== undefined)
        await rv.refresh();
}
//# sourceMappingURL=context.js.map