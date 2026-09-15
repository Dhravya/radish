import { describe, expect, test } from "bun:test";

import { FakeSqlStorage } from "./sqlite-adapter";
import { applySchema, type SqlBinding, type SqlCursor, type SqlRow, type SqlRowShape, type SqlStorage } from "../src/schema";
import { Store } from "../src/store";
import { inMemoryColdBucket, type InMemoryColdBucket } from "../src/tier/bucket";
import type { TierPolicy } from "../src/tier/engine";
import { DEFAULT_POLICY } from "../src/tier/planner";
import {
  ATTACHMENT_FORMAT,
  MAX_INLINE_ATTACHMENT_BYTES,
  SessionExecutor,
  concatBytes,
  matchGlobBytes,
  type Host,
  type Peer,
} from "../src/session";

const ENCODER = new TextEncoder();

const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? ENCODER.encode(value) : value;

const latin1 = (input: Uint8Array): string => {
  let out = "";
  for (const byte of input) out += String.fromCharCode(byte);
  return out;
};

const raw = (...codes: number[]): Uint8Array => Uint8Array.from(codes);

const NOW = 1_700_000_000_000;

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

const req = (...args: (string | Uint8Array)[]): Uint8Array => {
  const parts: Uint8Array[] = [ENCODER.encode(`*${args.length}\r\n`)];
  for (const arg of args) {
    const payload = bytes(arg);
    parts.push(ENCODER.encode(`$${payload.length}\r\n`), payload, ENCODER.encode("\r\n"));
  }
  return concatBytes(parts);
};

interface Attachment {
  readonly v: number;
  readonly i: number;
  readonly s: Uint8Array | null;
}

class TestPeer implements Peer {
  readonly frames: Uint8Array[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  rejectSends = false;
  #attachment: unknown = null;

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.rejectSends) throw new Error("peer is gone");
    if (typeof data === "string") {
      this.frames.push(ENCODER.encode(data));
      return;
    }
    this.frames.push(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
    );
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.#attachment;
  }

  attachment(): Attachment | null {
    return this.#attachment as Attachment | null;
  }

  wire(): string {
    return latin1(concatBytes(this.frames.length === 0 ? [new Uint8Array(0)] : this.frames));
  }

  take(): string {
    const seen = this.wire();
    this.frames.length = 0;
    return seen;
  }
}

class InterruptibleSql implements SqlStorage {
  readonly inner = new FakeSqlStorage();
  failOn: RegExp | null = null;
  allowBeforeFailing = 0;

  get databaseSize(): number {
    return this.inner.databaseSize;
  }

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    if (this.failOn !== null && this.failOn.test(query)) {
      if (this.allowBeforeFailing === 0) throw new Error("injected storage failure");
      this.allowBeforeFailing -= 1;
    }
    return this.inner.exec<T>(query, ...bindings);
  }

  interrupt(failOn: RegExp, allowBeforeFailing = 0): void {
    this.failOn = failOn;
    this.allowBeforeFailing = allowBeforeFailing;
  }

  recover(): void {
    this.failOn = null;
    this.allowBeforeFailing = 0;
  }

  atomically<T>(run: () => T): T {
    this.inner.db.exec("BEGIN");
    try {
      const result = run();
      this.inner.db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.inner.db.exec("ROLLBACK");
      throw cause;
    }
  }
}

class Fixture {
  readonly sql = new InterruptibleSql();
  readonly store: Store;
  readonly peers: Peer[] = [];
  readonly bucket: InMemoryColdBucket;
  readonly host: Host;
  executor: SessionExecutor;

  constructor(tiered = false) {
    applySchema(this.sql);
    this.store = new Store(this.sql);
    this.bucket = inMemoryColdBucket();
    this.host = {
      sql: this.sql,
      store: this.store,
      bucket: tiered ? this.bucket : null,
      peers: () => this.peers,
      atomically: (run) => this.sql.atomically(run),
    };
    this.executor = new SessionExecutor(this.host);
  }

  connect(): TestPeer {
    const peer = new TestPeer();
    this.peers.push(peer);
    this.executor.open(peer);
    peer.take();
    return peer;
  }

  async send(peer: TestPeer, ...chunks: Uint8Array[]): Promise<string> {
    for (const chunk of chunks) await this.executor.message(peer, chunk, NOW);
    return peer.take();
  }

  hibernate(): void {
    this.executor = new SessionExecutor(this.host);
  }
}

