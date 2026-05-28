/**
 * Runtime debug areas for `nbf --debug` and `webdav-serve --debug`.
 *
 * Areas (comma-separated, case-insensitive):
 *   - cli    — stack traces on CLI/REPL command errors
 *   - webdav — log each WebDAV request and response
 *   - timing — per-request stage timings and log-replay breakdown
 *
 * `--debug` with no argument enables all areas.
 */

export const DEBUG_AREAS = ['cli', 'webdav', 'timing'] as const;
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

export function parseWebDavPort(raw: string | number | undefined, fallback = 9843): number {
  if (raw === undefined) return fallback;
  const port = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WebDAV port: ${String(raw)}`);
  }
  return port;
}

function isDebugArea(value: string): value is DebugArea {
  return (DEBUG_AREAS as readonly string[]).includes(value);
}
