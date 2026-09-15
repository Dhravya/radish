import { beforeEach, describe, expect, test } from "bun:test";

import { dispatch, registry } from "../src/commands";
import type { Ctx } from "../src/commands/spec";
import { encodeReply } from "../src/resp";
import { applySchema, type SqlStorage } from "../src/schema";
import { Store } from "../src/store";
import { type Command, type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import { FakeSqlStorage } from "./sqlite-adapter";

type Arg = string | number | Uint8Array;

const argv = (parts: readonly Arg[]): Command =>
  parts.map((part) =>
    part instanceof Uint8Array ? part : encodeUtf8(typeof part === "number" ? String(part) : part),
  );

const flat = (reply: Reply): unknown => {
  switch (reply.kind) {
    case "simple":
      return reply.value;
    case "error":
      return reply.value;
    case "integer":
      return Number(reply.value);
    case "bulk":
      return decodeUtf8(reply.value);
    case "double":
      return reply.value;
    case "boolean":
      return reply.value;
    case "array":
    case "set":
      return reply.value.map(flat);
    case "map":
      return reply.value.flatMap(([k, v]) => [flat(k), flat(v)]);
    case "null":
    case "nullArray":
      return null;
  }
};

let sql: SqlStorage;
let store: Store;
let ctx: Ctx;

const r = (...parts: Arg[]): unknown => flat(dispatch(ctx, argv(parts)));
const kind = (...parts: Arg[]): Reply["kind"] => dispatch(ctx, argv(parts)).kind;
const reply = (...parts: Arg[]): Reply => dispatch(ctx, argv(parts));

beforeEach(() => {
  sql = new FakeSqlStorage();
  applySchema(sql);
  store = new Store(sql);
  ctx = {
    store,
    sql,
    now: Date.now(),
    conn: { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false },
    commands: registry,
  };
});

describe("hash", () => {
  test("HSET reports only newly created fields", () => {
    expect(r("HSET", "h", "a", "1", "b", "2")).toBe(2);
    expect(r("HSET", "h", "a", "9")).toBe(0);
    expect(r("HGET", "h", "a")).toBe("9");
    expect(r("HLEN", "h")).toBe(2);
  });

  test("HSET with an odd field/value tail is an arity error", () => {
    expect(r("HSET", "h", "a", "1", "b")).toBe(
      "ERR wrong number of arguments for 'hset' command",
    );
  });

  test("HSETNX only writes an absent field", () => {
    expect(r("HSETNX", "h", "a", "1")).toBe(1);
    expect(r("HSETNX", "h", "a", "2")).toBe(0);
    expect(r("HGET", "h", "a")).toBe("1");
  });

  test("HMSET replies +OK and HMGET nils missing fields", () => {
    expect(r("HMSET", "h", "a", "1", "b", "2")).toBe("OK");
    expect(r("HMGET", "h", "a", "zz", "b")).toEqual(["1", null, "2"]);
    expect(r("HMGET", "nope", "a")).toEqual([null]);
  });

  test("reads of a missing hash are empty, not errors", () => {
    expect(kind("HGET", "nope", "a")).toBe("null");
    expect(r("HLEN", "nope")).toBe(0);
    expect(r("HEXISTS", "nope", "a")).toBe(0);
    expect(r("HSTRLEN", "nope", "a")).toBe(0);
    expect(r("HKEYS", "nope")).toEqual([]);
    expect(r("HVALS", "nope")).toEqual([]);
    expect(r("HGETALL", "nope")).toEqual([]);
    expect(r("HDEL", "nope", "a")).toBe(0);
  });

  test("HKEYS, HVALS and HGETALL agree, in field order", () => {
    r("HSET", "h", "b", "2", "a", "1", "c", "3");
    expect(r("HKEYS", "h")).toEqual(["a", "b", "c"]);
    expect(r("HVALS", "h")).toEqual(["1", "2", "3"]);
    expect(r("HGETALL", "h")).toEqual(["a", "1", "b", "2", "c", "3"]);
    expect(kind("HGETALL", "h")).toBe("map");
  });

  test("HDEL deletes the key once the last field goes", () => {
    r("HSET", "h", "a", "1", "b", "2");
    expect(r("HDEL", "h", "a", "zz")).toBe(1);
    expect(r("TYPE", "h")).toBe("hash");
    expect(r("HDEL", "h", "b")).toBe(1);
    expect(r("EXISTS", "h")).toBe(0);
    expect(r("TYPE", "h")).toBe("none");
  });

  test("HSTRLEN measures bytes, not characters", () => {
    r("HSET", "h", "a", "héllo");
    expect(r("HSTRLEN", "h", "a")).toBe(6);
    expect(r("HSTRLEN", "h", "missing")).toBe(0);
  });

  test("HINCRBY creates, accumulates, and refuses non-integers", () => {
    expect(r("HINCRBY", "h", "n", "5")).toBe(5);
    expect(r("HINCRBY", "h", "n", "-8")).toBe(-3);
    expect(r("HGET", "h", "n")).toBe("-3");
    r("HSET", "h", "s", "abc");
    expect(r("HINCRBY", "h", "s", "1")).toBe("ERR hash value is not an integer");
    expect(r("HINCRBY", "h", "n", "x")).toBe("ERR value is not an integer or out of range");
  });

  test("HINCRBY detects 64-bit overflow", () => {
    r("HSET", "h", "n", "9223372036854775807");
    expect(r("HINCRBY", "h", "n", "1")).toBe("ERR increment or decrement would overflow");
    expect(r("HGET", "h", "n")).toBe("9223372036854775807");
  });

  test("HINCRBYFLOAT prints the human form, not a raw double", () => {
    expect(r("HINCRBYFLOAT", "h", "f", "10.5")).toBe("10.5");
    expect(r("HINCRBYFLOAT", "h", "f", "0.1")).toBe("10.6");
    expect(r("HINCRBYFLOAT", "h", "f", "5.0e3")).toBe("5010.6");
    expect(r("HINCRBYFLOAT", "h", "g", "3.0")).toBe("3");
    expect(r("HINCRBYFLOAT", "h", "g", "inf")).toBe(
      "ERR increment would produce NaN or Infinity",
    );
    r("HSET", "h", "s", "abc");
    expect(r("HINCRBYFLOAT", "h", "s", "1")).toBe("ERR hash value is not a float");
    expect(r("HINCRBYFLOAT", "h", "f", "abc")).toBe("ERR value is not a valid float");
  });

  test("HRANDFIELD distinguishes positive, negative and absent counts", () => {
    r("HSET", "h", "a", "1", "b", "2", "c", "3");
    expect(r("HRANDFIELD", "h")).toMatch(/^[abc]$/);
    expect((r("HRANDFIELD", "h", "2") as string[]).length).toBe(2);
    expect(new Set(r("HRANDFIELD", "h", "10") as string[]).size).toBe(3);
    expect((r("HRANDFIELD", "h", "-7") as string[]).length).toBe(7);
    expect(r("HRANDFIELD", "h", "0")).toEqual([]);
    const pairs = r("HRANDFIELD", "h", "3", "WITHVALUES") as string[];
    expect(pairs.length).toBe(6);
    expect(kind("HRANDFIELD", "nope")).toBe("null");
    expect(r("HRANDFIELD", "nope", "3")).toEqual([]);
  });

  test("HSCAN walks every field exactly once across pages", () => {
    for (let i = 0; i < 250; i++) r("HSET", "h", `f${i}`, `v${i}`);
    const seen = new Map<string, string>();
    let cursor = "0";
    let pages = 0;
    do {
      const [next, items] = r("HSCAN", "h", cursor, "COUNT", "17") as [string, string[]];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i]!, items[i + 1]!);
      cursor = next;
      pages++;
    } while (cursor !== "0" && pages < 100);
    expect(cursor).toBe("0");
    expect(seen.size).toBe(250);
    expect(seen.get("f42")).toBe("v42");
  });

  test("HSCAN honours MATCH and NOVALUES", () => {
    r("HSET", "h", "aa", "1", "ab", "2", "bb", "3");
    const [, matched] = r("HSCAN", "h", "0", "MATCH", "a*") as [string, string[]];
    expect(matched).toEqual(["aa", "1", "ab", "2"]);
    const [, bare] = r("HSCAN", "h", "0", "NOVALUES") as [string, string[]];
    expect(bare).toEqual(["aa", "ab", "bb"]);
    expect(r("HSCAN", "h", "notanumber")).toBe("ERR invalid cursor");
    expect(r("HSCAN", "nope", "0")).toEqual(["0", []]);
  });

  test("every hash command rejects a key of another type", () => {
    r("RPUSH", "l", "x");
    const wrong = "WRONGTYPE Operation against a key holding the wrong kind of value";
    expect(r("HGET", "l", "a")).toBe(wrong);
    expect(r("HSET", "l", "a", "1")).toBe(wrong);
    expect(r("HDEL", "l", "a")).toBe(wrong);
    expect(r("HGETALL", "l")).toBe(wrong);
    expect(r("HINCRBY", "l", "a", "1")).toBe(wrong);
    expect(r("HSCAN", "l", "0")).toBe(wrong);
  });
});

