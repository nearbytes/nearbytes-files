# WebDAV + FILES v0.5 `blockRefs` Design

Status: working draft for final discussion.

## Scope

- Implement WebDAV in `nearbytes-files`, served only on localhost over HTTPS.
- Preserve `FileService` as the single authoritative API for filesystem
  operations.
- Use visible event-envelope `blockRefs` as application-level dependencies:
  the data needed for the current event to have an unambiguous FILES meaning.
- Keep cleartext refs untyped. Role-rich metadata belongs in ciphertext.
- Move FILES replay from timestamp-first ordering to topological replay over the
  FILES observed-log-head dependency, with timestamps only as concurrency
  tiebreaks.

## Product Behavior

- Mount URL: `https://host/<volume-name>/...`
- Basic auth:
  - `username = <volume-name>`
  - `password = <secret-part>`
  - effective channel secret = `username:password`
- Any volume name is accepted dynamically; no config pre-registration.
- Wrong credentials must not leak other volumes: empty history / decrypt-failure
  semantics only.
- HTTPS is mandatory for WebDAV credentials.
- Listener binds localhost only by default (`127.0.0.1`).
- WebDAV auto-starts in the REPL/default shell path, not one-shot commands.

## Normative Spec Targets

- `nearbytes-specs/application/blockrefs-v0.1.md`
  - `blockRefs` are visible application-level dependency refs.
  - refs can name event payloads or ciphertext blocks.
  - clear refs are direct dependencies only, not transitive closure.
  - generic storage/sync must not assume all refs are blocks.
- `nearbytes-specs/application/file-events-v0.5.md`
  - all FILES v0.5 events on a non-empty channel carry the observed log head as
    the ordering parent.
  - replay uses a deterministic topological sort over that parent edge.
  - timestamps and event hashes choose among currently replayable events only.
  - direct predecessor refs and content refs do not order replay.
  - valid target conflicts are latest-wins in canonical replay order.

## FILES v0.5 Visible `blockRefs`

Normative clear ref order for FILES v0.5 producers:

1. `observedLogHead`:
   - event hash of the last readable FILES event in this channel's canonical
     replay order at emit time;
   - channel-local;
   - used as the only topological replay parent;
   - mandatory for every v0.5 event on a non-empty channel.
2. direct predecessor refs:
   - event hashes for exact-path entries directly updated by this event;
   - support previous versions, conflict tooling, and reverse replay;
   - not used for replay ordering.
3. previous-content refs:
   - content block/manifest for direct predecessor files;
   - useful for WebDAV/version/conflict tooling, retention, and reverse replay;
   - not used for replay ordering.
4. introduced-content refs:
   - new `CREATE_FILE` content block or manifest hash;
   - needed for sync/backup and materialization availability.

The observed log head is a FILES application-level rule. It is not derived from
block relationships, `fileOrigins`, WebDAV ETags, or local filesystem mtimes.
If the first visible ref cannot yet be resolved as a same-channel event and is
not the payload-declared content hash of a v0.4-compatible `CREATE_FILE`, replay
must treat the event as pending a missing dependency instead of silently making
it a root.

## No Cascade Expansion

Directory cascade is materializer semantics, not `blockRefs` expansion.

- `DELETE dir` must not list every descendant event/block.
- `RENAME dir other` must not list every descendant event/block.
- Exact-path file dependencies are allowed.
- Exact-path predecessor event refs are mandatory when an entry head exists.
- Directory/prefix-wide causal anchors are out of scope unless a future spec
  introduces one explicit compact anchor.

## Replay And Tiebreaking

FILES v0.5 replay order:

1. Build edges only from the observed-log-head event ref to the current event.
2. Run a Kahn-style topological sort.
3. At each step, among currently ready events, choose the smallest FILES
   timestamp.
4. If ready timestamps tie, choose the smallest event hash.

Do not implement this as a pairwise comparator of "parent first, otherwise
timestamp": parent constraints and timestamp preferences can otherwise become
non-transitive.

This gives causal last-wins behavior:

