import type { Command } from 'commander';
export interface FileAddOptions {
    path: string;
    secret: string;
    name?: string;
    dataDir?: string;
}
/**
 * File add command handler
 * Adds a file to a volume
 */
export declare function handleFileAdd(options: FileAddOptions): Promise<void>;
/**
 * Registers the file add command
 */
export declare function registerFileAddCommand(program: Command): void;
//# sourceMappingURL=file-add.d.ts.map