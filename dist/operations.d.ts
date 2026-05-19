import type { Secret, PublicKey } from 'nearbytes-crypto';
import type { Hash } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import { type Log } from 'nearbytes-log';
/**
 * Sets up a new channel from a secret
 * Derives keys and returns the public key (no storage concerns)
 * @param secret - Channel secret (e.g., "channelname:password")
 * @param crypto - Cryptographic operations
 * @returns Public key
 */
export declare function setupChannel(secret: Secret, crypto: CryptoOperations): Promise<{
    publicKey: PublicKey;
}>;
/**
 * Stores data in a channel
 * @param data - Plaintext data to store
 * @param fileName - Name of the file
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Event hash and data hash
 */
export declare function storeData(data: Uint8Array, fileName: string, secret: Secret, crypto: CryptoOperations, channelStorage: Log): Promise<{
    eventHash: Hash;
    dataHash: Hash;
}>;
/**
 * Retrieves data from a channel
 * @param eventHash - Event hash
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Decrypted plaintext data
 */
export declare function retrieveData(eventHash: Hash, secret: Secret, crypto: CryptoOperations, channelStorage: Log): Promise<Uint8Array>;
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
export declare function storeDataDeduplicated(data: Uint8Array, fileName: string, secret: Secret, crypto: CryptoOperations, channelStorage: Log): Promise<{
    eventHash: Hash;
    dataHash: Hash;
    wasDeduplicated: boolean;
}>;
/**
 * Deletes a file from a channel
 * @param fileName - Name of the file to delete
 * @param secret - Channel secret
 * @param crypto - Cryptographic operations
 * @param channelStorage - Channel storage instance
 * @returns Event hash
 */
export declare function deleteFile(fileName: string, secret: Secret, crypto: CryptoOperations, channelStorage: Log): Promise<{
    eventHash: Hash;
}>;
//# sourceMappingURL=operations.d.ts.map