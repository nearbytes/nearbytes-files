import type { Command } from 'commander';
export interface ListOptions {
    secret: string;
    dataDir?: string;
    format?: string;
}
/**
 * List command handler
 */
export declare function handleList(options: ListOptions): Promise<void>;
/**
 * Registers the list command
 */
export declare function registerListCommand(program: Command): void;
//# sourceMappingURL=list.d.ts.map