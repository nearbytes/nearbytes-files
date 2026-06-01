/**
 * Runtime debug areas for `nbf --debug` and `webdav-serve --debug`.
 *
 * Areas (comma-separated, case-insensitive):
 *   - cli    — stack traces on CLI/REPL command errors
 *   - webdav — log each WebDAV request and response
 *   - timing — per-request stage timings and log-replay breakdown
 *   - sync     — wire protocol (have/want/delta) and volume refresh on inbound events
 *   - timeline — boot + discovery startup + peer search + connect phases (no wire spam)
 *
 * `--debug` with no argument enables all areas.
 */

export const DEBUG_AREAS = ['cli', 'webdav', 'timing', 'sync', 'timeline'] as const;
export type DebugArea = (typeof DEBUG_AREAS)[number];

const active = new Set<DebugArea>();

export function applyDebugOption(value: boolean | string | undefined): void {
  active.clear();
  if (value === undefined || value === false) return;
  if (value === true) {
    for (const area of DEBUG_AREAS) active.add(area);
    return;
  }
  for (const part of value.split(',')) {
    const area = part.trim().toLowerCase();
    if (area.length === 0) continue;
    if (!isDebugArea(area)) {
      throw new Error(`Unknown debug area "${area}". Known: ${DEBUG_AREAS.join(', ')}`);
    }
    active.add(area);
  }
}

export function debugEnabled(area: DebugArea): boolean {
  return active.has(area);
}

export function parseTcpPort(
  raw: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined) return fallback;
  const port = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${String(raw)}`);
  }
  return port;
}

export function parseWebDavPort(raw: string | number | undefined, fallback = 9843): number {
  return parseTcpPort(raw, fallback, 'WebDAV');
}

/** `--dev-inspect` with no value → default 9845; omit/false → disabled. */
export function parseDevInspectPort(raw: boolean | string | undefined): number | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return 9845;
  return parseTcpPort(raw, 9845, 'dev-inspect');
}

function isDebugArea(value: string): value is DebugArea {
  return (DEBUG_AREAS as readonly string[]).includes(value);
}
