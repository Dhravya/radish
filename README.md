<div align="center">
<img src="assets/icon.png" width="220">
<h1>Radish</h1>
A Redis-compatible server that runs inside a Cloudflare Durable Object
</div>

---

Radish began in 2024 as a Go reimplementation of Redis, written when Redis changed
to a source-available license. This is its second life, and a different bet: the
original escaped the *license*, this escapes the **operations**, by putting Redis
semantics on a substrate that already solves durability and failover.

SQLite is the store, a Durable Object is the process, and R2 is the cold tier.
No cluster to shard, no failover to configure, no AOF policy to tune — those are
properties of the platform rather than things to operate.

The Go implementation is preserved at tag
[`go-implementation`](https://github.com/dhravya/radish/tree/go-implementation)
and remains MIT-licensed. Nothing about it was wrong; it just needed a machine
to run on.

**Status: not production ready.** See [Limits](#limits) and
[Not implemented](#not-implemented) before considering it for data you care about.
It does run on Cloudflare — `redis-cli` drives a deployed Durable Object
unmodified — but it has no production miles.

```
  YOUR MACHINE                    │            CLOUDFLARE
                                  │
  ┌───────────┐                   │
  │ redis-cli │                   │
  │ ioredis   │                   │
  │ redis-py  │                   │
  └─────┬─────┘                   │
        │ TCP :6379               │
        │ raw RESP bytes          │
        ▼                         │
  ┌───────────┐                   │
  │ Bun shim  │  translates only  │      ┌──────────┐
  │           │──────────────────────────│  Worker  │  authenticates the
  └───────────┘  wss + x-radish-auth│      │  router  │  upgrade, then exits
                                  │      └────┬─────┘  the data path
        ▲                         │           │
        │                         │           │ ?db=cli
        └─ deleted when connect() │           ▼
           lands; client then     │   ┌───────────────────┐
           reaches the DO direct  │   │     RedisDO       │
                                  │   │  ◀── socket lives │  hibernatable
                                  │   │      HERE         │  evicts between
                                  │   │                   │  commands
                                  │   │  ┌─────────────┐  │
                                  │   │  │   SQLite    │  │  hot + warm
                                  │   │  │  meta       │  │  meta never
                                  │   │  │  str hash   │  │  leaves
                                  │   │  │  list sett  │  │
                                  │   │  │  zset       │  │
                                  │   │  └──────┬──────┘  │
                                  │   └─────────┼─────────┘
                                  │             │ evict ▼  ▲ fault in
                                  │        ┌────┴─────────────┐
                                  │        │  R2  ColdTier    │  cold
                                  │        └──────────────────┘  unbounded
                                  │
                                  │   ?db=sessions ──▶ a DIFFERENT DO
                                  │   ?db=tenant-7 ──▶ another one
                                  │   each: own SQLite, own lease,
                                  │         own failover, 10 GB each
```

**The Worker is not in the data path.** It authenticates the upgrade, calls
`redis.getByName(name).fetch(request)`, and steps out. `Cloudflare.upgrade()` runs
inside the *Durable Object* and calls `ctx.acceptWebSocket(...)` on the
`DurableObjectState`, so the socket terminates there. Every RESP frame after the
handshake reaches the DO's `webSocketMessage` handler with no per-message Worker
invocation. Because it is `acceptWebSocket` rather than `accept`, the socket is
**hibernatable** — the object can be evicted between commands while the connection
stays open, which is why connection state rides in the socket attachment.

**The shim is the only piece that is not real.** It exists because `redis-cli` speaks
TCP and a Durable Object cannot accept TCP. It has no protocol knowledge — bytes in,
bytes out — and it is temporary: Cloudflare's `connect()` handler is in private beta,
and on celld the handler does not exist and would have to be added. When either
lands the shim is deleted and clients reach the DO with nothing in between.

**One name is one instance.** `?db=cli` and `?db=sessions` are different Durable
Objects with different SQLite databases, migrating between machines independently.
No cluster, no resharding, no failover to operate.

## What this is

| | |
|---|---|
| Commands | 136 of Redis 7.4.11's 250 — 124 in the dispatch table, 12 connection-scoped |
| Tests | 624, ~159,700 assertions |
| Differential | 10 seeds × ~2,025 commands vs `redis:7.4.11`, byte-identical |
| Source | 7,980 lines |

## Compatibility contract

Pinned to **Redis 7.4.11**. Reply shapes verified for RESP2 and RESP3 separately;
they differ per command and are tested per command.

Correctness is established by **differential testing**, not by assertion: the same
seeded command stream runs against a real `redis-server` and against radish, and the
raw RESP bytes are compared. Any difference is a bug unless it is listed below.
Unit tests can only assert what their author believed Redis does; four times during
development that belief was wrong and the harness caught it.

### Deliberate deviations

Each of these is a difference we chose, with a test pinning it.

| Deviation | Reason |
|---|---|
| `SELECT` accepts only index 0 | One named Durable Object is one instance. A second database does not exist; `CONFIG GET databases` reports `1` consistently. |
| `ERR scan cursor expired` | Our SCAN cursors are server-side and evictable after 60s idle. Redis's are stateless and cannot expire, so this reply has no upstream equivalent. It is an explicit error rather than a successful-looking empty result, which would silently violate the full-iteration guarantee. |
| List position space exhaustion refuses | Lists use fractional indices. Exhausting the float space at one end returns an error rather than drifting toward `-Infinity`. Requires ~2^53 pushes at one end, which the 10 GB cap makes unreachable. |
| `EXEC` rolls back on **infrastructure** failure | An ordinary command error inside `MULTI` still preserves successful siblings, as Redis does. A storage failure rolls the whole transaction back rather than committing a half-applied mutation. Redis has no equivalent because it has no storage layer that can fail this way. |
| Values capped at 1 MiB | Cloudflare caps a SQLite row/BLOB at 2 MB. Advertising Redis's 512 MiB would be a limit no row can hold. |
| `SCAN MATCH *` matches the empty string | Literal `stringmatchlen` returns false there, a quirk masked in Redis by `KEYS`' allkeys short-circuit. We keep sane glob semantics. |
| `ZSCAN` score spelling does not depend on size | Upstream re-spells `ZSCAN` scores with `%.17Lg` once a sorted set exceeds `zset-max-listpack-entries` (default 128), so above that size **Redis disagrees with its own `ZSCORE` on the same key**. Measured: 0 of 114 scores differ at listpack size, 145 of 194 at skiplist size. We have one representation and keep the `d2string` spelling at every size, which agrees with `ZSCORE` and every other double reply. |

### Platform-dependent behavior

`INCRBYFLOAT` and `HINCRBYFLOAT` reproduce IEEE **binary128** (`long double` on
aarch64 and every other quad-precision target) with correct round-to-nearest-even
and Redis's `%.17Lf` human form, bit-for-bit, across the full representable range
including subnormals, overflow and underflow. Verified byte-identical against
redis 7.4.11 over 1,821 randomized cases.

On **x86-64**, where `long double` is x87 80-bit, upstream Redis prints fewer
significant digits for values above ~2^56. We match the quad-precision platform,
not the x87 one. The regression test asserts this mechanically: the reply must
equal the binary128 expansion **and must not equal** the x87 expansion, so a
future run against an x86-64 reference names its own cause.

### Double formatting

`double` replies reproduce Redis's `fpconv_dtoa` (Grisu2), not JavaScript's
shortest round-trip form. The two disagree on exponent-form thresholds, and
Grisu2 is not always shortest — Redis prints `-678346351760656.7` where the
shortest round-tripping decimal is `-678346351760656.8`. We print what Redis
prints, verified byte-identical against the reference.

## Limits

Platform limits, enforced rather than advertised:

| | |
|---|---|
| Storage per instance | 10 GB of SQLite **per named instance**; beyond that, values tier to R2. Instances are unlimited. |
| Value size | 1 MiB (2 MB platform row cap, less key and column overhead) |
| Bound parameters | 100 per statement — set algebra is folded rather than expanded |
| Statement length | 100 KB |
| Connection attachment | 16,384 bytes; larger session state spills to a SQL row |
| Queued `MULTI` | 512 KiB / 1024 commands, charged before acknowledgement |
| Subscriptions | 64 KiB / 1024, charged before acknowledgement |

## Tiering

SQLite is capped at 10 GB per Durable Object and writes *fail* at the ceiling
rather than degrading, so values tier out to R2. `meta` never leaves SQLite, so
`TYPE`, `TTL`, `EXISTS`, `SCAN` and `DEL` never touch R2 at any dataset size.

| tier | SQLite rows | R2 object | |
|---|---|---|---|
| `hot` | yes | absent or stale | written since last upload |
| `warm` | yes | present, identical | eviction costs zero uploads |
| `cold` | no | present, authoritative | faulted in before dispatch |

A key that cycles in and out without being written uploads exactly once.

The two stores share no transaction, so `meta` is the single authority and every
sequence fails toward "upload again", never toward losing data. `hot → warm`
uploads, **re-reads and byte-compares** before marking — a write can land during
the `await`, and the key is already `hot` so no trigger fires. `warm → cold` is
one SQLite transaction. `cold → warm` restores rows and marks warm together; a
missing object raises rather than returning an empty key.

Mutations invalidate the R2 copy via **SQLite triggers** on all five value
tables, so a command author cannot forget — including authors of commands that
do not exist yet.

Keys are extracted from `argv` *before* dispatch, so cold values are restored
while command handlers stay synchronous. A keyspace that has never evicted pays
no SQL, no allocation and no microtask on that path.

### What gets evicted

The planner is a pure function returning a plan, not an action, and every
eviction carries a reason. Free evictions (`warm → cold`) are a separate pool
that is always drained before any upload is planned — an asymmetry no score can
invert.

```
score = bytes / (readProbability · readAmplification · churnPenalty)
```

Fault-in is whole-key, so **read amplification is type-dependent and dominates**:
a `string` is amplification 1, while restoring a 10,000-member hash to serve one
`HGET` is not. It spans 1–57× against recency's 10.7×, deliberately.

Hard exclusions: a key expiring within 5 minutes (it frees its own bytes; an
upload buys nothing and leaves an orphan), and anything under 4096 bytes —
SQLite's page size, below which eviction may release no pages at all while still
costing an object, a Class A operation and a future round trip.

`churnPenalty` is **inert**: nothing records a last-write time, and adding one
would mean an unconditional `meta` write per command across all 136 commands.
Named `WRITE_CLOCK_NOT_RECORDED` at its use site.

## Not implemented

Absent, not partially working:

- **Blocking** — `BLPOP` `BRPOP` `BLMOVE` `BLMPOP`
- **Streams** — `XADD` `XRANGE` `XREAD` and consumer groups
- **Scripting** — `EVAL` `EVALSHA` `FUNCTION`
- **Zset set-ops** — `ZUNION` `ZINTER` `ZDIFF` and their `*STORE` forms
- **Multi-key pop** — `LMPOP` `ZMPOP`
- **Introspection** — `OBJECT` `DUMP` `RESTORE`
- **Cluster, replication, ACL**

`WATCH`/`UNWATCH` **are** implemented, so `MULTI` is not structurally incomplete.

## Complexity

SQLite is a B-tree, not a quicklist. Where that costs something, it is named:

| Operation | Redis | radish |
|---|---|---|
| `LPUSH` / `RPUSH` | O(1) | O(log n) — index seek on one endpoint |
| `LLEN` `HLEN` `SCARD` `ZCARD` | O(1) | O(1) — maintained cardinality |
| `ZRANK` / `ZREVRANK` | O(log n) | **O(rank)** — row-value range scan, not rank metadata |
| `LINSERT` worst case | O(n) | O(dense run adjacent to insertion), bounded and resumable |

Cardinality is stored nullable, where NULL means *not yet counted*. A path that
mutates rows without updating the counter can only make the count unknown, never
wrong; the next read repairs it with one `COUNT(*)` and memoises.

## Durability

A reply is held until the writes behind it are durable — Cloudflare's output gate.
Redis defaults to `appendfsync everysec` and can lose up to a second of
acknowledged writes; radish loses none.

**This is not a backup story.** Durable storage does not specify export, retention,
restore, corruption recovery, or accidental-deletion recovery. There is no tested
runbook for any of them. R2 holds evicted values (see [Tiering](#tiering)); it is
not a backup, and there is no export or point-in-time restore.

## Running

### Locally

```sh
bun install
bun test                 # 624 tests
node node_modules/alchemy/bin/cli.js dev
bun run shim             # TCP :6379 → ws://localhost:8787/connect
redis-cli -p 6379 ping
```

### Deployed

```sh
node node_modules/alchemy/bin/cli.js deploy --yes

RADISH_AUTH_TOKEN=$(cat .radish-token) \
UPSTREAM="wss://<worker>.workers.dev/connect?db=cli" \
  bun run shim

redis-cli -p 6379 set greeting "hello from cloudflare"
```

Creates a Worker, a SQLite-backed Durable Object namespace, and the `ColdTier`
R2 bucket. The shim sends `x-radish-auth` whenever `RADISH_AUTH_TOKEN` is set in
its environment.

**The Worker refuses to serve without a token.** `RADISH_AUTH_TOKEN` is read from
`.env` at deploy time (the Effect-native path registers the binding implicitly
from the `yield* Config` in the Init phase, so no `env` prop is needed). Without
it `/connect` returns 503 rather than serving anonymously; set
`RADISH_ALLOW_UNAUTHENTICATED=true` to opt out deliberately. A changed secret is
not detected as a diff, so redeploying a new token needs `--force`.

### Toolchain constraints

The Alchemy CLI must run under **Node, not Bun** — alchemy 2.0.0-beta.77 assumes
Node's CJS interop (`Workerd.default.default`). Use the local install, never
`bunx alchemy`, which fetches an unpinned copy into a temp directory and ignores
everything below. `effect` is pinned to `4.0.0-rc.112` via `overrides`; rc.113+
renamed `Config.string` and alchemy has not followed. `patches/` carries ESM
shims for `fast-glob` and `picomatch`, which ship no default export.

`alchemy profile refresh` needs a real TTY for its OAuth scope picker, so it
cannot run inside a non-interactive shell. `profile edit --method stored --set
apiToken=env:VAR` is the non-interactive alternative.

### Differential harness

```sh
docker run --rm -p 6380:6379 redis:7 redis-server --databases 1
SEED=1234 bun test/differential.ts --ref localhost:6380 --sut localhost:6379
```

It begins with `FLUSHALL`. **Never point it at an instance holding real data.**

## Layout

```
src/types.ts        Reply algebra + byte helpers
src/errors.ts       Redis error strings, verbatim; bounded binary-safe diagnostics
src/resp.ts         RESP2/RESP3 codec; incremental, chunk-boundary safe
src/schema.ts       SQLite DDL
src/store.ts        Keyspace: types, lazy expiry, SCAN cursors, byte glob
src/commands/       Synchronous command handlers, (Ctx, argv) => Reply
src/session.ts      SessionExecutor: decode, dispatch, MULTI, WATCH, pub/sub
src/do.ts           Durable Object wiring only
src/worker.ts       Router. One name = one instance.
shim/tcp-shim.ts    TCP:6379 ↔ WebSocket
test/differential.ts  Diffs raw RESP bytes against a real redis-server
```

Command handlers are **synchronous**, not pure — they read and write SQL and may
mutate connection state. What they do not touch is the socket or the protocol
version, which is what lets one table serve RESP2, RESP3 and queued transactions.

## Design invariants

1. **Bytes stay bytes on the storage path.** Keys, values, fields, members,
   channels and patterns are `BLOB` end to end. Text conversion is limited to
   ASCII syntax parsing and escaped diagnostics.
2. **Lazy expiry has one enforcement point.** Every existence check routes through
   `Store.typeOf`, which purges an expired key before answering.
3. **Connection state is reconstructible.** A hibernating socket can outlive its
   isolate, so even the decoder's partial buffer is bounded and persisted.
4. **Unsupported means an error, never a plausible reply.** `CONFIG SET` rejects
   parameters it cannot apply; `INFO` omits fields it cannot measure rather than
   reporting zero.
