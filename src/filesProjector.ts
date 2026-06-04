/**
 * FILES projector for the projection engine (`storage/projection-engine-v1.md`,
 * `application/file-events-v0.5.md` §11). FILES is an *ordered* projector: its
 * `reorder` is the canonical causal topological merge over observed-log-head
 * parents (§5), and its `reduce` is materialization (§6). The projector's state
 * is the {@link FileReplayContext} — the live filesystem, the causal ordered log,
 * the live wrapped keys, and the observed head — persisted so warm reads and
 * restarts never re-materialize the whole channel.
 */
import {
  createHash,
  createEncryptedData,
  base64UrlToBytes,
  bytesToBase64Url,
  EventType,
  type EncryptedData,
  type Hash,
} from 'nearbytes-crypto';
import type { EventLogEntry, OrderKey, Projector } from 'nearbytes-log';
import {
  deserializeEvent,
  deserializeInnerEventPayloadJson,
  serializeEvent,
  serializeInnerEventPayloadJson,
} from 'nearbytes-log';
import { applyCachedBlobSizes, type FileReplayContext } from './fileEmit.js';
import type { MaterializedFileSystem } from './fileMaterializer.js';
import { materializeIncremental } from './fileMaterializer.js';
import {
  fileOrderKeyForEntry,
  observedLogHeadFromOrdered,
  orderFileKeys,
  toCanonicalEntriesFromOrdered,
  type FileOrderKey,
} from './fileLogEntries.js';
import { runMaterialization } from './materialization.js';

export const FILES_PROJECTOR_ID = 'nb.files.v0.5';

export type FilesKey = OrderKey & FileOrderKey;

function buildLiveEncryptedKeys(
  orderedEntries: readonly EventLogEntry[],
  fs: MaterializedFileSystem,
): Map<string, EncryptedData> {
  const keyByEventHash = new Map<string, EncryptedData>();
  for (const entry of orderedEntries) {
    const payload = entry.signedEvent.payload;
    if (payload.type === EventType.CREATE_FILE) keyByEventHash.set(entry.eventHash, payload.wrappedKey);
  }
  const live = new Map<string, EncryptedData>();
  for (const [path, originHash] of fs.fileOrigins) {
    const wrapped = keyByEventHash.get(originHash);
    if (wrapped !== undefined) live.set(path, wrapped);
  }
  return live;
}

function reduceContext(
  base: FileReplayContext,
  orderedTail: readonly EventLogEntry[],
): FileReplayContext {
  const orderedEntries = [...base.orderedEntries, ...orderedTail];
  const canonicalTail = toCanonicalEntriesFromOrdered(orderedTail);
  const rawFs =
    base.orderedEntries.length === 0
      ? runMaterialization(canonicalTail)
      : materializeIncremental(base.fs, canonicalTail);
  const fs = applyCachedBlobSizes(rawFs);
  const head = observedLogHeadFromOrdered(orderedEntries);
  const liveEncryptedKeys = buildLiveEncryptedKeys(orderedEntries, fs);
  const next: FileReplayContext = {
    fs,
    orderedEntries,
    liveEncryptedKeys,
    ...(head !== undefined ? { observedHead: createHash(head) } : {}),
  };
  return next;
}

// ── snapshot codec ───────────────────────────────────────────────────────────

interface SerializedContext {
  readonly fs: {
    readonly files: [string, unknown][];
    readonly directories: [string, unknown][];
    readonly fileOrigins: [string, string][];
    readonly entryHeads: [string, string][];
    readonly shadows: unknown[];
  };
  readonly observedHead: string | null;
  readonly liveEncryptedKeys: [string, string][];
  readonly orderedEntries: { readonly h: string; readonly e: unknown; readonly p: unknown }[];
}

function serializeContext(state: FileReplayContext): Uint8Array {
  const payload: SerializedContext = {
    fs: {
      files: [...state.fs.files] as [string, unknown][],
      directories: [...state.fs.directories] as [string, unknown][],
      fileOrigins: [...state.fs.fileOrigins],
      entryHeads: [...state.fs.entryHeads],
      shadows: [...state.fs.shadows],
    },
    observedHead: state.observedHead ?? null,
    liveEncryptedKeys: [...state.liveEncryptedKeys].map(([path, key]) => [path, bytesToBase64Url(key)]),
    orderedEntries: state.orderedEntries.map((entry) => ({
      h: entry.eventHash,
      e: serializeEvent(entry.signedEvent),
      p: serializeInnerEventPayloadJson(entry.signedEvent.payload),
    })),
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function deserializeContext(bytes: Uint8Array): FileReplayContext {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SerializedContext;
  const fs: MaterializedFileSystem = {
    files: new Map(parsed.fs.files as [string, never][]),
    directories: new Map(parsed.fs.directories as [string, never][]),
    fileOrigins: new Map(parsed.fs.fileOrigins),
    entryHeads: new Map(parsed.fs.entryHeads),
    shadows: parsed.fs.shadows as MaterializedFileSystem['shadows'],
  };
  const orderedEntries: EventLogEntry[] = parsed.orderedEntries.map((row) => ({
    eventHash: row.h as Hash,
    signedEvent: {
      ...deserializeEvent(row.e as Parameters<typeof deserializeEvent>[0]),
      payload: deserializeInnerEventPayloadJson(
        row.p as Parameters<typeof deserializeInnerEventPayloadJson>[0],
      ),
    },
  }));
  const liveEncryptedKeys = new Map<string, EncryptedData>(
    parsed.liveEncryptedKeys.map(([path, key]) => [path, createEncryptedData(base64UrlToBytes(key))]),
  );
  return {
    fs,
    orderedEntries,
    liveEncryptedKeys,
    ...(parsed.observedHead !== null ? { observedHead: createHash(parsed.observedHead) } : {}),
  };
}

export function createFilesProjector(): Projector<FileReplayContext, FilesKey> {
  return {
    id: FILES_PROJECTOR_ID,
    initial: () => ({
      fs: runMaterialization([]),
      orderedEntries: [],
      liveEncryptedKeys: new Map(),
    }),
    serializeState: serializeContext,
    deserializeState: deserializeContext,
    key: (entry) => fileOrderKeyForEntry(entry) as FilesKey,
    reorder: (prev, next) => {
      const known = new Set(prev.map((k) => k.hash));
      const added = next.filter((k) => !known.has(k.hash));
      const merged = orderFileKeys([...prev, ...added]) as FilesKey[];
      let insertAt = merged.length;
      for (let i = 0; i < merged.length; i += 1) {
        if (i >= prev.length || merged[i]!.hash !== prev[i]!.hash) {
          insertAt = i;
          break;
        }
      }
      return { keys: merged, insertAt };
    },
    reduce: (base, tail) => reduceContext(base, tail),
  };
}
