/**
 * Context-aware tab completion for the nbf REPL.
 */
import { readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { expandTildeInPartial, pathEndsWithSeparator, pathHasSeparator, preferredSep, userHomeDir, } from './paths.js';
// ---------------------------------------------------------------------------
// Command vocabulary
// ---------------------------------------------------------------------------
const TOP_LEVEL = [
    'setup',
    'volume',
    'volumes',
    'use',
    'info',
    'timeline',
    'refresh',
    'file',
    'help',
    'exit',
    'quit',
];
const VOLUME_SUB = ['open', 'info', 'show'];
const FILE_SUB = ['add', 'list', 'ls', 'get', 'rm', 'remove', 'del', 'delete'];
const SECRET_FLAGS = ['-s', '--secret'];
const FILE_SUB_ALIASES = {
    ls: 'list',
    remove: 'rm',
    del: 'rm',
    delete: 'rm',
};
// ---------------------------------------------------------------------------
// Line parsing (aligned with repl tokenise)
// ---------------------------------------------------------------------------
export function parseCompletionInput(line) {
    const endsWithSpace = /[ \t]$/.test(line);
    if (endsWithSpace) {
        return { prefix: tokeniseForCompletion(line), partial: '' };
    }
    const tokens = tokeniseForCompletion(line);
    if (tokens.length === 0) {
        return { prefix: [], partial: '' };
    }
    return {
        prefix: tokens.slice(0, -1),
        partial: tokens[tokens.length - 1],
    };
}
function tokeniseForCompletion(line) {
    const tokens = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of line.trimEnd()) {
        if (inQuote) {
            if (ch === quoteChar)
                inQuote = false;
            else
                current += ch;
        }
        else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        }
        else if (ch === ' ' || ch === '\t') {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current.length > 0)
        tokens.push(current);
    return tokens;
}
function filterByPartial(candidates, partial) {
    if (partial.length === 0)
        return candidates;
    const lower = partial.toLowerCase();
    const hits = candidates.filter((c) => c.toLowerCase().startsWith(lower));
    return hits.length > 0 ? hits : candidates;
}
function quoteIfNeeded(value) {
    if (/[\s'"\\]/.test(value)) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}
// ---------------------------------------------------------------------------
// Dynamic candidates from session
// ---------------------------------------------------------------------------
function knownSecrets(ctx) {
    const out = new Set();
    for (const v of ctx.config.volumes)
        out.add(v.secret);
    for (const rv of ctx.volumes.values()) {
        out.add(rv.volume.secret);
    }
    return [...out].map(quoteIfNeeded);
}
function volumeKeyPrefixes(ctx) {
    return [...ctx.volumes.keys()].map((hex) => hex.slice(0, 16));
}
function activeFileNames(ctx) {
    if (!ctx.activeVolume)
        return [];
    const state = ctx.activeVolume.get();
    return [...state.files.keys()].map(quoteIfNeeded);
}
function completePaths(partial) {
    const home = userHomeDir();
    const tilde = partial.startsWith('~');
    const expanded = expandTildeInPartial(partial);
    const sep = preferredSep(partial);
    const dirSuffix = sep;
    let searchDir;
    let base;
    if (expanded === '' || expanded === '.') {
        searchDir = process.cwd();
        base = '';
    }
    else if (pathEndsWithSeparator(expanded)) {
        searchDir = resolve(expanded);
        base = '';
    }
    else if (pathHasSeparator(expanded)) {
        searchDir = resolve(dirname(expanded));
        const parts = expanded.split(/[/\\]/);
        base = parts[parts.length - 1] ?? '';
    }
    else {
        searchDir = process.cwd();
        base = expanded;
    }
    try {
        const entries = readdirSync(searchDir, { withFileTypes: true });
        const out = [];
        for (const ent of entries) {
            if (base.length > 0 && !ent.name.startsWith(base))
                continue;
            const full = join(searchDir, ent.name);
            const suffix = ent.isDirectory() ? dirSuffix : '';
            let display;
            if (tilde && full.startsWith(home)) {
                const tail = full.slice(home.length).replace(/\\/g, '/');
                display = `~${tail}${suffix}`;
            }
            else if (!pathHasSeparator(expanded) && searchDir === process.cwd()) {
                display = ent.name + suffix;
            }
            else if (pathEndsWithSeparator(expanded)) {
                display = partial + ent.name + suffix;
            }
            else {
                const parent = pathHasSeparator(expanded) ? dirname(expanded) : '.';
                display = join(parent, ent.name).split(/[/\\]/).join(sep) + suffix;
            }
            out.push(display);
        }
        return out.sort();
    }
    catch {
        return [];
    }
}
function stripFlags(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-s' || t === '--secret') {
            i++;
            continue;
        }
        out.push(t);
    }
    return out;
}
function fileSubCanonical(sub) {
    if (!sub)
        return undefined;
    const lower = sub.toLowerCase();
    return FILE_SUB_ALIASES[lower] ?? lower;
}
// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------
function suggest(ctx, prefix, partial) {
    const [verb, ...rest] = prefix;
    const lowerVerb = verb?.toLowerCase();
    if (!verb) {
        return filterByPartial([...TOP_LEVEL], partial);
    }
    switch (lowerVerb) {
        case 'help':
        case 'exit':
        case 'quit':
        case 'volumes':
        case 'info':
        case 'refresh':
        case 'timeline':
            return filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
        case 'setup':
            return filterByPartial(knownSecrets(ctx), partial);
        case 'use':
            return filterByPartial([...volumeKeyPrefixes(ctx), ...knownSecrets(ctx)], partial);
        case 'volume': {
            const [sub] = rest;
            if (!sub) {
                return filterByPartial([...VOLUME_SUB], partial);
            }
            const lowerSub = sub.toLowerCase();
            if (lowerSub === 'open') {
                return filterByPartial(knownSecrets(ctx), partial);
            }
            if (lowerSub === 'info' || lowerSub === 'show') {
                return [];
            }
            return filterByPartial([...VOLUME_SUB], partial);
        }
        case 'file': {
            const [sub, ...args] = rest;
            if (!sub) {
                return filterByPartial([...FILE_SUB], partial);
            }
            const canon = fileSubCanonical(sub);
            const positional = stripFlags(args);
            const hasSecretFlag = args.includes('-s') || args.includes('--secret');
            const flagValuePending = (args[args.length - 1] === '-s' || args[args.length - 1] === '--secret') &&
                partial === '';
            if (partial === '-s' || partial.startsWith('-')) {
                const flagHits = filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
                if (flagHits.length > 0)
                    return flagHits;
            }
            if (flagValuePending || (hasSecretFlag && positional.length === 0)) {
                return filterByPartial(knownSecrets(ctx), partial);
            }
            switch (canon) {
                case 'add': {
                    if (positional.length === 0) {
                        return filterByPartial(completePaths(partial), partial);
                    }
                    if (positional.length === 1) {
                        const names = activeFileNames(ctx);
                        const flags = [...SECRET_FLAGS];
                        return filterByPartial([...names, ...flags, ...knownSecrets(ctx)], partial);
                    }
                    return filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
                }
                case 'list':
                    return filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
                case 'get': {
                    if (positional.length === 0) {
                        return filterByPartial([...activeFileNames(ctx), ...SECRET_FLAGS], partial);
                    }
                    if (positional.length === 1) {
                        return filterByPartial(completePaths(partial), partial);
                    }
                    return filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
                }
                case 'rm':
                    if (positional.length === 0) {
                        return filterByPartial([...activeFileNames(ctx), ...SECRET_FLAGS], partial);
                    }
                    return filterByPartial([...SECRET_FLAGS, ...knownSecrets(ctx)], partial);
                default:
                    return filterByPartial([...FILE_SUB], partial);
            }
        }
        default:
            return filterByPartial([...TOP_LEVEL], partial);
    }
}
// ---------------------------------------------------------------------------
// Public completer factory
// ---------------------------------------------------------------------------
export function createReplCompleter(ctx) {
    return (line) => {
        const { prefix, partial } = parseCompletionInput(line);
        const candidates = suggest(ctx, prefix, partial);
        const unique = [...new Set(candidates)];
        const hits = filterByPartial(unique, partial);
        return [hits.length > 0 ? hits : unique, partial];
    };
}
//# sourceMappingURL=replCompleter.js.map