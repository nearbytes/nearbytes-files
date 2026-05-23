import { type NearbytesConfig } from 'nearbytes-skeleton';
import type { Context } from './context.js';
export declare function normalizeFriendPublicKey(raw: string): string;
export declare function matchFriendKey(friends: readonly string[], prefixOrKey: string): string | null;
export declare function persistConfig(ctx: Context, next: NearbytesConfig): Promise<void>;
//# sourceMappingURL=configStore.d.ts.map