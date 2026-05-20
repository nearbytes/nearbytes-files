import { createCryptoOperations } from 'nearbytes-crypto';
import { setupChannel } from 'nearbytes-files';
import { green, red } from '../output/colors.js';
import { validateSecret } from '../validation.js';
import { getDefaultStorageDir } from '../storagePath.js';
/**
 * Setup command handler
 */
export async function handleSetup(options) {
    try {
        // Validate secret
        const secret = validateSecret(options.secret);
        // Initialize crypto
        const crypto = createCryptoOperations();
        // Setup channel (derives keys)
        const result = await setupChannel(secret, crypto);
        // Output result
        console.log(green('✓ Channel initialized successfully'));
        console.log(`Public Key: ${Buffer.from(result.publicKey).toString('hex')}`);
    }
    catch (error) {
        console.error(red(`✗ Error: ${error instanceof Error ? error.message : 'unknown error'}`));
        process.exit(1);
    }
}
/**
 * Registers the setup command
 */
export function registerSetupCommand(program) {
    program
        .command('setup')
        .description('Initialize a new channel')
        .requiredOption('-s, --secret <secret>', 'Channel secret (e.g., "channelname:password")')
        .option('-d, --data-dir <path>', 'Storage directory (default: ~/nearbytes/local)', getDefaultStorageDir())
        .action(handleSetup);
}
//# sourceMappingURL=setup.js.map