import type { Hash } from 'nearbytes-crypto';
export type OutputFormat = 'json' | 'table' | 'plain';
/**
 * Formats event list as JSON
 */
export declare function formatEventsAsJson(events: Hash[]): string;
/**
 * Formats event list as a table
 */
export declare function formatEventsAsTable(events: Hash[]): string;
/**
 * Formats event list as plain text
 */
export declare function formatEventsAsPlain(events: Hash[]): string;
/**
 * Formats a single event hash
 */
export declare function formatEventHash(hash: Hash): string;
/**
 * Formats operation result
 */
export declare function formatResult(result: Record<string, unknown>): string;
//# sourceMappingURL=formatters.d.ts.map