# Nearbytes File Events — v0.5

Status: draft normative.

This spec extends `application/file-events-v0.4.md` with application-level
`blockRefs` semantics and causal replay ordering. The inner encrypted payload
verbs remain:

`CREATE_FILE | MKDIR | DELETE | RENAME`

The materializer still owns filesystem effects: implicit directories, recursive
directory deletion, directory rename prefix rewriting, file/directory namespace
conflicts, and conflict/history records are not emitted as extra log events.

## 1. Relationship To `blockRefs`

FILES v0.5 follows `application/blockrefs-v0.1.md`.

Visible `blockRefs` name the direct data dependencies needed for a filesystem
event to have an unambiguous application-level meaning. The list remains
untyped in cleartext. Roles are defined by this FILES spec and by the decrypted
payload.

FILES v0.5 uses three classes of visible dependency:

1. **event-payload dependency**: the channel-local event hash of the last FILES
   event observed by the emitter in the channel's canonical replay order;
2. **direct predecessor dependency**: event hashes for exact-path entries that
   the current event directly updates, useful for previous versions, conflict
   tooling, and reverse replay;
3. **content dependency**: ciphertext block or manifest hashes needed for the
   current event's content or directly superseded previous content.

Only the observed-log-head event dependency participates in replay ordering.

## 2. Observed Log Head

When emitting any FILES v0.5 event, the producer MUST inspect the readable FILES
events already present in the channel and compute the current FILES canonical
replay order (§5). If the ordered set is non-empty, the producer MUST include
the last event hash in visible `blockRefs`.

This hash is the event's **observed log head**.

Rules:

1. The observed log head is channel-local.
2. It is the last event according to the FILES replay order, not according to
   content block lineage, previous-file block hashes, WebDAV validators, local
   filesystem mtime, or transport reception order.
3. All FILES verbs use the same rule. The parent is not path-specific.
4. If no prior FILES event is readable, the parent is omitted.
5. Only v0.4 compatibility events may omit the parent. A v0.5-conformant event
   on a non-empty channel carries it.

The purpose is "no interruptions": a producer that has seen a current winner can
make its next write causally after that winner without locking or rejecting
other writers. Writers that have not seen each other produce concurrent events;
timestamps then break the tie.

## 3. Direct Predecessor Dependencies

Every FILES v0.5 event that directly updates a previous exact-path entry MUST
include that previous entry's event hash in visible `blockRefs`.

This is a direct predecessor rule, not a subtree snapshot rule:

1. it records the entry/entries the operation directly replaces, removes, or
   moves;
2. it supports reverse replay of direct entry history and previous-version
   tooling;
3. it does not create a replay-order edge;
4. it does not expand over directory descendants.

Implementations SHOULD maintain an `entryHead[path]` view during materialization:
the last FILES event in canonical replay order that directly wrote that exact
path. Tombstones count as entry heads.

Implicit directories that exist only because descendants are live do not create
an exact-path `entryHead` by themselves. Operating on such a directory may have
materializer cascade effects, but it does not expand predecessor refs over the
descendants.

Per verb:

| Verb | Direct predecessor event refs |
| --- | --- |
| `CREATE_FILE(path)` | `entryHead[path]`, if any |
| `MKDIR(path)` | `entryHead[path]`, if any |
| `DELETE(path)` | `entryHead[path]`, if any |
| `RENAME(fromPath, toPath)` | `entryHead[fromPath]`, if any; then `entryHead[toPath]`, if any and different |

If the same event hash is also the observed log head, one clear occurrence is
enough. The first occurrence still serves as the replay parent; the predecessor
role is recovered from this FILES rule and the decrypted payload.

## 4. Content Dependencies

FILES v0.5 producers MUST include the direct content dependencies specified
below in visible `blockRefs`.

### 4.1 Introduced Content

`CREATE_FILE` MUST include the block hash or manifest hash named by the
encrypted content descriptor:

1. `nb.content.single.v1.blockHash`, or
2. `nb.content.manifest.v1.manifestHash`.

This lets sync and backup fetch the content needed by the new file without
decrypting the event first.

### 4.2 Previous Content

When a direct predecessor entry is a file, the producer MUST include that file's
current content block or manifest hash as a
previous-content dependency.

Per verb:

| Verb | Previous-content refs |
| --- | --- |
| `CREATE_FILE(path)` | content of previous `entryHead[path]` if it is a file |
| `DELETE(path)` | content of previous `entryHead[path]` if it is a file |
| `MKDIR(path)` | content of previous `entryHead[path]` if it is a file |
| `RENAME(fromPath, toPath)` | content of previous source entry if it is a file; content of previous target entry if it is a file |

Previous-content refs are useful for version browsing, WebDAV-oriented
validators, richer conflict tooling, retention of directly superseded file
content, and inverse reconstruction of direct file updates. They do not order
replay.

### 4.3 No Cascade Expansion

Directory effects are materializer semantics, not `blockRefs` expansion.

`DELETE dir` and `RENAME dir other` MUST NOT list every descendant file block or
event. If `dir` is an exact live file, it may contribute that one file's content
ref. If `dir` is a directory, descendant content refs are omitted.

## 5. Canonical Replay Order

FILES v0.5 replay is a deterministic topological extension of the event-parent
graph.

For each readable FILES event `E`:

1. inspect the event according to this spec;
2. if the first visible `blockRefs` entry exists and names a readable event in
   the same channel, treat that hash as `E`'s observed-log-head parent and add
   an edge `parent -> E`;
3. ignore every other `blockRefs` entry for ordering, including direct
   predecessor event refs and content refs.

