# nearbytes-files

File protocol package for Nearbytes.

`nearbytes-files` owns encrypted file volumes on top of the Nearbytes event log:
file event codecs, file encryption helpers, volume replay/materialization, and
the `FileService` library API. It does not own the user-facing CLI anymore.

For the command-line app, REPL, WebDAV mount, profile/friend commands, and chat
commands, use [`nearbytes-cli`](https://github.com/nearbytes/nearbytes-cli).
For hub-scoped chat records, use
[`nearbytes-chat`](https://github.com/nearbytes/nearbytes-chat).

## Install

```sh
yarn install
yarn build
yarn type-check
```

Needs Node 18+ and Git.

This package is not published to npm. Other Nearbytes repos consume it with a
pinned GitHub dependency:

```json
{
  "dependencies": {
    "nearbytes-files": "github:nearbytes/nearbytes-files#<commit-sha>"
  }
}
```

## What This Package Owns

- `FileService` for adding, listing, reading, deleting, renaming, and importing
  files in a Nearbytes channel.
- FILES event replay and materialization.
- File crypto helpers for encrypting/decrypting content and wrapping keys.
- Source/recipient file reference bundles.
- Volume helpers over `nearbytes-log` channels.
- Timeline projection of file events and generic app records that appear in a
  hub/volume log.

## What Moved

The old `nbf` CLI documentation and runtime now live in
[`nearbytes-cli`](https://github.com/nearbytes/nearbytes-cli). In particular:

- REPL usage (`yarn repl`, `volume add`, `file add`, `timeline`, etc.).
- WebDAV local mount.
- profile/friend management.
- sync diagnostics (`peers`, `monitor`, `whoami`).
- hub-scoped chat (`say`, `chat`).

`nearbytes-files` still exports file protocol primitives that the CLI consumes.

## Library Usage

```ts
import { createFileService } from 'nearbytes-files';
import { createFilesystemLog } from 'nearbytes-log';
import { createCryptoOperations } from 'nearbytes-crypto';

const log = createFilesystemLog('/path/to/data');
const crypto = createCryptoOperations();
const files = createFileService({ log, crypto });

const meta = await files.addFile(
  'myvol:password',
  'hello.txt',
  Buffer.from('Hello!'),
);

const list = await files.listFiles('myvol:password');
const data = await files.getFile('myvol:password', meta.blobHash);
```

Main exports include:

- `FileService`, `createFileService`
- `openVolume`, `materializeVolume`, `replayEvents`
- `loadFileReplayContext`, `replayContextThrough`
- file crypto helpers
- reference bundle codecs
- path helpers
- file/timeline metadata types

## Protocol Notes

A volume is a Nearbytes channel derived from a secret string, commonly
`name:password`. The same secret deterministically maps to the same channel
keypair.

Persistent data is stored by `nearbytes-log`:

```text
<dataDir>/
  blocks/<hash>.bin
  channels/<pubkey-hex>/
```

FILES replay is deterministic over the channel event log. File operations affect
only file materialization; other `APP_RECORD` payloads, such as identity or chat
records, are preserved in timeline projections but do not mutate file state.

## Specs

Normative specs live in
[`nearbytes-specs`](https://github.com/nearbytes/nearbytes-specs):

- `application/file-events-v0.5.md`
- `application/blockrefs-v0.1.md`
- `storage/log-api-v1.md`

The CLI/WebDAV specs are implemented by `nearbytes-cli` and referenced there.
