/**
 * Central emit path for FILES visible `blockRefs`.
 */

import { performance } from 'node:perf_hooks';
import type { KeyPair } from 'nearbytes-crypto';
import { createHash, type CryptoOperations, type EventPayload, type Hash } from 'nearbytes-crypto';
import { EventType, type EncryptedData } from 'nearbytes-crypto';
import type { Log } from 'nearbytes-log';
import type { Channel, EventLogEntry } from 'nearbytes-log';
import {
  createSignedEvent,
  eventEnvelopePublicKeyMatches,
  hydrateSignedEvent,
  loadEventLog,
  openChannel,
  verifyEventLog,
} from 'nearbytes-log';
import { materializeIncremental, type MaterializedFileSystem } from './fileMaterializer.js';
import { observedLogHeadFromOrdered, orderEventLogEntries, toCanonicalEntriesFromOrdered } from './fileLogEntries.js';
import { createSecret, type Secret } from 'nearbytes-crypto';
import { cachedBlobPlaintextSize, rememberBlobPlaintextSize } from './fileBlobSizes.js';
import { decryptFileForVolume } from './fileCrypto.js';
import { debugEnabled } from './debug.js';
import { runMaterialization } from './materialization.js';

export interface CausalLineage {
  readonly supersededEvent?: Hash;
  readonly lastBlock?: Hash;
}

export function buildBlockRefs(
  observedHead: Hash | undefined,
  lineages: readonly CausalLineage[],
  introducedBlocks: readonly Hash[],
): Hash[] {
  const refs: Hash[] = [];
  if (observedHead !== undefined) refs.push(observedHead);
  for (const lineage of lineages) {
    if (lineage.supersededEvent !== undefined) refs.push(lineage.supersededEvent);
    if (lineage.lastBlock !== undefined) refs.push(lineage.lastBlock);
  }
  for (const block of introducedBlocks) refs.push(block);
  return refs;
}

export function lineageAtPath(fs: MaterializedFileSystem, path: string): CausalLineage {
  const origin = fs.entryHeads.get(path);
  const file = fs.files.get(path);
  return {
    supersededEvent: origin !== undefined ? createHash(origin) : undefined,
    lastBlock: file !== undefined ? createHash(file.blobHash) : undefined,
  };
}

export function lineagesForRename(
  fs: MaterializedFileSystem,
  fromPath: string,
  toPath: string,
): CausalLineage[] {
  const out: CausalLineage[] = [lineageAtPath(fs, fromPath)];
  if (fromPath !== toPath) {
    const to = lineageAtPath(fs, toPath);
    if (to.supersededEvent !== undefined || to.lastBlock !== undefined) out.push(to);
  }
  return out;
}

export async function loadMaterializedFileSystem(
  secret: string,
  crypto: CryptoOperations,
  log: Log,
): Promise<MaterializedFileSystem> {
  const volume = await openChannel(createSecret(secret), crypto);
  const { orderedEntries } = await loadChannelEntries(volume, log, crypto);
  return runMaterialization(toCanonicalEntriesFromOrdered(orderedEntries));
}

export interface FileReplayContext {
  readonly fs: MaterializedFileSystem;
  readonly observedHead?: Hash;
  readonly orderedEntries: readonly EventLogEntry[];
  readonly liveEncryptedKeys: ReadonlyMap<string, EncryptedData>;
}

export interface LoadFileReplayContextOptions {
  readonly seed?: FileReplayContext;
  /** Decrypt live blobs to fill `FileMetadata.size` (WebDAV PROPFIND). */
  readonly enrichSizes?: boolean;
  /** Materialize only through this event hash (prefix replay; read-only views). */
  readonly throughEventHash?: string;
}

