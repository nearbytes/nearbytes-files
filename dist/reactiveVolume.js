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
import { writable } from 'nearbytes-skeleton';
import { openVolume, materializeVolume } from './volume.js';
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
export async function createReactiveVolume(secret, crypto, log) {
    const volume = await openVolume(secret, crypto);
    const initialState = await materializeVolume(volume, log, crypto);
    const store = writable(initialState);
    let refreshing = false;
    return {
        subscribe: store.subscribe.bind(store),
        get: store.get.bind(store),
        volume,
        async refresh() {
            if (refreshing)
                return;
            refreshing = true;
            try {
                const state = await materializeVolume(volume, log, crypto);
                store.set(state);
            }
            finally {
                refreshing = false;
            }
        },
        get refreshing() {
            return refreshing;
        },
    };
}
//# sourceMappingURL=reactiveVolume.js.map