# webdav-v1 — local HTTPS mount per volume

Normative package summary. Design notes: `nearbytes-design/design/webdav-v1.md`.
Normative cross-repo spec: `nearbytes-specs/application/webdav-v1.md`.

## Transport

- **HTTPS only**, bind **`127.0.0.1`** (default port `9843`).
- TLS cert: `~/.nearbytes/webdav/tls.pem` + `tls-key.pem` (`0600`), minted on first start (`selfsigned`, CN `nearbytes-files-local`).

## CLI options

WebDAV starts with **`nbf`** / **`nbf repl`** (interactive REPL) or **`node scripts/webdav-serve.mjs`** (server only).

| Option | Default | Description |
|--------|---------|-------------|
| `--webdav-port <port>` | `9843` | TCP port for the local HTTPS WebDAV listener. |
| `--debug [areas]` | off | Enable debug logging. Omit `areas` to turn on **all** areas below. Otherwise pass a comma-separated list (spaces are trimmed; case-insensitive). |

### `--debug` areas

| Area | Output |
|------|--------|
| `cli` | Stack traces and verbose diagnostics on CLI/REPL command errors (`nbf` only). |
| `webdav` | One line per WebDAV request (method, URL, path, `Depth`, `Destination`) and one line per response (status, elapsed ms). |
| `timing` | Per-request handler stage timings (`readBody`, `snapshotForSecret`, `getFileByPath`, …) and replay timing when a cold or stale refresh runs. |

Examples:

```bash
nbf --debug                          # all areas
nbf --debug webdav,timing            # WebDAV + replay timing only
nbf --debug cli --webdav-port 9844   # CLI errors only, alternate port
node scripts/webdav-serve.mjs --debug webdav,timing
```

Other global `nbf` flags (`-c`, `-d`, `-m`) are unchanged; see `nbf help` in the REPL.

## Auth & volume URL

One OS mount = one volume:

```text
https://127.0.0.1:<port>/<volumeName>/…
```

**HTTP Basic:** `username = volumeName`, `password` = secret password → channel secret `volumeName:password` → `deriveKeys` (same as `nbf`). First URL segment must equal `username`.

Wrong password: empty channel or decrypt failure; no cross-volume leakage.

## Operations

Maps to `FileService` via `fileEmit` (FILES `blockRefs` v0.5). `ETag` SHOULD be
a quoted FILES event hash: file resources use their live entry head, while
collection resources use the current channel replay head unless a future
implementation computes a narrower directory-listing head. This keeps implicit
directories and listing changes covered without inventing non-event validators.
A client `If-Match` value is therefore the previous event/version the client
claims to have observed. Writes do not fail on `If-Match`: the server commits a
new FILES event whose semantic parent is the actual observed log head at commit
time. If the client validator is retained, it belongs in optional encrypted
metadata such as `clientObservedEtag`, not in cleartext typed envelope fields.

Clear `blockRefs` include direct predecessor event refs and previous-content
blocks for exact-path file overwrites/deletes/moves. This is enough for
previous-version and conflict tooling without expanding directory cascades.

WebDAV `LOCK`/`UNLOCK` are compatibility acknowledgements for clients such as
Finder. They MUST NOT become blocking application-level locks. Writes still
commit as FILES events whose causal order is represented by observed-log-head
dependencies; conflicts are resolved by v0.5 replay.

## Projection And In-Memory Channel Replay

WebDAV reads a per-secret **in-memory channel replay** owned by `FileService`, not
the raw on-disk log on every request.

### Cache contents

For each channel secret the implementation keeps a `FileReplayContext`:

- **ordered hydrated entries** — causally ordered `EventLogEntry` values (payload already decrypted);
- **materialized filesystem** — `MaterializedFileSystem` from FILES v0.5 replay;
- **live decryption keys** — wrapped file keys indexed by live path;
- **observed channel head** — last FILES event hash in replay order.

### Lifecycle

| Phase | Behavior |
|-------|----------|
| **Cold open** | First `getReplayContext` for a secret loads event hashes from storage, hydrates payloads, verifies signatures, topologically orders, and materializes. Cost is **O(n)** in channel event count. |
| **Warm read** | Subsequent `getReplayContext` returns the cached context with **no disk I/O** (`timeline`, `ls`, WebDAV `PROPFIND`/`GET`). |
| **Local write** | After `emitFileEvent`, the new entry is appended in memory via `extendFileReplayContext` and incremental materialization over **only** the new entries. The full channel MUST NOT be reloaded from disk. |
| **External sync** | When another process appends to the same `dataDir`, the implementation calls `markReplayStale`. The next read merges **only new event hashes** from disk into the in-memory log, then re-materializes incrementally when the ordered prefix is preserved. |

These steps are performance optimizations. Implementations MUST preserve the same
live filesystem state as a full canonical replay from storage.

### PROPFIND sizes

macOS WebDAV clients use `getcontentlength` from `PROPFIND` (not only `GET`).
`CREATE_FILE` inner payloads do not yet carry plaintext length. Implementations
SHOULD:

1. record plaintext size in an in-process cache keyed by content block hash on write;
2. apply cached sizes to materialized file metadata on replay; and
3. for WebDAV reads only, MAY decrypt live blobs once when size is still unknown
   (`enrichSizes`).

`HEAD` SHOULD send `Content-Length` when the materialized size is known.

## Lifecycle

Started with **`nbf` REPL / default shell** (not one-shot CLI). Stopped on REPL exit (`flushAndStop`). Shares `dataDir` with `nbsync` like the CLI.

Debug and port are configured only via **`--debug`** and **`--webdav-port`** (not environment variables).
