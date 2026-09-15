# `tcp-shim` — raw Redis TCP into a Durable Object

A Durable Object cannot accept a TCP connection. It can accept a WebSocket.
So this Bun process sits in front of one and moves bytes:

```
                           this process
                     ┌───────────────────────┐
  redis-cli          │                       │        Cloudflare
  ioredis    ──TCP──▶│  Bun.listen(:6379)    │        ┌──────────────┐
  redis-py     6379  │          │            │        │              │
  redis TCL          │          ▼            │──WS───▶│  Worker      │
  redis-benchmark    │   new WebSocket(...)  │  RESP  │  /connect    │
                     │                       │  bytes │      │       │
                     └───────────────────────┘        │      ▼       │
                                                      │  RedisDO     │
                                                      └──────────────┘
```

Nothing in this file understands RESP. That is the whole point: the shim
forwards opaque bytes, so every real Redis client works unmodified and every
protocol decision stays in `src/resp.ts` instead of leaking into the plumbing.

---

## Run it

```sh
bun shim/tcp-shim.ts
```

```
  radish tcp-shim
  listening   127.0.0.1:6379
  upstream    ws://localhost:8787/connect
  try         redis-cli -p 6379 ping
```

| Flag | Env | Default | |
|---|---|---|---|
| `--port <n>` | `PORT` | `6379` | TCP port to listen on |
| `--host <addr>` | `HOST` | `127.0.0.1` | interface to bind; use `0.0.0.0` to expose |
| `--upstream <url>` | `UPSTREAM` | `ws://localhost:8787/connect` | the Worker. `http(s)://` is accepted and mapped to `ws(s)://`, because that is what `wrangler dev` prints |
| `--tls` / `--no-tls` | `TLS=1｜0` | from the URL scheme | force `wss://` or `ws://` |
| `--stats [ms]` | — | off (`5000` under `--debug`) | periodic live-connection line |
| `--debug` | `DEBUG=1` | off | log every frame |
| `-h`, `--help` | — | | |

Against a deployed Worker:

```sh
bun shim/tcp-shim.ts --upstream wss://radish.<account>.workers.dev/connect
```

Bad configuration exits `2` with the reason; `SIGINT`/`SIGTERM` drains live
connections and exits `0`.

### In-process

`startShim()` is exported so tests can drive it without a subprocess. `port: 0`
binds an ephemeral port and `shim.port` reports which one:

```ts
import { startShim } from "./shim/tcp-shim.ts";

const shim = startShim({ port: 0, upstream: "ws://localhost:8787/connect" });
// … shim.port, shim.stats() …
await shim.stop();
```

---

## Point a client at it

```sh
redis-cli -p 6379 ping
redis-cli -p 6379 set greeting "hello"
redis-cli -p 6379 --scan
redis-benchmark -p 6379 -t set,get -n 100000 -P 8 -q
```

```ts
import Redis from "ioredis";
const redis = new Redis(6379, "127.0.0.1");
```

```py
import redis
r = redis.Redis(host="127.0.0.1", port=6379)
```

None of them know the server is a Durable Object.

---

## The differential harness

`test/differential.ts` is the file that decides whether "our Redis" is Redis.
It drives an identical, seeded command stream into a reference `redis-server`
and into the shim, and compares the **raw RESP reply bytes**.

```sh
docker run --rm -p 6380:6379 redis:7 redis-server --databases 1   # the reference
bun shim/tcp-shim.ts                          # the subject, on :6379
bun test/differential.ts --ref localhost:6380 --sut localhost:6379
```

```
summary
  commands     4027
  divergences  0
  seed         1234
  elapsed      0.4s
  relaxations  SCANx22 RANDOMKEYx14 PTTLx1

PASS — 4027 commands, replies byte-identical
```

A divergence prints the command, the reason, and a hexdump of both sides with
the first differing byte marked:

```
DIVERGENCE #1
  command  HMGET k1 f1 f1
  reason   bytes differ at offset 4

  reference localhost:6380 (14 bytes)
    00000000  2a 32 0d 0a 24 2d 31 0d  0a 24 2d 31 0d 0a        |*2..$-1..$-1..  | <-- first difference

  subject   localhost:6379 (14 bytes)
    00000000  2a 32 0d 0a 2a 2d 31 0d  0a 2a 2d 31 0d 0a        |*2..*-1..*-1..  | <-- first difference
```

