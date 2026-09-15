# Redis correctness and Durable Object review

Reviewed 2026-09-14. This is a review of the current working tree, including untracked source files, not just the staged diff. Findings describe the implementation before any repairs.

## Verdict

Do not use this implementation for valuable data yet. SQLite inside a Durable Object is a reasonable foundation, but the current server can lose old values after failed writes, accepts configuration changes it does not apply, and has substantial connection and protocol incompatibilities.

The most objectionable code is fake success. `CONFIG SET requirepass secret` returns `OK`, while `HELLO AUTH` ignores the credentials. DUde wtf this is AI slop. that's not supposed to be in a database. Unsupported functionality must fail explicitly; successful replies are promises to callers.

## Verification and limits of this review

- `bun run typecheck`: passed.
- `bun test`: 247 passed, 0 failed, 1,617 assertions.
- Ran targeted local reproductions through the actual dispatcher and Bun SQLite adapter. Demonstrated failed-write data loss, incorrect expiry flags, binary matching collisions, reply framing injection, float parsing/rounding issues, session serialization overflow, and premature SCAN completion.
- Checked current Cloudflare documentation and Redis documentation/source. In particular, current WebSocket attachments allow **16,384 serialized bytes**, not the older 2 KiB limit.
- Did not deploy, run a production fault test, or run the network differential harness. `redis-server` was not available on PATH. The SQLite fault reproduction establishes the application's error-handling behavior; production runtime failure behavior still needs integration tests.
- No implementation files were changed. This document is the review artifact and repair specification, not a claim that the repairs have been made. It is not an exhaustive proof of Redis compatibility.

## Release blockers

### 1. P1: failed writes can destroy existing data

Locations: [dispatch](src/commands/index.ts), [writeStringRow / setDiscardingTtl](src/commands/string.ts), [EXEC](src/do.ts).

`SET` deletes the old value, writes metadata, then inserts the replacement. `dispatch` catches every unexpected exception and returns `ERR internal error`. Nothing restores the preceding changes. Even inside `EXEC`, the enclosing transaction callback sees a normal return rather than the exception that would trigger rollback.

Reproduction: set `k` to `old`; inject a storage exception on `INSERT INTO str`; execute `SET k replacement`. The command returns an internal error, `GET k` returns null, and `TYPE k` still returns `string`. This is both data loss and inconsistent metadata.

The same ordering pattern occurs in destination-overwriting commands and list rewrites. A statement-size, parameter-limit, or row-size error is a normal reachable failure, not just a theoretical disk disaster.

Required: establish explicit failure boundaries around mutations, validate before destructive changes, and translate infrastructure exceptions only after the relevant rollback. Preserve Redis's successful sibling commands on ordinary EXEC command errors. Do not confuse automatic batching with rollback of a caught exception. [Cloudflare transaction semantics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync), [Redis transaction error semantics](https://redis.io/docs/latest/develop/using-commands/transactions/).

### 2. P1: authentication and configuration are pretend implementations

Locations: [HELLO and CONFIG](src/commands/server.ts), [router](src/worker.ts).

`CONFIG SET` accepts arbitrary key/value pairs and returns success without changing anything. `HELLO ... AUTH user password` simply skips those arguments. There is no authentication or authorization check before routing arbitrary `db` names to objects. Someone who can reach an unprotected deployed Worker can read, write, flush, and create named instances.

Reproduced `CONFIG SET requirepass secret` returning `OK` and `HELLO 2 AUTH nobody wrong` succeeding. `CONFIG REWRITE` and `RESETSTAT` are also unconditional successes.

Required: either implement supported configuration faithfully or reject it. Define an explicit trusted-network or authenticated deployment contract, enforce instance access before routing, and never silently accept authentication options.

### 3. P1: hibernation attachments cannot contain these queues

Locations: [Session.encode / toB64](src/session.ts), [persist](src/do.ts).

The attachment includes the entire MULTI queue, partial request, and subscriptions. A single 16 KiB queued value becomes a 21,848-character base64 string before the rest of the attachment is counted. That already exceeds the documented 16 KiB serialized limit. Fragmented ordinary requests can hit the same path. There is no admission limit or spill mechanism.