- if `B` saw `A`, `B` replays after `A` regardless of clock skew;
- if `A` and `B` are both ready and concurrent, timestamp/hash decides;
- no lock or overwrite failure is required to preserve deterministic history.

The materializer still owns filesystem semantics. Same-file overwrites and valid
target conflicts are last-writer-wins in replay order: file/file replacement,
file/directory replacement, and `RENAME` over an existing target all replace the
previous live target. Invalid operations with no source, or invalid namespace
topology such as renaming a directory into itself, remain history entries that
do not change live state unless a later spec assigns tombstone semantics.

## Cleartext vs Ciphertext

Keep cleartext to the minimum needed by sync, backup, retention, and deterministic
application replay.

Cleartext:

- observed log head event ref;
- direct predecessor event refs for exact-path entries;
- introduced content block/manifest refs;
- direct previous-content block/manifest refs where FILES v0.5 says they are
  direct dependencies.

Ciphertext:

- typed role annotations;
- optional WebDAV `If-Match` / client-observed ETags, e.g.
  `clientObservedEtag`;
- merge hints;
- UI/debug/audit explanations;
- anything not needed by generic sync/backup or replay ordering.

## WebDAV Mapping

`src/webdav/handler.ts` should keep using `FileService` methods:

- `PROPFIND` -> `listFiles` + `listDirectories`
- `GET`/`HEAD` -> `listFiles` + `getFile`
- `PUT` -> `addFile`
- `DELETE` -> `delete`
- `MKCOL` -> `mkdir`
- `MOVE` -> `rename`

Writes do not fail on `If-Match`. The committed FILES event uses the actual
observed log head at commit time as semantic parent. If retained, the client's
observed ETag is optional encrypted metadata (`clientObservedEtag`), not
cleartext replay metadata.

ETag strategy:

- expose file resources with the live FILES entry head as the WebDAV ETag;
- expose collection resources conservatively with the current channel replay
  head, unless a future implementation computes a narrower directory-listing
  head;
- implicit directories therefore still have a stable event-hash ETag;
- a client `If-Match` value is the previous event/version the client claims to
  have observed;
- retained `If-Match` goes to optional encrypted `clientObservedEtag`;
- current implementation still derives from `fileOrigins[path]`, which is only
  content-origin and must be replaced for full v0.5 conformance.

## Current Code Baseline

Already present:

- `src/fileEmit.ts`
  - central `emitFileEvent(...)`
  - current lineage helpers based on materialized state
- `src/fileLogEntries.ts`
  - canonical mapping
- `src/fileService.ts`
  - mutators routed through emit helpers
- `src/webdav/*`
  - server, handler, auth, TLS, XML
- REPL integration:
  - `src/cli/context.ts`
  - `src/cli/index.ts`

Known gaps against v0.5:

- emitters must add observed-log-head event refs for every FILES event;
- emitters must add direct predecessor event refs and previous-content refs
  uniformly;
- replay/materialization must sort topologically over those parent refs;
- materializer conflict handling must become latest-wins for valid target
  conflicts;
- current `fileOrigins` is content-origin, not observed log head;
- current WebDAV ETags are content-origin based and must become file entry heads
  or conservative collection replay heads;
- tests must cover clock skew, concurrent branches, and "saw latest winner"
  overwrites.

## Acceptance Checklist

- [ ] `blockrefs-v0.1` accepted as generic visible dependency spec
- [ ] `file-events-v0.5` accepted as FILES ordering/content-ref spec
- [ ] all FILES writes emit observed-log-head parent when channel is non-empty
- [ ] all FILES writes emit direct predecessor refs for exact-path entry updates
- [ ] direct predecessor files emit previous-content refs
- [ ] replay is topological over observed-log-head refs
- [ ] timestamps are tiebreaks only among currently ready events
- [ ] valid target conflicts are latest-wins
- [ ] no directory cascade expands descendant refs
- [ ] clear refs remain untyped; typed metadata remains encrypted
- [ ] WebDAV writes go through `FileService`
- [ ] localhost-only HTTPS enforced by default
- [ ] Basic auth volume mapping implemented
- [ ] REPL starts/stops WebDAV; one-shot commands do not
