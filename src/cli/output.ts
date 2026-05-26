/**
 * Terminal output helpers — ANSI colours and simple formatters.
 * Colour output is suppressed when stdout is not a TTY (pipes, CI, etc.).
 */

import { EventType } from 'nearbytes-crypto';
import type { FileMetadata } from '../fileEvents.js';
import type { TimelineEvent } from '../fileService.js';

const isTTY = process.stdout.isTTY === true;

function wrap(code: number, reset: number) {
  return (s: string): string =>
    isTTY ? `\x1b[${code}m${s}\x1b[${reset}m` : s;
}

export const green  = wrap(32, 39);
export const yellow = wrap(33, 39);
export const red    = wrap(31, 39);
export const cyan   = wrap(36, 39);
export const dim    = wrap(2,  22);
export const bold   = wrap(1,  22);

/** Format a human-readable byte size string. */
function fmtSize(bytes: number): string {
  if (bytes === 0) return dim('—');
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Format a Unix-ms timestamp as a short local date-time string. */
function fmtDate(ms: number): string {
  if (ms === 0) return dim('—');
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/**
 * Format a list of FileMetadata entries as a compact, human-readable table.
 *
 * Columns: Path · Size · Created · Content hash (first 16 hex chars + ellipsis)
 */
export function formatFileTable(files: readonly FileMetadata[]): string {
  if (files.length === 0) return yellow('  (no files)');

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  const COL_SIZE = 10;
  const COL_DATE = 18;
  const col1 = Math.min(48, Math.max(8, ...sorted.map((f) => f.path.length)) + 2);

  const header =
    bold('Path'.padEnd(col1)) +
    bold('Size'.padEnd(COL_SIZE)) +
    bold('Created'.padEnd(COL_DATE)) +
    bold('Content hash');

  const sep = dim('─'.repeat(col1 + COL_SIZE + COL_DATE + 17));

  const body = sorted.map((f) => {
    const display =
      f.path.length > col1 - 2 ? f.path.slice(0, col1 - 5) + '...' : f.path;
    return (
      display.padEnd(col1) +
      fmtSize(f.size).padEnd(COL_SIZE) +
      fmtDate(f.createdAt).padEnd(COL_DATE) +
      f.blobHash.slice(0, 16) + '…'
    );
  });

  return [header, sep, ...body].join('\n');
}

function describeTimelineEvent(event: TimelineEvent): string {
  const shadowMark = event.shadow ? ' ⚠' : '';
  switch (event.type) {
    case EventType.CREATE_FILE:
      return `+ ${event.path}${shadowMark}`;
    case EventType.MKDIR:
      return `+ ${event.path}/${shadowMark}`;
    case EventType.DELETE:
      return `- ${event.path}${shadowMark}`;
    case EventType.RENAME:
      return `${event.path} → ${event.toPath ?? '?'}${shadowMark}`;
    case EventType.DECLARE_IDENTITY:
      return event.summary ?? event.displayName ?? 'identity';
    case EventType.CHAT_MESSAGE:
      return event.summary ?? event.body ?? 'chat';
    case EventType.APP_RECORD:
      return event.summary ?? event.protocol ?? 'record';
    default:
      return event.summary ?? String(event.type);
  }
}

function formatTimelineType(event: TimelineEvent): string {
  switch (event.type) {
    case EventType.CREATE_FILE:
      return 'create';
    case EventType.MKDIR:
      return 'mkdir';
    case EventType.DELETE:
      return 'delete';
    case EventType.RENAME:
      return 'rename';
    case EventType.DECLARE_IDENTITY:
      return 'identity';
    case EventType.CHAT_MESSAGE:
      return 'chat';
    case EventType.APP_RECORD:
      return 'record';
    default:
      return String(event.type).toLowerCase();
  }
}

/**
 * Chronological audit log of volume events (oldest first).
 */
export function formatTimelineTable(events: readonly TimelineEvent[]): string {
  if (events.length === 0) return yellow('  (no events)');

  const COL_SEQ = 5;
  const COL_WHEN = 18;
  const COL_TYPE = 8;
  const colWhat = Math.min(
    56,
    Math.max(
      12,
      ...events.map((e) => describeTimelineEvent(e).length),
    ),
  );

  const header =
    bold('#'.padEnd(COL_SEQ)) +
    bold('When'.padEnd(COL_WHEN)) +
    bold('Type'.padEnd(COL_TYPE)) +
    bold('What') +
    bold('  Event');

  const sep = dim('─'.repeat(COL_SEQ + COL_WHEN + COL_TYPE + colWhat + 20));

  const body = events.map((event, index) => {
    const what = describeTimelineEvent(event);
    const whatCol =
      what.length > colWhat ? `${what.slice(0, colWhat - 1)}…` : what;
    return (
      dim(String(index + 1).padStart(3)) +
      '  ' +
      fmtDate(event.timestamp).padEnd(COL_WHEN) +
      formatTimelineType(event).padEnd(COL_TYPE) +
      whatCol.padEnd(colWhat) +
      dim(event.eventHash.slice(0, 12) + '…')
    );
  });

  return [header, sep, ...body].join('\n');
}
