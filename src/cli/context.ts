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
import type { WebDavServer } from '../webdav/index.js';

export interface Context {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  webdav: WebDavServer | null;
  activeVolume: ReactiveVolume | null;
  readonly volumes: Map<string, ReactiveVolume>;
  readonly watchers: Map<string, VolumeWatcher>;
  /**
   * Current "remote working directory" inside the active volume — used by
   * FTP-style commands so users can `cd notes/2026 && ls`. Empty string
   * means the volume's root. The cwd is session-only, not persisted, and
   * is silently reset to `''` whenever the active volume changes.
   */
  remoteCwd: string;
  destroy(): Promise<void>;
}

/**
 * Creates a CLI context: filesystem log, file service, empty volume cache.
 */
export interface CreateContextOptions {
  readonly webdav?: boolean;
  readonly webdavPort?: number;
}

export async function createContext(
  config: NearbytesConfig,
  options?: CreateContextOptions,
): Promise<Context> {
  const skeleton = await createFilesystemSkeletonFromConfig(config);
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();

  let webdav: WebDavServer | null = null;
  if (options?.webdav === true) {
    const { startWebDavServer } = await import('../webdav/index.js');
    webdav = await startWebDavServer({
      fileService,
      crypto: skeleton.crypto,
      log: skeleton.log,
      port: options.webdavPort,
    });
  }

  return {
    config,
    skeleton,
    fileService,
    webdav,
    activeVolume: null,
    volumes,
    watchers,
    remoteCwd: '',

    async destroy(): Promise<void> {
      if (webdav !== null) await webdav.close();
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
