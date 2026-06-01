/**
 * Timestamped debug logging for `nbf --debug <areas>`.
 */

import { debugEnabled, type DebugArea } from './debug.js';

/** Compact wall time for terminal debug (`14:17:23.255`). */
export function formatDebugTimestamp(now = Date.now()): string {
  const d = new Date(now);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * @param scope - sub-tag (`replay`, `wire`, `refresh`, …)
 * @param message - remainder of the line (no leading space required)
 */
export function debugLog(area: DebugArea, scope: string, message: string): void {
  if (!debugEnabled(area)) {
    return;
  }
  const tag = scope.length > 0 ? `${area}:${scope}` : area;
  console.error(`[${formatDebugTimestamp()}] [nearbytes-${tag}] ${message}`);
}