describe("connection commands inside MULTI", () => {
  test("PUBLISH is queued, not executed, and DISCARD drops it", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("SUBSCRIBE", "c"));

    const replies = await world.send(
      writer,
      req("MULTI"),
      req("PUBLISH", "c", "payload"),
      req("DISCARD"),
    );

    expect(replies).toBe("+OK\r\n+QUEUED\r\n+OK\r\n");
    expect(listener.take()).toBe("");
  });

  test("EXEC runs a queued PUBLISH and delivers it", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();
    await world.send(listener, req("SUBSCRIBE", "c"));

    const replies = await world.send(writer, req("MULTI"), req("PUBLISH", "c", "hi"), req("EXEC"));

    expect(replies).toBe("+OK\r\n+QUEUED\r\n*1\r\n:1\r\n");
    expect(listener.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$2\r\nhi\r\n");
  });

  test("SUBSCRIBE is queued and takes effect at EXEC", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    const queueing = await world.send(listener, req("MULTI"), req("SUBSCRIBE", "c"));
    expect(queueing).toBe("+OK\r\n+QUEUED\r\n");
    expect(await world.send(writer, req("PUBLISH", "c", "early"))).toBe(":0\r\n");

    expect(await world.send(listener, req("EXEC"))).toBe(
      "*1\r\n*3\r\n$9\r\nsubscribe\r\n$1\r\nc\r\n:1\r\n",
    );
    expect(await world.send(writer, req("PUBLISH", "c", "late"))).toBe(":1\r\n");
    expect(listener.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$4\r\nlate\r\n");
  });

  test("surplus arguments are rejected and dirty the queue", async () => {
    const world = new Fixture();
    const peer = world.connect();

    expect(await world.send(peer, req("MULTI"))).toBe("+OK\r\n");
    expect(await world.send(peer, req("EXEC", "extra"))).toBe(
      "-ERR wrong number of arguments for 'exec' command\r\n",
    );
    expect(await world.send(peer, req("EXEC"))).toBe(
      "-EXECABORT Transaction discarded because of previous errors.\r\n",
    );
  });

  test("PUBLISH rejects surplus arguments outside MULTI", async () => {
    const world = new Fixture();
    const peer = world.connect();
    expect(await world.send(peer, req("PUBLISH", "c", "a", "b"))).toBe(
      "-ERR wrong number of arguments for 'publish' command\r\n",
    );
  });

  test("MULTI with surplus arguments is an arity error", async () => {
    const world = new Fixture();
    const peer = world.connect();
    expect(await world.send(peer, req("MULTI", "extra"))).toBe(
      "-ERR wrong number of arguments for 'multi' command\r\n",
    );
    expect(await world.send(peer, req("EXEC"))).toBe("-ERR EXEC without MULTI\r\n");
  });
});

describe("QUIT and RESET are connection transitions", () => {
  test("a command after QUIT in the same frame never runs", async () => {
    const world = new Fixture();
    const peer = world.connect();

    const frame = concatBytes([
      req("SET", "before", "1"),
      req("QUIT"),
      req("SET", "after", "1"),
    ]);
    const replies = await world.send(peer, frame);

    expect(replies).toBe("+OK\r\n+OK\r\n");
    expect(peer.closeCode).toBe(1000);

    const survivor = world.connect();
    expect(await world.send(survivor, req("GET", "before"))).toBe("$1\r\n1\r\n");
    expect(await world.send(survivor, req("GET", "after"))).toBe("$-1\r\n");
  });

  test("RESET clears live subscriptions", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("SUBSCRIBE", "c"), req("PSUBSCRIBE", "c*"));
    expect(await world.send(listener, req("RESET"))).toBe("+RESET\r\n");

    expect(await world.send(writer, req("PUBLISH", "c", "x"))).toBe(":0\r\n");
    expect(listener.take()).toBe("");
    expect(await world.send(listener, req("GET", "missing"))).toBe("$-1\r\n");
  });

  test("RESET inside MULTI resets the transaction immediately", async () => {
    const world = new Fixture();
    const peer = world.connect();

    expect(await world.send(peer, req("MULTI"), req("RESET"))).toBe("+OK\r\n+RESET\r\n");
    expect(await world.send(peer, req("EXEC"))).toBe("-ERR EXEC without MULTI\r\n");
  });

  test("RESET returns the connection to RESP2", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("HELLO", "3"));
    expect(await world.send(peer, req("GET", "missing"))).toBe("_\r\n");
    await world.send(peer, req("RESET"));
    expect(await world.send(peer, req("GET", "missing"))).toBe("$-1\r\n");
  });
});

