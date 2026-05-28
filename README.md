# nearbytes-files

Encrypted file volumes on a cryptographic event log — library (`FileService`) and CLI (`nbf`).

## Setup

Internal deps (`nearbytes-crypto`, `nearbytes-log`, `nearbytes-skeleton`, …) are pinned in `package.json` as `github:nearbytes/<pkg>#<commit-sha>` and resolved by `yarn install` — there is no sibling-checkout requirement. Yarn 4.15 (Corepack-managed via the `packageManager` field) fetches each pinned commit, runs its `prepack: tsc`, and caches the resulting tarball in `yarn.lock`.

First-time bootstrap (macOS, Linux, Windows; needs Node 18+ and Git):

```sh
git clone https://github.com/nearbytes/nearbytes-files.git
cd nearbytes-files
yarn install
yarn repl
```

That's it — no other Nearbytes repos need to be checked out locally.

When something in another Nearbytes repo's `main` moves, refresh internal deps to the latest published commits:

```sh
yarn update
```

This bumps every `github:nearbytes/<pkg>#<sha>` entry in `package.json` to the current HEAD of its `main` branch on GitHub and re-runs `yarn install`. Commit the resulting `package.json` + `yarn.lock` to publish the new combination.

When pushing changes to multiple Nearbytes repos at once, run `yarn update` + `git commit` + `git push` in each downstream repo in topological order: `nearbytes-crypto → log → sync → skeleton → files → benchmarks`.

## CLI (`nbf`)

### Run

| Command | What it does |
|---------|----------------|
| `yarn repl` | Interactive REPL (no subcommand → REPL is the default) |
| `yarn repl -d <dir>` | REPL against a custom data directory |
| `yarn nbf <args>` | One-shot command (e.g. `yarn nbf file list -s "myvol:pass"`) |
| `yarn nbf -d <dir> <subcmd>` | Any subcommand against a custom data directory |
| `yarn nbf repl` | Same as `yarn repl` |
| `npx nbf …` | After install, if the `nbf` bin is linked |

Global flags (`-c <config>`, `-d <data-dir>`) must precede the subcommand (or be passed alone for the REPL default).

> **Yarn 4 note:** do **not** use `--` between the script name and the args (e.g. `yarn repl -- -d /tmp/foo`). Yarn 4 forwards `--` literally to the node process, where Commander reads it as the POSIX end-of-options sentinel and treats `-d /tmp/foo` as positional args, so the flag is silently dropped. Just drop the `--`: `yarn repl -d /tmp/foo`. The old `npm`-style `-- <args>` separator is unnecessary on Yarn 4.

### Secrets

A volume is identified by a secret string, usually `name:password` (e.g. `myvol:password`). The same secret always maps to the same volume keys. There is no separate “register secret” step — you pass it on each command, open it in the REPL, or list it in config (below).

### Storage

Persistent data lives under a **storage root** (`dataDir`):

- Default: `~/nearbytes/local`
- Override: `-d /path`, `dataDir` in config, or env `NEARBYTES_STORAGE_DIR`

Layout:

```
<dataDir>/
  blocks/<hash>.bin           # encrypted file blobs
  channels/<pubkey-hex>/      # signed events per volume
```

`volume open` only **reads** and replays this data into memory. Writes happen on `file add` / `file rm` (new events and blocks).

**Volume session (v1 target):** registered volumes persist in `<dataDir>/.nearbytes/volume-session.json` (`0600`). Use `volume add` / `volume use` / `volume forget` (profile-style: register the secret once, then switch by name). See `docs/specs/volume-session-v1.md`.

Config (optional): `~/.nearbytes/config.json` — override with `-c` or `NEARBYTES_CONFIG`.

```json
{
  "dataDir": "/path/to/local",
  "volumes": [
    { "label": "My volume", "secret": "myvol:password" }
  ]
}
```

Volumes in config auto-open when you start `yarn repl`.

