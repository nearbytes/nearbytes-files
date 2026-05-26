/**
 * Remote-path helpers for the CLI. Volume paths are `/`-separated and have
 * no leading or trailing `/`; the empty string represents the root.
 * The CLI maintains a session-level *remote cwd* (also a normalized path)
 * so users can `cd` into a subtree and then refer to files with bare names.
 */

/** Normalize a user-typed remote path token to its canonical form. */
export function normalizeRemotePath(input: string): string {
  /**
   * Strip surrounding whitespace and trailing slashes; preserve a leading
   * `/` as the "absolute" marker so `resolveRemotePath` can distinguish
   * `/foo` (root) from `foo` (relative to cwd).
   */
  const trimmed = input.trim();
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Returns true if the (already normalized) input ends with `/` in the source. */
export function endsWithSlash(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.length > 1 && (trimmed.endsWith('/') || trimmed.endsWith('\\'));
}

/**
 * Resolve `input` against `cwd` into a canonical volume path. Returns the
 * empty string for root. Handles `.` and `..` segments. Inputs starting
 * with `/` are absolute.
 *
 * @throws if the path escapes the root via too many `..` segments.
 */
export function resolveRemotePath(cwd: string, input: string): string {
  /**
   * Preserve a leading `/` as the "absolute" marker BEFORE collapsing
   * trailing slashes — otherwise the lone token "/" is indistinguishable
   * from the empty string and would be treated as "stay in cwd".
   */
  const trimmed = input.trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed === '.') return cwd;
  if (/^\/+$/.test(trimmed)) return '';

  const absolute = trimmed.startsWith('/');
  const body = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (body === '' || body === '.') return absolute ? '' : cwd;

  const segments: string[] = [];
  if (!absolute && cwd.length > 0) {
    segments.push(...cwd.split('/'));
  }

  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) {
        if (absolute) continue;
        throw new Error(`Path escapes the volume root: "${input}"`);
      }
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

/** Join already-canonical paths. */
export function joinRemotePaths(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    segments.push(...part.split('/'));
  }
  return segments.filter((s) => s.length > 0).join('/');
}

/**
 * Normalize a directory argument (e.g. for `mget -d`). Same semantics as
 * {@link resolveRemotePath} but ensures the result is suitable as a parent
 * (i.e. empty-or-non-slash-suffixed).
 */
export function normalizeRemoteDirectory(cwd: string, input: string | undefined): string {
  if (input === undefined) return cwd;
  return resolveRemotePath(cwd, input);
}
