import { homedir } from 'os';
import { join, normalize, resolve, sep } from 'path';

/** User home directory (portable: macOS, Linux, Windows). */
export function userHomeDir(): string {
  return homedir();
}

/** `~/.nearbytes` config/history root. */
export function nearbytesConfigDir(): string {
  return join(userHomeDir(), '.nearbytes');
}

/**
 * Expands leading `~` / `~\` and resolves to an absolute path for filesystem I/O.
 */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') {
    return userHomeDir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(userHomeDir(), trimmed.slice(2));
  }
  return resolve(normalize(trimmed));
}

/** Expands `~` in a partial path for tab-completion (may stay relative). */
export function expandTildeInPartial(partial: string): string {
  if (partial === '~') {
    return userHomeDir();
  }
  if (partial.startsWith('~/') || partial.startsWith('~\\')) {
    return userHomeDir() + partial.slice(1);
  }
  return partial;
}

export function pathHasSeparator(p: string): boolean {
  return p.includes('/') || p.includes('\\');
}

export function pathEndsWithSeparator(p: string): boolean {
  return p.endsWith('/') || p.endsWith('\\');
}

/** Directory separator implied by user input, or platform default. */
export function preferredSep(partial: string): string {
  if (partial.includes('\\')) return '\\';
  if (partial.includes('/')) return '/';
  return sep;
}
