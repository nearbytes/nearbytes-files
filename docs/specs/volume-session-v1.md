# volume-session-v1 — registered volumes, retention, and REPL session

Status: normative target for `nearbytes-files` REPL.
Design: `nearbytes-design/design/volume-session-v1.md`.
Normative cross-repo: `nearbytes-specs/application/volume-session-v1.md`.

## 1. Scope

This document specifies how the `nbf` REPL registers file volumes (channel
secrets), which volumes appear in a session, and how that set is persisted
under `dataDir`. It does not define FILES event semantics; see
`file-events-v0.5.md`.

WebDAV exposure of registered volumes is defined in `webdav-v2.md`.

## 2. Volume identity and directory name

1. A volume secret MUST be `volumeName:password` (same as today).
2. The **volume directory name** exposed to users and WebDAV (`/<volumeName>/`)
   MUST be the `volumeName` prefix (text before the first `:`).
3. Implementations MUST NOT list or materialize a channel without the secret.
   Unknown channels on disk under `channels/<pubkey-hex>/` are invisible until
   the user registers the matching secret.

A future information protocol MAY add display aliases; v1 uses the prefix only.

## 3. Register-then-use (profile-like)

Volume handling mirrors sync **profiles** (`profile add` / `profile use`):

| Command | Behavior |
|---------|----------|
| `volume add <name> <secret>` | Register `name` → `secret` in session retention, open the channel, add to the **open** set. If no active volume, set active to this volume. `name` SHOULD equal the secret prefix but MAY differ (stored mapping). |
| `volume use <name>` | Set **active** volume to a registered entry. MUST fail if `name` is not registered. Does not prompt for a secret. |
| `volume forget <name>` | Remove from retention and open set; stop watcher; close in-memory state. If active, clear active (no auto-pick of another volume). |
| `volume list` | List registered volumes; mark active with `▶`. |

Aliases:

- `open <secret>` MAY remain as sugar for `volume add <prefix> <secret>` followed by
  activation when `<prefix>` is derived from the secret.
- `use <name>` is an alias for `volume use <name>` once registered.
- `forget <name>` is an alias for `volume forget <name>`.
- `volumes` lists the **open** set in the current process (same as registered
  after restore).

`volume add` is the only command that reads a new secret from the REPL line
during normal operation. After registration, `volume use` and WebDAV path lookup
use the stored mapping.

## 4. Retention file

1. Path: `<dataDir>/.nearbytes/volume-session.json` (implementation MAY use an
   equivalent path under `.nearbytes/`).
2. File mode MUST be **`0600`** on create and update (owner read/write only).
3. Contents (illustrative):

```json
{
  "volumes": [
    { "name": "test2", "secret": "test2:…" },
    { "name": "myvol", "secret": "myvol:…" }
  ],
  "active": "test2"
}
```

4. On REPL start, implementations SHOULD load this file and open every listed
   volume (same as config auto-open, but session-scoped secrets live here).
5. `volume add` / `volume forget` MUST update the file atomically.
6. Timeline cursor state MUST NOT be persisted in v1 (see §5).

Config `volumes[]` in `~/.nearbytes/config.json` remains optional bootstrap;
session retention is the source of truth for “what is open” across REPL runs.

## 5. Active volume and timeline cursor

1. Exactly one volume is **active** at a time when any is registered.
2. **Timeline navigation** (historical read-only view) applies only to the
   active volume.
3. Changing active volume (`volume use`, or `open` on another volume) MUST
   **reset** the timeline cursor to **live head** for the new active volume.
4. Timeline cursor MUST NOT be written to `volume-session.json` in v1.

## 6. Security

1. Session file holds channel secrets in cleartext, like config profiles.
2. Mode `0600` is mandatory; loaders SHOULD refuse looser permissions (same
   policy as `config.json` in nearbytes-skeleton).
3. Without a registered secret, no channel data is exposed via REPL or WebDAV.
