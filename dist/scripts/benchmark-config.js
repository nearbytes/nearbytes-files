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
const FULL_PAYLOAD_SIZES = [
    4 * 1024,
    16 * 1024,
    64 * 1024,
    256 * 1024,
    1024 * 1024,
    4 * 1024 * 1024,
];
const PAPER_PAYLOAD_SIZES = [
    4 * 1024,
    64 * 1024,
    256 * 1024,
    1024 * 1024,
    4 * 1024 * 1024,
];
const QUICK_PAYLOAD_SIZES = [4 * 1024, 64 * 1024];
const LATENCY_ONLY_SIZES = [4 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
/** Empty string env (from `VAR= cmd`) must not become 0 via Number(''). */
export function benchEnvMs(key, fallback) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
export function benchEnvInt(key, fallback) {
    return Math.max(0, Math.floor(benchEnvMs(key, fallback)));
}
export function isQuickBench() {
    const v = process.env['NEARBYTES_BENCH_QUICK']?.toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
export function getBenchProfileMode() {
    const explicit = process.env['NEARBYTES_BENCH_PROFILE']?.toLowerCase();
    if (explicit === 'latency-only' || explicit === 'latency')
        return 'latency-only';
    if (explicit === 'paper')
        return 'paper';
    if (explicit === 'quick')
        return 'quick';
    if (explicit === 'full')
        return 'full';
    if (isQuickBench())
        return 'quick';
    return 'full';
}
export function getBenchProfile() {
    const mode = getBenchProfileMode();
    if (mode === 'latency-only') {
        return {
            mode,
            quick: true,
            latencyOnly: true,
            payloadSizes: LATENCY_ONLY_SIZES,
            latencyRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_REPEATS', 1),
            latencyWarmupRepeats: 0,
            throughputMode: 'none',
            throughputFileBytes: 0,
            throughputFileCount: 0,
            throughputStreamBytes: 0,
            discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 2000),
            interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 0),
            graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 1500),
            swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 12000),
            receiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS', 25000),
            receiverPollMs: benchEnvMs('NEARBYTES_BENCH_RECEIVER_POLL_MS', 50),
        };
    }
    if (mode === 'paper') {
        return {
            mode,
            quick: false,
            latencyOnly: false,
            payloadSizes: PAPER_PAYLOAD_SIZES,
            latencyRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_REPEATS', 10),
            latencyWarmupRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_WARMUP', 2),
            throughputMode: 'stream',
            throughputFileBytes: 0,
            throughputFileCount: 0,
            throughputStreamBytes: benchEnvInt('NEARBYTES_BENCH_STREAM_BYTES', 32 * 1024 * 1024),
            discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 3000),
            interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 50),
            graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 5000),
            swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 30000),
            receiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS', 600000),
            receiverPollMs: benchEnvMs('NEARBYTES_BENCH_RECEIVER_POLL_MS', 50),
        };
    }
    if (mode === 'quick') {
        return {
            mode,
            quick: true,
            latencyOnly: false,
            payloadSizes: QUICK_PAYLOAD_SIZES,
            latencyRepeats: 1,
            latencyWarmupRepeats: 0,
            throughputMode: 'batch',
            throughputFileBytes: 64 * 1024,
            throughputFileCount: 2,
            throughputStreamBytes: 0,
            discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 4000),
            interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 200),
            graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 4000),
            swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 15000),
            receiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS', 45000),
            receiverPollMs: 250,
        };
    }
    return {
        mode: 'full',
        quick: false,
        latencyOnly: false,
        payloadSizes: FULL_PAYLOAD_SIZES,
        receiverPollMs: 250,
        latencyRepeats: 5,
        latencyWarmupRepeats: 0,
        throughputMode: 'batch',
        throughputFileBytes: 1024 * 1024,
        throughputFileCount: 12,
        throughputStreamBytes: 0,
        discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 18000),
        interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 2500),
        graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 35000),
        swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 120000),
        receiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS', 900000),
    };
}
//# sourceMappingURL=benchmark-config.js.map