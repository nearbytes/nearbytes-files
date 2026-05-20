import type { Command } from 'commander';
export interface FileRemoveOptions {
    name: string;
    secret: string;
    dataDir?: string;
    force?: boolean;
}
/**
 * File remove command handler
 * Removes a file from a volume
 */
export declare function handleFileRemove(options: FileRemoveOptions): Promise<void>;
/**
 * Registers the file remove command
 */
export declare function registerFileRemoveCommand(program: Command): void;
//# sourceMappingURL=file-remove.d.ts.map