describe("list", () => {
  test("LPUSH and RPUSH build from opposite ends", () => {
    expect(r("RPUSH", "l", "b", "c")).toBe(2);
    expect(r("LPUSH", "l", "a")).toBe(3);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["a", "b", "c"]);
    expect(r("LPUSH", "l", "x", "y", "z")).toBe(6);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["z", "y", "x", "a", "b", "c"]);
  });

  test("LPUSHX and RPUSHX refuse to create", () => {
    expect(r("LPUSHX", "l", "a")).toBe(0);
    expect(r("RPUSHX", "l", "a")).toBe(0);
    expect(r("EXISTS", "l")).toBe(0);
    r("RPUSH", "l", "seed");
    expect(r("LPUSHX", "l", "a")).toBe(2);
    expect(r("RPUSHX", "l", "b")).toBe(3);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["a", "seed", "b"]);
  });

  test("head and tail pushes stay independent across 10k alternating pushes", () => {
    const expected: string[] = [];
    for (let i = 0; i < 5000; i++) {
      r("LPUSH", "l", `L${i}`);
      expected.unshift(`L${i}`);
      r("RPUSH", "l", `R${i}`);
      expected.push(`R${i}`);
    }
    expect(r("LLEN", "l")).toBe(10000);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(expected);
    expect(r("LINDEX", "l", "0")).toBe("L4999");
    expect(r("LINDEX", "l", "-1")).toBe("R4999");
    expect(r("LINDEX", "l", "5000")).toBe("R0");
  });

  test("LINSERT keeps working after the midpoints between two seqs run out", () => {
    r("RPUSH", "l", "a", "b");
    for (let i = 0; i < 60; i++) {
      expect(r("LINSERT", "l", "AFTER", "a", `x${i}`)).toBe(i + 3);
    }
    const expected = ["a", ...Array.from({ length: 60 }, (_, i) => `x${59 - i}`), "b"];
    expect(r("LRANGE", "l", "0", "-1")).toEqual(expected);
    expect(r("LPUSH", "l", "head")).toBe(63);
    expect(r("RPUSH", "l", "tail")).toBe(64);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["head", ...expected, "tail"]);
  });

  test("LINSERT BEFORE at the head needs no midpoint", () => {
    r("RPUSH", "l", "a", "b");
    expect(r("LINSERT", "l", "BEFORE", "a", "z")).toBe(3);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["z", "a", "b"]);
    expect(r("LINSERT", "l", "BEFORE", "missing", "q")).toBe(-1);
    expect(r("LINSERT", "nope", "BEFORE", "a", "q")).toBe(0);
    expect(r("LINSERT", "l", "SIDEWAYS", "a", "q")).toBe("ERR syntax error");
  });

  test("LRANGE clamps out-of-range and inverted windows", () => {
    r("RPUSH", "l", "a", "b", "c", "d", "e");
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["a", "b", "c", "d", "e"]);
    expect(r("LRANGE", "l", "-3", "-2")).toEqual(["c", "d"]);
    expect(r("LRANGE", "l", "-100", "100")).toEqual(["a", "b", "c", "d", "e"]);
    expect(r("LRANGE", "l", "3", "1")).toEqual([]);
    expect(r("LRANGE", "l", "10", "20")).toEqual([]);
    expect(r("LRANGE", "l", "-1", "-5")).toEqual([]);
    expect(r("LRANGE", "nope", "0", "-1")).toEqual([]);
  });

  test("LPOP and RPOP distinguish nil from nil-array", () => {
    r("RPUSH", "l", "a", "b", "c");
    expect(r("LPOP", "l")).toBe("a");
    expect(r("RPOP", "l")).toBe("c");
    expect(r("RPOP", "l", "5")).toEqual(["b"]);
    expect(r("EXISTS", "l")).toBe(0);
    expect(kind("LPOP", "l")).toBe("null");
    expect(kind("LPOP", "l", "2")).toBe("nullArray");
    r("RPUSH", "l", "a", "b", "c");
    expect(r("RPOP", "l", "2")).toEqual(["c", "b"]);
    expect(r("LPOP", "l", "0")).toEqual([]);
    expect(r("LPOP", "l", "-1")).toBe("ERR value is out of range, must be positive");
  });

  test("LSET and LINDEX address from both ends", () => {
    r("RPUSH", "l", "a", "b", "c");
    expect(r("LSET", "l", "-1", "C")).toBe("OK");
    expect(r("LINDEX", "l", "2")).toBe("C");
    expect(r("LSET", "l", "9", "x")).toBe("ERR index out of range");
    expect(r("LSET", "nope", "0", "x")).toBe("ERR no such key");
    expect(kind("LINDEX", "l", "99")).toBe("null");
    expect(kind("LINDEX", "nope", "0")).toBe("null");
  });

  test("LREM removes from the head, the tail, or everywhere", () => {
    const seed = (): void => {
      r("DEL", "l");
      r("RPUSH", "l", "a", "b", "a", "c", "a");
    };
    seed();
    expect(r("LREM", "l", "2", "a")).toBe(2);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["b", "c", "a"]);
    seed();
    expect(r("LREM", "l", "-2", "a")).toBe(2);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["a", "b", "c"]);
    seed();
    expect(r("LREM", "l", "0", "a")).toBe(3);
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["b", "c"]);
    expect(r("LREM", "l", "0", "b")).toBe(1);
    expect(r("LREM", "l", "0", "c")).toBe(1);
    expect(r("EXISTS", "l")).toBe(0);
  });

  test("LTRIM keeps a window, and an empty window deletes the key", () => {
    r("RPUSH", "l", "a", "b", "c", "d", "e");
    expect(r("LTRIM", "l", "1", "-2")).toBe("OK");
    expect(r("LRANGE", "l", "0", "-1")).toEqual(["b", "c", "d"]);
    expect(r("LTRIM", "l", "5", "10")).toBe("OK");
    expect(r("EXISTS", "l")).toBe(0);
    expect(r("LTRIM", "nope", "0", "-1")).toBe("OK");
  });

  test("RPOPLPUSH and LMOVE move, and rotate in place", () => {
    r("RPUSH", "src", "a", "b", "c");
    expect(r("RPOPLPUSH", "src", "dst")).toBe("c");
    expect(r("LRANGE", "src", "0", "-1")).toEqual(["a", "b"]);
    expect(r("LRANGE", "dst", "0", "-1")).toEqual(["c"]);
    expect(r("LMOVE", "src", "dst", "LEFT", "RIGHT")).toBe("a");
    expect(r("LRANGE", "dst", "0", "-1")).toEqual(["c", "a"]);

    r("DEL", "rot");
    r("RPUSH", "rot", "1", "2", "3");
    expect(r("LMOVE", "rot", "rot", "RIGHT", "LEFT")).toBe("3");
    expect(r("LRANGE", "rot", "0", "-1")).toEqual(["3", "1", "2"]);
    expect(r("LMOVE", "rot", "rot", "LEFT", "RIGHT")).toBe("3");
    expect(r("LRANGE", "rot", "0", "-1")).toEqual(["1", "2", "3"]);

    expect(r("LMOVE", "src", "dst", "UP", "LEFT")).toBe("ERR syntax error");
  });

  test("LMOVE reports a missing source before it type-checks the destination", () => {
    r("SADD", "wrongtype", "x");
    expect(kind("LMOVE", "gone", "wrongtype", "LEFT", "LEFT")).toBe("null");
    r("RPUSH", "src", "a");
    expect(r("LMOVE", "src", "wrongtype", "LEFT", "LEFT")).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
  });

  test("moving the last element deletes the source key", () => {
    r("RPUSH", "src", "only");
    expect(r("RPOPLPUSH", "src", "dst")).toBe("only");
    expect(r("EXISTS", "src")).toBe(0);
    expect(r("EXISTS", "dst")).toBe(1);
  });

  test("LPOS finds by rank, count and maxlen", () => {
    r("RPUSH", "l", "a", "b", "c", "b", "d", "b");
    expect(r("LPOS", "l", "b")).toBe(1);
    expect(r("LPOS", "l", "b", "RANK", "2")).toBe(3);
    expect(r("LPOS", "l", "b", "RANK", "-1")).toBe(5);
    expect(r("LPOS", "l", "b", "RANK", "-2")).toBe(3);
    expect(r("LPOS", "l", "b", "COUNT", "0")).toEqual([1, 3, 5]);
    expect(r("LPOS", "l", "b", "COUNT", "2")).toEqual([1, 3]);
    expect(r("LPOS", "l", "b", "RANK", "-1", "COUNT", "0")).toEqual([5, 3, 1]);
    expect(r("LPOS", "l", "b", "MAXLEN", "2")).toBe(1);
    expect(r("LPOS", "l", "b", "MAXLEN", "1")).toBe(null);
    expect(r("LPOS", "l", "zz", "COUNT", "0")).toEqual([]);
    expect(kind("LPOS", "l", "zz")).toBe("null");
    expect(kind("LPOS", "nope", "a")).toBe("null");
    expect(r("LPOS", "l", "b", "RANK", "0")).toMatch(/^ERR RANK can't be zero/);
    expect(r("LPOS", "l", "b", "COUNT", "-1")).toBe("ERR COUNT can't be negative");
    expect(r("LPOS", "l", "b", "MAXLEN", "-1")).toBe("ERR MAXLEN can't be negative");
  });

  test("every list command rejects a key of another type", () => {
    r("SADD", "s", "x");
    const wrong = "WRONGTYPE Operation against a key holding the wrong kind of value";
    expect(r("RPUSH", "s", "a")).toBe(wrong);
    expect(r("LRANGE", "s", "0", "-1")).toBe(wrong);
    expect(r("LPOP", "s")).toBe(wrong);
    expect(r("LLEN", "s")).toBe(wrong);
    expect(r("LMOVE", "s", "d", "LEFT", "LEFT")).toBe(wrong);
  });
});

