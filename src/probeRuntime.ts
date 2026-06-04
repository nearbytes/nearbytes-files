/**
 * Integration-test runtime for nearbytes-files (probes, benchmarks).
 * The user-facing `nbf` CLI lives in nearbytes-cli; use nearbytes-engine in apps.
 */

import { createFileService } from './fileService.js';
import { createReactiveVolume, type ReactiveVolume } from './reactiveVolume.js';
import {
  createFilesystemSkeletonFromConfig,
  createFilesystemWatcher,
  type VolumeWatcher,
  type NearbytesConfig,
} from 'nearbytes-skeleton';
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { defaultPathMapper } from 'nearbytes-log';
import type { TimelineEvent } from './fileService.js';
import { installSyncDebugBridge } from './syncDebugBridge.js';
import { debugEnabled } from './debug.js';
import {
  syncTimelineBeginSession,
  syncTimelineMarkSession,
} from 'nearbytes-sync/node';
import {
  attachSyncInboundRefresh as attachFilesSyncInboundRefresh,
  type SyncInboundRefreshHost,
} from './syncInboundRefresh.js';

export interface ProbeRuntime extends SyncInboundRefreshHost {
  activeVolume: ReactiveVolume | null;
  readonly watchers: Map<string, VolumeWatcher>;
  /** Registered volume name → channel secret (integration probes). */
  readonly volumeRegistry: Map<string, string>;
  lastTimelineEvents: TimelineEvent[] | null;
  destroy(): Promise<void>;
}

export async function createProbeRuntime(config: NearbytesConfig): Promise<ProbeRuntime> {
  installSyncDebugBridge();
  if (debugEnabled('timeline')) {
    syncTimelineBeginSession('repl-start');
  }
  const skeletonStart = Date.now();
  const skeleton = await createFilesystemSkeletonFromConfig(config);
  if (debugEnabled('timeline')) {
    syncTimelineMarkSession('skeleton-ready', `${Date.now() - skeletonStart}ms`);
  }
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();

  const rt: ProbeRuntime = {
    config,
    skeleton,
    fileService,
    activeVolume: null,
    volumes,
    watchers,
    volumeRegistry: new Map<string, string>(),
    lastTimelineEvents: null,

    openVolumeSecrets(): Iterable<string> {
      return rt.volumeRegistry.values();
    },

    onVolumeRefreshed(): void {
      rt.lastTimelineEvents = null;
    },

    async destroy(): Promise<void> {
      for (const w of rt.watchers.values()) w.close();
      rt.watchers.clear();
      await skeleton.destroy();
    },
  };

  return rt;
}

export async function reloadVolumeFromDisk(
  rt: ProbeRuntime,
  secret: string,
): Promise<import('./fileEmit.js').FileReplayContext> {
  rt.fileService.markReplayStale(secret);
  rt.lastTimelineEvents = null;

  const replay = await rt.fileService.getReplayContext(secret);
  const keyPair = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  const rv = rt.volumes.get(keyHex);
  if (rv !== undefined) {
    rv.applyMaterialized(replay.fs);
  }
  return replay;
}

export async function openAndWatch(
  rt: ProbeRuntime,
  secret: string,
  watch = true,
): Promise<ReactiveVolume> {
  const keyPair = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);

  const cached = rt.volumes.get(keyHex);
  if (cached !== undefined) return cached;

  const rv = await createReactiveVolume(createSecret(secret), rt.skeleton.crypto, rt.skeleton.log);
  rt.volumes.set(keyHex, rv);
  await rt.fileService.getReplayContext(secret);

  if (watch && !rt.watchers.has(keyHex)) {
    const channelDir = join(rt.config.dataDir, defaultPathMapper(keyPair.publicKey));
    const watcher = await createFilesystemWatcher(channelDir, {
      refresh: async () => {
        await reloadVolumeFromDisk(rt, secret);
      },
    });
    rt.watchers.set(keyHex, watcher);
  }

  return rv;
}

export async function refreshIfOpen(rt: ProbeRuntime, secret: string): Promise<void> {
  const keyPair = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  if (!rt.volumes.has(keyHex)) return;
  const replay = await rt.fileService.getReplayContext(secret);
  rt.volumes.get(keyHex)!.applyMaterialized(replay.fs);
}

export function attachSyncInboundRefresh(rt: ProbeRuntime): () => void {
  return attachFilesSyncInboundRefresh(rt);
}

/** @deprecated Use {@link createProbeRuntime}. */
export const createContext = createProbeRuntime;

/** @deprecated Use {@link ProbeRuntime}. */
export type Context = ProbeRuntime;