The config file contains volume (and profile) secrets in cleartext. Both `nbf` and `nbsync` refuse to load a config whose POSIX mode is anything looser than `0o600` (owner read+write only) — see the [skeleton README](https://github.com/nearbytes/nearbytes-skeleton#config-file-permissions). `writeConfig` always produces a `0o600` file; if you wrote the file by hand and the loader rejects it, `chmod 600 ~/.nearbytes/config.json`.

### Running alongside `nbsync`

The `nbf` CLI is safe to use against the same `dataDir` as a running [`nbsync`](https://github.com/nearbytes/nearbytes-sync) daemon. The skeleton's `bootSync` probes the sync-singleton lock on start: if the daemon holds it, `nbf` boots in writer-only mode (no swarm sockets, no peer-loop) and writes events/blocks straight to the shared `dataDir`. The daemon notices the new files via its filesystem watcher (DISC-27.4) and announces them to peers. From a remote peer's perspective `nbf`-authored events are indistinguishable from daemon-authored ones. No IPC, no flag, no coordination — just open the same `dataDir`.

### REPL

```sh
yarn repl
```

```
setup myvol:password          # show public key (no disk write)
volume open myvol:password    # open + list files
file add ./doc.pdf            # uses active volume
file list
file get readme.txt /tmp/out
help
exit
```

Tab completes commands, secrets, file names, and paths (Windows paths with `\` or `~` work). Command history persists in `~/.nearbytes/nbf-history` (override with `NEARBYTES_REPL_HISTORY`). Use `^R` for reverse search, `^C` to clear the line (does not exit), `^D` or `exit` to quit. Works on macOS, Linux, and Windows (Node 18+).

After `volume open` (or `volume add` + `volume use`), file commands use the active volume (no `-s` needed).

**Timeline:** `timeline` lists events in causal replay order. `timeline goto <n|date>` moves a read-only cursor (1-based index or first event after a parsed date). `timeline live` returns to the head. The cursor applies only to the active volume, resets when you switch volumes, and is not persisted. While the cursor is before the head, WebDAV shows that historical snapshot (read-only); writes always commit at the live log head.

Type `help` in the REPL for the full command list.

### WebDAV

Starting the REPL also starts the local HTTPS WebDAV server (requires an **active sync profile** — `profile add` / `profile use`).

```sh
yarn repl
```

**v2 mount:** one Finder mount for all registered volumes:

```text
https://127.0.0.1:9843/
  myvol/…
  test2/…
```

1. Register volumes: `volume add myvol myvol:password` (secret entered once).
2. `volume use myvol` sets the active volume (timeline cursor resets).
3. Connect to `https://127.0.0.1:9843/` with **global** HTTP Basic (tied to the active profile; re-auth after `profile use`).
4. Only registered volume names appear; channels without a registered secret are never listed.

**Legacy v1 per-volume URLs** are no longer served by the REPL listener; use the single root above.

The server binds to `127.0.0.1` with a local self-signed certificate. On macOS use **Go → Connect to Server…**.

**Performance:** each volume keeps its hydrated event log and materialized filesystem in memory after the first access. `timeline`, `ls`, and WebDAV reads are instant on a warm cache; only the first open (or a sync from another process) reloads events from disk.

**Debug flags** (no environment variables):

```sh
yarn repl --debug webdav,timing
yarn repl --webdav-port 9844
```

Specs: `docs/specs/webdav-v2.md`, `docs/specs/volume-session-v1.md`, `docs/specs/webdav-v1.md` (transport and replay cache).

### One-shot examples

```sh
yarn nbf setup -s "myvol:password"
yarn nbf volume open -s "myvol:password"
yarn nbf file add -p ./hello.txt -s "myvol:password"
yarn nbf file list -s "myvol:password"
yarn nbf timeline -s "myvol:password"
yarn nbf file get -n hello.txt -o /tmp/hello.txt -s "myvol:password"
```

## Library

```ts
import { createFileService } from 'nearbytes-files';
import { createFilesystemLog } from 'nearbytes-log';
import { createCryptoOperations } from 'nearbytes-crypto';

const log = createFilesystemLog('/path/to/data');
const crypto = createCryptoOperations();
const files = createFileService({ log, crypto });

const meta = await files.addFile('myvol:password', 'hello.txt', Buffer.from('Hello!'));
const list = await files.listFiles('myvol:password');
const data = await files.getFile('myvol:password', meta.blobHash);
```

Main exports: `FileService`, `createFileService`, volume replay (`openVolume`, `materializeVolume`, `replayEvents`), file crypto helpers, reference bundles, and types (`FileMetadata`, `VolumeFileSystemState`, …).

## Install as dependency

This package isn't published to npm. Other repos in the Nearbytes set consume it via `github:nearbytes/nearbytes-files#<commit-sha>` pinned in their `package.json`, with `yarn.lock` committed alongside.
