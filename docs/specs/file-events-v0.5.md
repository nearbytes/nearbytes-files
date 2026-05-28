# file-events-v0.5 — semantic `blockRefs`

Package-local summary of the normative spec in
`nearbytes-specs/application/file-events-v0.5.md`.

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

## Implementation Gap

The current implementation emits v0.5-shaped content lineage, but still needs
the full v0.5 replay upgrade:

1. emit observed log head for every filesystem event;
2. emit direct predecessor refs and previous-content refs uniformly;
3. replay topologically over observed-log-head refs;
4. use timestamps only between currently ready events;
5. update the materializer from first-conflict-wins to latest-wins.