describe("pub/sub", () => {
  test("patterns match and literals do not", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    expect(await world.send(listener, req("PSUBSCRIBE", "foo*"))).toBe(
      "*3\r\n$10\r\npsubscribe\r\n$4\r\nfoo*\r\n:1\r\n",
    );
    expect(await world.send(writer, req("PUBLISH", "foobar", "x"))).toBe(":1\r\n");
    expect(listener.take()).toBe(
      "*4\r\n$8\r\npmessage\r\n$4\r\nfoo*\r\n$6\r\nfoobar\r\n$1\r\nx\r\n",
    );
  });

  test("a literal subscription does not receive a different channel", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("SUBSCRIBE", "foo"));
    expect(await world.send(writer, req("PUBLISH", "foobar", "x"))).toBe(":0\r\n");
    expect(listener.take()).toBe("");
  });

  test("literal and pattern unsubscribes do not interfere", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SUBSCRIBE", "a"), req("PSUBSCRIBE", "a"));
    expect(await world.send(peer, req("UNSUBSCRIBE", "a"))).toBe(
      "*3\r\n$11\r\nunsubscribe\r\n$1\r\na\r\n:1\r\n",
    );
    expect(await world.send(peer, req("PUNSUBSCRIBE", "a"))).toBe(
      "*3\r\n$12\r\npunsubscribe\r\n$1\r\na\r\n:0\r\n",
    );
  });

  test("multi-channel acknowledgements are separate replies", async () => {
    const world = new Fixture();
    const peer = world.connect();

    expect(await world.send(peer, req("SUBSCRIBE", "a", "b"))).toBe(
      "*3\r\n$9\r\nsubscribe\r\n$1\r\na\r\n:1\r\n" +
        "*3\r\n$9\r\nsubscribe\r\n$1\r\nb\r\n:2\r\n",
    );
  });

  test("unsubscribing with no subscriptions acknowledges a null channel", async () => {
    const world = new Fixture();
    const peer = world.connect();

    expect(await world.send(peer, req("UNSUBSCRIBE"))).toBe(
      "*3\r\n$11\r\nunsubscribe\r\n$-1\r\n:0\r\n",
    );
    expect(await world.send(peer, req("PUNSUBSCRIBE"))).toBe(
      "*3\r\n$12\r\npunsubscribe\r\n$-1\r\n:0\r\n",
    );
  });

  test("bare UNSUBSCRIBE acknowledges each held channel", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SUBSCRIBE", "a", "b"));
    expect(await world.send(peer, req("UNSUBSCRIBE"))).toBe(
      "*3\r\n$11\r\nunsubscribe\r\n$1\r\na\r\n:1\r\n" +
        "*3\r\n$11\r\nunsubscribe\r\n$1\r\nb\r\n:0\r\n",
    );
  });

  test("channel names are compared as bytes, not as decoded text", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("SUBSCRIBE", raw(0xff)));
    expect(await world.send(writer, req("PUBLISH", raw(0xfe), "x"))).toBe(":0\r\n");
    expect(listener.take()).toBe("");
    expect(await world.send(writer, req("PUBLISH", raw(0xff), "x"))).toBe(":1\r\n");
    expect(listener.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\n\xff\r\n$1\r\nx\r\n");
  });

  test("patterns match bytes, not decoded text", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("PSUBSCRIBE", raw(0xff, 0x2a)));
    expect(await world.send(writer, req("PUBLISH", raw(0xfe, 0x01), "x"))).toBe(":0\r\n");
    expect(await world.send(writer, req("PUBLISH", raw(0xff, 0x01), "x"))).toBe(":1\r\n");
  });

  test("a RESP2 subscriber cannot run ordinary commands", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SUBSCRIBE", "c"));
    expect(await world.send(peer, req("GET", "k"))).toBe(
      "-ERR Can't execute 'get': only (P|S)SUBSCRIBE / " +
        "(P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n",
    );
  });

  test("a RESP3 subscriber may run ordinary commands", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("HELLO", "3"));
    await world.send(peer, req("SUBSCRIBE", "c"));
    expect(await world.send(peer, req("GET", "k"))).toBe("_\r\n");
  });

  test("PING has its subscribed reply shape in RESP2", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SUBSCRIBE", "c"));
    expect(await world.send(peer, req("PING"))).toBe("*2\r\n$4\r\npong\r\n$0\r\n\r\n");
    expect(await world.send(peer, req("PING", "hello"))).toBe("*2\r\n$4\r\npong\r\n$5\r\nhello\r\n");
  });

  test("RESP3 acknowledgements and deliveries are push frames", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("HELLO", "3"));
    expect(await world.send(listener, req("SUBSCRIBE", "c"))).toBe(
      ">3\r\n$9\r\nsubscribe\r\n$1\r\nc\r\n:1\r\n",
    );

    await world.send(writer, req("PUBLISH", "c", "x"));
    expect(listener.take()).toBe(">3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n");
  });

  test("RESP3 pattern deliveries are push frames", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("HELLO", "3"));
    expect(await world.send(listener, req("PSUBSCRIBE", "c*"))).toBe(
      ">3\r\n$10\r\npsubscribe\r\n$2\r\nc*\r\n:1\r\n",
    );

    await world.send(writer, req("PUBLISH", "cx", "y"));
    expect(listener.take()).toBe(
      ">4\r\n$8\r\npmessage\r\n$2\r\nc*\r\n$2\r\ncx\r\n$1\r\ny\r\n",
    );
  });

  test("each subscriber is framed for its own protocol", async () => {
    const world = new Fixture();
    const two = world.connect();
    const three = world.connect();
    const writer = world.connect();

    await world.send(three, req("HELLO", "3"));
    await world.send(two, req("SUBSCRIBE", "c"));
    await world.send(three, req("SUBSCRIBE", "c"));

    expect(await world.send(writer, req("PUBLISH", "c", "x"))).toBe(":2\r\n");
    expect(two.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n");
    expect(three.take()).toBe(">3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n");
  });

  test("a throwing peer does not abort the fan-out", async () => {
    const world = new Fixture();
    const broken = world.connect();
    const healthy = world.connect();
    const writer = world.connect();

    await world.send(broken, req("SUBSCRIBE", "c"));
    await world.send(healthy, req("SUBSCRIBE", "c"));
    broken.rejectSends = true;

    expect(await world.send(writer, req("PUBLISH", "c", "x"))).toBe(":1\r\n");
    expect(healthy.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n");
    expect(broken.closeCode).toBe(1011);
  });
});

