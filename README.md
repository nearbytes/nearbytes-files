# nearbytes-files

Encrypted file volumes on a cryptographic event log — library (`FileService`) and CLI (`nbf`).

## Setup

From this repo (requires sibling packages `nearbytes-crypto`, `nearbytes-log`, `nearbytes-skeleton`):

```sh
yarn install
yarn build
```

## CLI (`nbf`)

### Run

| Command | What it does |
|---------|----------------|
| `yarn repl` | Interactive REPL |
| `yarn nbf -- <args>` | One-shot command (e.g. `yarn nbf -- file list -s "myvol:pass"`) |
| `yarn nbf repl` | Same as `yarn repl` |
| `npx nbf …` | After install, if the `nbf` bin is linked |

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

`volume open` only **reads** and replays this data into memory. Writes happen on `file add` / `file rm` (new events and blocks). Session state (open volumes, active volume) is in-process only and is lost when the CLI exits.

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

After `volume open`, file commands use the active volume (no `-s` needed). `timeline` prints the volume’s event audit log (creates, deletes, renames, …) in replay order. Type `help` in the REPL for the full command list.

### One-shot examples

```sh
yarn nbf -- setup -s "myvol:password"
yarn nbf -- volume open -s "myvol:password"
yarn nbf -- file add -p ./hello.txt -s "myvol:password"
yarn nbf -- file list -s "myvol:password"
yarn nbf -- timeline -s "myvol:password"
yarn nbf -- file get -n hello.txt -o /tmp/hello.txt -s "myvol:password"
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

## Testing

| Script | What it does |
|--------|----------------|
| `yarn e2e:bidirectional:local` | Bidirectional 1 MiB friend-sync smoke + hash verify (~12s wall) |
| `yarn test:sync-bidirectional:local` | Same as above |

Performance benchmarks and paper campaigns live in **`nearbytes-benchmarks`** (sibling repo).

Requires sibling packages built (`nearbytes-log`, `nearbytes-sync` via `nearbytes-skeleton`). Run `yarn build` before e2e.

## Install as dependency

```sh
yarn add nearbytes/nearbytes-files#main
```
