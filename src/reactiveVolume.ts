/**
 * ReactiveVolume — a live, subscribable view over VolumeFileSystemState.
 *
 * Wraps the nearbytes-files volume replay in a Svelte-store-compatible
 * interface so UI frameworks and the CLI REPL can observe file-system state
 * changes without polling.
 *
 * Framework-agnostic: the store contract matches Svelte's, but there is zero
 * Svelte dependency.
 */

import type { Secret } from 'nearbytes-crypto';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { Log } from 'nearbytes-log';
import { writable, type Readable } from 'nearbytes-skeleton';
import { openVolume, materializeVolume, type Volume, type VolumeFileSystemState } from './volume.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReactiveVolume extends Readable<VolumeFileSystemState> {
  /** The underlying Volume (holds publicKey + secret). */
  readonly volume: Volume;
  /**
   * Re-materialises state from the event log and notifies subscribers.
   * Call after any write, or when the watcher fires.
   */
  refresh(): Promise<void>;
  /** `true` while a refresh is in progress (prevents concurrent refreshes). */
  readonly refreshing: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Opens a volume from a secret and returns a reactive view over its state.
 *
 * The store is immediately populated via an initial replay; await this
 * function before attaching subscribers that need a fully-loaded state.
 *
 * @param secret - Volume secret (branded `Secret` from nearbytes-crypto).
 * @param crypto - Cryptographic operations.
 * @param log    - Event log + block store.
 */
export async function createReactiveVolume(
  secret: Secret,
  crypto: CryptoOperations,
  log: Log,
): Promise<ReactiveVolume> {
  const volume = await openVolume(secret, crypto);
  const initialState = await materializeVolume(volume, log, crypto);

  const store = writable<VolumeFileSystemState>(initialState);
  let refreshing = false;

  return {
    subscribe: store.subscribe.bind(store),
    get: store.get.bind(store),

    volume,

    async refresh(): Promise<void> {
      if (refreshing) return;
      refreshing = true;
      try {
        const state = await materializeVolume(volume, log, crypto);
        store.set(state);
      } finally {
        refreshing = false;
      }
    },

    get refreshing(): boolean {
      return refreshing;
    },
  };
}