describe("glob matching on bytes", () => {
  test("stars, classes and escapes follow Redis", async () => {
    const match = (pattern: string, subject: string): boolean =>
      matchGlobBytes(ENCODER.encode(pattern), ENCODER.encode(subject));

    expect(match("foo*", "foobar")).toBe(true);
    expect(match("foo*", "fo")).toBe(false);
    expect(match("*bar", "foobar")).toBe(true);
    expect(match("f?o", "foo")).toBe(true);
    expect(match("f?o", "fooo")).toBe(false);
    expect(match("[abc]x", "bx")).toBe(true);
    expect(match("[abc]x", "dx")).toBe(false);
    expect(match("[^abc]x", "dx")).toBe(true);
    expect(match("[a-c]x", "bx")).toBe(true);
    expect(match("[c-a]x", "bx")).toBe(true);
    expect(match("\\*x", "*x")).toBe(true);
    expect(match("\\*x", "ax")).toBe(false);
    expect(match("", "")).toBe(true);
    expect(match("", "a")).toBe(false);
    expect(match("*", "")).toBe(true);
    expect(match("a*b*c", "axxbyyc")).toBe(true);
    expect(match("a*b*c", "axxbyy")).toBe(false);
  });

  test("a pattern of many stars does not blow up", async () => {
    const pattern = ENCODER.encode(`${"*a".repeat(24)}b`);
    const subject = ENCODER.encode("a".repeat(2048));
    expect(matchGlobBytes(pattern, subject)).toBe(false);
  });
});

