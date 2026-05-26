/**
 * Context-aware tab completion for the nbf REPL.
 *
 * Designed to feel like sftp / lftp: every verb knows whether its next
 * positional is a remote name (active volume's file list), a local path
 * (current working directory + tilde expansion), a profile name, a friend
 * key, or a free-form argument. `-s <secret>` / `-d <dir>` are recognised
 * anywhere on the line; the literal `file` prefix is silently stripped so
 * `file g<TAB>` behaves the same as `g<TAB>`.
 *
 * The completer is intentionally pessimistic when multiple readings are
 * possible: it returns the union of likely candidates rather than guessing,
 * matching readline's own behaviour of showing all options when a TAB does
 * not uniquely commit.
 */

import { readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Context } from './context.js';
import {
  expandTildeInPartial,
  pathEndsWithSeparator,
  pathHasSeparator,
  preferredSep,
  userHomeDir,
} from './paths.js';

// ---------------------------------------------------------------------------
// Command vocabulary (FTP/SFTP-style; flat — no required sub-command depth)
// ---------------------------------------------------------------------------

const TOP_LEVEL = [
  // File transfer
  'ls',
  'dir',
  'list',
  'get',
  'put',
  'mget',
  'mput',
  'rm',
  'delete',
  'del',
  'mv',
  'rename',
  // Local nav
  'lpwd',
  'lcd',
  'lls',
  'pwd',
  // Connections
  'open',
  'close',
  'use',
  'volumes',
  'setup',
  'info',
  'timeline',
  'refresh',
  // Identity / discovery
  'profile',
  'friend',
  'volume',
  // Session
  'help',
  'bye',
  'exit',
  'quit',
  // Legacy `file` prefix (still accepted)
  'file',
] as const;

const PROFILE_SUB = ['add', 'use', 'list', 'ls', 'show', 'publish', 'remove', 'rm'] as const;
const FRIEND_SUB = ['list', 'ls', 'add', 'remove', 'rm', 'del', 'delete', 'show'] as const;
const VOLUME_SUB = ['open', 'close', 'info', 'show'] as const;

const SECRET_FLAGS = ['-s', '--secret'] as const;
const DEST_FLAGS = ['-d', '--dest'] as const;

// Verbs whose first positional is a remote filename in the active volume.
const REMOTE_NAME_VERBS = new Set(['ls', 'dir', 'list', 'get', 'rm', 'delete', 'del', 'mv', 'rename', 'mget']);

// Verbs whose first positional is a local path.
const LOCAL_PATH_VERBS = new Set(['put', 'add', 'upload', 'mput', 'lcd', 'lls']);

// ---------------------------------------------------------------------------
// Tokenisation aligned with repl.ts
// ---------------------------------------------------------------------------

export function parseCompletionInput(line: string): { prefix: string[]; partial: string } {
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
    partial: tokens[tokens.length - 1]!,
  };
}

