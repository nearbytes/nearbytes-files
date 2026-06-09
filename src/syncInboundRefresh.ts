/**
 * Inbound sync → file replay refresh (channel-scoped, incremental when possible).
 * Shared by nearbytes-engine, nearbytes-cli, and integration probes.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hash } from 'nearbytes-crypto';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { blockPath, publicKeyFromHex } from 'nearbytes-log';
import type { NearbytesConfig, NearbytesSkeleton } from 'nearbytes-skeleton';
import { debugEnabled } from './debug.js';
import { debugLog } from './debugLog.js';
import type { FileService } from './fileService.js';
import type { ReactiveVolume } from './reactiveVolume.js';
import { formatSyncEventLine, installSyncDebugBridge } from './syncDebugBridge.js';

export interface SyncInboundRefreshHost {
  readonly config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  readonly volumes: Map<string, ReactiveVolume>;
  /** Channel secrets for volumes that are currently open. */
  openVolumeSecrets(): Iterable<string>;
  /** Called after a volume's materialized state was updated. */
  onVolumeRefreshed?(secret: string): void;
}

export interface SyncInboundRefreshOptions {
  readonly onAfterRefresh?: () => void;
}

async function reloadVolumeFromDisk(
  host: SyncInboundRefreshHost,
  secret: string,
): Promise<void> {
  host.fileService.markReplayStale(secret);
  const replay = await host.fileService.getReplayContext(secret);
  const keyPair = await host.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  host.volumes.get(keyHex)?.applyMaterialized(replay.fs);
  host.onVolumeRefreshed?.(secret);
}

/**
 * Subscribe to sync events and refresh open file volumes when peer data arrives.
 * Skips when this process is writer-only (nbsync daemon holds the lock).
 */
export function attachSyncInboundRefresh(
  host: SyncInboundRefreshHost,
  options: SyncInboundRefreshOptions = {},
): () => void {
  installSyncDebugBridge();
  const writerOnly = (host.skeleton.sync as { daemon?: unknown }).daemon !== undefined;
  if (writerOnly) {
    return () => {};
  }

  const { onAfterRefresh } = options;

  return host.skeleton.sync.onEvent((event) => {
    if (debugEnabled('sync')) {
      debugLog('sync', 'event', formatSyncEventLine(event));
    }
    if (event.kind === 'block-received') {
      void refreshAllOpenVolumes(host).then(() => onAfterRefresh?.());
    } else if (event.kind === 'event-received') {
      void maybeRefreshAfterInboundEvent(
        host,
        event.channel.toLowerCase(),
        event.eventHash,
      ).then(() => onAfterRefresh?.());
    }
  });
}

async function refreshAllOpenVolumes(host: SyncInboundRefreshHost): Promise<void> {
  for (const secret of host.openVolumeSecrets()) {
    const keyPair = await host.skeleton.crypto.deriveKeys(createSecret(secret));
    const keyHex = bytesToHex(keyPair.publicKey);
    if (!host.volumes.has(keyHex)) {
      continue;
    }
    if (debugEnabled('sync')) {
      debugLog('sync', 'files', `reload open volume channel=${keyHex.slice(0, 8)}…`);
    }
    await reloadVolumeFromDisk(host, secret);
  }
}

async function maybeRefreshAfterInboundEvent(
  host: SyncInboundRefreshHost,
  channelHex: string,
  eventHash: string,
): Promise<void> {
  if (!(await inboundEventReadyToMaterialize(host, channelHex, eventHash))) {
    return;
  }
  await refreshVolumesForChannel(host, channelHex, eventHash);
}

async function inboundEventReadyToMaterialize(
  host: SyncInboundRefreshHost,
  channelHex: string,
  eventHash: string,
): Promise<boolean> {
  const pk = publicKeyFromHex(channelHex);
  if (pk === null) {
    return false;
  }
  const log = host.skeleton.log;
  try {
    const signed = await log.events.retrieveEvent(pk, eventHash as Hash);
    const refs = signed.envelope.blockRefs.map((h) => String(h).toLowerCase());
    if (refs.length === 0) {
      return true;
    }
    const headRef = refs[0]!;
    const blockReady = async (hash: string): Promise<boolean> => {
      if (await log.blocks.has(hash as Hash)) {
        return true;
      }
      try {
        await access(join(host.config.dataDir, blockPath(hash as Hash)));
        return true;
      } catch {
        return false;
      }
    };
    if (refs.length === 1) {
      return blockReady(headRef);
    }
    if (!(await log.events.hasEvent(pk, headRef as Hash))) {
      return false;
    }
    for (const hash of refs.slice(1)) {
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
  host: SyncInboundRefreshHost,
  channelHex: string,
  eventHash: string,
): Promise<void> {
  for (const secret of host.openVolumeSecrets()) {
    const keyPair = await host.skeleton.crypto.deriveKeys(createSecret(secret));
    if (bytesToHex(keyPair.publicKey).toLowerCase() !== channelHex) {
      continue;
    }
    const keyHex = bytesToHex(keyPair.publicKey);
    if (!host.volumes.has(keyHex)) {
      continue;
    }
    if (debugEnabled('sync')) {
      debugLog('sync', 'files', `reload open volume channel=${channelHex.slice(0, 8)}…`);
    }
    const replay = await host.fileService.applyInboundEvent(secret, eventHash);
    if (replay !== undefined) {
      host.volumes.get(keyHex)!.applyMaterialized(replay.fs);
      host.onVolumeRefreshed?.(secret);
      continue;
    }
    await reloadVolumeFromDisk(host, secret);
  }
}
