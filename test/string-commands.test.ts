import { beforeEach, describe, expect, test } from "bun:test";

import { dispatch, registry } from "../src/commands";
import type { Ctx } from "../src/commands/spec";
import {
  applySchema,
  type SqlBinding,
  type SqlCursor,
  type SqlRow,
  type SqlRowShape,
  type SqlStorage,
} from "../src/schema";
import { Store } from "../src/store";
import { type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import { FakeSqlStorage } from "./sqlite-adapter";

let sql: SqlStorage;
let ctx: Ctx;

const run = (...parts: string[]): Reply => dispatch(ctx, parts.map(encodeUtf8));
const text = (...parts: string[]): string => {
  const reply = run(...parts);
  if (reply.kind === "bulk") return decodeUtf8(reply.value);
  if (reply.kind === "error" || reply.kind === "simple") return reply.value;
  if (reply.kind === "integer") return String(reply.value);
  return `<${reply.kind}>`;
};

beforeEach(() => {
  sql = new FakeSqlStorage();
  applySchema(sql);
  ctx = {
    store: new Store(sql),
    sql,
    now: Date.now(),
    conn: { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false },
    commands: registry,
  };
});

describe("GETRANGE returns empty when both ends count back and start is past end", () => {
  beforeEach(() => {
    run("SET", "v", "hello");
  });

  test("the rule fires on the relation, not on how far out of range the ends are", () => {
    for (const [start, end] of [
      ["-1", "-2"],
      ["-2", "-5"],
      ["-5", "-7"],
      ["-6", "-7"],
      ["-7", "-9"],
      ["-1", "-10"],
      ["-100", "-200"],
    ]) {
      expect(text("GETRANGE", "v", start as string, end as string)).toBe("");
    }
  });

  test("ends that are equal or in order still clamp independently", () => {
    expect(text("GETRANGE", "v", "-100", "-100")).toBe("h");
    expect(text("GETRANGE", "v", "-200", "-100")).toBe("h");
    expect(text("GETRANGE", "v", "-6", "-6")).toBe("h");
    expect(text("GETRANGE", "v", "-5", "-5")).toBe("h");
    expect(text("GETRANGE", "v", "-10", "-1")).toBe("hello");
    expect(text("GETRANGE", "v", "-3", "-3")).toBe("l");
    expect(text("GETRANGE", "v", "-2", "-1")).toBe("lo");
    expect(text("GETRANGE", "v", "-1", "-1")).toBe("o");
  });

  test("a mixed-sign pair is not the rule's business and clamps as before", () => {
    expect(text("GETRANGE", "v", "0", "-1")).toBe("hello");
    expect(text("GETRANGE", "v", "-9", "3")).toBe("hell");
    expect(text("GETRANGE", "v", "3", "-9")).toBe("");
    expect(text("GETRANGE", "v", "-1", "0")).toBe("");
    expect(text("GETRANGE", "v", "0", "0")).toBe("h");
    expect(text("GETRANGE", "v", "5", "2")).toBe("");
  });

  test("a wrong type still outranks the empty reply", () => {
    run("SADD", "s", "m");
    expect(text("GETRANGE", "s", "-100", "-200")).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
  });

  test("a missing or empty value replies empty whatever the ends are", () => {
    expect(text("GETRANGE", "missing", "-100", "-200")).toBe("");
    run("SET", "empty", "");
    expect(text("GETRANGE", "empty", "-100", "-200")).toBe("");
  });

  test("SUBSTR shares the rule", () => {
    expect(text("SUBSTR", "v", "-100", "-200")).toBe("");
    expect(text("SUBSTR", "v", "-2", "-1")).toBe("lo");
  });
});

describe("GETEX validates its expiry before it looks the key up", () => {
  test("an invalid duration is an error even when the key is absent", () => {
    expect(text("GETEX", "missing", "EX", "0")).toBe(
      "ERR invalid expire time in 'getex' command",
    );
    expect(run("GETEX", "missing").kind).toBe("null");
  });

  test("a valid duration still reads, sets and persists", () => {
    run("SET", "k", "v");
    expect(text("GETEX", "k", "EX", "100")).toBe("v");
    expect(text("TTL", "k")).toBe("100");
    expect(text("GETEX", "k", "PERSIST")).toBe("v");
    expect(text("TTL", "k")).toBe("-1");
  });
});

describe("string writes that the reorganized suite left uncovered", () => {
  test("SETNX writes only an absent key", () => {
    expect(text("SETNX", "a", "first")).toBe("1");
    expect(text("SETNX", "a", "second")).toBe("0");
    expect(text("GET", "a")).toBe("first");
  });

  test("KEEPTTL keeps the deadline that a plain SET discards", () => {
    run("SET", "t", "v", "EX", "100");
    run("SET", "t", "w", "KEEPTTL");
    expect(text("TTL", "t")).toBe("100");
    run("SET", "t", "z");
    expect(text("TTL", "t")).toBe("-1");
  });

  test("SETEX and PSETEX set a deadline and refuse a zero one", () => {
    run("SETEX", "s1", "100", "v");
    expect(text("TTL", "s1")).toBe("100");
    expect(text("SETEX", "s2", "0", "v")).toBe("ERR invalid expire time in 'setex' command");

    run("PSETEX", "s3", "100000", "v");
    expect(text("TTL", "s3")).toBe("100");
    expect(text("PSETEX", "s4", "0", "v")).toBe("ERR invalid expire time in 'psetex' command");
  });

  test("GETDEL returns the value once", () => {
    run("SET", "a", "first");
    expect(text("GETDEL", "a")).toBe("first");
    expect(text("EXISTS", "a")).toBe("0");
    expect(run("GETDEL", "a").kind).toBe("null");
  });

  test("MSETNX writes all of its pairs or none of them", () => {
    run("MSET", "m1", "1", "m2", "2");
    expect(text("GET", "m2")).toBe("2");
    expect(text("MSETNX", "m2", "x", "m3", "y")).toBe("0");
    expect(text("EXISTS", "m3")).toBe("0");
    expect(text("MSETNX", "n1", "x", "n2", "y")).toBe("1");
    expect(text("GET", "n2")).toBe("y");
  });

  test("NX, XX and GET agree on what the key was before the write", () => {
    run("SET", "m1", "1");
    expect(run("SET", "miss", "v", "XX").kind).toBe("null");
    expect(text("EXISTS", "miss")).toBe("0");
    expect(run("SET", "m1", "v", "NX").kind).toBe("null");
    expect(text("SET", "m1", "new", "GET")).toBe("1");
    expect(text("GET", "m1")).toBe("new");
    expect(run("SET", "fresh", "v", "GET").kind).toBe("null");
    expect(text("SET", "m1", "again", "XX", "GET")).toBe("new");
  });
});

describe("the folded string read keeps lazy expiry doing the purging", () => {
  class CountingSqlStorage implements SqlStorage {
    readonly inner = new FakeSqlStorage();
    readonly queries: string[] = [];

    exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
      this.queries.push(query);
      return this.inner.exec<T>(query, ...bindings);
    }
  }

  let counting: CountingSqlStorage;
  let clock: number;
  let store: Store;

  const at = (moment: number): Ctx => ({
    store,
    sql: counting,
    now: moment,
    conn: { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false },
    commands: registry,
  });

  const rowsIn = (table: string, key: string): number =>
    counting.inner.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`,
      encodeUtf8(key),
    ).one().n;

  const say = (moment: number, ...parts: string[]): Reply =>
    dispatch(at(moment), parts.map(encodeUtf8));

  beforeEach(() => {
    counting = new CountingSqlStorage();
    applySchema(counting);
    clock = 1_700_000_000_000;
    store = new Store(counting, () => clock);
  });

  test("a GET past the deadline replies nil and leaves no rows behind", () => {
    say(clock, "SET", "k", "v", "PX", "100");
    expect(rowsIn("str", "k")).toBe(1);
    expect(rowsIn("meta", "k")).toBe(1);

    clock += 101;
    expect(say(clock, "GET", "k").kind).toBe("null");

    expect(rowsIn("str", "k")).toBe(0);
    expect(rowsIn("meta", "k")).toBe(0);
    expect(say(clock, "TYPE", "k").kind).toBe("simple");
    expect(store.typeOf(encodeUtf8("k"))).toBe("none");
  });

  test("MGET past the deadline purges too, and never reports the stale value", () => {
    say(clock, "SET", "gone", "v", "PX", "100");
    say(clock, "SET", "kept", "w");

    clock += 101;
    const reply = say(clock, "MGET", "gone", "kept");
    expect(reply.kind).toBe("array");
    expect(reply.kind === "array" ? reply.value.map((r) => r.kind) : []).toEqual(["null", "bulk"]);
    expect(rowsIn("str", "gone")).toBe(0);
    expect(rowsIn("meta", "gone")).toBe(0);
  });

  test("a live GET reads once, not once for the metadata and again for the value", () => {
    say(clock, "SET", "k", "v", "PX", "100");

    clock += 50;
    counting.queries.length = 0;
    expect(say(clock, "GET", "k").kind).toBe("bulk");

    expect(counting.queries.length).toBe(1);
    expect(counting.queries[0]).toContain("meta");
    expect(counting.queries[0]).toContain("str");
    expect(rowsIn("str", "k")).toBe(1);
  });

  test("the fold still raises WRONGTYPE for another type", () => {
    say(clock, "SADD", "s", "m");
    const reply = say(clock, "GET", "s");
    expect(reply.kind === "error" ? reply.value : "").toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
    expect(say(clock, "MGET", "s").kind).toBe("array");
  });
});
