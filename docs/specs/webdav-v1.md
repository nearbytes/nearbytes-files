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

Maps to `FileService` via `fileEmit` (causal `blockRefs` v0.5). `ETag` = quoted live superseded `CREATE_FILE` `eventHash` (after write, new event hash). `If-Match` never returns 412 (LWW); optional observed etag for future payload fields.

## Lifecycle

Started with **`nbf` REPL / default shell** (not one-shot CLI). Stopped on REPL exit (`flushAndStop`). Shares `dataDir` with `nbsync` like the CLI.
