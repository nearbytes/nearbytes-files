/**
 * Benchmark profiles.
 *
 * | Profile       | Use case                                      |
 * |---------------|-----------------------------------------------|
 * | quick         | CI smoke (≤30s)                               |
 * | latency-only  | Fast latency sweep, no throughput             |
 * | full          | Legacy research run (~3–4 min)                |
 * | paper         | Conference-grade: warmup discard, n≥10, stream  |
 *
 * Set NEARBYTES_BENCH_PROFILE=paper for publication numbers.
 */
export type BenchProfileMode = 'full' | 'quick' | 'latency-only' | 'paper';
export type ThroughputMode = 'batch' | 'stream' | 'none';
export interface BenchProfile {
    readonly mode: BenchProfileMode;
    readonly quick: boolean;
    readonly latencyOnly: boolean;
    readonly payloadSizes: readonly number[];
    readonly receiverPollMs: number;
    readonly latencyRepeats: number;
    /** Discarded warmup payloads per size (not in trial manifest). */
    readonly latencyWarmupRepeats: number;
    readonly throughputMode: ThroughputMode;
    readonly throughputFileBytes: number;
    readonly throughputFileCount: number;
    /** Single-stream sustained transfer (paper profile). */
    readonly throughputStreamBytes: number;
    readonly discoveryMs: number;
    readonly interTrialMs: number;
    readonly graceMs: number;
    readonly swarmTimeoutMs: number;
    /** Max wait for latency payloads (receiver). */
    readonly latencyReceiveTimeoutMs: number;
    /** Max wait for throughput stream/batch after latency (receiver). */
    readonly throughputReceiveTimeoutMs: number;
}
/** Empty string env (from `VAR= cmd`) must not become 0 via Number(''). */
export declare function benchEnvMs(key: string, fallback: number): number;
export declare function benchEnvInt(key: string, fallback: number): number;
export declare function isQuickBench(): boolean;
export declare function getBenchProfileMode(): BenchProfileMode;
export declare function getBenchProfile(): BenchProfile;
//# sourceMappingURL=benchmark-config.d.ts.map