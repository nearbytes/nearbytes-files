import type { Command } from 'commander';
export interface StoreOptions {
    file: string;
    secret: string;
    dataDir?: string;
}
/**
 * Store command handler
 */
export declare function handleStore(options: StoreOptions): Promise<void>;
/**
 * Registers the store command
 */
export declare function registerStoreCommand(program: Command): void;
//# sourceMappingURL=store.d.ts.map