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
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { defaultPathMapper } from 'nearbytes-log';
import type { WebDavServer } from '../webdav/index.js';
import type { DevInspectServer } from '../dev/index.js';
import { debugEnabled } from '../debug.js';
import { debugLog } from '../debugLog.js';
import { formatSyncEventLine, installSyncDebugBridge } from '../syncDebugBridge.js';

export interface Context {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  webdav: WebDavServer | null;
  devInspect: DevInspectServer | null;
  activeVolume: ReactiveVolume | null;
  readonly volumes: Map<string, ReactiveVolume>;
  readonly watchers: Map<string, VolumeWatcher>;
  /** Registered volume name → channel secret (`volume-session.json`). */
  readonly volumeRegistry: Map<string, string>;
  volumeSessionActive: string | null;
  /** Historical timeline cursor on the active volume (null = live head). */
  timelineCursorHash: string | null;
  lastTimelineEvents: import('../fileService.js').TimelineEvent[] | null;
  webdavAuthGeneration: number;
  webdavAuthenticatedGeneration: number | null;
  /** Set when a WebDAV client completes successful Basic auth for the current generation. */
  webdavLastAuthProfile: string | null;
  webdavLastAuthAt: number | null;
  /** Bumped on timeline cursor / view changes so WebDAV ETags change (Finder, Explorer, gvfs). */
  webdavViewGeneration: number;
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
  /** When set, start the local HTTP dev inspect API on this port (default 9845). */
  readonly devInspectPort?: number;
}

export async function createContext(
  config: NearbytesConfig,
  options?: CreateContextOptions,
): Promise<Context> {
  installSyncDebugBridge();
  const skeleton = await createFilesystemSkeletonFromConfig(config);
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();

  const ctx: Context = {
    config,
    skeleton,
    fileService,
    webdav: null,
    devInspect: null,
    activeVolume: null,
    volumes,
    watchers,
    volumeRegistry: new Map<string, string>(),
    volumeSessionActive: null,
    timelineCursorHash: null,
    lastTimelineEvents: null,
    webdavAuthGeneration: 0,
    webdavAuthenticatedGeneration: null,
    webdavLastAuthProfile: null,
    webdavLastAuthAt: null,
    webdavViewGeneration: 0,
    remoteCwd: '',

    async destroy(): Promise<void> {
      if (ctx.devInspect !== null) await ctx.devInspect.close();
      if (ctx.webdav !== null) await ctx.webdav.close();
      for (const w of ctx.watchers.values()) w.close();
      ctx.watchers.clear();
      await skeleton.destroy();
    },
  };

  if (options?.webdav === true) {
    const { startWebDavServer } = await import('../webdav/index.js');
    const { createWebDavAccess } = await import('../webdav/access.js');
    ctx.webdav = await startWebDavServer({
      fileService,
      access: createWebDavAccess(ctx),
      port: options.webdavPort,
    });
  }

  if (options?.devInspectPort !== undefined) {
    const { startDevInspectServer } = await import('../dev/index.js');
    const { createReplCommandRunner } = await import('./replExec.js');
    ctx.devInspect = await startDevInspectServer({
      dataDir: config.dataDir,
      fileService,
      port: options.devInspectPort,
      runCommand: createReplCommandRunner(ctx),
    });
  }

  return ctx;
}

export function assertTimelineWritesAllowed(ctx: Context): void {
  if (ctx.timelineCursorHash !== null) {
    throw new Error('Timeline is not at live head — run `timeline live` before mutating files');
  }
}

/**
 * Reload a volume after external writes (peer sync, nbsync, another process).
 * `timeline` / `ls` / WebDAV use `FileService`'s replay cache; the dataDir
 * watcher must invalidate it (see webdav-v1 §Projection — External sync).
 */
export async function reloadVolumeFromDisk(
  ctx: Context,
  secret: string,
): Promise<import('../fileEmit.js').FileReplayContext> {
  ctx.fileService.markReplayStale(secret);
  ctx.lastTimelineEvents = null;

  const replay = await ctx.fileService.getReplayContext(secret);
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  const rv = ctx.volumes.get(keyHex);
  if (rv !== undefined) {
    rv.applyMaterialized(replay.fs);
  }
  return replay;
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
    const channelDir = join(ctx.config.dataDir, defaultPathMapper(keyPair.publicKey));
    const watcher = createFilesystemWatcher(channelDir, {
      refresh: async () => {
        await reloadVolumeFromDisk(ctx, secret);
      },
    });
    ctx.watchers.set(keyHex, watcher);
  }

  return rv;
}

export async function refreshIfOpen(ctx: Context, secret: string): Promise<void> {
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  if (!ctx.volumes.has(keyHex)) return;
  const replay = await ctx.fileService.getReplayContext(secret);
  ctx.volumes.get(keyHex)!.applyMaterialized(replay.fs);
}

/**
 * When this process owns the sync engine, reload open volumes after inbound
 * peer writes so `ls` / `timeline` reflect synced data without manual refresh.
 */
export function attachSyncInboundRefresh(ctx: Context): () => void {
  const writerOnly =
    (ctx.skeleton.sync as { daemon?: unknown }).daemon !== undefined;
  if (writerOnly) {
    return () => {};
  }

  return ctx.skeleton.sync.onEvent((event) => {
    if (debugEnabled('sync')) {
      debugLog('sync', 'event', formatSyncEventLine(event));
    }
    if (event.kind === 'event-received') {
      void refreshVolumesForChannel(ctx, event.channel.toLowerCase());
    }
  });
}

async function refreshVolumesForChannel(ctx: Context, channelHex: string): Promise<void> {
  for (const secret of ctx.volumeRegistry.values()) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    if (bytesToHex(keyPair.publicKey).toLowerCase() !== channelHex) {
      continue;
    }
    const keyHex = bytesToHex(keyPair.publicKey);
    if (!ctx.volumes.has(keyHex)) {
      continue;
    }
    if (debugEnabled('sync')) {
      debugLog('sync', 'files', `reload open volume channel=${channelHex.slice(0, 8)}…`);
    }
    await reloadVolumeFromDisk(ctx, secret);
  }
}

