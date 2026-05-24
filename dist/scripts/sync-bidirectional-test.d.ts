/**
 * Bidirectional friend-sync integration test.
 *
 *   NEARBYTES_TEST_ROLE=alice|bob  node dist/scripts/sync-bidirectional-test.js
 *
 * Fast local defaults (~10s wall with e2e runner): 1 MiB payload, 50ms poll, 8s receive timeout.
 */
/** Public test identities — do not use in production. */
export declare const TEST_CREDENTIALS: {
    readonly profileAlice: "nearbytes-alice:beautiful-document";
    readonly profileBob: "nearbytes-bob:beautiful-document";
    readonly volume: "nearbytes-test:beautiful-document";
    readonly fileAlice: "the-nearbytes-ledger-alice.bin";
    readonly fileBob: "the-nearbytes-ledger-bob.bin";
};
type Role = 'alice' | 'bob';
export declare function makeTestPayload(sizeBytes: number, role: Role): Buffer;
export {};
//# sourceMappingURL=sync-bidirectional-test.d.ts.map