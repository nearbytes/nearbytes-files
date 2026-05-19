import type { CryptoOperations } from 'nearbytes-crypto';
import type { EncryptedData, Hash } from 'nearbytes-crypto';
import type { PrivateKey, PublicKey, SymmetricKey } from 'nearbytes-crypto';
import type { ContentDescriptor } from './fileReferenceCodec.js';
export interface EncryptedFileWrite {
    readonly blobHash: Hash;
    readonly encryptedData: EncryptedData;
    readonly encryptedKey: EncryptedData;
    readonly contentType: 'b';
}
export interface RecipientKeyCapsuleBytes {
    readonly recipientVolumeId: string;
    readonly ephemeralPublicKey: string;
    readonly nonce: string;
    readonly wrappedKey: string;
}
export declare function encryptFileForVolume(crypto: CryptoOperations, volumePrivateKey: PrivateKey, data: Uint8Array): Promise<EncryptedFileWrite>;
export declare function wrapFileKeyForVolume(crypto: CryptoOperations, volumePrivateKey: PrivateKey, fileKey: SymmetricKey): Promise<EncryptedData>;
export declare function unwrapFileKeyForVolume(crypto: CryptoOperations, volumePrivateKey: PrivateKey, encryptedKey: Uint8Array): Promise<SymmetricKey>;
export declare function decryptFileForVolume(crypto: CryptoOperations, volumePrivateKey: PrivateKey, encryptedData: EncryptedData, encryptedKey: Uint8Array): Promise<Uint8Array>;
export declare function createRecipientKeyCapsule(fileKey: SymmetricKey, recipientVolumeId: string, descriptor: ContentDescriptor): Promise<RecipientKeyCapsuleBytes>;
export declare function unwrapRecipientKeyCapsule(recipientPrivateKey: PrivateKey, recipientVolumeId: string, descriptor: ContentDescriptor, capsule: {
    readonly e: string;
    readonly n: string;
    readonly w: string;
}): Promise<SymmetricKey>;
export declare function volumeIdFromPublicKey(publicKey: PublicKey): string;
export declare function publicKeyFromVolumeId(volumeId: string): PublicKey;
//# sourceMappingURL=fileCrypto.d.ts.map