export async function loadFileReplayContext(
  secret: string,
  crypto: CryptoOperations,
  log: Log,
  options: LoadFileReplayContextOptions = {},
): Promise<FileReplayContext> {
  const { seed, enrichSizes = false, throughEventHash } = options;
  const timing = debugEnabled('timing');
  const started = timing ? performance.now() : 0;
  const volume = await openChannel(createSecret(secret), crypto);
  const afterOpen = timing ? performance.now() : 0;
  const { orderedEntries, loadedCount } = await loadChannelEntries(volume, log, crypto, seed);
  const afterLoad = timing ? performance.now() : 0;
  const head = observedLogHeadFromOrdered(orderedEntries);
  let fs: MaterializedFileSystem;
  if (seed !== undefined && hasOrderedPrefix(seed.orderedEntries, orderedEntries)) {
    const appended = orderedEntries.slice(seed.orderedEntries.length);
    fs = appended.length > 0
      ? materializeIncremental(seed.fs, toCanonicalEntriesFromOrdered(appended))
      : seed.fs;
  } else {
    fs = runMaterialization(toCanonicalEntriesFromOrdered(orderedEntries));
  }
  if (timing) {
    const afterMaterialize = performance.now();
    const round = (value: number) => Math.round(value * 10) / 10;
    console.error(
      `[nearbytes-webdav][timing] replay open=${round(afterOpen - started)}ms load=${round(afterLoad - afterOpen)}ms` +
        ` materialize=${round(afterMaterialize - afterLoad)}ms entries=${orderedEntries.length} loaded=${loadedCount}`,
    );
  }
  const liveEncryptedKeys = new Map<string, EncryptedData>();
  const keyByEventHash = new Map<string, EncryptedData>();
  for (const entry of orderedEntries) {
    const payload = entry.signedEvent.payload;
    if (payload.type !== EventType.CREATE_FILE) continue;
    keyByEventHash.set(entry.eventHash, payload.wrappedKey);
  }
  for (const [path, originHash] of fs.fileOrigins) {
    const wrapped = keyByEventHash.get(originHash);
    if (wrapped !== undefined) liveEncryptedKeys.set(path, wrapped);
  }
  const sizedFs = applyCachedBlobSizes(fs);
  const finalFs = enrichSizes
    ? await enrichLiveFileSizes(sizedFs, liveEncryptedKeys, createSecret(secret), crypto, log)
    : sizedFs;
  const base: FileReplayContext = {
    fs: finalFs,
    observedHead: head !== undefined ? createHash(head) : undefined,
    orderedEntries,
    liveEncryptedKeys,
  };
  if (throughEventHash !== undefined) {
    return replayContextThrough(base, throughEventHash, { enrichSizes });
  }
  return base;
}

/**
 * Prefix replay through an inclusive cursor event (historical read-only views).
 */
export function replayContextThrough(
  replay: FileReplayContext,
  throughEventHash: string,
  options: { readonly enrichSizes?: boolean } = {},
): FileReplayContext {
  const idx = findEventIndex(replay.orderedEntries, throughEventHash);
  if (idx < 0) {
    throw new Error(`Timeline cursor not found: ${throughEventHash}`);
  }
  const orderedEntries = replay.orderedEntries.slice(0, idx + 1);
  const fs = runMaterialization(toCanonicalEntriesFromOrdered(orderedEntries));
  const liveEncryptedKeys = new Map<string, EncryptedData>();
  for (const [path, originHash] of fs.fileOrigins) {
    const wrapped = entryWrappedKey(orderedEntries, originHash);
    if (wrapped !== undefined) liveEncryptedKeys.set(path, wrapped);
  }
  const head = observedLogHeadFromOrdered(orderedEntries);
  let sizedFs = applyCachedBlobSizes(fs);
  if (options.enrichSizes === true) {
    // enrichSizes path needs crypto+log; callers using historical WebDAV pass false or handle upstream
  }
  return {
    fs: sizedFs,
    observedHead: head !== undefined ? createHash(head) : undefined,
    orderedEntries,
    liveEncryptedKeys,
  };
}

const MIN_TIMELINE_HASH_PREFIX = 8;

/**
 * Resolve `timeline goto` selector: **event number first** (1-based), then hash prefix
 * (hex, at least {@link MIN_TIMELINE_HASH_PREFIX} chars). Returns -1 if not index/hash.
 */
export function findEventIndex(
  orderedEntries: readonly EventLogEntry[],
  selector: string,
): number {
  const trimmed = selector.trim().replace(/^#/, '');
  if (trimmed.length === 0) return -1;

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n >= 1 && n <= orderedEntries.length) return n - 1;
    return -1;
  }

  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= MIN_TIMELINE_HASH_PREFIX) {
    const lower = trimmed.toLowerCase();
    let match = -1;
    for (let i = 0; i < orderedEntries.length; i++) {
      const h = orderedEntries[i]!.eventHash.toLowerCase();
      if (h === lower || h.startsWith(lower)) {
        if (match >= 0) return -2;
        match = i;
      }
    }
    return match;
  }

  return -1;
}