describe("attachment bounds", () => {
  test("a fresh connection carries a versioned attachment", async () => {
    const world = new Fixture();
    const peer = world.connect();
    const attachment = peer.attachment();

    expect(attachment?.v).toBe(ATTACHMENT_FORMAT);
    expect(attachment?.s).toBeInstanceOf(Uint8Array);
    expect((attachment?.s as Uint8Array).length).toBeLessThanOrEqual(MAX_INLINE_ATTACHMENT_BYTES);
  });

  test("a large queued value spills out of the attachment and survives hibernation", async () => {
    const world = new Fixture();
    const peer = world.connect();
    const value = "v".repeat(20_000);

    await world.send(peer, req("MULTI"), req("SET", "k", value));

    const attachment = peer.attachment();
    expect(attachment?.s).toBeNull();
    expect(attachment?.v).toBe(ATTACHMENT_FORMAT);

    const spill = world.sql
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM conn_spill")
      .one();
    expect(spill.total).toBe(1);

    world.hibernate();
    expect(await world.send(peer, req("EXEC"))).toBe("*1\r\n+OK\r\n");
    expect(await world.send(peer, req("STRLEN", "k"))).toBe(":20000\r\n");
  });

  test("the attachment shrinks back and the spill row is released", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"), req("SET", "k", "v".repeat(20_000)), req("DISCARD"));

    expect(peer.attachment()?.s).toBeInstanceOf(Uint8Array);
    const spill = world.sql
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM conn_spill")
      .one();
    expect(spill.total).toBe(0);
  });

  test("an oversized transaction queue is refused instead of acknowledged", async () => {
    const world = new Fixture();
    const peer = world.connect();
    const chunk = "v".repeat(64 * 1024);

    await world.send(peer, req("MULTI"));
    let refusal = "";
    for (let i = 0; i < 16 && refusal === ""; i++) {
      const reply = await world.send(peer, req("SET", `k${i}`, chunk));
      if (!reply.startsWith("+QUEUED")) refusal = reply;
    }

    expect(refusal).toContain("transaction queue exceeds");
    expect(await world.send(peer, req("EXEC"))).toBe(
      "-EXECABORT Transaction discarded because of previous errors.\r\n",
    );
  });

  test("subscriptions are bounded before acknowledgement", async () => {
    const world = new Fixture();
    const peer = world.connect();
    const channel = "c".repeat(1024);

    let refusal = "";
    for (let i = 0; i < 80 && refusal === ""; i++) {
      const reply = await world.send(peer, req("SUBSCRIBE", `${channel}${i}`));
      if (reply.startsWith("-")) refusal = reply;
    }

    expect(refusal).toContain("subscriptions exceed");
  });

  test("a hibernated subscription still receives publications", async () => {
    const world = new Fixture();
    const listener = world.connect();
    const writer = world.connect();

    await world.send(listener, req("SUBSCRIBE", "c"));
    world.hibernate();

    expect(await world.send(writer, req("PUBLISH", "c", "x"))).toBe(":1\r\n");
    expect(listener.take()).toBe("*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n");
  });
});

describe("protocol errors", () => {
  const VALID = req("PING");
  const MALFORMED = ENCODER.encode("*1\r\n+PONG\r\n");
  const EXPECTED =
    "+PONG\r\n-ERR Protocol error: expected '$', got '+'\r\n";

  test("a valid prefix is answered before the connection is closed", async () => {
    const world = new Fixture();
    const peer = world.connect();

    expect(await world.send(peer, concatBytes([VALID, MALFORMED]))).toBe(EXPECTED);
    expect(peer.closeCode).toBe(1000);
    expect(peer.closeReason).toBe("protocol error");
  });

  test("every chunk split produces the same bytes", async () => {
    const whole = concatBytes([VALID, MALFORMED]);

    for (let split = 1; split < whole.length; split++) {
      const world = new Fixture();
      const peer = world.connect();
      const seen =
        await world.send(peer, whole.slice(0, split)) + await world.send(peer, whole.slice(split));
      expect(seen).toBe(EXPECTED);
      expect(peer.closeCode).toBe(1000);
    }
  });

  test("an inline command still works", async () => {
    const world = new Fixture();
    const peer = world.connect();
    expect(await world.send(peer, ENCODER.encode("PING\r\n"))).toBe("+PONG\r\n");
  });
});

