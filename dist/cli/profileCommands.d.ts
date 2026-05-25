/**
 * Profile management commands.
 *
 * A *profile* is the cryptographic sync keypair: a secp256k1 secret, a
 * derived public key, and a sync topic. A node may serve $K \ge 0$ profiles
 * in parallel (`requirements/sync-protocol-v1.md` SYNC-00). The user names
 * each profile locally (`alice`, `work`, …); one of them is the **active**
 * profile, used to sign `profile publish` and as the follower identity for
 * outbound dials.
 *
 * Identity records (`nb.identity.record.v1`) are a separate, social-layer
 * concept — they bind a display name to a profile. `profile publish` signs
 * one with the active (or `--as`-selected) profile.
 */
import type { Context } from './context.js';
export declare function cmdProfileAdd(ctx: Context, name: string, secret: string): Promise<void>;
export declare function cmdProfileUse(ctx: Context, name: string): Promise<void>;
export declare function cmdProfileList(ctx: Context): Promise<void>;
export declare function cmdProfileShow(ctx: Context, name?: string): Promise<void>;
export declare function cmdProfilePublish(ctx: Context, displayName: string, bio?: string, asName?: string): Promise<void>;
export declare function cmdProfileRemove(ctx: Context, name: string): Promise<void>;
//# sourceMappingURL=profileCommands.d.ts.map