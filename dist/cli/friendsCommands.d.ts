import type { Context } from './context.js';
export declare function cmdFriendList(ctx: Context): Promise<void>;
export declare function cmdFriendAdd(ctx: Context, publicKey: string): Promise<void>;
export declare function cmdFriendRemove(ctx: Context, prefixOrKey: string): Promise<void>;
export declare function cmdFriendShow(ctx: Context, prefixOrKey: string): Promise<void>;
//# sourceMappingURL=friendsCommands.d.ts.map