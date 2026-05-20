import type { Command } from 'commander';
export interface VolumeOpenOptions {
    secret: string;
    dataDir?: string;
}
/**
 * Volume open command handler
 * Opens a volume from a secret and displays volume information
 */
export declare function handleVolumeOpen(options: VolumeOpenOptions): Promise<void>;
/**
 * Registers the volume open command
 */
export declare function registerVolumeOpenCommand(program: Command): void;
//# sourceMappingURL=volume-open.d.ts.map