describe("WATCH", () => {
  test("a concurrent write aborts EXEC with a null reply", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    await world.send(other, req("SET", "k", "changed"));
    await world.send(watcher, req("MULTI"), req("SET", "k", "mine"));

    expect(await world.send(watcher, req("EXEC"))).toBe("*-1\r\n");
    expect(await world.send(other, req("GET", "k"))).toBe("$7\r\nchanged\r\n");
  });

  test("an untouched watch lets EXEC through", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    await world.send(other, req("SET", "unrelated", "1"));
    await world.send(watcher, req("MULTI"), req("SET", "k", "mine"));

    expect(await world.send(watcher, req("EXEC"))).toBe("*1\r\n+OK\r\n");
  });

  test("UNWATCH cancels the guard", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    await world.send(other, req("SET", "k", "changed"));
    expect(await world.send(watcher, req("UNWATCH"))).toBe("+OK\r\n");

    await world.send(watcher, req("MULTI"), req("SET", "k", "mine"));
    expect(await world.send(watcher, req("EXEC"))).toBe("*1\r\n+OK\r\n");
  });

  test("WATCH inside MULTI is refused", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"));
    expect(await world.send(peer, req("WATCH", "k"))).toBe(
      "-ERR WATCH inside MULTI is not allowed\r\n",
    );
  });

  test("FLUSHALL touches every watched key", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    await world.send(other, req("FLUSHALL"));
    await world.send(watcher, req("MULTI"), req("SET", "k", "mine"));

    expect(await world.send(watcher, req("EXEC"))).toBe("*-1\r\n");
  });

  test("a watch survives hibernation", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    world.hibernate();
    await world.send(other, req("SET", "k", "changed"));
    await world.send(watcher, req("MULTI"), req("SET", "k", "mine"));

    expect(await world.send(watcher, req("EXEC"))).toBe("*-1\r\n");
  });

  test("closing a connection releases its watches", async () => {
    const world = new Fixture();
    const watcher = world.connect();
    const other = world.connect();

    await world.send(watcher, req("WATCH", "k"));
    world.executor.close(watcher);

    await world.send(other, req("SET", "k", "changed"));
    const rows = world.sql
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM conn_watch")
      .one();
    expect(rows.total).toBe(0);
  });
});

describe("connection identifiers", () => {
  test("ids come from storage and never collide after reinitialization", async () => {
    const world = new Fixture();
    const first = world.connect();
    const second = world.connect();

    expect(await world.send(first, req("CLIENT", "ID"))).toBe(":1\r\n");
    expect(await world.send(second, req("CLIENT", "ID"))).toBe(":2\r\n");

    world.hibernate();
    const third = world.connect();
    expect(await world.send(third, req("CLIENT", "ID"))).toBe(":3\r\n");
    expect(await world.send(first, req("CLIENT", "ID"))).toBe(":1\r\n");
  });

  test("reap clears state left behind by connections that are gone", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("WATCH", "k"), req("MULTI"), req("SET", "k", "v".repeat(20_000)));
    world.peers.length = 0;
    world.executor.reap();

    expect(
      world.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM conn_spill").one().total,
    ).toBe(0);
    expect(
      world.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM conn_watch").one().total,
    ).toBe(0);
  });
});

describe("failure boundaries", () => {
  test("a storage failure outside a transaction becomes an internal error", async () => {
    const world = new Fixture();
    const peer = world.connect();

    world.sql.interrupt(/INSERT OR REPLACE INTO str/);
    const reply = await quietly(() => world.send(peer, req("SET", "k", "v")));
    world.sql.recover();

    expect(reply).toBe("-ERR internal error\r\n");
    expect(peer.closeCode).toBeNull();
    expect(await world.send(peer, req("PING"))).toBe("+PONG\r\n");
  });

  test("a storage failure inside EXEC rolls the whole transaction back", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"), req("SET", "a", "1"), req("SET", "b", "2"));

    world.sql.interrupt(/INSERT OR REPLACE INTO str/, 1);
    const reply = await quietly(() => world.send(peer, req("EXEC")));
    world.sql.recover();

    expect(reply).toBe("-ERR internal error\r\n");
    expect(await world.send(peer, req("GET", "a"))).toBe("$-1\r\n");
    expect(await world.send(peer, req("GET", "b"))).toBe("$-1\r\n");
  });

  test("an ordinary error inside EXEC preserves its successful siblings", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"), req("SET", "k", "v"), req("INCR", "k"), req("APPEND", "k", "!"));

    expect(await world.send(peer, req("EXEC"))).toBe(
      "*3\r\n+OK\r\n-ERR value is not an integer or out of range\r\n:2\r\n",
    );
    expect(await world.send(peer, req("GET", "k"))).toBe("$2\r\nv!\r\n");
  });

  test("a failed EXEC leaves the connection usable and out of MULTI", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"), req("SET", "a", "1"));
    world.sql.interrupt(/INSERT OR REPLACE INTO str/);
    await quietly(() => world.send(peer, req("EXEC")));
    world.sql.recover();

    expect(await world.send(peer, req("EXEC"))).toBe("-ERR EXEC without MULTI\r\n");
    expect(await world.send(peer, req("SET", "a", "1"))).toBe("+OK\r\n");
  });
});

