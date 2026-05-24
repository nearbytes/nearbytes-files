import type { Log } from 'nearbytes-log';
export interface BenchMarker {
    readonly event: string;
    readonly t: number;
    readonly fields: Record<string, string | number | boolean>;
}
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
export declare function readBenchMarkers(log: Log): Promise<BenchMarker[]>;
//# sourceMappingURL=test-markers.d.ts.map