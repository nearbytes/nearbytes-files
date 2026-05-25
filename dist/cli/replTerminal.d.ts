/**
 * Portable REPL terminal helpers (Node readline + process signals).
 */
import * as readline from 'readline';
export type ReadlineWithLine = readline.Interface & {
    line: string;
    cursor: number;
};
/** Clears the current input line without injecting key sequences (avoids readline recursion). */
export declare function clearReadlineLine(rl: readline.Interface): void;
/**
 * Traps Ctrl+C so the REPL stays open: clears the line or cancels ^R search.
 * Registers on both `process` and the readline interface for Unix and Windows terminals.
 */
export declare function installReplInterruptHandlers(rl: readline.Interface, options?: {
    cancelSearch?: () => boolean;
}): void;
//# sourceMappingURL=replTerminal.d.ts.map