If the first visible ref is absent, `E` has no observed-log-head parent. If the
first visible ref is the introduced-content hash declared by a `CREATE_FILE`
payload, a v0.4-compatible reader treats it as content, not as a parent. If the
first visible ref is neither a readable same-channel event nor a payload-declared
content dependency, the FILES projection SHOULD treat `E` as pending a missing
dependency instead of replaying it as a root event.

The canonical order is then computed with a Kahn-style topological sort:

1. start with every readable event whose observed-log-head parent is omitted or
   already emitted;
2. repeatedly emit the ready event with the smallest FILES timestamp;
3. if ready timestamps tie, emit the event with the smallest event hash;
4. after emitting an event, make its children ready when all their parents have
   been emitted.

Implementations MUST NOT implement replay as a pairwise comparator that says
"parent first, otherwise timestamp". Parent constraints and timestamp
preferences over unrelated events can otherwise form a non-transitive comparator.

The FILES timestamp is:

| Verb | Timestamp field |
| --- | --- |
| `CREATE_FILE` | `createdAt` |
| `MKDIR` | `createdAt` |
| `DELETE` | `deletedAt` |
| `RENAME` | `renamedAt` |

This makes timestamps a tiebreak among currently replayable events, not a causal
source of truth. If `B` names `A` as its observed log head, `A` replays before
`B` regardless of wall-clock skew.

## 6. Materialization And Conflicts

v0.5 changes conflict handling from first-writer-wins shadows to causal
last-writer-wins over the canonical replay order:

1. events are atomic syntax;
2. implicit ancestors, directory cascades, and prefix rewrites are computed by
   replay;
3. same-file `CREATE_FILE` overwrites are last-writer-wins in canonical replay
   order;
4. target conflicts are resolved by the later valid event in canonical replay
   order, including file/file replacement, file/directory replacement, and
   `RENAME` over an existing target;
5. overwritten entries SHOULD remain visible in history/version tooling through
   direct predecessor refs, but they are not live filesystem state.

Therefore "last wins" in v0.5 means: causal parents force later replay, and
timestamps choose among concurrent candidates. The materializer still decides
how a later replayed event affects the live filesystem state.

Valid operations SHOULD NOT be rejected merely because the target currently
exists or has the opposite kind. For example, a later `CREATE_FILE(foo)`
replaces a live directory entry at `foo`, a later `MKDIR(foo)` replaces a live
file entry at `foo`, and a later `RENAME(a, b)` replaces the live target at
`b`. Directory descendants affected by that namespace change are still derived
materializer effects and are not listed as refs.

Operations whose source does not exist, such as `RENAME(missing, dst)`, are
recorded in history but do not change live state unless a future spec defines an
explicit tombstone effect for them.

`RENAME` operations that would create an invalid namespace topology, such as
renaming a directory into itself, are also recorded in history without changing
live state.

## 7. Visible Ref Layout

The envelope remains `blockRefs: Hash[]`; this section specifies producer
ordering, not typed wire fields.

Normative emission order:

1. observed log head event hash, if present;
2. direct predecessor event refs in the per-verb order of §3;
3. previous-content refs in the per-verb order of §4.2;
4. introduced-content refs from §4.1.

Consumers MUST NOT rely on duplicate occurrences. If a previous-content hash and
introduced-content hash are identical, one occurrence is sufficient because the
same content-addressed bytes satisfy both roles.

## 8. Encrypted Metadata

Typed role annotations, merge hints, and UI-oriented explanations SHOULD be
stored inside the encrypted payload or a future encrypted metadata field. They
SHOULD NOT be added as cleartext typed fields to the envelope.

WebDAV `If-Match` / client-observed ETags MAY be retained in an optional
encrypted field, e.g. `clientObservedEtag`. This value is the version the client
claimed to have seen before writing; it is not the semantic replay parent.

The semantic replay parent is always the observed log head at commit time, not a
client-supplied validator.

## 9. Compatibility

v0.4 events remain valid. A v0.5 reader treats a v0.4 event with no observed log
head as concurrent with other events unless an implementation-specific migration
provides a parent edge.

Current implementations that still sort by timestamp before reading `blockRefs`
are v0.4-compatible but not fully v0.5-conformant.

## 10. Implementation Checklist

1. Emit the observed log head for every FILES event when the channel is non-empty.
2. Emit direct predecessor event refs for exact-path entries updated by the event.
3. Emit previous content blocks for direct predecessor files.
4. Emit introduced content blocks for `CREATE_FILE`.
5. Do not emit descendant refs for directory cascades.
6. Replay with parent-topological order and timestamp/event-hash tiebreaking.
7. Resolve valid target conflicts as latest-wins in canonical replay order.
8. Keep clear refs untyped; put role-rich metadata in ciphertext.

## 11. In-Memory Channel Log (Conforming Runtimes)

This section is normative for long-lived FILES runtimes (`nbf` REPL, WebDAV
server in the same process). It does not change on-disk log format.

1. After the first successful replay of a channel in a process, implementations
   SHOULD retain **hydrated** `EventLogEntry` values in causal replay order until
   the process exits or the channel is explicitly marked stale.
2. Read APIs (`timeline`, directory listings including REPL `ls`, WebDAV
   `PROPFIND`/`GET`) SHOULD use the retained log without re-reading every event
   file from storage on each call when the cache is warm.
3. After a locally emitted event, implementations MUST append the hydrated entry
   to the retained log and update materialized state without reloading the full
   channel from storage.
4. When storage may have been modified externally, implementations MUST refresh
   before serving reads. Refresh SHOULD fetch and verify only event hashes not
   already present in the retained log when the causal prefix is unchanged.
5. Incremental materialization over an appended suffix MUST produce the same live
   filesystem as full replay.

Reference implementation: `FileService` replay cache, `loadFileReplayContext`,
`extendFileReplayContext`, and `markReplayStale` in `nearbytes-files`.
