/**
 * Persistent REPL command history and reverse-i-search (^R).
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import * as readline from 'readline';
import { dim, cyan } from './output.js';
import { nearbytesConfigDir } from './paths.js';

export const REPL_HISTORY_MAX_ENTRIES = 10_000;
const MAX_ENTRIES = REPL_HISTORY_MAX_ENTRIES;
const FLUSH_DEBOUNCE_MS = 200;

export const DEFAULT_HISTORY_PATH = join(nearbytesConfigDir(), 'nbf-history');

export function historyFilePath(): string {
  return process.env['NEARBYTES_REPL_HISTORY']?.trim() || DEFAULT_HISTORY_PATH;
}

/** Chronological order (oldest first) — matches readline `history` option layout. */
export async function loadReplHistory(): Promise<string[]> {
  const filePath = historyFilePath();
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }

  if (out.length > MAX_ENTRIES) {
    return out.slice(-MAX_ENTRIES);
  }
  return out;
}

export async function saveReplHistory(lines: string[]): Promise<void> {
  const filePath = historyFilePath();
  const trimmed = trimHistory(lines);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const body = trimmed.length > 0 ? `${trimmed.join('\n')}\n` : '';
  await writeFile(filePath, body, 'utf-8');
}

function trimHistory(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }
  if (out.length > MAX_ENTRIES) {
    return out.slice(-MAX_ENTRIES);
  }
  return out;
}

export interface ReplHistorySession {
  readonly lines: string[];
  remember(line: string): void;
  attach(rl: readline.Interface): void;
  flush(): Promise<void>;
}

export function createReplHistorySession(initial: string[]): ReplHistorySession {
  const lines = trimHistory([...initial]);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFlush = (): void => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void saveReplHistory(lines);
    }, FLUSH_DEBOUNCE_MS);
  };

  return {
    lines,

    remember(line: string): void {
      if (line.length === 0) return;
      if (lines[lines.length - 1] === line) return;
      lines.push(line);
      if (lines.length > MAX_ENTRIES) {
        lines.splice(0, lines.length - MAX_ENTRIES);
      }
      scheduleFlush();
    },

    attach(rl: readline.Interface): void {
      const flushNow = (): void => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        void saveReplHistory(lines);
      };

      rl.on('close', flushNow);
      process.on('exit', flushNow);
    },

    async flush(): Promise<void> {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await saveReplHistory(lines);
    },
  };
}

// ---------------------------------------------------------------------------
// Reverse incremental search (^R / ^S)
// ---------------------------------------------------------------------------

type HistoryRl = readline.Interface & { history: string[]; line: string; cursor: number };

function newestFirst(lines: string[]): string[] {
  return [...lines].reverse();
}

export function attachReverseSearch(
  rl: readline.Interface,
  session: ReplHistorySession,
): { cancelSearch: () => boolean } {
  if (!process.stdin.isTTY) {
    return { cancelSearch: () => false };
  }

  readline.emitKeypressEvents(process.stdin, rl);

  let active = false;
  let query = '';
  let matches: string[] = [];
  let matchIndex = 0;
  let savedLine = '';
  let savedCursor = 0;

  const allHistory = (): string[] => {
    const merged = new Set<string>();
    for (const line of newestFirst((rl as HistoryRl).history ?? [])) {
      merged.add(line);
    }
    for (const line of newestFirst(session.lines)) {
      merged.add(line);
    }
    return [...merged];
  };

  const refreshMatches = (): void => {
    const pool = allHistory();
    if (query.length === 0) {
      matches = pool;
    } else {
      const q = query.toLowerCase();
      matches = pool.filter((line) => line.toLowerCase().includes(q));
    }
    if (matches.length === 0) {
      matchIndex = 0;
      return;
    }
    if (matchIndex >= matches.length) matchIndex = 0;
  };

  const renderSearchLine = (): void => {
    const hit = matches[matchIndex] ?? '';
    const status =
      matches.length === 0
        ? dim('(no match)')
        : dim(`(${matchIndex + 1}/${matches.length})`);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
      dim('(reverse-i-search)`') + cyan(query) + dim(`': `) + hit + ` ${status}`,
    );
    (rl as HistoryRl).line = hit;
    (rl as HistoryRl).cursor = hit.length;
  };

  const exitSearch = (restore: boolean): void => {
    active = false;
    query = '';
    matches = [];
    matchIndex = 0;
    rl.resume();
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const iface = rl as HistoryRl;
    if (restore) {
      iface.line = savedLine;
      iface.cursor = savedCursor;
    } else {
      iface.line = '';
      iface.cursor = 0;
    }
    rl.prompt(true);
  };

  const enterSearch = (): void => {
    rl.pause();
    active = true;
    savedLine = (rl as HistoryRl).line ?? '';
    savedCursor = (rl as HistoryRl).cursor ?? 0;
    query = '';
    refreshMatches();
    renderSearchLine();
  };

  process.stdin.on('keypress', (str: string | undefined, key: readline.Key) => {
    if (!key) return;

    if (!active) {
      if (key.ctrl && key.name === 'r') {
        enterSearch();
      }
      return;
    }

    if (key.ctrl && key.name === 'g') {
      exitSearch(true);
      return;
    }

    if (key.name === 'escape') {
      exitSearch(true);
      return;
    }

    if (key.ctrl && key.name === 'r') {
      if (matches.length > 0) {
        matchIndex = (matchIndex + 1) % matches.length;
        renderSearchLine();
      }
      return;
    }

    if (key.ctrl && key.name === 's') {
      if (matches.length > 0) {
        matchIndex = (matchIndex - 1 + matches.length) % matches.length;
        renderSearchLine();
      }
      return;
    }

    if (key.name === 'return') {
      const chosen = matches[matchIndex] ?? '';
      active = false;
      query = '';
      matches = [];
      matchIndex = 0;
      rl.resume();
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      const iface = rl as HistoryRl;
      iface.line = '';
      iface.cursor = 0;
      rl.prompt(true);
      process.nextTick(() => {
        rl.emit('line', chosen);
      });
      return;
    }

    if (key.name === 'backspace') {
      query = query.slice(0, -1);
      matchIndex = 0;
      refreshMatches();
      renderSearchLine();
      return;
    }

    if (str && !key.ctrl && !key.meta) {
      query += str;
      matchIndex = 0;
      refreshMatches();
      renderSearchLine();
    }
  });

  return {
    cancelSearch: () => {
      if (!active) return false;
      exitSearch(true);
      return true;
    },
  };
}
