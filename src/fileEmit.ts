/**
 * Single emit path for file-events-v0.5 causal `blockRefs`.
 */

import type { KeyPair } from 'nearbytes-crypto';
import { createHash, type CryptoOperations, type EventPayload, type Hash } from 'nearbytes-crypto';
import type { Log } from 'nearbytes-log';
import { createSignedEvent, loadEventLog, openChannel, verifyEventLog } from 'nearbytes-log';
import { materialize, type MaterializedFileSystem } from './fileMaterializer.js';
import { toCanonicalEntries } from './fileLogEntries.js';
import { createSecret } from 'nearbytes-crypto';

export interface CausalLineage {
  readonly supersededEvent?: Hash;
  readonly lastBlock?: Hash;
}

export function buildBlockRefs(
  lineages: readonly CausalLineage[],
  introducedBlocks: readonly Hash[],
): Hash[] {
  const refs: Hash[] = [];
  for (const lineage of lineages) {
    if (lineage.supersededEvent !== undefined) refs.push(lineage.supersededEvent);
    if (lineage.lastBlock !== undefined) refs.push(lineage.lastBlock);
  }
  for (const block of introducedBlocks) refs.push(block);
  return refs;
}

export function lineageAtPath(fs: MaterializedFileSystem, path: string): CausalLineage {
  const origin = fs.fileOrigins.get(path);
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
  const entries = await loadEventLog(volume, log, crypto);
  await verifyEventLog(entries, volume, crypto);
  return materialize(toCanonicalEntries(entries));
}

export async function emitFileEvent(
  crypto: CryptoOperations,
  keyPair: KeyPair,
  log: Log,
  payload: EventPayload,
  lineages: readonly CausalLineage[],
  introducedBlocks: readonly Hash[],
): Promise<Hash> {
  const blockRefs = buildBlockRefs(lineages, introducedBlocks);
  const event = await createSignedEvent(crypto, keyPair, payload, blockRefs);
  return log.events.storeEvent(keyPair.publicKey, event);
}
