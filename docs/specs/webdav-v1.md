# webdav-v1 — local HTTPS projection for FILES volumes

Status: normative for transport, replay cache, and live-head write mapping.
**REPL mount and auth** are superseded by `application/webdav-v2.md`.

Design: `nearbytes-design/design/webdav-v1.md`.
Package summary: `nearbytes-files/docs/specs/webdav-v1.md`.

## 1. Scope

This document specifies how a conforming implementation exposes a FILES volume
over WebDAV for local OS mounts (Finder, Explorer, etc.). It does not change
FILES event semantics; see `application/file-events-v0.5.md`.

## 2. Transport And Binding

1. Implementations MUST serve WebDAV over **HTTPS**.
2. The default bind address MUST be **`127.0.0.1`** (localhost only).
3. The default port SHOULD be **`9843`** and MAY be overridden by `--webdav-port`.
4. TLS credentials MAY be locally generated self-signed certificates stored under
   the user's Nearbytes config directory.

## 3. Volume URL And Authentication

Mount URL shape:

```text
https://<host>:<port>/<volumeName>/…
```

1. `volumeName` MUST equal the HTTP Basic **username**.
2. The HTTP Basic **password** MUST be the secret password part (not the full
   `volumeName:password` string in the password field).
3. The effective channel secret MUST be `volumeName:password`, identical to
   other Nearbytes file tools.
4. Wrong credentials MUST NOT expose another volume's history (empty channel or
   decrypt failure only).

## 4. Operation Mapping

| WebDAV method | FILES operation |
|---------------|-----------------|
| `PROPFIND` | List materialized directories and files |
| `GET` | Read live file bytes |
| `HEAD` | File metadata without body |
| `PUT` | `CREATE_FILE` (create or replace) |
| `DELETE` | `DELETE` |
| `MKCOL` | `MKDIR` |
| `MOVE` | `RENAME` |
| `LOCK` / `UNLOCK` | Compatibility no-op (non-blocking) |

All writes MUST go through the same code path as the `FileService` API. A
separate shadow filesystem or side-channel write log is NOT conforming.

## 5. ETags And Preconditions

1. Live **file** resources SHOULD expose an `ETag` equal to the quoted event hash
   of the live entry head for that path.
2. **Collection** resources SHOULD expose an `ETag` derived from the channel
   replay head unless a future revision defines a narrower directory head.
3. `If-Match` MAY be accepted as client intent but MUST NOT cause `412`
   responses that block writes. The semantic parent of a write is the observed
   log head at commit time per FILES v0.5.
4. Client-observed validators MAY be stored in encrypted metadata (e.g.
   `clientObservedEtag`), not as cleartext envelope fields.

## 6. PROPFIND Content Length

macOS and other WebDAV clients use `D:getcontentlength` from `PROPFIND` for file
size display and copy.

1. Implementations MUST report the **plaintext** byte length of live file content
   for non-empty files.
2. Because `CREATE_FILE` payloads do not yet normatively carry plaintext size,
   implementations MAY derive size from:
   - an in-process cache populated on write (keyed by content block hash); and/or
   - one-time decryption of the live blob when size is unknown (WebDAV-only
     enrichment).
3. `HEAD` SHOULD include `Content-Length` when size is known.

## 7. In-Memory Channel Replay (Implementation Requirement)

WebDAV latency MUST NOT require reloading and re-decrypting the entire channel
from disk on every request.

Conforming implementations MUST maintain per channel secret:

1. causally ordered **hydrated** event entries;
2. the materialized FILES snapshot derived from those entries;
3. data required to decrypt live file content (e.g. wrapped keys by path).

### 7.1 Warm reads

After the channel has been opened in a process, `PROPFIND`, `GET`, `HEAD`, and
equivalent CLI reads MUST be servable from the in-memory replay without
re-executing `loadEventLog` for the full channel.

### 7.2 Local writes

After a locally emitted FILES event, implementations MUST append the new hydrated
entry to the in-memory log and update materialized state incrementally. They MUST
NOT force a full channel reload from disk solely because of that write.

### 7.3 External changes

When storage may have changed under another process (sync daemon, second CLI,
or the co-located sync engine writing into `channels/<pubkey>/`), implementations
MUST refresh the in-memory log before serving stale state. Refresh SHOULD load
and verify **only event hashes not already cached** when the causal ordered
prefix is preserved.

In a REPL that owns the sync engine, inbound `event-received` notifications MUST
mark the matching channel's replay cache stale and refresh **open** volumes for
that channel only (`volume-session-v1.md` §7). Content `block-received` events do
not change the materialized file listing and MUST NOT trigger full replay of every
open volume.

### 7.4 Equivalence

All caching and incremental strategies MUST be observationally equivalent to full
canonical replay from storage.

## 8. Debug And Configuration

1. Debug logging MUST be controlled by CLI flags, not environment variables.
2. `--debug [areas]` where `areas` is a comma-separated subset of:
   `cli`, `webdav`, `timing`. Omitting `areas` enables all.
3. `timing` covers replay refresh and per-request WebDAV stage timings.

## 9. Lifecycle

1. WebDAV MAY start automatically with the interactive `nbf` REPL.
2. WebDAV MUST stop when the hosting REPL or standalone server process exits.
3. WebDAV shares the same `dataDir` as `nbf` and `nbsync`.
