import { EventType } from 'nearbytes-crypto';
import type { EventLogEntry } from 'nearbytes-log';
import type { CanonicalEntry, CanonicalEvent } from './fileMaterializer.js';

export function toCanonicalEntries(entries: EventLogEntry[]): CanonicalEntry[] {
  return toCanonicalEntriesFromOrdered(orderEventLogEntries(entries));
}

export function toCanonicalEntriesFromOrdered(entries: readonly EventLogEntry[]): CanonicalEntry[] {
  return entries.map((entry) => ({
    tiebreak: entry.eventHash,
    event: toCanonicalEvent(entry),
  }));
}

/**
 * Compact, JSON-serializable order key for the FILES projector
 * (`storage/projection-engine-v1.md`). Carries everything the topological merge
 * needs without the decrypted payload, so the projection engine can persist it
 * and recompute insertion points cheaply.
 */
export interface FileOrderKey {
  readonly hash: string;
  /** observed-log-head parent (blockRefs[0] for a FILES verb), if any. */
  readonly parent?: string;
  readonly ts: number;
  readonly isFileVerb: boolean;
}

export function fileOrderKeyForEntry(entry: EventLogEntry): FileOrderKey {
  const isFileVerb = isFileEventEntry(entry);
  let parent = observedLogHeadRef(entry);
  if (parent !== undefined && isPayloadDeclaredContentRef(entry, parent)) parent = undefined;
  const key: FileOrderKey = { hash: entry.eventHash, ts: extractTimestamp(entry, 0), isFileVerb };
  return parent !== undefined ? { ...key, parent } : key;
}

/**
 * Canonical FILES replay order over keys (parallel to {@link orderEventLogEntries}
 * but operating on {@link FileOrderKey}s). Per `WIP §8` / projection-engine-v1
 * PROJ-7, a FILES event whose observed-log-head parent is not (yet) present is
 * treated as a root and still materialized, rather than excluded as pending.
 */
export function orderFileKeys(keys: readonly FileOrderKey[]): FileOrderKey[] {
  const nodes = keys.map((key, sequence) => ({
    key,
    sequence,
    children: [] as number[],
    indegree: 0,
  }));
  const byHash = new Map<string, number>();
  for (let i = 0; i < nodes.length; i += 1) byHash.set(nodes[i]!.key.hash, i);

  for (let childIndex = 0; childIndex < nodes.length; childIndex += 1) {
    const child = nodes[childIndex]!;
    const parentHash = child.key.parent;
    if (parentHash === undefined) continue;
    const parentIndex = byHash.get(parentHash);
    if (parentIndex !== undefined) {
      nodes[parentIndex]!.children.push(childIndex);
      child.indegree += 1;
    }
    // Missing parent: treat as root (materialize-on-arrival).
  }

  const cmp = (a: { key: FileOrderKey; sequence: number }, b: { key: FileOrderKey; sequence: number }): number => {
    if (a.key.ts !== b.key.ts) return a.key.ts - b.key.ts;
    if (a.key.hash !== b.key.hash) return a.key.hash < b.key.hash ? -1 : 1;
    return a.sequence - b.sequence;
  };

  const ready: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i]!.indegree === 0) ready.push(i);
  ready.sort((l, r) => cmp(nodes[l]!, nodes[r]!));

  const ordered: FileOrderKey[] = [];
  while (ready.length > 0) {
    const index = ready.shift()!;
    const node = nodes[index]!;
    ordered.push(node.key);
    for (const childIndex of node.children) {
      const child = nodes[childIndex]!;
      child.indegree -= 1;
      if (child.indegree === 0) {
        let at = 0;
        while (at < ready.length && cmp(nodes[ready[at]!]!, child) <= 0) at += 1;
        ready.splice(at, 0, childIndex);
      }
    }
  }
  return ordered;
}

export function orderEventLogEntries(entries: readonly EventLogEntry[]): EventLogEntry[] {
  const nodes = entries.map((entry, sequence) => ({
    entry,
    sequence,
    timestamp: extractTimestamp(entry, sequence),
    children: [] as number[],
    indegree: 0,
  }));
  const byHash = new Map<string, number>();
  for (let i = 0; i < nodes.length; i += 1) byHash.set(nodes[i]!.entry.eventHash, i);

  for (let childIndex = 0; childIndex < nodes.length; childIndex += 1) {
    const child = nodes[childIndex]!;
    const parentHash = observedLogHeadRef(child.entry);
    if (parentHash === undefined) continue;
    const parentIndex = byHash.get(parentHash);
    if (parentIndex !== undefined) {
      nodes[parentIndex]!.children.push(childIndex);
      child.indegree += 1;
      continue;
    }
    if (!isPayloadDeclaredContentRef(child.entry, parentHash)) {
      child.indegree += 1;
    }
  }

  const ready: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.indegree === 0) ready.push(i);
  }
  ready.sort((left, right) => compareNode(nodes[left]!, nodes[right]!));

  const ordered: EventLogEntry[] = [];
  while (ready.length > 0) {
    const index = ready.shift()!;
    const node = nodes[index]!;
    ordered.push(node.entry);
    for (const childIndex of node.children) {
      const child = nodes[childIndex]!;
      child.indegree -= 1;
      if (child.indegree === 0) {
        insertReady(ready, childIndex, nodes);
      }
    }
  }

  return ordered;
}