Exit codes: `0` pass, `1` divergence or connection failure, `2` bad arguments.

| Flag | Env | Default |
|---|---|---|
| `--ref <host:port>` | `REF` | `localhost:6380` |
| `--sut <host:port>` | `SUT` | `localhost:6379` |
| `--seed <n>` | `SEED` | random, always printed |
| `--commands <n>` | `COMMANDS` | `2000` |
| `--max-divergences <n>` | `MAX_DIVERGENCES` | `5` |
| `--timeout <ms>` | `TIMEOUT_MS` | `5000` |
| `--verbose` | — | print every command |

Every failure is reproducible: `SEED=1234 bun test/differential.ts` replays the
exact stream.

### What the stream looks like

Commands are drawn from strings, hashes, lists, sets and zsets over a pool of
**eight key names**. The small pool is deliberate — the same name gets used as
a string, then a list, then a hash, so `WRONGTYPE` and the type-check paths are
exercised constantly rather than by luck. Values sit on the edges: empty,
`9223372036854775807`, `18446744073709551616`, leading/trailing spaces,
embedded `NUL`, non-ASCII, 200 bytes of padding. Wrong arity and unknown
commands are emitted on purpose, because error strings are protocol too and
clients branch on them.

One batch in twelve is a pipeline burst of 2–8 commands written as a single TCP
segment. That is where a byte-shovelling shim is most likely to be wrong.

The run ends with a **full sweep**: every key in the reference is dumped from
both servers (`GET`/`LRANGE`/`SMEMBERS`/`HGETALL`/`ZRANGE … WITHSCORES`) plus
`DBSIZE` and `KEYS *`. Reply-by-reply agreement can in principle be reached by
two servers whose stored state has drifted; a write that silently no-ops on one
side only shows up when something reads it back.

### The allowlist

Default comparison is byte-exact. There are exactly two kinds of exception. Each
entry carries its justification as a `why` field in the table itself, printed in
full at startup and counted in the summary, so neither kind can hide quietly.

**Unordered** — not a relaxation of fidelity, because Redis never promised an
order here. Compared as a multiset: `SMEMBERS`, `SINTER`, `SUNION`, `SDIFF`,
`KEYS`, `HKEYS`, `HVALS`; as a multiset of pairs: `HGETALL`, `CONFIG GET`.

**Relaxed** — Redis itself does not give the same answer twice:

| Command | Compared by | Why |
|---|---|---|
| `INFO` | shape | uptime, memory, pid, version |
| `TIME` | shape | wall clock |
| `RANDOMKEY`, `SRANDMEMBER`, `HRANDFIELD`, `ZRANDMEMBER`, `SPOP` | shape | random selection |
| `SCAN`, `HSCAN`, `SSCAN`, `ZSCAN` | shape (depth 2) | cursor encoding and batch size are unspecified |
| `TTL`, `EXPIRETIME` | integer ±1 | the second may tick between the two sends |
| `PTTL`, `PEXPIRETIME` | integer ±100 | milliseconds elapse between the two sends |
| `DEBUG`, `OBJECT` | shape | server internals |

Even under a relaxed policy, an error on one side and not the other is always a
failure, and two errors must match byte for byte. Relaxations apply to values,
never to outcomes.

`SPOP`, `DEBUG` and `OBJECT` are in the table but the generator never emits
them: a divergent reply from those also *mutates state divergently*, turning one
bug into a cascade of meaningless failures. They stay listed so a hand-written
stream can still use them.

The summary's `relaxations` line counts only the cases where a relaxed policy
actually covered a byte difference. If that line is empty, the run was fully
byte-exact.

---

## The real Redis TCL test suite

The upstream suite can run against an external server, which is the strongest
evidence available that this is Redis:

```sh
git clone --branch 7.2 --depth 1 https://github.com/redis/redis
cd redis        # no `make` needed: external mode never spawns a server

./runtest --host 127.0.0.1 --port 6379 --singledb \
          --tags "-needs:debug -needs:repl -needs:save -needs:config-maxmemory"
```

