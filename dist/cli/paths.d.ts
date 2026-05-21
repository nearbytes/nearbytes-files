/** User home directory (portable: macOS, Linux, Windows). */
export declare function userHomeDir(): string;
/** `~/.nearbytes` config/history root. */
export declare function nearbytesConfigDir(): string;
/**
 * Expands leading `~` / `~\` and resolves to an absolute path for filesystem I/O.
 */
export declare function expandUserPath(input: string): string;
/** Expands `~` in a partial path for tab-completion (may stay relative). */
export declare function expandTildeInPartial(partial: string): string;
export declare function pathHasSeparator(p: string): boolean;
export declare function pathEndsWithSeparator(p: string): boolean;
/** Directory separator implied by user input, or platform default. */
export declare function preferredSep(partial: string): string;
//# sourceMappingURL=paths.d.ts.map