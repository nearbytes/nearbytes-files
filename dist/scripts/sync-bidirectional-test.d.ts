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
/** Public test identities — do not use in production. */
export declare const TEST_CREDENTIALS: {
    readonly profileAlice: "nearbytes-alice:beautiful-document";
    readonly profileBob: "nearbytes-bob:beautiful-document";
    readonly volume: "nearbytes-test:beautiful-document";
    readonly fileAlice: "the-nearbytes-ledger-alice.txt";
    readonly fileBob: "the-nearbytes-ledger-bob.txt";
    readonly payloadAlice: "NearBytes — Alice wrote this line.\n";
    readonly payloadBob: "NearBytes — Bob wrote this line.\n";
};
//# sourceMappingURL=sync-bidirectional-test.d.ts.map