/**
 * Integration-test runtime for nearbytes-files (probes, benchmarks).
 * The user-facing `nbf` CLI lives in nearbytes-cli; use nearbytes-engine in apps.
 */

import { createFileService, type FileService } from './fileService.js';
import { createReactiveVolume, type ReactiveVolume } from './reactiveVolume.js';
import {
  createFilesystemSkeletonFromConfig,
  type NearbytesSkeleton,
  createFilesystemWatcher,
  type VolumeWatcher,
  type NearbytesConfig,
} from 'nearbytes-skeleton';
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { access } from 'node:fs/promises';
import { defaultPathMapper, blockPath, publicKeyFromHex } from 'nearbytes-log';
import type { Hash } from 'nearbytes-crypto';
import type { TimelineEvent } from './fileService.js';
import { formatSyncEventLine, installSyncDebugBridge } from './syncDebugBridge.js';
import { debugEnabled } from './debug.js';
import { debugLog } from './debugLog.js';
import {
  syncTimelineBeginSession,
  syncTimelineMarkSession,
} from 'nearbytes-sync/node';

export interface ProbeRuntime {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  activeVolume: ReactiveVolume | null;
  readonly volumes: Map<string, ReactiveVolume>;
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
  const writerOnly =
    (rt.skeleton.sync as { daemon?: unknown }).daemon !== undefined;
  if (writerOnly) {
    return () => {};
  }

  return rt.skeleton.sync.onEvent((event) => {
    if (debugEnabled('sync')) {
      debugLog('sync', 'event', formatSyncEventLine(event));
    }
    if (event.kind === 'block-received') {
      void refreshAllOpenVolumes(rt);
    } else if (event.kind === 'event-received') {
      void maybeRefreshAfterInboundEvent(rt, event.channel.toLowerCase(), event.eventHash);
    }
  });
}

async function refreshAllOpenVolumes(rt: ProbeRuntime): Promise<void> {
  for (const secret of rt.volumeRegistry.values()) {
    const keyPair = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
    const keyHex = bytesToHex(keyPair.publicKey);
    if (!rt.volumes.has(keyHex)) {
      continue;
    }
    if (debugEnabled('sync')) {
      debugLog('sync', 'files', `reload open volume channel=${keyHex.slice(0, 8)}…`);
    }
    await reloadVolumeFromDisk(rt, secret);
  }
}

async function maybeRefreshAfterInboundEvent(
  rt: ProbeRuntime,
  channelHex: string,
  eventHash: string,
): Promise<void> {
  if (!(await inboundEventReadyToMaterialize(rt, channelHex, eventHash))) {
    return;
  }
  await refreshVolumesForChannel(rt, channelHex, eventHash);
}

async function inboundEventReadyToMaterialize(
  rt: ProbeRuntime,
  channelHex: string,
  eventHash: string,
): Promise<boolean> {
  const pk = publicKeyFromHex(channelHex);
  if (pk === null) {
    return false;
  }
  try {
    const signed = await rt.skeleton.log.events.retrieveEvent(pk, eventHash as Hash);
    const refs = signed.envelope.blockRefs.map((h) => String(h).toLowerCase());
    if (refs.length === 0) {
      return true;
    }
    const known = new Set(
      (await rt.skeleton.log.events.listEvents(pk)).map((h) => h.toLowerCase()),
    );
    const headRef = refs[0]!;
    const blockReady = async (hash: string): Promise<boolean> => {
      if (await rt.skeleton.log.blocks.has(hash as Hash)) {
        return true;
      }
      try {
        await access(join(rt.config.dataDir, blockPath(hash as Hash)));
        return true;
      } catch {
        return false;
      }
    };
    if (refs.length === 1) {
      return blockReady(headRef);
    }
    if (!known.has(headRef)) {
      return false;
    }
    for (const hash of refs.slice(1)) {
      if (known.has(hash)) {
        continue;
      }
      if (!(await blockReady(hash))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function refreshVolumesForChannel(
  rt: ProbeRuntime,
  channelHex: string,
  eventHash: string,
): Promise<void> {
  for (const secret of rt.volumeRegistry.values()) {
    const keyPair = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
    if (bytesToHex(keyPair.publicKey).toLowerCase() !== channelHex) {
      continue;
    }
    const keyHex = bytesToHex(keyPair.publicKey);
    if (!rt.volumes.has(keyHex)) {
      continue;
    }
    if (debugEnabled('sync')) {
      debugLog('sync', 'files', `reload open volume channel=${channelHex.slice(0, 8)}…`);
    }
    const replay = await rt.fileService.applyInboundEvent(secret, eventHash);
    if (replay !== undefined) {
      rt.lastTimelineEvents = null;
      rt.volumes.get(keyHex)!.applyMaterialized(replay.fs);
      continue;
    }
    await reloadVolumeFromDisk(rt, secret);
  }
}

/** @deprecated Use {@link createProbeRuntime}. */
export const createContext = createProbeRuntime;

/** @deprecated Use {@link ProbeRuntime}. */
export type Context = ProbeRuntime;
