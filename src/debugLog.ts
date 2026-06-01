/**
 * Timestamped debug logging for `nbf --debug <areas>`.
 */

import { debugEnabled, type DebugArea } from './debug.js';

export function formatDebugTimestamp(now = Date.now()): string {
  return new Date(now).toISOString();
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
