import type { Secret, PublicKey } from 'nearbytes-crypto';
import type { Hash, EventPayload } from 'nearbytes-crypto';
import { EventType } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import { type Log } from 'nearbytes-log';
import { createEncryptedData } from 'nearbytes-crypto';
import { createSymmetricKey } from 'nearbytes-crypto';
import { computeHash } from 'nearbytes-crypto';
import { serializeEventEnvelope } from 'nearbytes-log';
import { createSignedEvent, hydrateSignedEvent } from 'nearbytes-log';

/**
 * Sets up a new channel from a secret
 * Derives keys and returns the public key (no storage concerns)
 * @param secret - Channel secret (e.g., "channelname:password")
 * @param crypto - Cryptographic operations
 * @returns Public key
 */
export async function setupChannel(
  secret: Secret,
  crypto: CryptoOperations
): Promise<{ publicKey: PublicKey }> {
  // Derive key pair from secret
  const keyPair = await crypto.deriveKeys(secret);

  return {
    publicKey: keyPair.publicKey,
  };
}

/**
 * Stores data in a channel
 * @param data - Plaintext data to store
 * @param fileName - Name of the file
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Event hash and data hash
 */
export async function storeData(
  data: Uint8Array,
  fileName: string,
  secret: Secret,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<{ eventHash: Hash; dataHash: Hash }> {
  // 1. Derive keys from secret
  const keyPair = await crypto.deriveKeys(secret);

  // 2. Generate symmetric key for data encryption
  const symmetricKey = await crypto.generateSymmetricKey();

  // 3. Encrypt data
  const encryptedData = await crypto.encryptSym(data, symmetricKey);

  // 4. Hand the encrypted block to the log; the log is the sole authority of
  //    the block content-address (storage/log-api-v1.md §2.3) and returns the
  //    SHA-256 hash of the bytes it persisted.
  const dataHash = await channelStorage.blocks.store(encryptedData, false);

  // 5. Derive symmetric key for encrypting the data encryption key
  const keyEncryptionKey = await crypto.deriveSymKey(keyPair.privateKey);

  // 6. Encrypt the symmetric key
  const encryptedKey = await crypto.encryptSym(symmetricKey, keyEncryptionKey);

  // 7. Create event payload (spec: file-events-v0.3)
  const payload: EventPayload = {
    type: EventType.CREATE_FILE,
    filename: fileName,
    content: { protocol: 'nb.content.single.v1', blockHash: dataHash },
    wrappedKey: createEncryptedData(encryptedKey),
    createdAt: Date.now(),
  };

  const signedEvent = await createSignedEvent(crypto, keyPair, payload, [dataHash]);
  const eventHash = await channelStorage.events.storeEvent(keyPair.publicKey, signedEvent);

  return { eventHash, dataHash };
}

/**
 * Retrieves data from a channel
 * @param eventHash - Event hash
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Decrypted plaintext data
 */
export async function retrieveData(
  eventHash: Hash,
  secret: Secret,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<Uint8Array> {
  // 1. Derive keys from secret
  const keyPair = await crypto.deriveKeys(secret);

  // 2. Retrieve signed event
  const signedEvent = await channelStorage.events.retrieveEvent(keyPair.publicKey, eventHash);

  const payloadBytes = serializeEventEnvelope(signedEvent.envelope);
  const isValid = await crypto.verifyPU(payloadBytes, signedEvent.signature, keyPair.publicKey);

  if (!isValid) {
    throw new Error('Event signature verification failed');
  }

  const decryptedEvent = await hydrateSignedEvent(crypto, keyPair.privateKey, signedEvent);

  if (decryptedEvent.payload.type !== EventType.CREATE_FILE) {
    throw new Error(`Expected CREATE_FILE event, got ${String(decryptedEvent.payload.type)}`);
  }

  const createPayload = decryptedEvent.payload;

  // 4. Derive symmetric key for decrypting the data encryption key
  const keyEncryptionKey = await crypto.deriveSymKey(keyPair.privateKey);

  // 5. Decrypt the symmetric key
  const symmetricKeyBytes = await crypto.decryptSym(createPayload.wrappedKey, keyEncryptionKey);
  const symmetricKey = createSymmetricKey(symmetricKeyBytes);

  // 6. Retrieve encrypted data using the block hash from the content descriptor
  if (createPayload.content.protocol !== 'nb.content.single.v1') {
    throw new Error(`Unsupported content protocol: ${createPayload.content.protocol}`);
  }
  const encryptedData = await channelStorage.blocks.retrieve(createPayload.content.blockHash);

  // 7. Decrypt data
  const plaintext = await crypto.decryptSym(encryptedData, symmetricKey);

  return plaintext;
}

/**
 * Stores data in a channel with deduplication
 * If the encrypted data block already exists (same hash), it will be reused
 * @param data - Plaintext data to store
 * @param fileName - Name of the file
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Event hash and data hash, and whether data was deduplicated
 */
export async function storeDataDeduplicated(
  data: Uint8Array,
  fileName: string,
  secret: Secret,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<{ eventHash: Hash; dataHash: Hash; wasDeduplicated: boolean }> {
  // 1. Derive keys from secret
  const keyPair = await crypto.deriveKeys(secret);

  // 2. Generate symmetric key for data encryption
  const symmetricKey = await crypto.generateSymmetricKey();

  // 3. Encrypt data
  const encryptedData = await crypto.encryptSym(data, symmetricKey);

  // 4. Probe deduplication via SHA-256 of the encrypted bytes, then hand the
  //    block to the log (which is the sole authority of the content-address).
  //    The hash returned by `store` is the address we reference downstream.
  const probeHash = await computeHash(encryptedData);
  const dataExists = await channelStorage.blocks.has(probeHash);
  const dataHash = await channelStorage.blocks.store(encryptedData, true);

  // 7. Derive symmetric key for encrypting the data encryption key
  const keyEncryptionKey = await crypto.deriveSymKey(keyPair.privateKey);

  // 8. Encrypt the symmetric key
  const encryptedKey = await crypto.encryptSym(symmetricKey, keyEncryptionKey);

  // 9. Create event payload (spec: file-events-v0.3)
  const payload: EventPayload = {
    type: EventType.CREATE_FILE,
    filename: fileName,
    content: { protocol: 'nb.content.single.v1', blockHash: dataHash },
    wrappedKey: createEncryptedData(encryptedKey),
    createdAt: Date.now(),
  };

  const signedEvent = await createSignedEvent(crypto, keyPair, payload, [dataHash]);
  const eventHash = await channelStorage.events.storeEvent(keyPair.publicKey, signedEvent);

  return { eventHash, dataHash, wasDeduplicated: dataExists };
}

/**
 * Deletes a file from a channel
 * @param fileName - Name of the file to delete
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Event hash
 */
export async function deleteFile(
  fileName: string,
  secret: Secret,
  crypto: CryptoOperations,
  channelStorage: Log
): Promise<{ eventHash: Hash }> {
  // 1. Derive keys from secret
  const keyPair = await crypto.deriveKeys(secret);

  // 2. Create DELETE_FILE event payload (spec: file-events-v0.3)
  // No block refs needed — deletion carries no data blocks
  const payload: EventPayload = {
    type: EventType.DELETE_FILE,
    filename: fileName,
    deletedAt: Date.now(),
  };

  const signedEvent = await createSignedEvent(crypto, keyPair, payload, []);
  const eventHash = await channelStorage.events.storeEvent(keyPair.publicKey, signedEvent);

  return { eventHash };
}