export function formatTimelineGotoIndexError(
  selector: string,
  orderedEntries: readonly EventLogEntry[],
  code: number,
): string {
  const trimmed = selector.trim().replace(/^#/, '');
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return `Event #${n} is out of range (timeline has ${orderedEntries.length} event(s), use 1–${orderedEntries.length})`;
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length < MIN_TIMELINE_HASH_PREFIX) {
    return `Hash prefix "${trimmed}" is too short — use at least ${MIN_TIMELINE_HASH_PREFIX} hex characters, or an event number (e.g. 32)`;
  }
  if (code === -2) {
    const lower = trimmed.toLowerCase();
    const nums: number[] = [];
    for (let i = 0; i < orderedEntries.length; i++) {
      const h = orderedEntries[i]!.eventHash.toLowerCase();
      if (h === lower || h.startsWith(lower)) nums.push(i + 1);
    }
    return `Ambiguous hash prefix "${trimmed}" (events #${nums.join(', #')}) — paste more of the hash`;
  }
  return `No event with hash prefix "${trimmed}"`;
}

/**
 * Loads channel events in causal replay order. When `seed` is provided and the
 * log only grew by append, reuses hydrated entries and verifies/decrypts only
 * new event hashes instead of replaying the full channel from disk.
 */
async function loadChannelEntries(
  volume: Channel,
  log: Log,
  crypto: CryptoOperations,
  seed?: FileReplayContext,
): Promise<{ orderedEntries: EventLogEntry[]; loadedCount: number }> {
  if (seed === undefined) {
    const entries = await loadEventLog(volume, log, crypto);
    await verifyEventLog(entries, volume, crypto);
    return { orderedEntries: orderEventLogEntries(entries), loadedCount: entries.length };
  }

  const keyPair = await crypto.deriveKeys(volume.secret);
  const listed = await log.events.listEvents(keyPair.publicKey);
  const known = new Set(seed.orderedEntries.map((entry) => entry.eventHash));
  const newHashes = listed.filter((hash) => !known.has(hash));

  if (newHashes.length === 0) {
    return { orderedEntries: [...seed.orderedEntries], loadedCount: 0 };
  }

  const newEntries: EventLogEntry[] = [];
  for (const eventHash of newHashes) {
    try {
      const signedEvent = await log.events.retrieveEvent(keyPair.publicKey, eventHash);
      if (!eventEnvelopePublicKeyMatches(signedEvent, keyPair.publicKey)) continue;
      newEntries.push({
        eventHash,
        signedEvent: await hydrateSignedEvent(crypto, keyPair.privateKey, signedEvent),
      });
    } catch {
      continue;
    }
  }
  await verifyEventLog(newEntries, volume, crypto);
  const orderedEntries = orderEventLogEntries([...seed.orderedEntries, ...newEntries]);
  if (!hasOrderedPrefix(seed.orderedEntries, orderedEntries)) {
    const entries = await loadEventLog(volume, log, crypto);
    await verifyEventLog(entries, volume, crypto);
    return { orderedEntries: orderEventLogEntries(entries), loadedCount: entries.length };
  }
  return { orderedEntries, loadedCount: newEntries.length };
}

/**
 * CREATE_FILE payloads do not carry plaintext length; fill `FileMetadata.size`
 * using the blob cache or, as a last resort, decrypting live blobs (WebDAV).
 */
