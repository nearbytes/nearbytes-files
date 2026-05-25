/**
 * Persistent REPL command history and reverse-i-search (^R).
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import * as readline from 'readline';
import { dim, cyan } from './output.js';
import { nearbytesConfigDir } from './paths.js';
export const REPL_HISTORY_MAX_ENTRIES = 10000;
const MAX_ENTRIES = REPL_HISTORY_MAX_ENTRIES;
const FLUSH_DEBOUNCE_MS = 200;
export const DEFAULT_HISTORY_PATH = join(nearbytesConfigDir(), 'nbf-history');
export function historyFilePath() {
    return process.env['NEARBYTES_REPL_HISTORY']?.trim() || DEFAULT_HISTORY_PATH;
}
/** Chronological order (oldest first) — matches readline `history` option layout. */
export async function loadReplHistory() {
    const filePath = historyFilePath();
    if (!existsSync(filePath))
        return [];
    let raw;
    try {
        raw = await readFile(filePath, 'utf-8');
    }
    catch {
        return [];
    }
    const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
    const out = [];
    for (const line of lines) {
        if (line.length === 0)
            continue;
        if (out[out.length - 1] === line)
            continue;
        out.push(line);
    }
    if (out.length > MAX_ENTRIES) {
        return out.slice(-MAX_ENTRIES);
    }
    return out;
}
export async function saveReplHistory(lines) {
    const filePath = historyFilePath();
    const trimmed = trimHistory(lines);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const body = trimmed.length > 0 ? `${trimmed.join('\n')}\n` : '';
    await writeFile(filePath, body, 'utf-8');
}
function trimHistory(lines) {
    const out = [];
    for (const line of lines) {
        if (line.length === 0)
            continue;
        if (out[out.length - 1] === line)
            continue;
        out.push(line);
    }
    if (out.length > MAX_ENTRIES) {
        return out.slice(-MAX_ENTRIES);
    }
    return out;
}
export function createReplHistorySession(initial) {
    const lines = trimHistory([...initial]);
    let flushTimer = null;
    const scheduleFlush = () => {
        if (flushTimer !== null)
            clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
            flushTimer = null;
            void saveReplHistory(lines);
        }, FLUSH_DEBOUNCE_MS);
    };
    return {
        lines,
        remember(line) {
            if (line.length === 0)
                return;
            if (lines[lines.length - 1] === line)
                return;
            lines.push(line);
            if (lines.length > MAX_ENTRIES) {
                lines.splice(0, lines.length - MAX_ENTRIES);
            }
            scheduleFlush();
        },
        attach(rl) {
            const flushNow = () => {
                if (flushTimer !== null) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
                void saveReplHistory(lines);
            };
            rl.on('close', flushNow);
            process.on('exit', flushNow);
        },
        async flush() {
            if (flushTimer !== null) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            await saveReplHistory(lines);
        },
    };
}
function newestFirst(lines) {
    return [...lines].reverse();
}
export function attachReverseSearch(rl, session) {
    if (!process.stdin.isTTY) {
        return { cancelSearch: () => false };
    }
    readline.emitKeypressEvents(process.stdin, rl);
    let active = false;
    let query = '';
    let matches = [];
    let matchIndex = 0;
    let savedLine = '';
    let savedCursor = 0;
    const allHistory = () => {
        const merged = new Set();
        for (const line of newestFirst(rl.history ?? [])) {
            merged.add(line);
        }
        for (const line of newestFirst(session.lines)) {
            merged.add(line);
        }
        return [...merged];
    };
    const refreshMatches = () => {
        const pool = allHistory();
        if (query.length === 0) {
            matches = pool;
        }
        else {
            const q = query.toLowerCase();
            matches = pool.filter((line) => line.toLowerCase().includes(q));
        }
        if (matches.length === 0) {
            matchIndex = 0;
            return;
        }
        if (matchIndex >= matches.length)
            matchIndex = 0;
    };
    const renderSearchLine = () => {
        const hit = matches[matchIndex] ?? '';
        const status = matches.length === 0
            ? dim('(no match)')
            : dim(`(${matchIndex + 1}/${matches.length})`);
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(dim('(reverse-i-search)`') + cyan(query) + dim(`': `) + hit + ` ${status}`);
        rl.line = hit;
        rl.cursor = hit.length;
    };
    const exitSearch = (restore) => {
        active = false;
        query = '';
        matches = [];
        matchIndex = 0;
        rl.resume();
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        const iface = rl;
        if (restore) {
            iface.line = savedLine;
            iface.cursor = savedCursor;
        }
        else {
            iface.line = '';
            iface.cursor = 0;
        }
        rl.prompt(true);
    };
    const enterSearch = () => {
        rl.pause();
        active = true;
        savedLine = rl.line ?? '';
        savedCursor = rl.cursor ?? 0;
        query = '';
        refreshMatches();
        renderSearchLine();
    };
    process.stdin.on('keypress', (str, key) => {
        if (!key)
            return;
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
            const iface = rl;
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
            if (!active)
                return false;
            exitSearch(true);
            return true;
        },
    };
}
//# sourceMappingURL=replHistory.js.map