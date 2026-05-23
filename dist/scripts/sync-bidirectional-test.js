/**
 * Bidirectional friend sync integration test.
 *
 * Well-known NearBytes-themed credentials (test only). Two roles share one volume
 * secret; each peer publishes a distinct file and waits for the other's file.
 *
 *   NEARBYTES_TEST_ROLE=alice|bob  node dist/scripts/sync-bidirectional-test.js
 *
 * Optional: NEARBYTES_CONFIG, NEARBYTES_STORAGE_DIR (set by runner), NEARBYTES_TEST_TIMEOUT_MS (default 180000).
 */
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createCryptoOperations, createSecret, bytesToHex } from 'nearbytes-crypto';
import { writeConfig } from 'nearbytes-skeleton';
import { createContext, openAndWatch } from '../cli/context.js';
/** Public test identities — do not use in production. */
export const TEST_CREDENTIALS = {
    profileAlice: 'nearbytes-alice:beautiful-document',
    profileBob: 'nearbytes-bob:beautiful-document',
    volume: 'nearbytes-test:beautiful-document',
    fileAlice: 'the-nearbytes-ledger-alice.txt',
    fileBob: 'the-nearbytes-ledger-bob.txt',
    payloadAlice: 'NearBytes — Alice wrote this line.\n',
    payloadBob: 'NearBytes — Bob wrote this line.\n',
};
function roleFromEnv() {
    const raw = process.env['NEARBYTES_TEST_ROLE']?.toLowerCase();
    if (raw === 'alice' || raw === 'bob')
        return raw;
    throw new Error('Set NEARBYTES_TEST_ROLE=alice or NEARBYTES_TEST_ROLE=bob');
}
async function profilePublicKeyHex(secret) {
    const crypto = createCryptoOperations();
    const kp = await crypto.deriveKeys(createSecret(secret));
    return bytesToHex(kp.publicKey);
}
function testDirs(role) {
    const base = process.env['NEARBYTES_TEST_BASE'] ??
        path.join(os.tmpdir(), 'nearbytes-sync-bidirectional-test');
    const workDir = path.join(base, role);
    return {
        workDir,
        configPath: path.join(workDir, 'config.json'),
        dataDir: path.join(workDir, 'data'),
    };
}
async function setupConfig(role) {
    const { configPath, dataDir, workDir } = testDirs(role);
    const alicePk = await profilePublicKeyHex(TEST_CREDENTIALS.profileAlice);
    const bobPk = await profilePublicKeyHex(TEST_CREDENTIALS.profileBob);
    if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
    }
    await mkdir(workDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const profileSecret = role === 'alice' ? TEST_CREDENTIALS.profileAlice : TEST_CREDENTIALS.profileBob;
    const friends = role === 'alice' ? [bobPk] : [alicePk];
    const config = {
        dataDir,
        volumes: [],
        friends,
        profileSecret,
    };
    process.env['NEARBYTES_CONFIG'] = configPath;
    process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
    await writeConfig(config, configPath);
    return { config, configPath };
}
async function listFilenames(ctx) {
    const files = await ctx.fileService.listFiles(TEST_CREDENTIALS.volume);
    return files.map((f) => f.filename);
}
async function waitForPeerFile(ctx, peerFile, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await openAndWatch(ctx, TEST_CREDENTIALS.volume, true);
        const names = await listFilenames(ctx);
        if (names.includes(peerFile))
            return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    const final = await listFilenames(ctx);
    throw new Error(`Timed out waiting for peer file "${peerFile}" (have: ${final.join(', ') || '(none)'})`);
}
async function main() {
    const role = roleFromEnv();
    const timeoutMs = Number(process.env['NEARBYTES_TEST_TIMEOUT_MS'] ?? '180000');
    const peerFile = role === 'alice' ? TEST_CREDENTIALS.fileBob : TEST_CREDENTIALS.fileAlice;
    const ownFile = role === 'alice' ? TEST_CREDENTIALS.fileAlice : TEST_CREDENTIALS.fileBob;
    const ownPayload = role === 'alice' ? TEST_CREDENTIALS.payloadAlice : TEST_CREDENTIALS.payloadBob;
    const { config, configPath } = await setupConfig(role);
    const alicePk = await profilePublicKeyHex(TEST_CREDENTIALS.profileAlice);
    const bobPk = await profilePublicKeyHex(TEST_CREDENTIALS.profileBob);
    console.log(`[${role}] config: ${configPath}`);
    console.log(`[${role}] data:   ${config.dataDir}`);
    console.log(`[${role}] alice profile pk: ${alicePk.slice(0, 16)}…`);
    console.log(`[${role}] bob profile pk:   ${bobPk.slice(0, 16)}…`);
    const ctx = await createContext(config);
    try {
        const discoveryMs = Number(process.env['NEARBYTES_TEST_DISCOVERY_MS'] ?? '10000');
        console.log(`[${role}] waiting ${discoveryMs}ms for peer discovery…`);
        await new Promise((r) => setTimeout(r, discoveryMs));
        const localPath = path.join(testDirs(role).workDir, ownFile);
        await writeFile(localPath, ownPayload, 'utf-8');
        await openAndWatch(ctx, TEST_CREDENTIALS.volume, true);
        const data = Buffer.from(ownPayload, 'utf-8');
        await ctx.fileService.addFile(TEST_CREDENTIALS.volume, ownFile, data);
        console.log(`[${role}] published ${ownFile}`);
        console.log(`[${role}] waiting for ${peerFile} (timeout ${timeoutMs}ms)…`);
        await waitForPeerFile(ctx, peerFile, timeoutMs);
        const names = await listFilenames(ctx);
        console.log(`[${role}] ✓ bidirectional sync OK — files: ${names.join(', ')}`);
        process.exitCode = 0;
    }
    finally {
        try {
            await ctx.destroy();
        }
        catch {
            /* transport teardown may reset hyperswarm sockets */
        }
    }
}
const ignoreTransportReset = (err) => String(err).includes('ECONNRESET') || String(err).includes('connection reset');
process.on('uncaughtException', (err) => {
    if (ignoreTransportReset(err))
        return;
    console.error(err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    if (ignoreTransportReset(err))
        return;
    console.error(err);
    process.exit(1);
});
main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
    console.error(String(err));
    process.exit(1);
});
//# sourceMappingURL=sync-bidirectional-test.js.map