describe("diagnostic text", () => {
  test("an unknown command name is escaped and bounded inside MULTI", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("MULTI"));
    const reply = await world.send(peer, req(raw(0xff, 0x01, 0x7f)));

    expect(reply).toContain("\\xff\\x01\\x7f");
    expect(reply).not.toContain("�");
    expect(await world.send(peer, req("EXEC"))).toBe(
      "-EXECABORT Transaction discarded because of previous errors.\r\n",
    );
  });

  test("a very long unknown command does not produce a very long error", async () => {
    const world = new Fixture();
    const peer = world.connect();

    const reply = await world.send(peer, req("z".repeat(5000), "y".repeat(5000)));
    expect(reply.length).toBeLessThan(1024);
  });

  test("the subscribed-context error names a bounded command", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SUBSCRIBE", "c"));
    const reply = await world.send(peer, req("GETRANGE", "k", "0", "1"));
    expect(reply).toStartWith("-ERR Can't execute 'getrange':");
  });
});

describe("cold tier", () => {
  const EVICT_EVERYTHING: TierPolicy = {
    highWatermarkBytes: 0,
    lowWatermarkBytes: 0,
    maxEvictionsPerPass: 1024,
    planner: { ...DEFAULT_POLICY, minEvictableBytes: 0 },
  };

  test("a string survives eviction and comes back on read", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "k", "hello"));
    const pass = await world.executor.relieve(EVICT_EVERYTHING);

    expect(pass?.demoted).toBeGreaterThan(0);
    expect(world.bucket.objects.size).toBeGreaterThan(0);
    expect(await world.send(peer, req("GET", "k"))).toBe("$5\r\nhello\r\n");
  });

  test("an aggregate comes back whole, so a later write cannot truncate it", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("HSET", "h", "a", "1", "b", "2", "c", "3"));
    await world.executor.relieve(EVICT_EVERYTHING);

    expect(await world.send(peer, req("HSET", "h", "d", "4"))).toBe(":1\r\n");
    expect(await world.send(peer, req("HLEN", "h"))).toBe(":4\r\n");
    expect(await world.send(peer, req("HGET", "h", "b"))).toBe("$1\r\n2\r\n");
  });

  test("an unreachable cold value fails the command instead of writing a partial key", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "k", "hello"));
    await world.executor.relieve(EVICT_EVERYTHING);

    world.bucket.failAlways({ op: "get", error: new Error("R2 is unreachable") });
    const reply = await quietly(() => world.send(peer, req("APPEND", "k", "!")));
    world.bucket.clearFaults();

    expect(reply).toBe("-ERR internal error\r\n");
    expect(await world.send(peer, req("GET", "k"))).toBe("$5\r\nhello\r\n");
  });

  test("EXEC faults in every queued key before opening the transaction", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "a", "1"), req("SET", "b", "2"));
    await world.executor.relieve(EVICT_EVERYTHING);

    await world.send(peer, req("MULTI"), req("APPEND", "a", "x"), req("APPEND", "b", "y"));
    expect(await world.send(peer, req("EXEC"))).toBe("*2\r\n:2\r\n:2\r\n");
    expect(await world.send(peer, req("GET", "a"))).toBe("$2\r\n1x\r\n");
  });

  test("a resident keyspace never touches the bucket", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    for (let i = 0; i < 20; i++) await world.send(peer, req("SET", `k${i}`, "v"));
    await world.send(peer, req("GET", "k1"), req("DEL", "k2"), req("KEYS", "*"));

    expect(world.bucket.calls).toHaveLength(0);
    expect(world.executor.tiering?.index.size).toBe(0);
  });

  test("a failed upload leaves the value readable", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "k", "hello"));
    world.bucket.failAlways({ op: "put", error: new Error("R2 refused the write") });
    await quietly(() => world.executor.relieve(EVICT_EVERYTHING));
    world.bucket.clearFaults();

    expect(await world.send(peer, req("GET", "k"))).toBe("$5\r\nhello\r\n");
  });

  test("eviction is inert without a bucket", async () => {
    const world = new Fixture();
    const peer = world.connect();

    await world.send(peer, req("SET", "k", "v"));
    expect(world.executor.tiering).toBeNull();
    expect(await world.executor.relieve(EVICT_EVERYTHING)).toBeNull();
    expect(await world.send(peer, req("GET", "k"))).toBe("$1\r\nv\r\n");
  });

  test("a cold key is restored across hibernation", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "k", "hello"));
    await world.executor.relieve(EVICT_EVERYTHING);
    world.hibernate();

    expect(world.executor.tiering?.index.size).toBe(1);
    expect(await world.send(peer, req("GET", "k"))).toBe("$5\r\nhello\r\n");
  });
});

