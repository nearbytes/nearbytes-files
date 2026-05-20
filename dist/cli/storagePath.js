import path from 'path';
import os from 'os';
const DEFAULT_STORAGE_DIR = path.join(os.homedir(), 'nearbytes', 'local');
/**
 * Returns the primary local storage root. Overridable via NEARBYTES_STORAGE_DIR.
 */
export function getDefaultStorageDir() {
    return process.env.NEARBYTES_STORAGE_DIR ?? DEFAULT_STORAGE_DIR;
}
//# sourceMappingURL=storagePath.js.map