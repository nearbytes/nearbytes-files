# webdav-v1 — local HTTPS mount per volume

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
| `timing` | Per-request handler stage timings (`readBody`, `snapshotForSecret`, `getFileByPath`, …) and log-replay breakdown (`open`, `load`, `verify`, `materialize`, entry count). |

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

## Projection And Performance Model

WebDAV projection uses a materialized FILES snapshot (`MaterializedFileSystem`)
plus observed channel head, scoped per secret.

- Read operations (`PROPFIND`, `GET`, `HEAD`) consume the in-memory snapshot.
- Writes (`PUT`, `DELETE`, `MKCOL`, `MOVE`) go through `FileService`, then
  invalidate the per-secret snapshot freshness marker.
- Refresh computes canonical replay from log and MAY reuse the previous
  materialized state as a seed when the ordered event stream keeps the previous
  prefix, applying only appended events incrementally.

This optimization is performance-only: it MUST preserve exact replay semantics
defined by FILES v0.5.

## Lifecycle

Started with **`nbf` REPL / default shell** (not one-shot CLI). Stopped on REPL exit (`flushAndStop`). Shares `dataDir` with `nbsync` like the CLI.

Debug and port are configured only via **`--debug`** and **`--webdav-port`** (not environment variables).
