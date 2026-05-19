export type FileContentType = 'b' | 'm';
export interface ContentDescriptor {
    readonly t: FileContentType;
    readonly h: string;
    readonly z: number;
}
export interface SourceFileReference {
    readonly p: 'nb.src.ref.v1';
    readonly s: string;
    readonly c: ContentDescriptor;
    readonly x: string;
}
export interface SourceReferenceBundleItem {
    readonly name: string;
    readonly mime?: string;
    readonly createdAt?: number;
    readonly ref: SourceFileReference;
}
export interface SourceReferenceBundle {
    readonly p: 'nb.src.refs.v1';
    readonly s: string;
    readonly items: SourceReferenceBundleItem[];
}
export interface RecipientKeyCapsule {
    readonly r: string;
    readonly e: string;
    readonly n: string;
    readonly w: string;
}
export interface RecipientFileReference {
    readonly p: 'nb.ref.v1';
    readonly c: ContentDescriptor;
    readonly k: RecipientKeyCapsule;
}
export interface RecipientReferenceBundleItem {
    readonly name: string;
    readonly mime?: string;
    readonly createdAt?: number;
    readonly ref: RecipientFileReference;
}
export interface RecipientReferenceBundle {
    readonly p: 'nb.refs.v1';
    readonly r: string;
    readonly items: RecipientReferenceBundleItem[];
}
type JsonValue = null | boolean | number | string | JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export declare function canonicalJsonString(value: JsonValue): string;
export declare function canonicalJsonBytes(value: JsonValue): Uint8Array;
export declare function serializeSourceReferenceBundle(bundle: SourceReferenceBundle): string;
export declare function serializeRecipientReferenceBundle(bundle: RecipientReferenceBundle): string;
export declare function parseSourceReferenceBundle(value: unknown): SourceReferenceBundle;
export declare function parseRecipientReferenceBundle(value: unknown): RecipientReferenceBundle;
export declare function parseSourceFileReferenceValue(value: unknown): SourceFileReference;
export declare function parseSourceReferenceJson(text: string): SourceReferenceBundle | null;
export declare function parseRecipientReferenceJson(text: string): RecipientReferenceBundle | null;
export declare function encodeWrappedKey(bytes: Uint8Array): string;
export declare function decodeWrappedKey(value: string, label: string): Uint8Array;
export {};
//# sourceMappingURL=fileReferenceCodec.d.ts.map