describe("set", () => {
  test("SADD counts only new members and SCARD follows", () => {
    expect(r("SADD", "s", "a", "b", "a")).toBe(2);
    expect(r("SADD", "s", "b", "c")).toBe(1);
    expect(r("SCARD", "s")).toBe(3);
    expect(r("SMEMBERS", "s")).toEqual(["a", "b", "c"]);
    expect(kind("SMEMBERS", "s")).toBe("set");
  });

  test("SREM deletes the key with the last member", () => {
    r("SADD", "s", "a", "b");
    expect(r("SREM", "s", "a", "zz")).toBe(1);
    expect(r("SREM", "s", "b")).toBe(1);
    expect(r("EXISTS", "s")).toBe(0);
    expect(r("SREM", "nope", "a")).toBe(0);
  });

  test("SISMEMBER and SMISMEMBER agree", () => {
    r("SADD", "s", "a", "b");
    expect(r("SISMEMBER", "s", "a")).toBe(1);
    expect(r("SISMEMBER", "s", "z")).toBe(0);
    expect(r("SISMEMBER", "nope", "a")).toBe(0);
    expect(r("SMISMEMBER", "s", "a", "z", "b")).toEqual([1, 0, 1]);
    expect(r("SMISMEMBER", "nope", "a", "b")).toEqual([0, 0]);
  });

  test("set algebra matches the same operations computed in JS", () => {
    const a = new Set<string>();
    const b = new Set<string>();
    const c = new Set<string>();
    for (let i = 0; i < 200; i++) {
      if (i % 2 === 0) a.add(`m${i}`);
      if (i % 3 === 0) b.add(`m${i}`);
      if (i % 5 === 0) c.add(`m${i}`);
    }
    for (const [key, members] of [["A", a], ["B", b], ["C", c]] as const) {
      r("SADD", key, ...members);
    }
    const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
    const inter = sorted([...a].filter((x) => b.has(x) && c.has(x)));
    const union = sorted(new Set([...a, ...b, ...c]));
    const diff = sorted([...a].filter((x) => !b.has(x) && !c.has(x)));

    expect(r("SINTER", "A", "B", "C")).toEqual(inter);
    expect(r("SUNION", "A", "B", "C")).toEqual(union);
    expect(r("SDIFF", "A", "B", "C")).toEqual(diff);
    expect(r("SINTERCARD", "3", "A", "B", "C")).toBe(inter.length);
    expect(r("SINTERCARD", "3", "A", "B", "C", "LIMIT", "2")).toBe(2);
    expect(r("SINTERCARD", "3", "A", "B", "C", "LIMIT", "0")).toBe(inter.length);

    expect(r("SINTERSTORE", "D", "A", "B", "C")).toBe(inter.length);
    expect(r("SMEMBERS", "D")).toEqual(inter);
    expect(r("SUNIONSTORE", "D", "A", "B", "C")).toBe(union.length);
    expect(r("SMEMBERS", "D")).toEqual(union);
    expect(r("SDIFFSTORE", "D", "A", "B", "C")).toBe(diff.length);
    expect(r("SMEMBERS", "D")).toEqual(diff);
  });

  test("a missing operand makes an intersection empty but not a union", () => {
    r("SADD", "A", "a", "b");
    expect(r("SINTER", "A", "gone")).toEqual([]);
    expect(r("SUNION", "A", "gone")).toEqual(["a", "b"]);
    expect(r("SDIFF", "gone", "A")).toEqual([]);
    expect(r("SDIFF", "A", "gone")).toEqual(["a", "b"]);
  });

  test("a store whose result is empty deletes the destination", () => {
    r("SADD", "A", "a");
    r("SADD", "B", "b");
    r("SADD", "D", "stale");
    expect(r("SINTERSTORE", "D", "A", "B")).toBe(0);
    expect(r("EXISTS", "D")).toBe(0);
  });

  test("a store can overwrite one of its own operands", () => {
    r("SADD", "A", "a", "b", "c");
    r("SADD", "B", "b", "c", "d");
    expect(r("SINTERSTORE", "A", "A", "B")).toBe(2);
    expect(r("SMEMBERS", "A")).toEqual(["b", "c"]);
    r("RPUSH", "L", "x");
    expect(r("SUNIONSTORE", "L", "A", "B")).toBe(3);
    expect(r("TYPE", "L")).toBe("set");
  });

  test("SPOP removes what it returns", () => {
    r("SADD", "s", "a", "b", "c", "d");
    const one = r("SPOP", "s") as string;
    expect(["a", "b", "c", "d"]).toContain(one);
    expect(r("SCARD", "s")).toBe(3);
    const two = r("SPOP", "s", "2") as string[];
    expect(two.length).toBe(2);
    expect(r("SCARD", "s")).toBe(1);
    expect((r("SPOP", "s", "99") as string[]).length).toBe(1);
    expect(r("EXISTS", "s")).toBe(0);
    expect(kind("SPOP", "s")).toBe("null");
    expect(r("SPOP", "s", "3")).toEqual([]);
    expect(r("SPOP", "s", "-1")).toBe("ERR value is out of range, must be positive");
  });

  test("SRANDMEMBER repeats only for a negative count", () => {
    r("SADD", "s", "a", "b", "c");
    expect(["a", "b", "c"]).toContain(r("SRANDMEMBER", "s") as string);
    expect(new Set(r("SRANDMEMBER", "s", "99") as string[]).size).toBe(3);
    expect((r("SRANDMEMBER", "s", "-8") as string[]).length).toBe(8);
    expect((r("SRANDMEMBER", "s", "2") as string[]).length).toBe(2);
    expect(r("SCARD", "s")).toBe(3);
    expect(r("SRANDMEMBER", "s", "0")).toEqual([]);
    expect(kind("SRANDMEMBER", "nope")).toBe("null");
  });

  test("SMOVE is a no-op within one key and deletes an emptied source", () => {
    r("SADD", "a", "x");
    r("SADD", "b", "y");
    expect(r("SMOVE", "a", "b", "zz")).toBe(0);
    expect(r("SMOVE", "a", "a", "x")).toBe(1);
    expect(r("SMEMBERS", "a")).toEqual(["x"]);
    expect(r("SMOVE", "a", "b", "x")).toBe(1);
    expect(r("EXISTS", "a")).toBe(0);
    expect(r("SMEMBERS", "b")).toEqual(["x", "y"]);
    expect(r("SMOVE", "gone", "b", "x")).toBe(0);
  });

  test("SSCAN walks every member exactly once", () => {
    const members = Array.from({ length: 300 }, (_, i) => `m${i}`);
    r("SADD", "s", ...members);
    const seen = new Set<string>();
    let cursor = "0";
    let pages = 0;
    do {
      const [next, items] = r("SSCAN", "s", cursor, "COUNT", "23") as [string, string[]];
      for (const item of items) seen.add(item);
      cursor = next;
      pages++;
    } while (cursor !== "0" && pages < 100);
    expect(cursor).toBe("0");
    expect(seen.size).toBe(300);
    const [, matched] = r("SSCAN", "s", "0", "MATCH", "m1", "COUNT", "1000") as [string, string[]];
    expect(matched).toEqual(["m1"]);
  });

  test("set commands reject keys of another type, on every operand", () => {
    r("SADD", "s", "a");
    r("RPUSH", "l", "x");
    const wrong = "WRONGTYPE Operation against a key holding the wrong kind of value";
    expect(r("SADD", "l", "a")).toBe(wrong);
    expect(r("SMEMBERS", "l")).toBe(wrong);
    expect(r("SINTER", "s", "l")).toBe(wrong);
    expect(r("SUNIONSTORE", "d", "s", "l")).toBe(wrong);
    expect(r("SMOVE", "s", "l", "a")).toBe(wrong);
    expect(r("SINTERCARD", "2", "s", "l")).toBe(wrong);
  });

  test("SINTERCARD validates numkeys and LIMIT", () => {
    r("SADD", "s", "a");
    expect(r("SINTERCARD", "0", "s")).toBe("ERR numkeys should be greater than 0");
    expect(r("SINTERCARD", "5", "s")).toBe("ERR Number of keys can't be greater than number of args");
    expect(r("SINTERCARD", "1", "s", "LIMIT", "-1")).toBe("ERR LIMIT can't be negative");
    expect(r("SINTERCARD", "1", "s", "NOPE", "1")).toBe("ERR syntax error");
  });
});

