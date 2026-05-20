import type { Command } from 'commander';
export interface SetupOptions {
    secret: string;
    dataDir?: string;
}
/**
 * Setup command handler
 */
export declare function handleSetup(options: SetupOptions): Promise<void>;
/**
 * Registers the setup command
 */
export declare function registerSetupCommand(program: Command): void;
//# sourceMappingURL=setup.d.ts.map