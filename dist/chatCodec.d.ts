import type { CryptoOperations } from 'nearbytes-crypto';
import type { KeyPair, PublicKey } from 'nearbytes-crypto';
export interface IdentityProfile {
    readonly displayName: string;
    readonly bio?: string;
}
export interface IdentityRecord {
    readonly p: 'nb.identity.record.v1';
    readonly k: string;
    readonly ts: number;
    readonly profile: IdentityProfile;
    readonly sig: string;
}
export interface IdentitySnapshot {
    readonly p: 'nb.identity.snapshot.v1';
    readonly k: string;
    readonly ts: number;
    readonly ref: {
        readonly channel: string;
        readonly eventHash: string;
    };
    readonly record: IdentityRecord;
    readonly sig: string;
}
export interface ChatMessage {
    readonly p: 'nb.chat.message.v1';
    readonly k: string;
    readonly ts: number;
    readonly body: string;
    readonly sig: string;
}
export declare function createIdentityRecord(crypto: CryptoOperations, keyPair: KeyPair, profile: IdentityProfile, timestamp: number): Promise<IdentityRecord>;
export declare function verifyIdentityRecord(crypto: CryptoOperations, record: IdentityRecord): Promise<boolean>;
export declare function createChatMessage(crypto: CryptoOperations, keyPair: KeyPair, input: {
    body: string;
    timestamp: number;
}): Promise<ChatMessage>;
export declare function verifyChatMessage(crypto: CryptoOperations, message: ChatMessage): Promise<boolean>;
export declare function createIdentitySnapshot(crypto: CryptoOperations, keyPair: KeyPair, input: {
    record: IdentityRecord;
    ref: {
        channel: string;
        eventHash: string;
    };
    timestamp: number;
}): Promise<IdentitySnapshot>;
export declare function verifyIdentitySnapshot(crypto: CryptoOperations, snapshot: IdentitySnapshot): Promise<boolean>;
export declare function serializeIdentityRecord(record: IdentityRecord): string;
export declare function serializeIdentitySnapshot(snapshot: IdentitySnapshot): string;
export declare function serializeChatMessage(message: ChatMessage): string;
export declare function parseIdentityRecord(value: unknown): IdentityRecord;
export declare function parseIdentityRecordJson(text: string): IdentityRecord | null;
export declare function parseIdentitySnapshot(value: unknown): IdentitySnapshot;
export declare function parseIdentitySnapshotJson(text: string): IdentitySnapshot | null;
export declare function parseChatMessage(value: unknown): ChatMessage;
export declare function parseChatMessageJson(text: string): ChatMessage | null;
export declare function publicKeyFromHex(value: string): PublicKey;
//# sourceMappingURL=chatCodec.d.ts.map