describe("zset", () => {
  test("ZADD reports additions, and CH reports changes too", () => {
    expect(r("ZADD", "z", "1", "a", "2", "b")).toBe(2);
    expect(r("ZADD", "z", "9", "a")).toBe(0);
    expect(r("ZADD", "z", "CH", "8", "a", "3", "c")).toBe(2);
    expect(r("ZADD", "z", "CH", "8", "a")).toBe(0);
    expect(r("ZCARD", "z")).toBe(3);
  });

  test("ZADD applies the NX / XX / GT / LT matrix", () => {
    r("ZADD", "z", "5", "m");
    expect(r("ZADD", "z", "NX", "9", "m")).toBe(0);
    expect(r("ZSCORE", "z", "m")).toBe(5);
    expect(r("ZADD", "z", "NX", "1", "new")).toBe(1);
    expect(r("ZADD", "z", "XX", "7", "absent")).toBe(0);
    expect(r("EXISTS", "z")).toBe(1);
    expect(r("ZADD", "z", "XX", "CH", "6", "m")).toBe(1);
    expect(r("ZSCORE", "z", "m")).toBe(6);

    expect(r("ZADD", "z", "GT", "CH", "4", "m")).toBe(0);
    expect(r("ZSCORE", "z", "m")).toBe(6);
    expect(r("ZADD", "z", "GT", "CH", "8", "m")).toBe(1);
    expect(r("ZSCORE", "z", "m")).toBe(8);
    expect(r("ZADD", "z", "LT", "CH", "9", "m")).toBe(0);
    expect(r("ZADD", "z", "LT", "CH", "2", "m")).toBe(1);
    expect(r("ZSCORE", "z", "m")).toBe(2);
    expect(r("ZADD", "z", "GT", "1", "fresh")).toBe(1);
  });

  test("ZADD rejects incompatible flags and bad scores atomically", () => {
    expect(r("ZADD", "z", "NX", "XX", "1", "a")).toBe(
      "ERR XX and NX options at the same time are not compatible",
    );
    expect(r("ZADD", "z", "GT", "NX", "1", "a")).toBe(
      "ERR GT, LT, and/or NX options at the same time are not compatible",
    );
    expect(r("ZADD", "z", "GT", "LT", "1", "a")).toBe(
      "ERR GT, LT, and/or NX options at the same time are not compatible",
    );
    expect(r("ZADD", "z", "INCR", "1", "a", "2", "b")).toBe(
      "ERR INCR option supports a single increment-element pair",
    );
    expect(r("ZADD", "z", "1", "a", "oops", "b")).toBe("ERR value is not a valid float");
    expect(r("EXISTS", "z")).toBe(0);
    expect(r("ZADD", "z", "1")).toBe("ERR wrong number of arguments for 'zadd' command");
  });

  test("ZADD INCR returns the new score, or nil when suppressed", () => {
    expect(r("ZADD", "z", "INCR", "5", "m")).toBe(5);
    expect(r("ZADD", "z", "INCR", "2.5", "m")).toBe(7.5);
    expect(kind("ZADD", "z", "NX", "INCR", "1", "m")).toBe("null");
    expect(kind("ZADD", "z", "XX", "INCR", "1", "absent")).toBe("null");
    expect(kind("ZADD", "z", "GT", "INCR", "-1", "m")).toBe("null");
    expect(r("ZSCORE", "z", "m")).toBe(7.5);
    r("ZADD", "z", "inf", "big");
    expect(r("ZADD", "z", "INCR", "-inf", "big")).toBe(
      "ERR resulting score is not a number (NaN)",
    );
  });

  test("ZADD with a duplicate member in one call sees its own write", () => {
    expect(r("ZADD", "z", "1", "a", "2", "a")).toBe(1);
    expect(r("ZSCORE", "z", "a")).toBe(2);
  });

  test("ZINCRBY creates, accumulates and rejects NaN", () => {
    expect(r("ZINCRBY", "z", "3", "m")).toBe(3);
    expect(r("ZINCRBY", "z", "-4.5", "m")).toBe(-1.5);
    r("ZADD", "z", "-inf", "low");
    expect(r("ZINCRBY", "z", "inf", "low")).toBe("ERR resulting score is not a number (NaN)");
    expect(r("ZSCORE", "z", "low")).toBe(-Infinity);
  });

  test("ties break by member bytes, ascending, in every direction", () => {
    r("ZADD", "z", "1", "c", "1", "a", "1", "b", "0", "z");
    expect(r("ZRANGE", "z", "0", "-1")).toEqual(["z", "a", "b", "c"]);
    expect(r("ZREVRANGE", "z", "0", "-1")).toEqual(["c", "b", "a", "z"]);
    expect(r("ZRANGEBYSCORE", "z", "1", "1")).toEqual(["a", "b", "c"]);
    expect(r("ZREVRANGEBYSCORE", "z", "1", "1")).toEqual(["c", "b", "a"]);
    expect(r("ZRANK", "z", "a")).toBe(1);
    expect(r("ZRANK", "z", "c")).toBe(3);
    expect(r("ZREVRANK", "z", "c")).toBe(0);
    expect(r("ZREVRANK", "z", "z")).toBe(3);
  });

  test("ZSCORE, ZMSCORE and ZRANK report absence distinctly", () => {
    r("ZADD", "z", "1", "a");
    expect(kind("ZSCORE", "z", "nope")).toBe("null");
    expect(kind("ZSCORE", "gone", "a")).toBe("null");
    expect(r("ZMSCORE", "z", "a", "nope")).toEqual([1, null]);
    expect(r("ZMSCORE", "gone", "a")).toEqual([null]);
    expect(kind("ZRANK", "z", "nope")).toBe("null");
    expect(kind("ZRANK", "z", "nope", "WITHSCORE")).toBe("nullArray");
    expect(r("ZRANK", "z", "a", "WITHSCORE")).toEqual([0, 1]);
    expect(r("ZCARD", "gone")).toBe(0);
  });

  test("score ranges parse infinities and exclusive bounds", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c");
    expect(r("ZRANGEBYSCORE", "z", "-inf", "+inf")).toEqual(["a", "b", "c"]);
    expect(r("ZRANGEBYSCORE", "z", "(1", "3")).toEqual(["b", "c"]);
    expect(r("ZRANGEBYSCORE", "z", "1", "(3")).toEqual(["a", "b"]);
    expect(r("ZRANGEBYSCORE", "z", "(1", "(3")).toEqual(["b"]);
    expect(r("ZRANGEBYSCORE", "z", "2", "1")).toEqual([]);
    expect(r("ZCOUNT", "z", "-inf", "+inf")).toBe(3);
    expect(r("ZCOUNT", "z", "(1", "+inf")).toBe(2);
    expect(r("ZRANGEBYSCORE", "z", "-inf", "+inf", "LIMIT", "1", "1")).toEqual(["b"]);
    expect(r("ZRANGEBYSCORE", "z", "-inf", "+inf", "LIMIT", "1", "-1")).toEqual(["b", "c"]);
    expect(r("ZRANGEBYSCORE", "z", "-inf", "+inf", "LIMIT", "-1", "2")).toEqual([]);
    expect(r("ZRANGEBYSCORE", "z", "bad", "3")).toBe("ERR min or max is not a float");
    expect(r("ZRANGEBYSCORE", "z", "1", "(x")).toBe("ERR min or max is not a float");
    expect(r("ZRANGEBYSCORE", "gone", "bad", "3")).toBe("ERR min or max is not a float");
  });

  test("an exclusive infinite bound still excludes members scored at it", () => {
    r("ZADD", "z", "-inf", "low", "0", "mid", "inf", "high");
    expect(r("ZRANGEBYSCORE", "z", "-inf", "+inf")).toEqual(["low", "mid", "high"]);
    expect(r("ZRANGEBYSCORE", "z", "(-inf", "+inf")).toEqual(["mid", "high"]);
    expect(r("ZRANGEBYSCORE", "z", "-inf", "(+inf")).toEqual(["low", "mid"]);
    expect(r("ZSCORE", "z", "high")).toBe(Infinity);
  });

  test("lex ranges parse sentinels and brackets", () => {
    r("ZADD", "z", "0", "a", "0", "b", "0", "c", "0", "d");
    expect(r("ZRANGEBYLEX", "z", "-", "+")).toEqual(["a", "b", "c", "d"]);
    expect(r("ZRANGEBYLEX", "z", "[b", "[c")).toEqual(["b", "c"]);
    expect(r("ZRANGEBYLEX", "z", "(b", "(d")).toEqual(["c"]);
    expect(r("ZRANGEBYLEX", "z", "-", "(c")).toEqual(["a", "b"]);
    expect(r("ZRANGEBYLEX", "z", "+", "-")).toEqual([]);
    expect(r("ZRANGEBYLEX", "z", "-", "+", "LIMIT", "1", "2")).toEqual(["b", "c"]);
    expect(r("ZRANGEBYLEX", "z", "b", "[c")).toBe("ERR min or max not valid string range item");
    expect(r("ZRANGEBYLEX", "gone", "b", "c")).toBe("ERR min or max not valid string range item");
    expect(r("ZRANGEBYLEX", "z", "-", "+", "WITHSCORES")).toBe("ERR syntax error");
  });

  test("ZREVRANGEBYLEX takes its bounds highest-first", () => {
    r("ZADD", "z", "0", "a", "0", "b", "0", "c", "0", "d");
    expect(r("ZREVRANGEBYLEX", "z", "+", "-")).toEqual(["d", "c", "b", "a"]);
    expect(r("ZREVRANGEBYLEX", "z", "[c", "[b")).toEqual(["c", "b"]);
    expect(r("ZREVRANGEBYLEX", "z", "(d", "(a")).toEqual(["c", "b"]);
    expect(r("ZREVRANGEBYLEX", "z", "+", "-", "LIMIT", "1", "2")).toEqual(["c", "b"]);
    expect(r("ZREVRANGEBYLEX", "z", "-", "+")).toEqual([]);
    expect(r("ZREVRANGEBYLEX", "z", "c", "[b")).toBe("ERR min or max not valid string range item");
    expect(r("ZREVRANGEBYLEX", "z", "+", "-", "WITHSCORES")).toBe("ERR syntax error");
    expect(r("ZREVRANGEBYLEX", "gone", "+", "-")).toEqual([]);
    r("SADD", "s", "x");
    expect(r("ZREVRANGEBYLEX", "s", "+", "-")).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
  });

  test("ZRANGE unifies BYSCORE, BYLEX, REV and LIMIT", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c");
    expect(r("ZRANGE", "z", "0", "-1")).toEqual(["a", "b", "c"]);
    expect(r("ZRANGE", "z", "0", "-1", "REV")).toEqual(["c", "b", "a"]);
    expect(r("ZRANGE", "z", "1", "3", "BYSCORE")).toEqual(["a", "b", "c"]);
    expect(r("ZRANGE", "z", "3", "1", "BYSCORE", "REV")).toEqual(["c", "b", "a"]);
    expect(r("ZRANGE", "z", "(1", "+inf", "BYSCORE", "LIMIT", "0", "1")).toEqual(["b"]);
    r("DEL", "lex");
    r("ZADD", "lex", "0", "a", "0", "b", "0", "c");
    expect(r("ZRANGE", "lex", "[a", "[b", "BYLEX")).toEqual(["a", "b"]);
    expect(r("ZRANGE", "lex", "[b", "[a", "BYLEX", "REV")).toEqual(["b", "a"]);
    expect(r("ZRANGE", "z", "0", "-1", "LIMIT", "0", "1")).toBe(
      "ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX",
    );
    expect(r("ZRANGE", "lex", "-", "+", "BYLEX", "WITHSCORES")).toBe(
      "ERR syntax error, WITHSCORES not supported in combination with BYLEX",
    );
    expect(r("ZRANGE", "z", "0", "-1", "NOPE")).toBe("ERR syntax error");
    expect(r("ZRANGE", "gone", "0", "-1")).toEqual([]);
  });

  test("WITHSCORES spells scores the way Redis does, in both protocols", () => {
    r("ZADD", "z", "1", "a", "2.5", "b", "inf", "c", "-inf", "d");
    expect(r("ZRANGE", "z", "0", "-1", "WITHSCORES")).toEqual([
      "d", -Infinity, "a", 1, "b", 2.5, "c", Infinity,
    ]);
    const resp2 = decodeUtf8(encodeReply(reply("ZRANGE", "z", "0", "-1", "WITHSCORES"), 2));
    expect(resp2).toBe(
      "*8\r\n$1\r\nd\r\n$4\r\n-inf\r\n$1\r\na\r\n$1\r\n1\r\n" +
        "$1\r\nb\r\n$3\r\n2.5\r\n$1\r\nc\r\n$3\r\ninf\r\n",
    );
    expect(resp2).not.toContain("1.0");

    ctx.conn.protocol = 3;
    const resp3 = decodeUtf8(encodeReply(reply("ZRANGE", "z", "0", "-1", "WITHSCORES"), 3));
    expect(resp3).toBe(
      "*4\r\n*2\r\n$1\r\nd\r\n,-inf\r\n*2\r\n$1\r\na\r\n,1\r\n" +
        "*2\r\n$1\r\nb\r\n,2.5\r\n*2\r\n$1\r\nc\r\n,inf\r\n",
    );
    expect(decodeUtf8(encodeReply(reply("ZSCORE", "z", "a"), 3))).toBe(",1\r\n");
    expect(decodeUtf8(encodeReply(reply("ZSCORE", "z", "c"), 3))).toBe(",inf\r\n");
  });

  test("ZPOPMIN and ZPOPMAX take from the right end", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c");
    expect(r("ZPOPMIN", "z")).toEqual(["a", 1]);
    expect(r("ZPOPMAX", "z")).toEqual(["c", 3]);
    expect(r("ZPOPMIN", "z", "5")).toEqual(["b", 2]);
    expect(r("EXISTS", "z")).toBe(0);
    expect(r("ZPOPMIN", "z")).toEqual([]);
    expect(r("ZPOPMAX", "gone", "2")).toEqual([]);
    r("ZADD", "z", "1", "a", "1", "b");
    expect(r("ZPOPMIN", "z", "2")).toEqual(["a", 1, "b", 1]);
  });

  test("ZRANDMEMBER mirrors HRANDFIELD's count rules", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c");
    expect(["a", "b", "c"]).toContain(r("ZRANDMEMBER", "z") as string);
    expect(new Set(r("ZRANDMEMBER", "z", "99") as string[]).size).toBe(3);
    expect((r("ZRANDMEMBER", "z", "-6") as string[]).length).toBe(6);
    expect((r("ZRANDMEMBER", "z", "2", "WITHSCORES") as string[]).length).toBe(4);
    expect(r("ZRANDMEMBER", "z", "0")).toEqual([]);
    expect(kind("ZRANDMEMBER", "gone")).toBe("null");
    expect(r("ZCARD", "z")).toBe(3);
  });

  test("ZREM and the ZREMRANGE family delete an emptied key", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c", "4", "d");
    expect(r("ZREM", "z", "a", "zz")).toBe(1);
    expect(r("ZREMRANGEBYRANK", "z", "0", "0")).toBe(1);
    expect(r("ZRANGE", "z", "0", "-1")).toEqual(["c", "d"]);
    expect(r("ZREMRANGEBYSCORE", "z", "(3", "+inf")).toBe(1);
    expect(r("ZRANGE", "z", "0", "-1")).toEqual(["c"]);
    expect(r("ZREM", "z", "c")).toBe(1);
    expect(r("EXISTS", "z")).toBe(0);

    r("ZADD", "lex", "0", "a", "0", "b", "0", "c");
    expect(r("ZREMRANGEBYLEX", "lex", "[a", "[b")).toBe(2);
    expect(r("ZRANGE", "lex", "0", "-1")).toEqual(["c"]);
    expect(r("ZREMRANGEBYLEX", "lex", "-", "+")).toBe(1);
    expect(r("EXISTS", "lex")).toBe(0);
    expect(r("ZREMRANGEBYRANK", "gone", "0", "-1")).toBe(0);
  });

  test("ZSCAN walks every member with its score", () => {
    for (let i = 0; i < 200; i++) r("ZADD", "z", String(i), `m${i}`);
    const seen = new Map<string, string>();
    let cursor = "0";
    let pages = 0;
    do {
      const [next, items] = r("ZSCAN", "z", cursor, "COUNT", "13") as [string, string[]];
      for (let i = 0; i < items.length; i += 2) {
        seen.set(items[i] as string, items[i + 1] as string);
      }
      cursor = next;
      pages++;
    } while (cursor !== "0" && pages < 100);
    expect(cursor).toBe("0");
    expect(seen.size).toBe(200);
    expect(seen.get("m7")).toBe("7");
    expect(r("ZSCAN", "gone", "0")).toEqual(["0", []]);
  });

  test("zset commands reject a key of another type", () => {
    r("SADD", "s", "x");
    const wrong = "WRONGTYPE Operation against a key holding the wrong kind of value";
    expect(r("ZADD", "s", "1", "a")).toBe(wrong);
    expect(r("ZSCORE", "s", "a")).toBe(wrong);
    expect(r("ZRANGE", "s", "0", "-1")).toBe(wrong);
    expect(r("ZRANK", "s", "a")).toBe(wrong);
    expect(r("ZINCRBY", "s", "1", "a")).toBe(wrong);
    expect(r("ZSCAN", "s", "0")).toBe(wrong);
  });
});
