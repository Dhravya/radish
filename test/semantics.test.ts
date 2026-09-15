import { beforeEach, describe, expect, test } from "bun:test";

import { dispatch, registry } from "../src/commands";
import type { ConnState, Ctx } from "../src/commands/spec";
import {
  addLongDouble,
  formatLongDouble,
  toDouble,
  toLongDouble,
} from "../src/commands/spec";
import { formatDouble } from "../src/dtoa";
import { encodeReply } from "../src/resp";
import { applySchema, type SqlStorage } from "../src/schema";
import { Store } from "../src/store";
import { type Command, type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import { FakeSqlStorage } from "./sqlite-adapter";

type Arg = string | number;

const argv = (parts: readonly Arg[]): Command =>
  parts.map((part) => encodeUtf8(typeof part === "number" ? String(part) : part));

const flat = (reply: Reply): unknown => {
  switch (reply.kind) {
    case "simple":
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
let conn: ConnState;
let clock = 1_700_000_000_000;

const ctx = (): Ctx => ({ store, sql, now: clock, conn, commands: registry });
const reply = (...parts: Arg[]): Reply => dispatch(ctx(), argv(parts));
const r = (...parts: Arg[]): unknown => flat(reply(...parts));
const wire = (version: 2 | 3, ...parts: Arg[]): string => {
  conn.protocol = version;
  const encoded = decodeUtf8(encodeReply(reply(...parts), version));
  conn.protocol = 2;
  return encoded;
};

const ld = (text: string) => toLongDouble(encodeUtf8(text));

const incrbyfloat = (base: string, increment: string): string => {
  const a = ld(base);
  const b = ld(increment);
  if (a === null || b === null) return "ERR value is not a valid float";
  const sum = addLongDouble(a, b);
  return sum === null ? "ERR increment would produce NaN or Infinity" : formatLongDouble(sum);
};

beforeEach(() => {
  sql = new FakeSqlStorage();
  applySchema(sql);
  clock = 1_700_000_000_000;
  store = new Store(sql, () => clock);
  conn = { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false };
});

describe("expiry conditions", () => {
  test("XX, NX, GT and LT each gate the write on their own", () => {
    r("SET", "k", "v");
    expect(r("EXPIRE", "k", "100")).toBe(1);

    expect(r("EXPIRE", "k", "10", "XX", "GT")).toBe(0);
    expect(r("TTL", "k")).toBe(100);
    expect(r("EXPIRE", "k", "200", "XX", "GT")).toBe(1);
    expect(r("TTL", "k")).toBe(200);
    expect(r("EXPIRE", "k", "10", "XX", "LT")).toBe(1);
    expect(r("TTL", "k")).toBe(10);
    expect(r("EXPIRE", "k", "100", "XX", "LT")).toBe(0);
    expect(r("TTL", "k")).toBe(10);
  });

  test("a key without a TTL satisfies LT but never XX or GT", () => {
    r("SET", "n", "v");
    expect(r("EXPIRE", "n", "10", "XX", "GT")).toBe(0);
    expect(r("TTL", "n")).toBe(-1);
    expect(r("EXPIRE", "n", "10", "GT")).toBe(0);
    expect(r("TTL", "n")).toBe(-1);
    expect(r("EXPIRE", "n", "10", "XX", "LT")).toBe(0);
    expect(r("TTL", "n")).toBe(-1);
    expect(r("EXPIRE", "n", "10", "LT")).toBe(1);
    expect(r("TTL", "n")).toBe(10);
    expect(r("EXPIRE", "n", "20", "NX")).toBe(0);
    expect(r("TTL", "n")).toBe(10);
  });

  test("incompatible flag pairs are refused before anything is written", () => {
    r("SET", "k", "v");
    r("EXPIRE", "k", "100");
    expect(r("EXPIRE", "k", "5", "NX", "GT")).toBe(
      "ERR NX and XX, GT or LT options at the same time are not compatible",
    );
    expect(r("EXPIRE", "k", "5", "XX", "GT", "LT")).toBe(
      "ERR GT and LT options at the same time are not compatible",
    );
    expect(r("TTL", "k")).toBe(100);
  });
});

describe("expiry deadline range", () => {
  test("a deadline past exact millisecond precision is refused, not rounded", () => {
    r("SET", "k", "v");
    expect(r("PEXPIREAT", "k", "9223372036854775807")).toBe(
      "ERR invalid expire time in 'pexpireat' command",
    );
    expect(r("PTTL", "k")).toBe(-1);
    expect(r("EXISTS", "k")).toBe(1);

    expect(r("PEXPIREAT", "k", String(Number.MAX_SAFE_INTEGER + 1))).toBe(
      "ERR invalid expire time in 'pexpireat' command",
    );
    expect(r("EXPIREAT", "k", "9223372036854775")).toBe(
      "ERR invalid expire time in 'expireat' command",
    );
    expect(r("PTTL", "k")).toBe(-1);
  });

  test("the largest exactly representable deadline is accepted and read back whole", () => {
    r("SET", "k", "v");
    expect(r("PEXPIREAT", "k", String(Number.MAX_SAFE_INTEGER))).toBe(1);
    expect(r("PTTL", "k")).toBe(Number.MAX_SAFE_INTEGER - clock);
  });

  test("a deadline in the distant past still expires the key", () => {
    r("SET", "k", "v");
    expect(r("PEXPIREAT", "k", "-9223372036854775808")).toBe(1);
    expect(r("EXISTS", "k")).toBe(0);
  });

  test("out-of-range arguments are rejected before the key is looked up", () => {
    expect(r("EXPIRE", "missing", "9223372036854775807")).toBe(
      "ERR invalid expire time in 'expire' command",
    );
    expect(r("PEXPIREAT", "missing", "99999999999999999999")).toBe(
      "ERR value is not an integer or out of range",
    );
  });
});

describe("SCAN cursor guarantees", () => {
  const fill = (count: number): void => {
    for (let i = 0; i < count; i++) r("SET", `key:${i}`, "v");
  };

  test("an expired cursor is an explicit error, never a finished iteration", () => {
    fill(20);
    const [cursor] = r("SCAN", "0", "COUNT", "2") as [string, string[]];
    expect(cursor).not.toBe("0");

    clock += 61_000;
    r("SCAN", "0", "COUNT", "2");

    expect(r("SCAN", cursor, "COUNT", "2")).toBe("ERR scan cursor expired");
  });

  test("a live cursor still walks every key exactly once", () => {
    fill(20);
    const seen = new Set<string>();
    let cursor = "0";
    let pages = 0;
    do {
      const [next, keys] = r("SCAN", cursor, "COUNT", "3") as [string, string[]];
      for (const key of keys) seen.add(key);
      cursor = next;
      pages++;
    } while (cursor !== "0" && pages < 50);
    expect(cursor).toBe("0");
    expect(seen.size).toBe(20);
  });

  test("cursors are parsed over the whole unsigned 64-bit range", () => {
    fill(3);
    expect(r("SCAN", "18446744073709551615")).toEqual(["0", []]);
    expect(r("SCAN", "18446744073709551616")).toBe("ERR invalid cursor");
    expect(r("SCAN", "-1")).toBe("ERR invalid cursor");
    expect(r("SCAN", "abc")).toBe("ERR invalid cursor");
    expect(r("SCAN", "0000")).toEqual(["0", ["key:0", "key:1", "key:2"]]);
    expect(r("SCAN", "+0")).toEqual(["0", ["key:0", "key:1", "key:2"]]);
    expect(r("SCAN", "0x10")).toBe("ERR invalid cursor");
    expect(r("SCAN", "1 ")).toBe("ERR invalid cursor");
  });
});

describe("RESP3 sorted-set shapes", () => {
  beforeEach(() => {
    r("ZADD", "z", "1", "a", "2.5", "b", "3", "c");
  });

  test("scored ranges are member/score pairs in RESP3 and flat in RESP2", () => {
    expect(wire(2, "ZRANGE", "z", "0", "0", "WITHSCORES")).toBe("*2\r\n$1\r\na\r\n$1\r\n1\r\n");
    expect(wire(3, "ZRANGE", "z", "0", "0", "WITHSCORES")).toBe("*1\r\n*2\r\n$1\r\na\r\n,1\r\n");
    expect(wire(3, "ZRANGE", "z", "0", "-1", "WITHSCORES")).toBe(
      "*3\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n*2\r\n$1\r\nc\r\n,3\r\n",
    );
    expect(wire(3, "ZRANGEBYSCORE", "z", "-inf", "+inf", "WITHSCORES")).toBe(
      "*3\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n*2\r\n$1\r\nc\r\n,3\r\n",
    );
    expect(wire(3, "ZREVRANGE", "z", "0", "0", "WITHSCORES")).toBe("*1\r\n*2\r\n$1\r\nc\r\n,3\r\n");
    expect(wire(3, "ZRANGE", "z", "0", "-1")).toBe("*3\r\n$1\r\na\r\n$1\r\nb\r\n$1\r\nc\r\n");
    expect(wire(3, "ZRANGE", "z", "5", "6", "WITHSCORES")).toBe("*0\r\n");
  });

  test("ZPOPMIN pairs up only when a count was given", () => {
    expect(wire(3, "ZPOPMIN", "z")).toBe("*2\r\n$1\r\na\r\n,1\r\n");
    expect(wire(3, "ZPOPMIN", "z", "2")).toBe(
      "*2\r\n*2\r\n$1\r\nb\r\n,2.5\r\n*2\r\n$1\r\nc\r\n,3\r\n",
    );
    r("ZADD", "z", "1", "a", "2", "b");
    expect(wire(2, "ZPOPMAX", "z", "2")).toBe("*4\r\n$1\r\nb\r\n$1\r\n2\r\n$1\r\na\r\n$1\r\n1\r\n");
    expect(wire(3, "ZPOPMIN", "gone")).toBe("*0\r\n");
    expect(wire(3, "ZPOPMIN", "gone", "2")).toBe("*0\r\n");
  });

  test("ZRANDMEMBER pairs up only with WITHSCORES", () => {
    expect(wire(3, "ZRANDMEMBER", "z", "1", "WITHSCORES")).toMatch(
      /^\*1\r\n\*2\r\n\$1\r\n[abc]\r\n,[\d.]+\r\n$/,
    );
    expect(wire(3, "ZRANDMEMBER", "z", "1")).toMatch(/^\*1\r\n\$1\r\n[abc]\r\n$/);
    expect(wire(3, "ZRANDMEMBER", "z")).toMatch(/^\$1\r\n[abc]\r\n$/);
  });

  test("ZSCAN spells scores as bulk strings in both protocols", () => {
    expect(wire(2, "ZSCAN", "z", "0")).toBe(
      "*2\r\n$1\r\n0\r\n*6\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n$1\r\nc\r\n$1\r\n3\r\n",
    );
    expect(wire(3, "ZSCAN", "z", "0")).toBe(
      "*2\r\n$1\r\n0\r\n*6\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n$1\r\nc\r\n$1\r\n3\r\n",
    );
  });

  test("ZRANK WITHSCORE keeps its own shape", () => {
    expect(wire(3, "ZRANK", "z", "b", "WITHSCORE")).toBe("*2\r\n:1\r\n,2.5\r\n");
    expect(wire(3, "ZRANK", "z", "gone", "WITHSCORE")).toBe("_\r\n");
    expect(wire(2, "ZRANK", "z", "gone", "WITHSCORE")).toBe("*-1\r\n");
  });
});

describe("sorted-set cardinality", () => {
  const trueCount = (key: string): number =>
    (sql.exec("SELECT COUNT(*) AS n FROM zset WHERE key = ?", encodeUtf8(key)).one() as { n: number })
      .n;

  test("ZRANK and ZREVRANK agree with a full ordering, ties included", () => {
    r("ZADD", "z", "1", "a", "1", "b", "2", "c", "2", "d", "3", "e");
    const order = ["a", "b", "c", "d", "e"];
    order.forEach((member, at) => {
      expect(r("ZRANK", "z", member)).toBe(at);
      expect(r("ZREVRANK", "z", member)).toBe(order.length - 1 - at);
    });
    expect(r("ZRANK", "z", "gone")).toBe(null);
    expect(r("ZRANK", "z", "c", "WITHSCORE")).toEqual([2, 2]);
    expect(r("ZREVRANK", "z", "c", "WITHSCORE")).toEqual([2, 2]);
  });

  test("ZCARD tracks every mutation path without drifting from the rows", () => {
    const members = Array.from({ length: 40 }, (_, i) => `m${i}`);
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };

    for (let step = 0; step < 600; step++) {
      const member = members[next(members.length)] as string;
      const score = String(next(20));
      switch (next(9)) {
        case 0:
          r("ZADD", "z", score, member);
          break;
        case 1:
          r("ZADD", "z", "NX", score, member);
          break;
        case 2:
          r("ZADD", "z", "XX", "CH", score, member);
          break;
        case 3:
          r("ZINCRBY", "z", "1.5", member);
          break;
        case 4:
          r("ZREM", "z", member, members[next(members.length)] as string);
          break;
        case 5:
          r("ZPOPMIN", "z", String(next(4)));
          break;
        case 6:
          r("ZPOPMAX", "z");
          break;
        case 7:
          r("ZREMRANGEBYRANK", "z", "0", String(next(3)));
          break;
        default:
          r("ZREMRANGEBYSCORE", "z", "0", String(next(5)));
          break;
      }
      expect(r("ZCARD", "z")).toBe(trueCount("z"));
    }
  });

  test("an emptied sorted set drops its key on every removal path", () => {
    for (const empty of [
      () => r("ZREM", "z", "a"),
      () => r("ZPOPMIN", "z"),
      () => r("ZPOPMAX", "z", "1"),
      () => r("ZREMRANGEBYRANK", "z", "0", "-1"),
      () => r("ZREMRANGEBYSCORE", "z", "-inf", "+inf"),
      () => r("ZREMRANGEBYLEX", "z", "-", "+"),
    ]) {
      r("DEL", "z");
      r("ZADD", "z", "0", "a");
      empty();
      expect(r("EXISTS", "z")).toBe(0);
      expect(r("ZCARD", "z")).toBe(0);
    }
  });

  test("a counter that was never initialised resolves from the rows", () => {
    r("ZADD", "z", "1", "a", "2", "b", "3", "c");
    sql.exec("UPDATE meta SET card = NULL WHERE key = ?", encodeUtf8("z"));
    expect(r("ZCARD", "z")).toBe(3);
    expect(r("ZREM", "z", "a")).toBe(1);
    expect(r("ZCARD", "z")).toBe(2);
  });
});

describe("float parsing", () => {
  test("zero with a nonzero exponent is still zero", () => {
    expect(toDouble(encodeUtf8("0e1"))).toBe(0);
    expect(toDouble(encodeUtf8("0e100"))).toBe(0);
    expect(toDouble(encodeUtf8("0.0e5"))).toBe(0);
    expect(toDouble(encodeUtf8("-0e3"))).toBe(-0);
    expect(r("ZADD", "z", "0e1", "m")).toBe(1);
    expect(r("ZSCORE", "z", "m")).toBe(0);
    expect(r("ZINCRBY", "z", "0e1", "m")).toBe(0);
  });

  test("a nonzero mantissa that underflows to zero is still rejected", () => {
    expect(toDouble(encodeUtf8("1e-400"))).toBe(null);
    expect(toDouble(encodeUtf8("0.00000e-400"))).toBe(0);
    expect(toDouble(encodeUtf8("1e400"))).toBe(null);
    expect(toDouble(encodeUtf8("1e-320"))).toBe(1e-320);
    expect(r("ZADD", "z", "1e-400", "m")).toBe("ERR value is not a valid float");
  });

  test("ZSCAN spells scores through the same formatter as every other double", () => {
    r("ZADD", "z", "0.0000813385", "a", "154288503.89524817", "b", "inf", "c");
    expect(wire(2, "ZSCAN", "z", "0")).toBe(
      "*2\r\n$1\r\n0\r\n*6\r\n" +
        `$1\r\na\r\n$${formatDouble(0.0000813385).length}\r\n${formatDouble(0.0000813385)}\r\n` +
        `$1\r\nb\r\n$${formatDouble(154288503.89524817).length}\r\n${formatDouble(154288503.89524817)}\r\n` +
        "$1\r\nc\r\n$3\r\ninf\r\n",
    );
    expect(formatDouble(0.0000813385)).toBe("8.13385e-5");
    expect(formatDouble(154288503.89524817)).toBe("1.5428850389524817e+8");
  });
});

describe("long double increments", () => {
  test("repeated decimal increments do not accumulate binary error", () => {
    expect(incrbyfloat("0.1", "0.2")).toBe("0.3");
    expect(incrbyfloat("10.5", "0.1")).toBe("10.6");
    expect(incrbyfloat("3.3", "1.1")).toBe("4.4");
    expect(incrbyfloat("3.0e3", "200")).toBe("3200");

    let value = "0";
    for (let i = 0; i < 10; i++) value = incrbyfloat(value, "0.1");
    expect(value).toBe("1");
  });

  test("int64 magnitudes keep the fraction Redis keeps", () => {
    expect(incrbyfloat("9223372036854775807", "0.1")).toBe("9223372036854775807.09999999999999964");
    expect(incrbyfloat("12345678901234567890123", "0")).toBe("12345678901234567890123");
  });

  test("the printed form stops at seventeen fraction digits", () => {
    expect(incrbyfloat("1", "0.000000000000000001")).toBe("1");
    expect(incrbyfloat("0.000000000000000001", "0")).toBe("0");
    expect(incrbyfloat("1e-4000", "0")).toBe("0");
    expect(incrbyfloat("-0.1", "0.1")).toBe("0");
    expect(incrbyfloat("5", "-5")).toBe("0");
  });

  test("the representable range ends where Redis ends it", () => {
    expect(ld("1e5000")).toBe(null);
    expect(ld("1e-5000")).toBe(null);
    expect(incrbyfloat("1", "inf")).toBe("ERR increment would produce NaN or Infinity");
    expect(incrbyfloat("1", "1e5000")).toBe("ERR value is not a valid float");
    expect(incrbyfloat("1", "1e4000").length).toBe(4001);
  });
});

