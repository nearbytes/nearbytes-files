# webdav-v1 — local HTTPS mount per volume

## Transport

- **HTTPS only**, bind **`127.0.0.1`** (default port `9843`, override `NEARBYTES_WEBDAV_PORT`).
- TLS cert: `~/.nearbytes/webdav/tls.pem` + `tls-key.pem` (`0600`), minted on first start (`selfsigned`, CN `nearbytes-files-local`).

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

## Lifecycle

Started with **`nbf` REPL / default shell** (not one-shot CLI). Stopped on REPL exit (`flushAndStop`). Shares `dataDir` with `nbsync` like the CLI.
