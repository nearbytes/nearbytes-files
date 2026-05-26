/**
 * Volume-path helpers. Volume paths are POSIX-style `/`-separated strings
 * with no leading or trailing `/`; the protocol normalizes user input
 * via {@link normalizeVolumePath}.
 */

/**
 * Normalises a user-supplied path:
 *   - converts backslashes to `/`,
 *   - collapses runs of `/`,
 *   - strips leading and trailing `/`,
 *   - rejects empty segments, `.`, `..`, and the empty string.
 *
 * @throws if the path is empty or contains an invalid segment.
 */
export function normalizeVolumePath(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (cleaned.length === 0) {
    throw new Error('Path cannot be empty');
  }
  for (const segment of cleaned.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`Invalid path segment in "${path}"`);
    }
  }
  return cleaned;
}

/** Returns the strict ancestor paths of `path`, ordered from shallowest to deepest. */
export function ancestorPaths(path: string): string[] {
  const out: string[] = [];
  let idx = path.indexOf('/');
  while (idx > 0) {
    out.push(path.slice(0, idx));
    idx = path.indexOf('/', idx + 1);
  }
  return out;
}

/** Returns ancestors plus the path itself (root to leaf). */
export function pathChain(path: string): string[] {
  return [...ancestorPaths(path), path];
}

/** Final path segment (basename). */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

/** Parent path, or `null` if `path` is at the top level (no `/`). */
export function dirname(path: string): string | null {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? null : path.slice(0, idx);
}

/** True if `descendant` is `ancestor` or lives strictly below `ancestor/`. */
export function isSelfOrDescendant(descendant: string, ancestor: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}/`);
}

/** True if `descendant` lives strictly below `ancestor/`. */
export function isStrictDescendant(descendant: string, ancestor: string): boolean {
  return descendant.startsWith(`${ancestor}/`);
}

/**
 * Rewrites `path`'s `from` prefix to `to`. Caller MUST ensure
 * {@link isSelfOrDescendant}(path, from) is true.
 */
export function rewritePrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  return `${to}${path.slice(from.length)}`;
}