Notes, verified against `tests/test_helper.tcl` on the 7.2 branch:

- Passing `--host` switches the suite into **external mode**, which also makes
  it skip every test tagged `external:skip` automatically.
- `--singledb` avoids `SELECT`, which a single-DB server does not have.
- `--tags` takes a space-separated list; a `-` prefix means *exclude*. This is
  how you drop the tests that depend on machinery a Durable Object does not
  have — `DEBUG JMAP`, `DEBUG OBJECT`, replication, `SAVE`/`BGSAVE`,
  `CONFIG SET maxmemory`.
- Tests that call `assert_encoding` are asserting on `OBJECT ENCODING`, i.e. on
  listpack-vs-skiplist internals that have no meaning here. Exclude those files
  with `--skipfile <file>` (one test name or `/regexp/` per line) rather than
  trying to fake an encoding.
- Start with one file at a time — `--single unit/type/string` — before running
  the whole suite.
- `./runtest --help` is the authority on the current flag set.

---

## Design notes

Three invariants, in the order they matter.

**Bytes that arrive before the WebSocket opens are buffered, then flushed in
order.** A client that pipelines `AUTH`/`HELLO` the instant the socket is up is
normal, not exotic, and dropping those bytes is the classic bug in this shape of
program. It is not theoretical: with `DEBUG=1`, *every* `redis-cli` invocation
logs a `flushed pre-handshake buffer` line, because `redis-cli` writes its
command before the WebSocket handshake to the Worker completes. The buffer is
capped (8 MiB per connection) so a client blasting into a dead upstream cannot
exhaust the process; overflow closes the connection loudly.

**Backpressure is honoured, not spun on.** `socket.write()` returns the number
of bytes actually accepted, which can be short. The remainder is parked at the
head of a per-connection queue and resumed from the `drain` handler; once
anything is parked, every later chunk queues behind it, or the stream reorders.
There is no retry loop and no polling.

**Frames are binary in both directions.** `ws.binaryType = "arraybuffer"`, and a
text frame from upstream closes the connection with an error rather than being
coerced. RESP is binary-safe; a byte that round-trips through a JS string is a
byte that can be corrupted.

Smaller decisions:

- One WebSocket per TCP socket, created in `open()`, so the two lifetimes are
  the same lifetime. Every teardown path — client FIN, upstream close, socket
  error, shutdown — funnels through a single `retire()` that runs once.
- When the upstream closes with bytes still parked, the client gets those bytes
  and *then* the FIN.
- Logging is one line per connection open and close (id, peer, duration, bytes
  each way, reason) plus errors. Per-frame logging only under `DEBUG=1`.
- `stop()` stops accepting, closes live connections, waits up to 2s for them to
  unwind, then forces the rest. A second `SIGINT` exits immediately.

---

## Verified

End-to-end on Bun 1.3.14, with a stand-in Worker piping WebSocket frames to a
real `redis-server`, and a second `redis:7` as the reference:

- `bun run typecheck` (the repo's `tsconfig.json`: `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`) is clean, as is
  `bun build --target=bun`. No `any` in either file.
- 5000-command differential runs at seeds 7, 777, 1234 and 424242: **0
  divergences**, replies byte-identical, including the final key sweep.
- The harness detects injected corruption: a proxy rewriting `$-1` as `*-1` was
  caught on the ninth command with a correct hexdump, exit 1.
- `redis-cli` (`PING`, `SET`, `GET`, `LPUSH`, `LRANGE`, `TYPE`) works unmodified.
- `redis-benchmark -c 20 -P 8` over `SET/GET/LPUSH/SADD/ZADD/LRANGE_300`:
  ~290k rps across 147 connections and 58 MiB moved, zero errors.
- A 4 MB value round-trips with a matching MD5 (exercises the short-write and
  `drain` path).
- `SIGTERM` exits `0`; a dead upstream logs `upstream unreachable` and closes the
  client; `startShim({ port: 0 })` binds, serves, and `stop()` really stops the
  listener.

Not verified here: TLS to a deployed Worker (`wss://`), and the real TCL suite,
which needs the actual `RedisDO` behind the shim rather than a stand-in.
