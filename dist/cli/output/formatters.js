/**
 * Formats event list as JSON
 */
export function formatEventsAsJson(events) {
    return JSON.stringify({
        events: events.map((hash) => ({ hash })),
        count: events.length,
    }, null, 2);
}
/**
 * Formats event list as a table
 */
export function formatEventsAsTable(events) {
    if (events.length === 0) {
        return 'No events found.';
    }
    const header = 'Event Hash';
    const separator = '-'.repeat(64);
    const rows = events.map((hash) => hash);
    return [header, separator, ...rows].join('\n');
}
/**
 * Formats event list as plain text
 */
export function formatEventsAsPlain(events) {
    return events.join('\n');
}
/**
 * Formats a single event hash
 */
export function formatEventHash(hash) {
    return hash;
}
/**
 * Formats operation result
 */
export function formatResult(result) {
    return JSON.stringify(result, null, 2);
}
//# sourceMappingURL=formatters.js.map