function tokeniseForCompletion(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of line.trimEnd()) {
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function filterByPartial(candidates: string[], partial: string): string[] {
  if (partial.length === 0) return candidates;
  const lower = partial.toLowerCase();
  const hits = candidates.filter((c) => c.toLowerCase().startsWith(lower));
  return hits.length > 0 ? hits : candidates;
}

function quoteIfNeeded(value: string): string {
  if (/[\s'"\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Dynamic candidates from the live session
// ---------------------------------------------------------------------------

function knownSecrets(ctx: Context): string[] {
  const out = new Set<string>();
  for (const v of ctx.config.volumes) out.add(v.secret);
  for (const rv of ctx.volumes.values()) {
    out.add(rv.volume.secret as string);
  }
  return [...out].map(quoteIfNeeded);
}

function volumeKeyPrefixes(ctx: Context): string[] {
  return [...ctx.volumes.keys()].map((hex) => hex.slice(0, 16));
}

function activeFileNames(ctx: Context): string[] {
  if (!ctx.activeVolume) return [];
  const state = ctx.activeVolume.get();
  return [...state.files.keys()].map(quoteIfNeeded);
}

function profileNames(ctx: Context): string[] {
  return ctx.config.profiles.map((p) => p.name);
}

/**
 * Filesystem path completion with tilde expansion and platform-correct
 * separators. Mirrors the behaviour readline users expect from bash / zsh:
 *   - `~`             → home directory
 *   - `~/foo/`        → list of `~/foo/*`
 *   - `./foo`         → relative to cwd, includes the `./` prefix back
 *   - directories are returned with a trailing separator (so a second TAB
 *     descends into them)
 */
function completePaths(partial: string): string[] {
  const home = userHomeDir();
  const tilde = partial.startsWith('~');
  const expanded = expandTildeInPartial(partial);
  const sep = preferredSep(partial);
  const dirSuffix = sep;

  let searchDir: string;
  let base: string;

  if (expanded === '' || expanded === '.') {
    searchDir = process.cwd();
    base = '';
  } else if (pathEndsWithSeparator(expanded)) {
    searchDir = resolve(expanded);
    base = '';
  } else if (pathHasSeparator(expanded)) {
    searchDir = resolve(dirname(expanded));
    const parts = expanded.split(/[/\\]/);
    base = parts[parts.length - 1] ?? '';
  } else {
    searchDir = process.cwd();
    base = expanded;
  }

  try {
    const entries = readdirSync(searchDir, { withFileTypes: true });
    const out: string[] = [];
    for (const ent of entries) {
      if (base.length > 0 && !ent.name.startsWith(base)) continue;
      const full = join(searchDir, ent.name);
      const suffix = ent.isDirectory() ? dirSuffix : '';
      let display: string;
      if (tilde && full.startsWith(home)) {
        const tail = full.slice(home.length).replace(/\\/g, '/');
        display = `~${tail}${suffix}`;
      } else if (!pathHasSeparator(expanded) && searchDir === process.cwd()) {
        display = ent.name + suffix;
      } else if (pathEndsWithSeparator(expanded)) {
        display = partial + ent.name + suffix;
      } else {
        const parent = pathHasSeparator(expanded) ? dirname(expanded) : '.';
        display = join(parent, ent.name).split(/[/\\]/).join(sep) + suffix;
      }
      out.push(display);
    }
    return out.sort();
  } catch {
    return [];
  }
}

/**
 * Strips `-s <val>` and `-d <val>` flags from a positional token list so the
 * per-verb position logic operates on remaining positionals only. The
 * `flagAwaitingValue` return tells the caller "the very last token was
 * `-s` / `-d` and the partial slot is its value" — used to surface secret /
 * directory candidates instead of remote/local filenames.
 */
function stripFlags(tokens: readonly string[]): { positional: string[]; flagAwaitingValue: 'secret' | 'dest' | null } {
  const out: string[] = [];
  let flagAwaitingValue: 'secret' | 'dest' | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '-s' || t === '--secret') {
      if (i === tokens.length - 1) flagAwaitingValue = 'secret';
      else i += 1;
    } else if (t === '-d' || t === '--dest') {
      if (i === tokens.length - 1) flagAwaitingValue = 'dest';
      else i += 1;
    } else {
      out.push(t);
    }
  }
  return { positional: out, flagAwaitingValue };
}

// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------

function suggestForFlatVerb(
  ctx: Context,
  verb: string,
  argsAfterVerb: readonly string[],
  partial: string,
): string[] {
  const { positional, flagAwaitingValue } = stripFlags(argsAfterVerb);

  if (flagAwaitingValue === 'secret' && partial === '') {
    return knownSecrets(ctx);
  }
  if (flagAwaitingValue === 'dest' && partial === '') {
    return completePaths(partial);
  }

  if (partial.startsWith('-')) {
    const flags: string[] = [];
    flags.push(...SECRET_FLAGS);
    if (verb === 'mget') flags.push(...DEST_FLAGS);
    return filterByPartial(flags, partial);
  }

  switch (verb) {
    case 'ls':
    case 'dir':
    case 'list':
    case 'pwd':
    case 'lpwd':
    case 'volumes':
    case 'info':
    case 'refresh':
    case 'close':
    case 'disconnect':
    case 'help':
    case '?':
    case 'bye':
    case 'exit':
    case 'quit':
      return [];

    case 'lcd':
    case 'lls':
      return filterByPartial(completePaths(partial), partial);

    case 'get': {
      if (positional.length === 0) {
        return filterByPartial(activeFileNames(ctx), partial);
      }
      if (positional.length === 1) {
        return filterByPartial(completePaths(partial), partial);
      }
      return [];
    }

    case 'put':
    case 'add':
    case 'upload': {
      if (positional.length === 0) {
        return filterByPartial(completePaths(partial), partial);
      }
      if (positional.length === 1) {
        return filterByPartial(activeFileNames(ctx), partial);
      }
      return [];
    }

    case 'rm':
    case 'delete':
    case 'del':
    case 'remove': {
      return filterByPartial(activeFileNames(ctx), partial);
    }

    case 'mv':
    case 'rename': {
      if (positional.length === 0) {
        return filterByPartial(activeFileNames(ctx), partial);
      }
      if (positional.length === 1) {
        return filterByPartial(activeFileNames(ctx), partial);
      }
      return [];
    }

    case 'mget': {
      return filterByPartial(activeFileNames(ctx), partial);
    }

    case 'mput': {
      return filterByPartial(completePaths(partial), partial);
    }

    case 'open':
    case 'setup':
      return filterByPartial(knownSecrets(ctx), partial);

    case 'use':
      return filterByPartial([...volumeKeyPrefixes(ctx), ...knownSecrets(ctx)], partial);

    case 'timeline':
      return filterByPartial(knownSecrets(ctx), partial);

    default:
      return [];
  }
}

function suggest(ctx: Context, prefix: string[], partial: string): string[] {
  /**
   * Optional `file` prefix. `file g<TAB>` and `g<TAB>` should both complete
   * to `get`. We strip the literal `file` head and rebuild the verb context
   * from the remaining prefix.
   */
  const normalizedPrefix =
    prefix.length > 0 && prefix[0]!.toLowerCase() === 'file' ? prefix.slice(1) : prefix;

  const [verb, ...rest] = normalizedPrefix;
  const lowerVerb = verb?.toLowerCase();

  if (!verb) {
    return filterByPartial([...TOP_LEVEL], partial);
  }

  switch (lowerVerb) {
    case 'profile': {
      const [sub] = rest;
      if (!sub) return filterByPartial([...PROFILE_SUB], partial);
      const lowerSub = sub.toLowerCase();
      if (lowerSub === 'use' || lowerSub === 'show' || lowerSub === 'remove' || lowerSub === 'rm') {
        return filterByPartial(profileNames(ctx), partial);
      }
      if (lowerSub === 'add' || lowerSub === 'publish') return filterByPartial([], partial);
      return [];
    }

    case 'friend': {
      const [sub] = rest;
      if (!sub) return filterByPartial([...FRIEND_SUB], partial);
      const lowerSub = sub.toLowerCase();
      if (lowerSub === 'list' || lowerSub === 'ls') return [];
      return filterByPartial([...ctx.config.friends], partial);
    }

    case 'volume': {
      const [sub] = rest;
      if (!sub) return filterByPartial([...VOLUME_SUB], partial);
      const lowerSub = sub.toLowerCase();
      if (lowerSub === 'open') return filterByPartial(knownSecrets(ctx), partial);
      return [];
    }

    default:
      if (!lowerVerb) return filterByPartial([...TOP_LEVEL], partial);
      return suggestForFlatVerb(ctx, lowerVerb, rest, partial);
  }
}

// Surface the per-verb category sets for tests / introspection.
export const __vocab = {
  TOP_LEVEL,
  PROFILE_SUB,
  FRIEND_SUB,
  VOLUME_SUB,
  REMOTE_NAME_VERBS,
  LOCAL_PATH_VERBS,
};

// ---------------------------------------------------------------------------
// Public completer factory
// ---------------------------------------------------------------------------

export function createReplCompleter(ctx: Context): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const { prefix, partial } = parseCompletionInput(line);
    const candidates = suggest(ctx, prefix, partial);
    const unique = [...new Set(candidates)];
    const hits = filterByPartial(unique, partial);
    return [hits.length > 0 ? hits : unique, partial];
  };
}
