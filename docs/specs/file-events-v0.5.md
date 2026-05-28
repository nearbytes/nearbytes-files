# file-events-v0.5 — causal `blockRefs`

Extension of [file-events-v0.4](file-events-v0.4.md). **Materialization is unchanged** (timestamp → log sequence → event hash; LWW). `blockRefs` carry lineage only; they do not affect replay order.

## Event shape (unchanged inner payload)

Inner payloads remain `CREATE_FILE | MKDIR | DELETE | RENAME` as in nearbytes-crypto. The outer envelope adds ordered `blockRefs`:

| Index | Kind | Meaning |
|-------|------|---------|
| 0 | **causal event** (optional) | `eventHash` of the live `CREATE_FILE` superseded at this path (from materializer `fileOrigins`) |
| 1 | **last block** (optional) | `blockHash` of that live file’s ciphertext (content-address) |
| 2… | **causal event / last block** (optional) | Extra pairs for `RENAME` when `toPath` already had live file state |
| … | **introduced blocks** | New ciphertext blocks this event requires (`CREATE_FILE` only) |

**Disambiguation:** sync and storage treat each ref as a **block** if `blocks.has(ref)`, else as an **event** if the channel stores that `eventHash`. Never fetch events as blocks.

## Per verb

| Verb | `blockRefs` |
|------|-------------|
| `CREATE_FILE` | `[supersededEvent?, lastBlock?, newBlock]` |
| `DELETE` | `[supersededEvent?, lastBlock?]` of the file at `path` (omit if path is only an implicit dir) |
| `MKDIR` | `[supersededEvent?, lastBlock?]` at `path` if a file lived there (overwrite edge); else `[]` |
| `RENAME` | from-path pair, then to-path pair if target had live file; no new blocks |

## Emit rule (single code path)

All file mutators call `emitFileEvent()` in `src/fileEmit.ts`: one replay → read `fileOrigins` / `files` → build refs → `createSignedEvent` → `storeEvent`. Timestamps are **tiebreak only**.

## WebDAV / If-Match

HTTP adapters always succeed writes (LWW). Optional `If-Match` is recorded as the client’s observed causal event hash in application metadata only until a future payload field exists; emit still includes factual `supersededEvent` from replay.
