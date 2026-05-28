# file-events-v0.4 (baseline)

Canonical semantics live in `nearbytes-crypto` (`EventType`, inner payloads) and `nearbytes-files` (`fileMaterializer.ts`).

- Pure-syntax events; cascade only in the materializer.
- Total order: `timestamp` → log `sequence` → `eventHash`.
- `CREATE_FILE` envelope `blockRefs` contained **only** the new content block.

See [file-events-v0.5](file-events-v0.5.md) for causal lineage in `blockRefs`.