Separately, spreading a 1 MiB argument into `String.fromCharCode` reproduced `RangeError: Maximum call stack size exceeded`. Chunking base64 conversion fixes only that second failure, not the attachment design.

Required: bounded connection state with attachment references to larger persisted state, or another explicit lifecycle strategy. Account for total queued bytes, partial input, and subscriptions before acknowledging them. [Cloudflare attachment contract](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment).

### 4. P1: connection commands bypass MULTI semantics

Location: [run / connectionCommand](src/do.ts).

The connection-command branch runs before the MULTI queue branch. `MULTI; PUBLISH c x; DISCARD` publishes immediately. SUBSCRIBE and related commands also bypass normal queuing. The special command path has inconsistent arity checks: `MULTI extra` and `EXEC extra` are accepted; PUBLISH accepts surplus arguments. Errors here do not consistently mark the queue dirty.

Required: one command specification and an explicit connection state machine, with per-command queueing and arity rules. WATCH and UNWATCH are absent and must be implemented or identified as unsupported. [Redis transactions](https://redis.io/docs/latest/develop/using-commands/transactions/).

### 5. P1: Pub/Sub has incompatible behavior and framing

Location: [publish / pubsub](src/do.ts).

- Patterns and literal subscriptions share one set; no pattern matching exists. `PSUBSCRIBE foo*` never receives a publication to `foobar`.
- Literal and pattern unsubscribe operations interfere with each other.
- Multi-channel subscription acknowledgements are nested into one array instead of separate replies.
- Unsubscribing with no subscriptions returns an empty array instead of the required acknowledgement with a null channel.
- RESP2 subscribed connections can execute normal database commands, and PING does not have its subscribed reply shape.
- RESP3 messages are arrays, not push frames; the reply model has no push type.
- Channels are decoded as UTF-8, so distinct invalid byte sequences become the same subscription.
- Every publish walks all sockets; a throwing peer send aborts the loop without isolating the failed peer.

Required: separate binary-safe channel/pattern indexes, correct subscription counts and wire frames, subscribed-state rules, and explicit slow/dead-consumer handling. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/), [RESP push frames](https://redis.io/docs/latest/develop/reference/protocol-spec/#pushes).

### 6. P1: user input can inject reply framing

Locations: [unknownCommand](src/errors.ts), [writeTextLine](src/resp.ts), interpolated errors in command handlers.

Unknown command names and arguments are interpolated into simple errors without escaping CR/LF. An unknown command containing `bad\r\n+PWN` produces an error containing a second protocol line. This can desynchronize a pipelined client. Error text can also grow with arbitrary input size.

Required: sanitize untrusted text at the line-reply boundary and bound diagnostic excerpts. Use binary-safe escaped representations for diagnostic input. [RESP line types](https://redis.io/docs/latest/develop/reference/protocol-spec/).

### 7. P1: advertised value limits are impossible with this storage layout

Locations: [RESP limits](src/resp.ts), [string commands](src/commands/string.ts), [CONFIG](src/commands/server.ts), [schema](src/schema.ts).

The server advertises 512 MiB bulk strings while storing an entire value in one SQLite BLOB. Cloudflare limits a BLOB or row to 2 MB. The key and other columns also consume row capacity. The decoder, mutations, and encoder allocate whole values and copies in the Worker heap.

Required: choose and enforce actual limits before allocation or mutation, or implement chunked storage and bounded transfer. A 512 MiB constant copied from Redis is not a working implementation. [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

### 8. P1: valid set operations exceed SQL limits, potentially after deleting their destination

Location: [compound / insertResultDirectly / sintercard](src/commands/set.ts).

One SELECT and parameter are generated per operand. Cloudflare allows 100 bound parameters per statement; 101 input keys exceed that limit. A store operation also binds its destination, so 100 source keys can exceed the limit. The distinct-destination path deletes the destination before attempting the oversized statement, combining with finding 1.

Required: bounded SQL operations or staged set algebra inside a safe mutation boundary. Test parameter and statement limits in the actual runtime. [Cloudflare SQL limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Redis correctness defects

### 9. P1: EXPIRE XX skips GT/LT comparisons

Location: [blockedByFlags](src/commands/keyspace.ts).

`if (flags.xx) return current === null` returns before checking GT or LT. Reproduced: after a 100-second TTL, `EXPIRE k 10 XX GT` returns 1 and shortens the TTL to 10 seconds. It must return 0 and preserve the longer TTL. Evaluate the independent conditions cumulatively. [EXPIRE options](https://redis.io/docs/latest/commands/expire/).

### 10. P1: key and element glob matching is not binary-safe

Locations: [KEYS](src/commands/keyspace.ts), [Store.scan](src/store.ts), [elementScan](src/commands/hash.ts).

Both patterns and keys/fields/members pass through TextDecoder. Reproduced: distinct one-byte keys `ff` and `fe` both match an exact `ff` pattern. Even valid UTF-8 changes the meaning of `?` from one byte to a character/code unit. Storing BLOBs does not make the matching path binary-safe. Implement byte-based Redis glob matching.

### 11. P2: SCAN can silently finish before visiting stable keys

Locations: [Store cursor cleanup](src/store.ts), [element cursor cleanup](src/commands/hash.ts).

Another scan deletes cursor state after 60 seconds of inactivity. Resuming the original cursor then returns `0` and no keys, even though unvisited keys remained present throughout. Reproduced with an injected clock and a second scan. This violates full-iteration guarantees. Cursor IDs are also converted to JavaScript numbers; element cursor parsing accepts arbitrarily long decimal strings without a finite/range check.

Required: a cursor design that preserves the intended iteration guarantees. If cursors can expire, that is a documented incompatibility and must not masquerade as successful completion. [Redis SCAN guarantees](https://redis.io/docs/latest/commands/scan/).

### 12. P1: RESP3 sorted-set score results have the wrong structure

Location: [withScores](src/commands/zset.ts).

`ZRANGE ... WITHSCORES` always builds a flat member/score array. RESP3 requires member/score pairs as nested arrays. For one element, the implementation emits `*2 ... member ... ,1`, rather than an outer one-element array containing the pair. Audit every command using this helper; response shape is command-specific.

The test named “WITHSCORES ... in both protocols” checks a RESP2 range and a RESP3 ZSCORE, not a RESP3 scored range. It does not establish the property its title claims. [Redis 7.4 sorted-set implementation](https://github.com/redis/redis/blob/7.4/src/t_zset.c).

### 13. P2: float parsing rejects valid zero values

Location: [underflowedToZero](src/commands/spec.ts).

The underflow test checks for a nonzero digit anywhere, including the exponent. `toDouble("0e1")` returns null. Zero with a nonzero exponent is still zero. This shared bug affects sorted sets and float increments. Test mantissa and exponent separately.

### 14. P2: float formatting cannot repair arithmetic precision

Locations: [INCRBYFLOAT](src/commands/string.ts), [HINCRBYFLOAT](src/commands/hash.ts), [formatDouble](src/commands/spec.ts).

The implementation uses JavaScript Number arithmetic and then custom decimal formatting. Reproduced two increments, 0.1 and 0.2, storing `0.30000000000000004`. Redis's string increment implementation uses long-double arithmetic and its own formatting. Expanding JavaScript's shortest decimal representation does not reproduce that behavior.

Required: define the compatibility target and implement/test the required numeric behavior; do not claim the output matches Redis merely because a few decimal examples pass. [Redis 7.4 string implementation](https://github.com/redis/redis/blob/7.4/src/t_string.c).

### 15. P2: 64-bit expiry inputs are rounded before storage

Locations: [applyExpire](src/commands/keyspace.ts), [absoluteDeadline](src/commands/string.ts).

Parsing uses BigInt but then converts the result to Number. Accepted timestamps above 2^53 lose integer precision; the maximum signed 64-bit timestamp rounds beyond its original value. Later TTL calculations and comparisons cannot recover it. Either preserve integer timestamps end to end or reject/document a supported range before changing data.

### 16. P2: GETEX skips expiry validation for missing keys

Location: [getex](src/commands/string.ts).

`GETEX missing EX 0` returns null because lookup returns before `absoluteDeadline` validates the duration. Invalid expiry arguments should be rejected before key lookup. Compare validation order with the chosen Redis release. [Redis 7.4 GETEX implementation](https://github.com/redis/redis/blob/7.4/src/t_string.c).

### 17. P2: RESET and QUIT do not control the whole connection

Locations: [reset / quit](src/commands/server.ts), [run and message loop](src/do.ts).

RESET only changes ConnState fields; it leaves subscriptions intact and gets queued inside MULTI instead of immediately resetting the transaction. QUIT sets a flag, but the message loop executes the rest of the already-decoded pipeline before closing. A command following QUIT in the same frame can still mutate the database.

Required: connection-level transitions owned by the session executor, with tests for queued commands, subscriptions, pipelining, and closure.

### 18. P2: CLIENT ID can be reused while old sockets survive

Location: [nextConnectionId / Session.decode](src/session.ts).

The counter is module memory. Reinitialization resets it, while attachments revive previous IDs without advancing the counter. A new connection can therefore collide with a surviving connection. Allocate identifiers from a lifecycle-safe source with the required scope.

### 19. P2: protocol errors are not handled at the connection boundary

Locations: [ProtocolError / drain](src/resp.ts), [webSocketMessage](src/do.ts).

ProtocolError contains a reply, but the event handler never catches it to send that reply and close the connection. `drain()` parses the entire batch before executing any command, so a malformed suffix throws away already-decoded valid commands from that event as well. Define and test behavior for a valid prefix followed by malformed input, including every chunk split.

## Resource and operational defects

### 20. P1: no end-to-end memory or backpressure budget

Locations: [decoder and encoder](src/resp.ts), [message batching](src/do.ts), [bridge output queues](shim/tcp-shim.ts).

The DO buffers all decoded commands, all replies, and a concatenated output frame. Buffers retain their grown capacity. Queued transactions and subscriptions have no limits. The shim bounds only pre-handshake input: after opening, upstream sends ignore buffered output, and slow-client output accumulates without a byte limit.

Required: per-connection and per-instance budgets for input, queues, replies, and subscriptions; bounded parsing/execution batches; bounded output buffering; and a defined disconnect/error policy. Exercise slow readers and fragmented large inputs, not just fast local clients.

### 21. P2: basic collection operations scan entire collections

Locations: [seqBounds / listLength](src/commands/list.ts), collection COUNT queries, [rank](src/commands/zset.ts).

Every list push runs MIN, MAX, and COUNT over the list. Repeated single-element pushes accumulate quadratic work. LLEN/HLEN/SCARD/ZCARD count rows; ZRANK counts predecessors rather than using rank metadata. SQLite indexes do not turn these queries into Redis's corresponding complexity bounds.

Required: document actual complexity and rows-read cost. Maintain transactional counts and efficient endpoint metadata where justified. Benchmark large collections and mixed workloads. This matters financially as well as for latency on DO SQL.

### 22. P2: list midpoint exhaustion rewrites the entire list

Location: [respreadSeqsOntoIntegers](src/commands/list.ts).

Exhausting floating-point space between adjacent positions loads every list value into memory, deletes every row, and reinserts the list. A large list can exceed memory or execution budgets; a caught insertion failure leaves it partially rebuilt. Floating endpoints also lack an explicit safe-integer exhaustion policy.

Required: a bounded rebalancing design or a different list representation, with documented worst-case behavior and failure tests. Floating positions are a tradeoff, not automatically wrong; this unbounded recovery path is the problem.

### 23. P2: expiration maintenance is unbounded and scheduled unnecessarily

Locations: [sweep / purge](src/store.ts), [rearm](src/do.ts).

An alarm collects every expired key and purges each through metadata plus all five value tables. A large expiration wave monopolizes the instance and can exceed its budget. Every message with any expiry present calls setAlarm, including read-only traffic. When no expiry remains, the old alarm is not canceled. Serialization failures also skip rearming because it is sequenced after the handler body.

Required: bounded expiration batches, indexed scheduling, no-op suppression, stale-alarm cancellation, and a recovery path for scheduling failures. Logical expiry must remain correct independently of alarm timing. An alarm is not an exact wall-clock deletion guarantee.

### 24. P2: glob conversion exposes expensive regex backtracking

Location: [globToRegExp](src/store.ts).

Each `*` becomes a separate greedy regex repetition. Patterns containing many stars and a failing suffix can cause combinatorial backtracking across each key. This was identified statically; no deliberately long blocking benchmark was run. Use a byte matcher with a bounded algorithm and explicit pattern limits.

### 25. P2: INFO and COMMAND metadata invent facts

Location: [server commands](src/commands/server.ts).

INFO reports one connected client, zero memory, zero hits/misses/expirations, and zero expiring keys regardless of reality. COMMAND DOCS assigns every command the same generic summary, group, and version. COMMAND INFO omits implemented connection commands because they live outside the registry. CONFIG GET advertises storage encodings the implementation does not use.

These are not harmless placeholders once monitoring or capability detection consumes them. Report measured facts, explicitly unsupported fields, and an honest compatibility version. Returning plausible-looking fiction makes operations harder.

### 26. P2: R2 persistence does not exist

Location: [ColdTier](src/worker.ts).

The bucket is declared and its read/write capability is acquired, but no storage path reads or writes it. There is no eviction mechanism, recovery protocol, versioned object reference, or reconciliation. SQLite is the entire implemented data store. The bucket also has forceDestroy enabled, a poor default if it later becomes authoritative persistence.

Required: remove unused infrastructure or clearly label it as unimplemented. Adding R2 later requires a separate consistency and recovery design because SQLite and R2 do not share a transaction.

### 27. P2: the validation suite does not cover the server's hardest guarantees

Locations: [test adapter](test/sqlite-adapter.ts), [differential runner](test/differential.ts), test suites.

The unit suites run handlers and codec helpers with Bun SQLite. They do not exercise the DO lifecycle, attachments, output gates, transaction executor, Pub/Sub, alarms, or platform SQL limits. The differential generator does not cover MULTI, WATCH, Pub/Sub, or RESP3 negotiation. Its key/value pools are strings, not arbitrary bytes. SCAN is only shape-compared, and the generator issues initial scans rather than proving full iteration.

Order-insensitive comparison and clock tolerances can be valid; shape-only tests cannot establish contents, membership, uniqueness, or complete traversal. The final success message says “replies byte-identical” even when differences were accepted by relaxed policies.

Required: actual Workers-runtime integration tests, isolated Redis reference instances pinned to a release, both protocols, arbitrary-byte tests, disconnect/hibernation tests, and fault injection at mutation boundaries. Keep successful seeds and regressions. Never run this harness against valuable instances: it begins with FLUSHALL.

## Smaller design and documentation problems

- [README](README.md): “Real Redis semantics,” “existing client works unmodified,” and “the real Redis test suite” are unsupported blanket claims. Common dependencies such as Lua scripting, blocking list operations, streams, ACLs, and WATCH are absent. Some subsets of clients will work; that is a different claim.
- README describes handlers as pure and unaware of protocol/connection state. They mutate SQL and ConnState. Call them synchronous command handlers. A useful abstraction does not need a false purity claim.
- README says MULTI rolls back unlike Redis. Ordinary errors are converted to replies, so the implementation does not provide that advertised behavior; changing all ordinary errors to roll back would itself violate Redis semantics.
- README equates SQLite with a snapshot. Durable storage does not specify export, backup retention, restore, corruption recovery, or accidental-deletion recovery. Those need an operational contract and a tested runbook.
- [Schema](src/schema.ts): metadata type is unrestricted text and `track` accepts `none`; there is no schema-version migration mechanism or invariant audit. The type/table invariant currently relies on every caller maintaining it correctly.
- `applySchema` runs in the DO initializer and again in the Store constructor. Remove redundant initialization, especially on a hibernating object.
- Collection cursor machinery is duplicated in Store and hash.ts; set.ts and zset.ts import generic scanning/sampling from the hash command module. Extract genuinely shared primitives into a neutral module.
- Some modules use schema constants while others hard-code the same tables. Pick one source of truth.
- Numerous one-line wrappers and names such as `bufferResultBeforeClearingDestination` describe implementation choreography while the important atomicity contract is absent. Prefer documenting the invariant over adding more naming layers.
- UNLINK and FLUSH ASYNC run synchronously. Results may be equivalent for simple callers, but the latency contract is different and must be documented.
- `/health` reports router liveness only; it does not establish storage readiness. Name and document it accordingly.
- Session attachments have terse fields but no explicit format version. Persisted connection state needs an evolution policy across deployment changes.

## Required compatibility and operational contract

These are requirements for the repaired implementation, not guarantees of the current one.

| Area | Contract to publish and enforce |
| --- | --- |
| Compatibility | Pin a Redis release; list supported commands, options, RESP2/RESP3 reply shapes, and deliberate deviations. The current registry has 124 commands plus a separate connection-command path. |
| Instance scope | One named DO is one isolated Redis-like instance. Only SELECT 0 is supported. No cross-instance transactions, cluster protocol, or automatic partitioning of a single instance. |
| Capacity | SQLite-backed DOs have a documented 10 GB per-object storage limit; BLOB/row size is 2 MB, statement length 100 KB, and bound parameters 100. Enforce stricter application limits where needed. [Platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Connections | Attachments are limited to 16,384 serialized bytes. Define input, output, transaction, subscription, and idle limits independently of this metadata envelope. [WebSocket limits](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment) |
| Atomicity | Define command mutation boundaries and EXEC behavior for validation errors, ordinary runtime errors, storage failures, and reply delivery failures. |
| Durability | State exactly when a success reply becomes externally visible relative to durable commit. A disconnect can leave the client unsure whether a command committed; automatic retry of non-idempotent commands is not safe by default. |
| Expiry | Millisecond deadlines; logical expiry at access; bounded physical reclamation; consistent command/EXEC time semantics; explicit supported timestamp range. |
| Binary safety | Keys, values, fields, members, channels, and patterns preserve bytes. Text conversion is limited to ASCII syntax parsing and escaped diagnostics. |
| Security | State and enforce the connection authentication, instance authorization, transport, and administrative-command policy. |
| Complexity | Publish actual SQL/CPU/memory behavior for expensive commands and the consequences of per-instance serialization. |
| Recovery | Document backup/PITR procedure, restore scope, deployment migration, full-disk behavior, and connection interruption. Test restoration. |
| R2 | No persistence or eviction role today. Any future tier must define authoritative ownership, versions, atomic visibility, failure recovery, and garbage collection. |

## Repair order and acceptance criteria

1. **Stop data loss and false success.** Test storage failures after each destructive statement. Existing data and metadata must stay consistent. Reject unsupported configuration and authentication behavior.
2. **Make the session executor testable.** Centralize command registration, arity, queueing, RESET/QUIT, and Pub/Sub transitions. Verify ordinary EXEC errors preserve successful siblings while infrastructure failures obey the published durability policy.
3. **Bound the runtime.** Implement attachment storage strategy, request/reply budgets, slow-client handling, and actual SQL/value limits. Validate in workerd, including hibernation and restart.
4. **Repair semantic divergences.** Binary matching, expiry flag combinations, cursor guarantees, numeric parsing, RESP3 collection shapes, and error framing need regression tests against the pinned Redis release.
5. **Fix scaling behavior.** Measure collection sizes, expiration waves, list rebalance, wide set algebra, and subscriber fan-out. Optimize based on rows read/written, CPU, memory, and latency.
6. **Replace marketing with a contract.** Publish the compatibility matrix and operational limits above, link every intentional deviation to a test, and run the supported portions of the actual Redis suite before claiming they work.

The BLOB key schema, indexed sorted-set ordering, synchronous execution model, and SQLite authority are worth retaining. The priority is to make observable behavior and failure guarantees trustworthy before expanding the command count.
