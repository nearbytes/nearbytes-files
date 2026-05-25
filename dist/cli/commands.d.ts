/**
 * Command handlers — pure async functions, framework-free.
 *
 * Each handler receives a Context and whatever arguments it needs, then writes
 * human-readable output to stdout.  The same functions are called from:
 *   - Commander.js (immediate mode): program.action(() => handler(ctx, ...))
 *   - REPL (interpreter mode): tokenised input dispatched here
 *
 * All file I/O goes through ctx.fileService (nearbytes-files FileService).
 * ctx.skeleton is used only for crypto (key derivation) and the log.
 *
 * Errors are thrown as plain Error objects; callers decide whether to exit the
 * process (immediate mode) or print the message and continue (REPL).
 */
import { red } from './output.js';
import { type Context } from './context.js';
/**
 * Derives the public key for a secret without reading or writing any events.
 */
export declare function cmdSetup(ctx: Context, secret: string): Promise<void>;
/** Open a volume, materialise its state, and print a summary. */
export declare function cmdVolumeOpen(ctx: Context, secret: string, watch?: boolean): Promise<void>;
/** Print info for the currently-active volume. */
export declare function cmdVolumeInfo(ctx: Context): Promise<void>;
/** Set the active volume by public-key hex prefix or secret. */
export declare function cmdUse(ctx: Context, keyPrefixOrSecret: string): Promise<void>;
export declare function cmdFileAdd(ctx: Context, filePath: string, secret: string, name?: string): Promise<void>;
export declare function cmdFileList(ctx: Context, secret: string): Promise<void>;
export declare function cmdFileGet(ctx: Context, filename: string, secret: string, outputPath: string): Promise<void>;
export declare function cmdFileRemove(ctx: Context, filename: string, secret: string): Promise<void>;
/** Show the volume event timeline (audit log of creates, deletes, renames, …). */
export declare function cmdTimeline(ctx: Context, secret: string): Promise<void>;
export declare function cmdRefresh(ctx: Context): Promise<void>;
export declare function cmdVolumes(ctx: Context): Promise<void>;
export { cmdFriendList, cmdFriendAdd, cmdFriendRemove, cmdFriendShow } from './friendsCommands.js';
export { cmdProfileAdd, cmdProfileUse, cmdProfileList, cmdProfileShow, cmdProfilePublish, cmdProfileRemove, } from './profileCommands.js';
export declare function cmdHelp(): void;
export { red };
//# sourceMappingURL=commands.d.ts.map