describe("ordering across an await", () => {
  const EVICT_EVERYTHING: TierPolicy = {
    highWatermarkBytes: 0,
    lowWatermarkBytes: 0,
    maxEvictionsPerPass: 1024,
    planner: { ...DEFAULT_POLICY, minEvictableBytes: 0 },
  };

  test("one connection keeps request order while a fault-in is in flight", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "cold", "value"));
    await world.executor.relieve(EVICT_EVERYTHING);
    world.bucket.latencyMs = 5;

    const slow = world.executor.message(peer, req("GET", "cold"), NOW);
    const fast = world.executor.message(peer, req("PING"), NOW);
    await Promise.all([slow, fast]);

    expect(peer.take()).toBe("$5\r\nvalue\r\n+PONG\r\n");
  });

  test("a pipelined frame behind a fault-in is not reordered", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "cold", "value"));
    await world.executor.relieve(EVICT_EVERYTHING);
    world.bucket.latencyMs = 5;

    const first = world.executor.message(peer, req("GET", "cold"), NOW);
    const second = world.executor.message(peer, concatBytes([req("ECHO", "a"), req("ECHO", "b")]), NOW);
    await Promise.all([first, second]);

    expect(peer.take()).toBe("$5\r\nvalue\r\n$1\r\na\r\n$1\r\nb\r\n");
  });

  test("a faulting connection does not block another connection", async () => {
    const world = new Fixture(true);
    const faulting = world.connect();
    const other = world.connect();

    await world.send(faulting, req("SET", "cold", "value"));
    await world.executor.relieve(EVICT_EVERYTHING);
    world.bucket.latencyMs = 5;

    const slow = world.executor.message(faulting, req("GET", "cold"), NOW);
    await world.executor.message(other, req("PING"), NOW);

    expect(other.take()).toBe("+PONG\r\n");
    expect(faulting.wire()).toBe("");

    await slow;
    expect(faulting.take()).toBe("$5\r\nvalue\r\n");
  });

  test("QUIT behind a fault-in still discards the rest of the pipeline", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    await world.send(peer, req("SET", "cold", "value"));
    await world.executor.relieve(EVICT_EVERYTHING);
    world.bucket.latencyMs = 5;

    const frame = concatBytes([req("GET", "cold"), req("QUIT"), req("SET", "after", "1")]);
    await world.executor.message(peer, frame, NOW);

    expect(peer.take()).toBe("$5\r\nvalue\r\n+OK\r\n");
    expect(peer.closeCode).toBe(1000);

    world.bucket.latencyMs = 0;
    const survivor = world.connect();
    expect(await world.send(survivor, req("GET", "after"))).toBe("$-1\r\n");
  });
});

describe("cold index priming", () => {
  test("an empty keyspace primes to nothing and stays on the resident path", () => {
    const world = new Fixture(true);
    expect(world.executor.tiering?.index.primed).toBe(true);
    expect(world.executor.tiering?.index.size).toBe(0);
  });

  test("priming is skipped when too many keys are cold to hold in memory", async () => {
    const world = new Fixture(true);
    const peer = world.connect();

    for (let i = 0; i < 4; i++) await world.send(peer, req("SET", `k${i}`, "v"));
    await world.executor.relieve({
      highWatermarkBytes: 0,
      lowWatermarkBytes: 0,
      maxEvictionsPerPass: 1024,
      planner: { ...DEFAULT_POLICY, minEvictableBytes: 0 },
    });

    const cramped = new SessionExecutor({ ...world.host, coldIndexLimit: 2 });
    expect(cramped.tiering?.index.primed).toBe(false);

    world.executor = cramped;
    expect(await world.send(peer, req("GET", "k0"))).toBe("$1\r\nv\r\n");
    expect(await world.send(peer, req("APPEND", "k1", "!"))).toBe(":2\r\n");
  });
});
