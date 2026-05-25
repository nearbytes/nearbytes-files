/**
 * Persistent REPL command history and reverse-i-search (^R).
 */
import * as readline from 'readline';
export declare const REPL_HISTORY_MAX_ENTRIES = 10000;
export declare const DEFAULT_HISTORY_PATH: string;
export declare function historyFilePath(): string;
/** Chronological order (oldest first) — matches readline `history` option layout. */
export declare function loadReplHistory(): Promise<string[]>;
export declare function saveReplHistory(lines: string[]): Promise<void>;
export interface ReplHistorySession {
    readonly lines: string[];
    remember(line: string): void;
    attach(rl: readline.Interface): void;
    flush(): Promise<void>;
}
export declare function createReplHistorySession(initial: string[]): ReplHistorySession;
export declare function attachReverseSearch(rl: readline.Interface, session: ReplHistorySession): {
    cancelSearch: () => boolean;
};
//# sourceMappingURL=replHistory.d.ts.map