async function enrichLiveFileSizes(
  fs: MaterializedFileSystem,
  liveEncryptedKeys: ReadonlyMap<string, EncryptedData>,
  volumeSecret: Secret,
  crypto: CryptoOperations,
  log: Log,
): Promise<MaterializedFileSystem> {
  const files = new Map(fs.files);
  let changed = false;
  const keyPair = await crypto.deriveKeys(volumeSecret);

  for (const [path, meta] of files) {
    if (meta.size > 0) continue;
    const cached = cachedBlobPlaintextSize(meta.blobHash);
    if (cached !== undefined) {
      files.set(path, { ...meta, size: cached });
      changed = true;
      continue;
    }
    const wrapped = liveEncryptedKeys.get(path);
    if (wrapped === undefined) continue;
    try {
      const encryptedData = await log.blocks.retrieve(meta.blobHash as Hash);
      const plaintext = await decryptFileForVolume(
        crypto,
        keyPair.privateKey,
        encryptedData,
        wrapped,
      );
      const size = plaintext.byteLength;
      rememberBlobPlaintextSize(meta.blobHash, size);
      files.set(path, { ...meta, size });
      changed = true;
    } catch {
      // leave size at 0 when content is unavailable
    }
  }
  return changed ? { ...fs, files } : fs;
}

function hasOrderedPrefix(
  previous: readonly EventLogEntry[],
  next: readonly EventLogEntry[],
): boolean {
  if (previous.length > next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i]!.eventHash !== next[i]!.eventHash) return false;
  }
  return true;
}

export async function emitFileEvent(
  crypto: CryptoOperations,
  keyPair: KeyPair,
  log: Log,
  payload: EventPayload,
  observedHead: Hash | undefined,
  lineages: readonly CausalLineage[],
  introducedBlocks: readonly Hash[],
): Promise<EventLogEntry> {
  const blockRefs = buildBlockRefs(observedHead, lineages, introducedBlocks);
  const signedEvent = await createSignedEvent(crypto, keyPair, payload, blockRefs);
  const eventHash = await log.events.storeEvent(keyPair.publicKey, signedEvent);
  return { eventHash, signedEvent };
}

/**
 * Applies newly emitted entries to an in-memory replay snapshot (no disk read).
 */
export function extendFileReplayContext(
  base: FileReplayContext,
  appended: readonly EventLogEntry[],
): FileReplayContext {
  const known = new Set(base.orderedEntries.map((entry) => entry.eventHash));
  const unique = appended.filter((entry) => !known.has(entry.eventHash));
  if (unique.length === 0) return base;

  const orderedEntries = orderEventLogEntries([...base.orderedEntries, ...unique]);
  let fs: MaterializedFileSystem;
  if (hasOrderedPrefix(base.orderedEntries, orderedEntries)) {
    const tail = orderedEntries.slice(base.orderedEntries.length);
    fs =
      tail.length > 0
        ? materializeIncremental(base.fs, toCanonicalEntriesFromOrdered(tail))
        : base.fs;
  } else {
    fs = runMaterialization(toCanonicalEntriesFromOrdered(orderedEntries));
  }

  const liveEncryptedKeys = new Map(base.liveEncryptedKeys);
  for (const entry of unique) {
    const payload = entry.signedEvent.payload;
    if (payload.type === EventType.CREATE_FILE) {
      liveEncryptedKeys.set(payload.path, payload.wrappedKey);
    }
  }
  for (const [path, originHash] of fs.fileOrigins) {
    const wrapped = entryWrappedKey(orderedEntries, originHash);
    if (wrapped !== undefined) liveEncryptedKeys.set(path, wrapped);
  }

  const head = observedLogHeadFromOrdered(orderedEntries);
  return {
    fs: applyCachedBlobSizes(fs),
    observedHead: head !== undefined ? createHash(head) : undefined,
    orderedEntries,
    liveEncryptedKeys,
  };
}

function applyCachedBlobSizes(fs: MaterializedFileSystem): MaterializedFileSystem {
  const files = new Map(fs.files);
  let changed = false;
  for (const [path, meta] of files) {
    if (meta.size > 0) continue;
    const size = cachedBlobPlaintextSize(meta.blobHash);
    if (size === undefined) continue;
    files.set(path, { ...meta, size });
    changed = true;
  }
  return changed ? { ...fs, files } : fs;
}

function entryWrappedKey(
  orderedEntries: readonly EventLogEntry[],
  eventHash: string,
): EncryptedData | undefined {
  const entry = orderedEntries.find((candidate) => candidate.eventHash === eventHash);
  if (entry === undefined) return undefined;
  const payload = entry.signedEvent.payload;
  if (payload.type !== EventType.CREATE_FILE) return undefined;
  return payload.wrappedKey;
}
