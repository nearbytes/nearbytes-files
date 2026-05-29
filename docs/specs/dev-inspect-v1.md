# dev-inspect-v1 — local HTTP replay inspection API

Status: normative for `nearbytes-files` development tooling.
Implementation: `src/dev/inspectServer.ts`.

## 1. Scope

When the **REPL** is started with `--dev-inspect`, a small **read-only** HTTP
server listens on an extra loopback port in the **same process** as the REPL and
WebDAV. It exposes replay state for registered volumes and does not replace
WebDAV.

Data sources:

- `<dataDir>/.nearbytes/volume-session.json` (registered volumes)
- `<dataDir>/.nearbytes/webdav-view.json` (timeline cursor for `at=cursor`)

There is **no** standalone “inspect-only” mode: without the REPL, the API is not
started.

## 2. Lifecycle

- **Enable:** `nbf --dev-inspect [port]`, `nbf repl --dev-inspect`, or
  `yarn dev` (alias for REPL + flag). Default port `9845` on `127.0.0.1`.
- **Runtime:** shares `FileService` with REPL and WebDAV in one Node process.
- **Stop:** when the REPL exits (`bye` / `^D` / shutdown), via `ctx.destroy()`.

`yarn repl` without the flag does **not** open the debug port.

## 3. Endpoints

All responses are JSON unless noted. Errors return `500` with plain text body.

### `GET /health`

```json
{ "ok": true, "dataDir": "/path/to/local" }
```

### `GET /volumes`

Contents of `volume-session.json` (empty registry if missing).

### `GET /view`

Contents of `webdav-view.json`, or `null` if absent.

### `GET /replay/<volume>?at=<selector>`

Replay snapshot for a **registered** volume name (not the channel secret).

Query `at` (default `cursor`):

| Value | Meaning |
|-------|---------|
| `live`, `head` | Live log head |
| `cursor` | Cursor from `webdav-view.json` when volume matches |
| `<n>` | 1-based event index in causal replay order |
| `<hex>` | Event hash (full or prefix accepted by replay) |

Response shape:

```json
{
  "volume": "test2",
  "at": "32",
  "events": 32,
  "files": [{ "path": "/foo.txt", "size": 123 }],
  "dirs": ["/"],
  "observedHead": "…",
  "webdavView": { … }
}
```

## 4. CLI

```sh
nbf --dev-inspect              # default port 9845
nbf --dev-inspect 9850         # custom port
yarn repl --dev-inspect
yarn dev                       # REPL + --dev-inspect (kills stale nbf first)
```

Every REPL start runs `killStaleNbfProcesses` before binding WebDAV/dev-inspect
ports (SIGTERM to prior `nbf` CLI in this repo and listeners on 9843/9845).
Does not stop `nbsync`.

## 5. Security

- Loopback only; plain HTTP (no TLS).
- Read-only: no mutation endpoints.
- Does not expose channel secrets (only registered volume **names**).

## 6. Related specs

- `volume-session-v1.md` — `/volumes` and volume name in `/replay/<vol>`
- `webdav-v2.md` — `webdav-view.json` drives `at=cursor`
- `webdav-v1.md` — transport/debug for the HTTPS server (port 9843)
