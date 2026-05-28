# webdav-v2 — single mount, multi-volume root, timeline projection

Status: normative target for `nearbytes-files` WebDAV adapter.
Supersedes mount and auth rules in `webdav-v1.md` (transport, debug, replay cache
unchanged — see `webdav-v1.md` §Projection And In-Memory Channel Replay).
Design: `nearbytes-design/design/webdav-v2.md`.
Normative cross-repo: `nearbytes-specs/application/webdav-v2.md`.

## 1. Scope

One OS mount exposes every **registered** volume (see `volume-session-v1.md`)
under a single HTTPS root. WebDAV reads may project **historical** filesystem
state at the REPL timeline cursor; writes always append to the **live log head**.

## 2. Transport

Unchanged from webdav-v1: HTTPS, `127.0.0.1`, default port `9843`, `--webdav-port`,
`--debug` areas, local TLS under `~/.nearbytes/webdav/`.

## 3. When WebDAV is available

1. WebDAV starts with the REPL (same lifecycle as v1).
2. The server MUST NOT serve volume paths until the CLI has an **active sync
   profile** (`profile use` / `profile add` establishing `activeProfile`).
3. Switching sync profile (`profile use <other>`) MUST invalidate the current
   WebDAV HTTP session: clients MUST re-authenticate (new `401` + `WWW-Authenticate`).

Rationale: one global credential bound to the active profile; avoids per-volume
password prompts while keeping secrets out of repeated REPL input.

## 4. Mount URL and layout

Single mount base:

```text
https://127.0.0.1:<port>/
```

Directory layout:

```text
/
  <volumeName>/          # prefix from registered secret; only if registered
    … files and dirs …
```

1. `PROPFIND` on `/` MUST list only **registered** volume names (not every
   `channels/` directory on disk).
2. Paths under `/<volumeName>/` use the registered secret for that name.
3. Unregistered or unknown `volumeName` MUST yield `404` (not empty channel probe).

## 5. Authentication (global Basic)

1. One HTTP Basic credential per active sync profile session (exact username/password
   scheme is implementation-defined but MUST be documented in `nbf help`).
2. Successful auth authorizes access to all registered volumes for that REPL process.
3. Failed auth MUST NOT leak whether a volume name exists.
4. On profile switch, prior Authorization headers MUST be rejected until the client
   sends credentials again.

v1 per-volume Basic (`username = volumeName`) is **deprecated** for the REPL mount.

## 6. Timeline projection (read-only historical view)

### 6.1 Cursor

1. The REPL maintains a **timeline cursor** on the **active** volume only.
2. Default cursor: **live head** (latest event in causal replay order).
3. `timeline goto …` moves the cursor (see §7).
4. Changing active volume resets cursor to live head (not persisted).

### 6.2 What clients see

| Cursor | REPL `ls` / `get` | WebDAV `GET` / `PROPFIND` / `HEAD` |
|--------|-------------------|-------------------------------------|
| Live head | Live materialized state | Live state; writes allowed (see §8) |
| Earlier event | Prefix replay up to cursor | Same prefix snapshot; **read-only** |

When the cursor moves backward or forward, file names, sizes, and existence
**change** on the mount because the server re-projects an earlier prefix of the
event log. The authoritative log on disk is unchanged.

### 6.3 Replay rule

Historical state MUST be computed by replaying FILES events in causal order
**through and including** the cursor event (or through the event selected by
`goto` rules). Implementations SHOULD reuse incremental materialization when
the cursor moves along the same ordered list.

## 7. REPL `timeline goto`

Extends existing `timeline` listing.

```text
timeline goto <selector>
```

`<selector>` MUST accept:

1. **Index** — 1-based line number in the last printed timeline table, or
   0-based implementation index if documented in help (normative: **1-based**
   for user input).
2. **Date/time** — any string parsed by a standard date library (e.g. ISO-8601,
   locale forms). Select the **first event strictly after** the parsed instant in
   causal replay order. Partial dates (e.g. `2026-05`) resolve per library rules
   then apply the “first after” rule.

If no event matches, the command MUST fail with a clear error.

Related:

```text
timeline live     # reset cursor to head (alias: timeline head)
```

## 8. Writes always target live head

**Normative:** All mutating operations append to the **live** observed log head,
never to a forked branch at the historical cursor.

| Surface | Cursor &lt; head | Cursor = head |
|---------|------------------|---------------|
| WebDAV `PUT`, `DELETE`, `MKCOL`, `MOVE` | **403 Forbidden** (read-only projection) | Allowed; commits at live head |
| REPL `put`, `rm`, `mv`, `mkdir`, … | Implementation MAY forbid or document that writes still go to live head without moving cursor; v1 target: **forbid** mutating commands until `timeline live` |

Historical view is for audit and inspection (Finder shows “what existed then”).
The encrypted channel on disk always advances only at the true tip.

This is not copy-on-write time travel: moving the cursor does not create
alternate realities on the log.

## 9. Operations (unchanged mapping at live head)

At live head, WebDAV method mapping is identical to webdav-v1 (`FileService` /
FILES v0.5). `ETag`, `LOCK`, `If-Match`, in-memory replay, and `getcontentlength`
rules from v1 apply unchanged.

## 10. Migration from v1

Clients that mounted `https://127.0.0.1:9843/<volume>/` with per-volume Basic
MUST remount `https://127.0.0.1:9843/` once, register volumes in the REPL, set
active profile, and authenticate with global credentials.