export function observedLogHead(entries: readonly EventLogEntry[]): string | undefined {
  return observedLogHeadFromOrdered(orderEventLogEntries(entries));
}

export function observedLogHeadFromOrdered(entries: readonly EventLogEntry[]): string | undefined {
  const ordered = entries;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const entry = ordered[i]!;
    if (isFileEventEntry(entry)) return entry.eventHash;
  }
  return undefined;
}

function observedLogHeadRef(entry: EventLogEntry): string | undefined {
  if (!isFileEventEntry(entry)) return undefined;
  return entry.signedEvent.envelope.blockRefs[0];
}

function isPayloadDeclaredContentRef(entry: EventLogEntry, hash: string): boolean {
  const payload = entry.signedEvent.payload;
  if (payload.type !== EventType.CREATE_FILE) return false;
  const contentHash =
    payload.content.protocol === 'nb.content.single.v1'
      ? payload.content.blockHash
      : payload.content.manifestHash;
  return contentHash === hash;
}

function isFileEventEntry(entry: EventLogEntry): boolean {
  const payload = entry.signedEvent.payload;
  return (
    payload.type === EventType.CREATE_FILE ||
    payload.type === EventType.MKDIR ||
    payload.type === EventType.DELETE ||
    payload.type === EventType.RENAME
  );
}

function insertReady(
  ready: number[],
  index: number,
  nodes: readonly {
    readonly entry: EventLogEntry;
    readonly sequence: number;
    readonly timestamp: number;
  }[],
): void {
  const node = nodes[index]!;
  let at = 0;
  while (at < ready.length && compareNode(nodes[ready[at]!]!, node) <= 0) at += 1;
  ready.splice(at, 0, index);
}

function compareNode(
  left: { readonly entry: EventLogEntry; readonly sequence: number; readonly timestamp: number },
  right: { readonly entry: EventLogEntry; readonly sequence: number; readonly timestamp: number },
): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (left.entry.eventHash !== right.entry.eventHash) {
    return left.entry.eventHash < right.entry.eventHash ? -1 : 1;
  }
  return left.sequence - right.sequence;
}

function toCanonicalEvent(entry: EventLogEntry): CanonicalEvent {
  const payload = entry.signedEvent.payload;
  if (payload.type === EventType.CREATE_FILE) {
    const blobHash =
      payload.content.protocol === 'nb.content.single.v1'
        ? payload.content.blockHash
        : payload.content.manifestHash;
    const contentType: 'b' | 'm' =
      payload.content.protocol === 'nb.content.manifest.v1' ? 'm' : 'b';
    return {
      kind: 'CREATE_FILE',
      path: payload.path,
      blobHash,
      contentType,
      size: 0,
      mimeType: payload.mimeType,
      createdAt: payload.createdAt,
    };
  }
  if (payload.type === EventType.MKDIR) {
    return { kind: 'MKDIR', path: payload.path, createdAt: payload.createdAt };
  }
  if (payload.type === EventType.DELETE) {
    return { kind: 'DELETE', path: payload.path, deletedAt: payload.deletedAt };
  }
  if (payload.type === EventType.RENAME) {
    return {
      kind: 'RENAME',
      fromPath: payload.fromPath,
      toPath: payload.toPath,
      renamedAt: payload.renamedAt,
    };
  }
  return { kind: 'OTHER', verb: String(payload.type), timestamp: extractTimestamp(entry, 0) };
}

function extractTimestamp(entry: EventLogEntry, fallback: number): number {
  const payload = entry.signedEvent.payload;
  if (payload.type === EventType.CREATE_FILE) return payload.createdAt;
  if (payload.type === EventType.MKDIR) return payload.createdAt;
  if (payload.type === EventType.DELETE) return payload.deletedAt;
  if (payload.type === EventType.RENAME) return payload.renamedAt;
  if (payload.type === EventType.DECLARE_IDENTITY) return payload.publishedAt ?? fallback;
  if (payload.type === EventType.CHAT_MESSAGE) return payload.publishedAt ?? fallback;
  if (payload.type === EventType.APP_RECORD) return payload.publishedAt;
  return fallback;
}
