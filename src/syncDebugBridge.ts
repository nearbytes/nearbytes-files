/**
 * Bridges `nbf --debug sync|timeline` to nearbytes-sync tracing.
 */

import {
  configureSyncDebug,
  configureSyncTimeline,
  type SyncEvent,
} from 'nearbytes-sync/node';
import { debugEnabled } from './debug.js';
import { debugLog } from './debugLog.js';

export function installSyncDebugBridge(): void {
  const syncOn = debugEnabled('sync');
  configureSyncDebug({
    enabled: syncOn,
    sink: syncOn
      ? (scope, line) => {
          debugLog('sync', scope, line);
        }
      : undefined,
  });

  const timelineOn = debugEnabled('timeline');
  configureSyncTimeline({
    enabled: timelineOn,
    sink: timelineOn
      ? (line: string) => {
          debugLog('timeline', 'sync', line);
        }
      : undefined,
  });
}

export function formatSyncEventLine(event: SyncEvent): string {
  switch (event.kind) {
    case 'peer-connected':
      return (
        `peer-connected role=${event.role} profile=${shortHex(event.remoteProfilePublicKey)} ` +
        `inst=${shortHex(event.remoteInstancePublicKey)} via ${event.transportLabel}`
      );
    case 'peer-disconnected':
      return (
        `peer-disconnected profile=${shortHex(event.remoteProfilePublicKey)} ` +
        `inst=${shortHex(event.remoteInstancePublicKey)}`
      );
    case 'peer-connect-failed':
      return (
        `peer-connect-failed reason=${event.reason} attempts=${event.attempts} ` +
        `via ${event.transportLabel}` +
        (event.remoteProfilePublicKey.length > 0
          ? ` profile=${shortHex(event.remoteProfilePublicKey)}`
          : '')
      );
    case 'peer-stalled':
      return (
        `peer-stalled reason=${event.reason} role=${event.role} ` +
        `profile=${shortHex(event.remoteProfilePublicKey)} ` +
        `inst=${shortHex(event.remoteInstancePublicKey)} via ${event.transportLabel}`
      );
    case 'block-sent':
      return (
        `block-sent hash=${shortHex(event.blockHash)} bytes=${event.bytes} ` +
        `to=${shortHex(event.toInstancePublicKey)}`
      );
    case 'block-received':
      return (
        `block-received hash=${shortHex(event.blockHash)} bytes=${event.bytes} ` +
        `from=${shortHex(event.fromInstancePublicKey)}`
      );
    case 'event-received':
      return (
        `event-received hash=${shortHex(event.eventHash)} channel=${shortHex(event.channel)} ` +
        `bytes=${event.bytes} from=${shortHex(event.fromInstancePublicKey)}`
      );
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function shortHex(hex: string): string {
  return hex.length > 8 ? `${hex.slice(0, 8)}…` : hex;
}
