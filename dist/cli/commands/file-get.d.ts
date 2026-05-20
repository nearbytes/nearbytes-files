import type { Command } from 'commander';
export interface FileGetOptions {
    name: string;
    secret: string;
    output: string;
    dataDir?: string;
}
/**
 * File get command handler
 * Retrieves a file from a volume by name
 */
export declare function handleFileGet(options: FileGetOptions): Promise<void>;
/**
 * Registers the file get command
 */
export declare function registerFileGetCommand(program: Command): void;
//# sourceMappingURL=file-get.d.ts.map