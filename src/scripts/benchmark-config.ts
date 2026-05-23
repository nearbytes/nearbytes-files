/**
 * Benchmark profiles. Set NEARBYTES_BENCH_QUICK=1 for a ≤30s smoke run (CI / sanity).
 * Default profile is research-grade (~3–4 min).
 */

export interface BenchProfile {
  readonly quick: boolean;
  readonly payloadSizes: readonly number[];
  readonly latencyRepeats: number;
  readonly throughputFileBytes: number;
  readonly throughputFileCount: number;
  readonly discoveryMs: number;
  readonly interTrialMs: number;
  readonly graceMs: number;
  readonly swarmTimeoutMs: number;
  readonly receiveTimeoutMs: number;
}

const FULL_PAYLOAD_SIZES = [
  4 * 1024,
  16 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;

const QUICK_PAYLOAD_SIZES = [4 * 1024, 64 * 1024] as const;

export function isQuickBench(): boolean {
  const v = process.env['NEARBYTES_BENCH_QUICK']?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function getBenchProfile(): BenchProfile {
  if (isQuickBench()) {
    return {
      quick: true,
      payloadSizes: QUICK_PAYLOAD_SIZES,
      latencyRepeats: 1,
      throughputFileBytes: 64 * 1024,
      throughputFileCount: 2,
      discoveryMs: Number(process.env['NEARBYTES_BENCH_DISCOVERY_MS'] ?? '4000'),
      interTrialMs: Number(process.env['NEARBYTES_BENCH_INTER_TRIAL_MS'] ?? '200'),
      graceMs: Number(process.env['NEARBYTES_BENCH_GRACE_MS'] ?? '4000'),
      swarmTimeoutMs: Number(process.env['NEARBYTES_BENCH_SWARM_TIMEOUT_MS'] ?? '15000'),
      receiveTimeoutMs: Number(process.env['NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS'] ?? '45000'),
    };
  }
  return {
    quick: false,
    payloadSizes: FULL_PAYLOAD_SIZES,
    latencyRepeats: 5,
    throughputFileBytes: 1024 * 1024,
    throughputFileCount: 12,
    discoveryMs: Number(process.env['NEARBYTES_BENCH_DISCOVERY_MS'] ?? '18000'),
    interTrialMs: Number(process.env['NEARBYTES_BENCH_INTER_TRIAL_MS'] ?? '2500'),
    graceMs: Number(process.env['NEARBYTES_BENCH_GRACE_MS'] ?? '35000'),
    swarmTimeoutMs: Number(process.env['NEARBYTES_BENCH_SWARM_TIMEOUT_MS'] ?? '120000'),
    receiveTimeoutMs: Number(process.env['NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS'] ?? '900000'),
  };
}
