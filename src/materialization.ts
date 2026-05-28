import { materialize, type CanonicalEntry, type MaterializedFileSystem } from './fileMaterializer.js';

/**
 * Single entrypoint for filesystem materialization.
 * Keep all callers routed through this helper.
 */
export function runMaterialization(entries: readonly CanonicalEntry[]): MaterializedFileSystem {
  return materialize(entries);
}
