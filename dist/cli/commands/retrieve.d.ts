import type { Command } from 'commander';
export interface RetrieveOptions {
    event: string;
    secret: string;
    output: string;
    dataDir?: string;
}
/**
 * Retrieve command handler
 */
export declare function handleRetrieve(options: RetrieveOptions): Promise<void>;
/**
 * Registers the retrieve command
 */
export declare function registerRetrieveCommand(program: Command): void;
//# sourceMappingURL=retrieve.d.ts.map