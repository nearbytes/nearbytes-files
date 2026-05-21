# nearbytes-files

High-level file API for Nearbytes encrypted volumes.

## What's inside

- **`FileService`** — the primary interface: `addFile`, `listFiles`, `getFile`, `deleteFile`, `renameFile`, `renameFolder`, and timeline/snapshot/reference-exchange methods
- **`createFileService({ log, crypto })`** — factory wired to a `nearbytes-log` `Log` and a `nearbytes-crypto` `CryptoOperations`
- **Volume replay** — `openVolume`, `loadEventLog`, `replayEvents`, `materializeVolume`, `listFiles`, `getFile`
- **File crypto** — `encryptFileForVolume`, `decryptFileForVolume`, `wrapFileKeyForVolume`, `unwrapFileKeyForVolume`, and recipient key capsule helpers
- **Reference bundles** — portable, serialisable file bundles for cross-volume sharing (`SourceReferenceBundle`, `RecipientReferenceBundle`)
- **Types** — `FileMetadata`, `FileEvent`, `VolumeFileSystemState`, `TimelineEvent`, `EventDetail`, …

## Install

```sh
yarn add nearbytes/nearbytes-files#main
```

## Quick start

```ts
import { createFileService } from 'nearbytes-files';
import { createLog } from 'nearbytes-log';
import { createCryptoOperations } from 'nearbytes-crypto';
import { FilesystemStorageBackend } from 'nearbytes-storage';

const storage = new FilesystemStorageBackend('/path/to/data');
const log     = createLog(storage);
const crypto  = createCryptoOperations();
const files   = createFileService({ log, crypto });

// Add a file
const meta = await files.addFile('myvol:password', 'hello.txt', Buffer.from('Hello!'));

// List files
const list = await files.listFiles('myvol:password');

// Retrieve a file
const data = await files.getFile('myvol:password', meta.blobHash);
```

## Package structure

```
src/
  fileService.ts        — FileService interface + createFileService() factory
  volume.ts             — Volume, VolumeFileSystemState, openVolume, materializeVolume, replayEvents
  fileEvents.ts         — FileMetadata, FileEvent union types
  operations.ts         — low-level storeData / retrieveData / deleteFile / setupChannel
  fileCrypto.ts         — per-file encryption helpers, volume ID encoding
  fileReferenceCodec.ts — SourceReferenceBundle / RecipientReferenceBundle serialisation
  fileEventCodec.ts     — encodeFileEvent / decodeFileEvent
  fileCommands.ts       — dedupeOrderedFilenames, resolveImportedFilename
  chatCodec.ts          — identity and chat message types
  fileState.ts          — reconstructFileState
```
