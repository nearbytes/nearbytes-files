/**
 * Validates a secret string
 */
export declare function validateSecret(secret: string): import('nearbytes-crypto').Secret;
/**
 * Validates a hash string
 */
export declare function validateHash(hash: string): import('nearbytes-crypto').Hash;
/**
 * Validates a file path exists and is readable
 */
export declare function validateFilePath(filePath: string): Promise<void>;
/**
 * Validates output directory exists or can be created
 */
export declare function validateOutputPath(filePath: string): Promise<void>;
//# sourceMappingURL=validation.d.ts.map