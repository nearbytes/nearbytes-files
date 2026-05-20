import { EventType } from 'nearbytes-crypto';
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
export async function setupChannel(secret, crypto) {
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
export async function storeData(data, fileName, secret, crypto, channelStorage) {
    // 1. Derive keys from secret
    const keyPair = await crypto.deriveKeys(secret);
    // 2. Generate symmetric key for data encryption
    const symmetricKey = await crypto.generateSymmetricKey();
    // 3. Encrypt data
    const encryptedData = await crypto.encryptSym(data, symmetricKey);
    // 4. Compute hash of encrypted data
    const dataHash = await computeHash(encryptedData);
    // 5. Store encrypted data
    await channelStorage.blocks.store(dataHash, encryptedData, false, keyPair.publicKey);
    // 6. Derive symmetric key for encrypting the data encryption key
    const keyEncryptionKey = await crypto.deriveSymKey(keyPair.privateKey);
    // 7. Encrypt the symmetric key
    const encryptedKey = await crypto.encryptSym(symmetricKey, keyEncryptionKey);
    // 8. Create event payload (spec: file-events-v0.3)
    const payload = {
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
export async function retrieveData(eventHash, secret, crypto, channelStorage) {
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
    const encryptedData = await channelStorage.blocks.retrieve(createPayload.content.blockHash, keyPair.publicKey);
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
export async function storeDataDeduplicated(data, fileName, secret, crypto, channelStorage) {
    // 1. Derive keys from secret
    const keyPair = await crypto.deriveKeys(secret);
    // 2. Generate symmetric key for data encryption
    const symmetricKey = await crypto.generateSymmetricKey();
    // 3. Encrypt data
    const encryptedData = await crypto.encryptSym(data, symmetricKey);
    // 4. Compute hash of encrypted data
    const dataHash = await computeHash(encryptedData);
    // 5. Check if data already exists
    const dataExists = await channelStorage.blocks.has(dataHash, keyPair.publicKey);
    // 6. Store encrypted data (skip if already exists)
    await channelStorage.blocks.store(dataHash, encryptedData, true, keyPair.publicKey);
    // 7. Derive symmetric key for encrypting the data encryption key
    const keyEncryptionKey = await crypto.deriveSymKey(keyPair.privateKey);
    // 8. Encrypt the symmetric key
    const encryptedKey = await crypto.encryptSym(symmetricKey, keyEncryptionKey);
    // 9. Create event payload (spec: file-events-v0.3)
    const payload = {
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
export async function deleteFile(fileName, secret, crypto, channelStorage) {
    // 1. Derive keys from secret
    const keyPair = await crypto.deriveKeys(secret);
    // 2. Create DELETE_FILE event payload (spec: file-events-v0.3)
    // No block refs needed — deletion carries no data blocks
    const payload = {
        type: EventType.DELETE_FILE,
        filename: fileName,
        deletedAt: Date.now(),
    };
    const signedEvent = await createSignedEvent(crypto, keyPair, payload, []);
    const eventHash = await channelStorage.events.storeEvent(keyPair.publicKey, signedEvent);
    return { eventHash };
}
//# sourceMappingURL=operations.js.map