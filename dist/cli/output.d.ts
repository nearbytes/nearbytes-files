/**
 * Terminal output helpers — ANSI colours and simple formatters.
 * Colour output is suppressed when stdout is not a TTY (pipes, CI, etc.).
 */
import type { FileMetadata } from '../fileEvents.js';
export declare const green: (s: string) => string;
export declare const yellow: (s: string) => string;
export declare const red: (s: string) => string;
export declare const cyan: (s: string) => string;
export declare const dim: (s: string) => string;
export declare const bold: (s: string) => string;
/**
 * Format a list of FileMetadata entries as a compact, human-readable table.
 *
 * Columns: Name · Size · Created · Content hash (first 16 hex chars + ellipsis)
 */
export declare function formatFileTable(files: readonly FileMetadata[]): string;
//# sourceMappingURL=output.d.ts.map