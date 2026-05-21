/**
 * Context-aware tab completion for the nbf REPL.
 */
import type { Context } from './context.js';
export declare function parseCompletionInput(line: string): {
    prefix: string[];
    partial: string;
};
export declare function createReplCompleter(ctx: Context): (line: string) => [string[], string];
//# sourceMappingURL=replCompleter.d.ts.map