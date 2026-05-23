/**
 * CLI session context — shared mutable state for immediate and REPL mode.
 */

import { createFileService, type FileService } from '../fileService.js';
import { createReactiveVolume, type ReactiveVolume } from '../reactiveVolume.js';
import {
  createFilesystemSkeletonFromConfig,
  type NearbytesSkeleton,
  createFilesystemWatcher,
  type VolumeWatcher,
  type NearbytesConfig,
} from 'nearbytes-skeleton';
import { createSecret, bytesToHex } from 'nearbytes-crypto';

export interface Context {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  activeVolume: ReactiveVolume | null;
  readonly volumes: Map<string, ReactiveVolume>;
  readonly watchers: Map<string, VolumeWatcher>;
  destroy(): Promise<void>;
}

/**
 * Creates a CLI context: filesystem log, file service, empty volume cache.
 */
export async function createContext(config: NearbytesConfig): Promise<Context> {
  const skeleton = await createFilesystemSkeletonFromConfig(config);
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

    async destroy(): Promise<void> {
      for (const w of watchers.values()) w.close();
      watchers.clear();
      await skeleton.destroy();
    },
  };
}

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

export async function refreshIfOpen(ctx: Context, secret: string): Promise<void> {
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  const rv = ctx.volumes.get(keyHex);
  if (rv !== undefined) await rv.refresh();
}
