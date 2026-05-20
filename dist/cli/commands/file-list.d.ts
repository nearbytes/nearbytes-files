import type { Command } from 'commander';
export interface FileListOptions {
    secret: string;
    dataDir?: string;
    format?: string;
}
/**
 * File list command handler
 * Lists all files in a volume
 */
export declare function handleFileList(options: FileListOptions): Promise<void>;
/**
 * Registers the file list command
 */
export declare function registerFileListCommand(program: Command): void;
//# sourceMappingURL=file-list.d.ts.map