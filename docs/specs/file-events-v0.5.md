# file-events-v0.5 — semantic `blockRefs`

Package-local summary of the normative spec in
`nearbytes-specs/application/file-events-v0.5.md`.
Design notes: `nearbytes-design/design/file-events-v0.5.md`.

v0.5 keeps the v0.4 inner payload verbs:

`CREATE_FILE | MKDIR | DELETE | RENAME`

The envelope `blockRefs` remain an untyped cleartext hash list. FILES assigns
application-level roles to direct dependencies only.

## Clear Refs

Normative producer order:

1. **observed log head**: for every v0.5 event on a non-empty channel, the last
   FILES event already visible in this channel's canonical replay order at emit
   time;
2. **direct predecessors**: exact-path entry event heads directly updated by the
   event;
3. **previous content**: content block/manifest for direct predecessor files;
4. **introduced content**: new content block/manifest for `CREATE_FILE`.

Only the observed log head creates a replay edge. Direct predecessor refs and
content refs help sync, backup, reverse replay, previous-version browsing,
WebDAV-oriented validators, and richer conflict tools; they do not order events.
If the first ref is neither a readable same-channel event nor the
payload-declared introduced content hash for a v0.4-compatible `CREATE_FILE`,
the projection should wait for the missing dependency rather than replaying the
event as a root.

Directory operations MUST NOT expand refs over descendants. The recursive effect
of `DELETE dir` and `RENAME dir other` remains materializer semantics.

## Replay

Replay uses a Kahn-style deterministic topological sort:

1. parents are emitted before children;
2. among currently ready events, the smallest FILES timestamp is emitted first;
3. if ready timestamps tie, the smallest event hash is emitted first.

Timestamps are therefore not causal truth. If event `B` names event `A` as its
observed log head, `A` replays before `B` even if `B` has the older wall-clock
timestamp.

Valid target conflicts are latest-wins in that canonical replay order. For
example, a later `CREATE_FILE(foo)` replaces a live directory entry at `foo`, a
later `MKDIR(foo)` replaces a live file entry at `foo`, and a later
`RENAME(a, b)` replaces the live target at `b`.

## WebDAV / If-Match

WebDAV writes remain "no interruptions": `If-Match` is accepted as client intent
but MUST NOT force 412 gating. The semantic parent is the actual observed log
head at commit time. A client-observed ETag MAY be retained in an optional
encrypted field such as `clientObservedEtag`.

## Implementation Status

The current implementation uses the v0.5 replay and emission model:

1. emits observed log head for every filesystem event on a non-empty channel;
2. emits direct predecessor refs and previous-content refs;
3. replays topologically over observed-log-head refs;
4. uses timestamps only between currently ready events;
5. resolves valid target conflicts as latest-wins.

### Materialization

- **Full replay** from ordered canonical entries is canonical.
- **Incremental replay** from an existing materialized state plus appended entries
  is allowed when the newly ordered stream preserves the previous ordered prefix.
- Incremental replay MUST be observationally equivalent to full replay.

### In-memory channel log (`FileService`)

Conforming `nearbytes-files` runtimes keep the hydrated channel log in memory per
secret:

- **cold**: load from `nearbytes-log`, verify, order, materialize once;
- **warm**: serve `timeline`, listings, and WebDAV from cache without re-reading disk;
- **local append**: after each emitted event, extend the cache in memory (no full reload);
- **stale**: after external `dataDir` changes, merge only new events from disk on the next read.

`loadFileReplayContext` implements cold load and stale merge. `extendFileReplayContext`
implements local append. WebDAV and CLI share the same cache through `getReplayContext`.

### Historical prefix replay (timeline cursor)

For audit and read-only projection (`webdav-v2.md`, REPL `timeline goto`):

1. Given cursor event hash `H`, materialized state MUST equal full replay of the
   ordered entry prefix **through `H` inclusive** in causal replay order.
2. Prefix materialization MUST be observationally equivalent to truncating the
   live replay after applying events up to `H`.
3. Mutating APIs MUST NOT append at `H`; commits always use the **live** observed
   log head on disk (see `webdav-v2.md` §Writes always target live head).
