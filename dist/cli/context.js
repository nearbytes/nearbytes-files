/**
 * CLI session context — shared mutable state for immediate and REPL mode.
 */
import { createFileService } from '../fileService.js';
import { createReactiveVolume } from '../reactiveVolume.js';
import { createFilesystemSkeleton, createFilesystemWatcher, } from 'nearbytes-skeleton';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
/**
 * Creates a CLI context: filesystem log, file service, empty volume cache.
 */
export async function createContext(config) {
    const skeleton = await createFilesystemSkeleton(config.dataDir);
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
export async function refreshIfOpen(ctx, secret) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    const keyHex = bytesToHex(keyPair.publicKey);
    const rv = ctx.volumes.get(keyHex);
    if (rv !== undefined)
        await rv.refresh();
}
//# sourceMappingURL=context.js.map