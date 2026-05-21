/**
 * Terminal output helpers — ANSI colours and simple formatters.
 * Colour output is suppressed when stdout is not a TTY (pipes, CI, etc.).
 */
const isTTY = process.stdout.isTTY === true;
function wrap(code, reset) {
    return (s) => isTTY ? `\x1b[${code}m${s}\x1b[${reset}m` : s;
}
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const red = wrap(31, 39);
export const cyan = wrap(36, 39);
export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
/** Format a human-readable byte size string. */
function fmtSize(bytes) {
    if (bytes === 0)
        return dim('—');
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1048576)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}
/** Format a Unix-ms timestamp as a short local date-time string. */
function fmtDate(ms) {
    if (ms === 0)
        return dim('—');
    return new Date(ms).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
    });
}
/**
 * Format a list of FileMetadata entries as a compact, human-readable table.
 *
 * Columns: Name · Size · Created · Content hash (first 16 hex chars + ellipsis)
 */
export function formatFileTable(files) {
    if (files.length === 0)
        return yellow('  (no files)');
    const sorted = [...files].sort((a, b) => a.filename.localeCompare(b.filename));
    const COL_SIZE = 10;
    const COL_DATE = 18;
    const col1 = Math.min(48, Math.max(8, ...sorted.map((f) => f.filename.length)) + 2);
    const header = bold('Name'.padEnd(col1)) +
        bold('Size'.padEnd(COL_SIZE)) +
        bold('Created'.padEnd(COL_DATE)) +
        bold('Content hash');
    const sep = dim('─'.repeat(col1 + COL_SIZE + COL_DATE + 17));
    const body = sorted.map((f) => {
        const name = f.filename.length > col1 - 2
            ? f.filename.slice(0, col1 - 5) + '...'
            : f.filename;
        return (name.padEnd(col1) +
            fmtSize(f.size).padEnd(COL_SIZE) +
            fmtDate(f.createdAt).padEnd(COL_DATE) +
            f.blobHash.slice(0, 16) + '…');
    });
    return [header, sep, ...body].join('\n');
}
//# sourceMappingURL=output.js.map