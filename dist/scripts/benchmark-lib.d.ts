import { type Log } from 'nearbytes-log';
import { type NearbytesConfig } from 'nearbytes-skeleton';
import { type Context } from '../cli/context.js';
export type BenchRole = 'sender' | 'receiver';
export interface BenchMarker {
    readonly event: string;
    readonly t: number;
    readonly fields: Record<string, string | number | boolean>;
}
/** Wall-clock phases for paper tables (per process). */
export interface RunPhaseTiming {
    readonly bootMs: number;
    readonly profilePublishMs: number;
    readonly discoveryWaitMs: number;
    readonly friendSessionMs: number | null;
    readonly publishMs: number | null;
    readonly receiveMs: number | null;
    readonly graceMs: number;
    readonly totalWallMs: number;
}
export declare function markerOffsetMs(markers: readonly BenchMarker[], event: string, sinceMs: number): number | null;
export interface TrialManifestEntry {
    readonly name: string;
    readonly sizeBytes: number;
    readonly repeat: number;
    readonly publishWallMs: number;
    readonly publishCpuMs: number;
}
export declare function benchRoleFromEnv(): BenchRole;
export declare function hrtimeMs(): number;
export declare function makePayload(sizeBytes: number, seed: number): Buffer;
export declare function profilePublicKeyHex(secret: string): Promise<string>;
export declare function benchRepoRoot(): string;
export declare function defaultBenchWorkBase(): string;
export declare function benchWorkDir(role: BenchRole): string;
export declare function setupBenchConfig(role: BenchRole): Promise<{
    config: NearbytesConfig;
    configPath: string;
    profileSecret: string;
}>;
export declare function publishProfile(ctx: Context, displayName: string, bio: string): Promise<{
    publicKey: string;
    eventHash: string;
    publishMs: number;
}>;
export declare function readBenchMarkers(log: Log): Promise<BenchMarker[]>;
export declare function waitForBenchEvent(log: Log, event: string, sinceWallMs: number, timeoutMs: number): Promise<BenchMarker>;
export declare function readReceptionTail(dataDir: string, limit?: number): Promise<string[]>;
export declare function readActivityRaw(dataDir: string): Promise<string[]>;
export interface BenchActivityEvent {
    readonly bench: string;
    readonly t: number;
    readonly kind?: string;
    readonly bytes?: number;
    readonly name?: string;
}
export declare function parseBenchActivityLines(activityLog: readonly string[]): BenchActivityEvent[];
/** Goodput from first-to-last inbound-stored block between throughput phase markers. */
export declare function inboundStreamProgress(receiverLog: readonly string[], sinceWallMs: number, minBlockBytes: number): {
    readonly bytes: number;
    readonly chunks: number;
};
export declare function formatBenchBytes(n: number): string;
export declare function goodputFromInboundMarkers(receiverLog: readonly string[], nominalBytes: number, senderLog?: readonly string[], sinceWallMs?: number): {
    readonly goodputMbps: number;
    readonly durationMs: number;
    readonly bytesReceived: number;
} | null;
export declare function listBenchFilenames(ctx: Context): Promise<string[]>;
export declare function waitForBenchFilename(ctx: Context, filename: string, timeoutMs: number): Promise<{
    wallMs: number;
    cpuMs: number;
}>;
export declare function sleep(ms: number): Promise<void>;
/** Sleep with periodic heartbeats so long waits never look stuck. */
export declare function sleepWithProgress(role: string, label: string, ms: number, tickMs?: number): Promise<void>;
export declare function resetProgressClock(): void;
/** Line-buffered progress for long benchmark runs (visible in CI and remote SSH). */
export declare function benchProgress(role: string, message: string): void;
export declare function createBenchContext(config: NearbytesConfig): Promise<Context>;
//# sourceMappingURL=benchmark-lib.d.ts.map