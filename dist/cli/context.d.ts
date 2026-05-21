/**
 * CLI session context — shared mutable state for immediate and REPL mode.
 */
import { type FileService } from '../fileService.js';
import { type ReactiveVolume } from '../reactiveVolume.js';
import { type NearbytesSkeleton, type VolumeWatcher, type NearbytesConfig } from 'nearbytes-skeleton';
export interface Context {
    readonly config: NearbytesConfig;
    readonly skeleton: NearbytesSkeleton;
    readonly fileService: FileService;
    activeVolume: ReactiveVolume | null;
    readonly volumes: Map<string, ReactiveVolume>;
    readonly watchers: Map<string, VolumeWatcher>;
    destroy(): void;
}
/**
 * Creates a CLI context: filesystem log, file service, empty volume cache.
 */
export declare function createContext(config: NearbytesConfig): Promise<Context>;
export declare function openAndWatch(ctx: Context, secret: string, watch?: boolean): Promise<ReactiveVolume>;
export declare function refreshIfOpen(ctx: Context, secret: string): Promise<void>;
//# sourceMappingURL=context.d.ts.map