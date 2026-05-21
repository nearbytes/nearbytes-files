/**
 * Interactive REPL (Read-Eval-Print Loop) for the Nearbytes file CLI.
 *
 * Launched with `nbf repl [--data-dir <d>]`.
 * Maintains a persistent Context across commands — opened volumes stay open.
 *
 * Command grammar is deliberately minimal:
 *   <verb> [<noun>] [<args>...]   — positional; flags are for one-shot mode only
 *
 * Examples:
 *   setup myvolume:password
 *   volume open myvolume:password
 *   file add /path/to/file.txt readme.txt
 *   file list
 *   file get readme.txt /tmp/out.txt
 *   file rm readme.txt
 */
import type { Context } from './context.js';
export declare function startRepl(ctx: Context): Promise<void>;
//# sourceMappingURL=repl.d.ts.map