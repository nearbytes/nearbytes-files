import { writeFile } from 'fs/promises';
import { createCryptoOperations } from 'nearbytes-crypto';
import { FilesystemStorageBackend } from 'nearbytes-storage';
import { createLog } from 'nearbytes-log';
import { retrieveData } from 'nearbytes-files';
import { green, red } from '../output/colors.js';
import { validateSecret, validateHash, validateOutputPath } from '../validation.js';
import { getDefaultStorageDir } from '../storagePath.js';
/**
 * Retrieve command handler
 */
export async function handleRetrieve(options) {
    try {
        // Validate inputs
        const secret = validateSecret(options.secret);
        const eventHash = validateHash(options.event);
        await validateOutputPath(options.output);
        // Initialize crypto and storage
        const crypto = createCryptoOperations();
        const storage = new FilesystemStorageBackend(options.dataDir ?? getDefaultStorageDir());
        const channelStorage = createLog(storage, (pubKey) => Array.from(pubKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''));
        // Retrieve data
        const data = await retrieveData(eventHash, secret, crypto, channelStorage);
        // Write to output file
        await writeFile(options.output, data);
        console.log(green(`✓ Data retrieved successfully to ${options.output}`));
    }
    catch (error) {
        console.error(red(`✗ Error: ${error instanceof Error ? error.message : 'unknown error'}`));
        process.exit(1);
    }
}
/**
 * Registers the retrieve command
 */
export function registerRetrieveCommand(program) {
    program
        .command('retrieve')
        .description('Retrieve data from a channel')
        .requiredOption('-e, --event <hash>', 'Event hash')
        .requiredOption('-s, --secret <secret>', 'Channel secret')
        .requiredOption('-o, --output <path>', 'Output file path')
        .option('-d, --data-dir <path>', 'Storage directory (default: ~/nearbytes/local)', getDefaultStorageDir())
        .action(handleRetrieve);
}
//# sourceMappingURL=retrieve.js.map