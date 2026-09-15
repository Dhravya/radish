import { describe, expect, test } from "bun:test";

import { FakeSqlStorage } from "./sqlite-adapter";
import { RedisError } from "../src/errors";
import { Store } from "../src/store";
import { type Command, type Reply, NULL, decodeUtf8, encodeUtf8 } from "../src/types";
import {
  type CommandSpec,
  type ConnState,
  type KeySpec,
  ALL_KEYS,
  extractKeys,
  hasKeys,
  keysAfterCount,
  keysAt,
  spec,
  ALTERNATING_KEYS,
  FIRST_TWO_KEYS,
  NO_KEYS,
  ONE_KEY,
} from "../src/commands/spec";
import { stringCommands } from "../src/commands/string";
import { keyspaceCommands } from "../src/commands/keyspace";
import { serverCommands } from "../src/commands/server";

const enc = encodeUtf8;

class Server {
  readonly sql = new FakeSqlStorage();
  clock = 1_700_000_000_000;
  readonly store = new Store(this.sql, () => this.clock);
  readonly conn: ConnState = { protocol: 2, id: 42, name: null, db: 0, closeAfterReply: false };
  readonly table: ReadonlyMap<string, CommandSpec> = new Map(
    [...stringCommands, ...keyspaceCommands, ...serverCommands].map((c) => [c.name, c]),
  );

  run(...args: readonly (string | Uint8Array)[]): Reply {
    const argv: Command = args.map((a) => (typeof a === "string" ? enc(a) : a));
    const name = String(args[0]).toLowerCase();
    const entry = this.table.get(name);
    if (entry === undefined) throw new Error(`no such command: ${name}`);
    if (entry.arity >= 0 ? argv.length !== entry.arity : argv.length < -entry.arity) {
      return { kind: "error", value: `ERR wrong number of arguments for '${name}' command` };
    }
    const ctx = {
      store: this.store,
      sql: this.sql,
      now: this.clock,
      conn: this.conn,
      commands: this.table,
    };
    try {
      return entry.handler(ctx, argv);
    } catch (cause) {
      if (cause instanceof RedisError) return cause.reply;
      throw cause;
    }
  }
  seedList(key: string, ...values: readonly string[]): void {
    this.store.track(enc(key), "list");
    values.forEach((v, i) =>
      this.sql.exec("INSERT INTO list (key, seq, val) VALUES (?, ?, ?)", enc(key), i, enc(v)),
    );
  }

  seedHash(key: string, pairs: Readonly<Record<string, string>>): void {
    this.store.track(enc(key), "hash");
    for (const [field, value] of Object.entries(pairs)) {
      this.sql.exec(
        "INSERT INTO hash (key, field, val) VALUES (?, ?, ?)",
        enc(key),
        enc(field),
        enc(value),
      );
    }
  }
}

const str = (r: Reply): string | null =>
  r.kind === "bulk" ? decodeUtf8(r.value) : r.kind === "null" ? null : `<${r.kind}>`;
const num = (r: Reply): number | string =>
  r.kind === "integer" ? Number(r.value) : `<${r.kind}:${describeOther(r)}>`;
const status = (r: Reply): string =>
  r.kind === "simple" ? r.value : `<${r.kind}:${describeOther(r)}>`;
const err = (r: Reply): string => (r.kind === "error" ? r.value : `<${r.kind}>`);
const list = (r: Reply): (string | null)[] =>
  r.kind === "array" ? r.value.map(str) : [`<${r.kind}>`];
const pairs = (r: Reply): Record<string, string> => {
  if (r.kind !== "map") return { kind: r.kind };
  return Object.fromEntries(
    r.value.map(([k, v]) => [str(k) ?? "", v.kind === "integer" ? String(v.value) : (str(v) ?? "")]),
  );
};
const items = (r: Reply): readonly Reply[] => (r.kind === "array" ? r.value : []);
const raw = (r: Reply): number[] => (r.kind === "bulk" ? [...r.value] : []);
const describeOther = (r: Reply): string =>
  r.kind === "error" || r.kind === "simple" ? r.value : "";

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";
const NOT_INT = "ERR value is not an integer or out of range";


describe("GET / SET", () => {
  test("round-trips values, including binary ones", () => {
    const s = new Server();
    expect(status(s.run("SET", "k", "v"))).toBe("OK");
    expect(str(s.run("GET", "k"))).toBe("v");
    expect(str(s.run("GET", "missing"))).toBeNull();

    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x0a]);
    s.run("SET", "bin", binary);
    const back = s.run("GET", "bin");
    expect(back.kind).toBe("bulk");
    expect(raw(back)).toEqual([...binary]);
  });

  test("NX and XX gate the write and reply null on abort", () => {
    const s = new Server();
    expect(status(s.run("SET", "k", "a", "NX"))).toBe("OK");
    expect(s.run("SET", "k", "b", "NX").kind).toBe("null");
    expect(str(s.run("GET", "k"))).toBe("a");

    expect(status(s.run("SET", "k", "c", "XX"))).toBe("OK");
    expect(str(s.run("GET", "k"))).toBe("c");
    expect(s.run("SET", "fresh", "v", "XX").kind).toBe("null");
    expect(num(s.run("EXISTS", "fresh"))).toBe(0);
  });

  test("GET replies with the old value whether or not the write happened", () => {
    const s = new Server();
    expect(s.run("SET", "k", "a", "GET").kind).toBe("null");
    expect(str(s.run("GET", "k"))).toBe("a");
    expect(str(s.run("SET", "k", "b", "GET"))).toBe("a");
    expect(str(s.run("SET", "k", "c", "NX", "GET"))).toBe("b");
    expect(str(s.run("GET", "k"))).toBe("b");
    expect(s.run("SET", "gone", "v", "XX", "GET").kind).toBe("null");
  });

  test("NX and XX together are a syntax error", () => {
    const s = new Server();
    expect(err(s.run("SET", "k", "v", "NX", "XX"))).toBe("ERR syntax error");
    expect(err(s.run("SET", "k", "v", "XX", "NX"))).toBe("ERR syntax error");
    expect(status(s.run("SET", "k", "v", "NX", "NX"))).toBe("OK");
  });

  test("SET clears the TTL, KEEPTTL preserves it", () => {
    const s = new Server();
    s.run("SET", "k", "v", "EX", "100");
    expect(num(s.run("TTL", "k"))).toBe(100);

    s.run("SET", "k", "v2");
    expect(num(s.run("TTL", "k"))).toBe(-1);

    s.run("SET", "k", "v", "EX", "100");
    s.run("SET", "k", "v3", "KEEPTTL");
    expect(num(s.run("TTL", "k"))).toBe(100);
    expect(str(s.run("GET", "k"))).toBe("v3");
  });

  test("KEEPTTL and an expiry option exclude each other", () => {
    const s = new Server();
    expect(err(s.run("SET", "k", "v", "KEEPTTL", "EX", "10"))).toBe("ERR syntax error");
    expect(err(s.run("SET", "k", "v", "EX", "10", "KEEPTTL"))).toBe("ERR syntax error");
    expect(err(s.run("SET", "k", "v", "EX", "10", "PX", "10"))).toBe("ERR syntax error");
  });

  test("expiry options are validated, and only after the option list parses", () => {
    const s = new Server();
    expect(err(s.run("SET", "k", "v", "EX", "0"))).toBe(
      "ERR invalid expire time in 'set' command",
    );
    expect(err(s.run("SET", "k", "v", "EX", "-1"))).toBe(
      "ERR invalid expire time in 'set' command",
    );
    expect(err(s.run("SET", "k", "v", "EX", "abc"))).toBe(NOT_INT);
    expect(err(s.run("SET", "k", "v", "EX", "0", "BOGUS"))).toBe("ERR syntax error");
    expect(err(s.run("SET", "k", "v", "EX"))).toBe("ERR syntax error");
  });

  test("PX, EXAT and PXAT all land on the same absolute deadline", () => {
    const s = new Server();
    s.run("SET", "a", "v", "PX", "100000");
    expect(num(s.run("PTTL", "a"))).toBe(100000);

    s.run("SET", "b", "v", "EXAT", String(Math.floor(s.clock / 1000) + 50));
    expect(num(s.run("TTL", "b"))).toBe(50);

    s.run("SET", "c", "v", "PXAT", String(s.clock + 30000));
    expect(num(s.run("PTTL", "c"))).toBe(30000);

    s.run("SET", "d", "v", "PXAT", String(s.clock - 1));
    expect(num(s.run("EXISTS", "d"))).toBe(0);
  });

  test("SET ... GET reports WRONGTYPE and leaves the value alone", () => {
    const s = new Server();
    s.seedList("l", "a", "b");
    expect(err(s.run("SET", "l", "v", "GET"))).toBe(WRONGTYPE);
    expect(status(s.run("TYPE", "l"))).toBe("list");
    expect(status(s.run("SET", "l", "v"))).toBe("OK");
    expect(status(s.run("TYPE", "l"))).toBe("string");
  });
});

describe("SETNX / SETEX / PSETEX / GETSET / GETDEL / GETEX", () => {
  test("SETNX reports 1 and 0 rather than OK and nil", () => {
    const s = new Server();
    expect(num(s.run("SETNX", "k", "a"))).toBe(1);
    expect(num(s.run("SETNX", "k", "b"))).toBe(0);
    expect(str(s.run("GET", "k"))).toBe("a");
  });

  test("SETEX and PSETEX name themselves in the invalid-expire error", () => {
    const s = new Server();
    expect(status(s.run("SETEX", "k", "100", "v"))).toBe("OK");
    expect(num(s.run("TTL", "k"))).toBe(100);
    expect(str(s.run("GET", "k"))).toBe("v");

    expect(err(s.run("SETEX", "k", "0", "v"))).toBe(
      "ERR invalid expire time in 'setex' command",
    );
    expect(err(s.run("PSETEX", "k", "-1", "v"))).toBe(
      "ERR invalid expire time in 'psetex' command",
    );

    expect(status(s.run("PSETEX", "p", "100000", "v"))).toBe("OK");
    expect(num(s.run("PTTL", "p"))).toBe(100000);
  });

  test("GETSET returns the old value and drops the TTL", () => {
    const s = new Server();
    s.run("SET", "k", "old", "EX", "100");
    expect(str(s.run("GETSET", "k", "new"))).toBe("old");
    expect(str(s.run("GET", "k"))).toBe("new");
    expect(num(s.run("TTL", "k"))).toBe(-1);
    expect(s.run("GETSET", "fresh", "v").kind).toBe("null");
  });

  test("GETDEL returns then removes", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    expect(str(s.run("GETDEL", "k"))).toBe("v");
    expect(num(s.run("EXISTS", "k"))).toBe(0);
    expect(s.run("GETDEL", "k").kind).toBe("null");
  });

  test("GETEX validates its expiry before it looks the key up", () => {
    const s = new Server();
    expect(err(s.run("GETEX", "missing", "EX", "0"))).toBe(
      "ERR invalid expire time in 'getex' command",
    );
    expect(s.run("GETEX", "missing").kind).toBe("null");

    s.run("SET", "k", "v");
    expect(str(s.run("GETEX", "k"))).toBe("v");
    expect(num(s.run("TTL", "k"))).toBe(-1);

    expect(str(s.run("GETEX", "k", "EX", "100"))).toBe("v");
    expect(num(s.run("TTL", "k"))).toBe(100);

    expect(str(s.run("GETEX", "k", "PERSIST"))).toBe("v");
    expect(num(s.run("TTL", "k"))).toBe(-1);

    expect(err(s.run("GETEX", "k", "EX", "0"))).toBe(
      "ERR invalid expire time in 'getex' command",
    );
    expect(err(s.run("GETEX", "k", "PERSIST", "EX", "1"))).toBe("ERR syntax error");
    expect(err(s.run("GETEX", "k", "NX"))).toBe("ERR syntax error");
  });

  test("GETEX with an elapsed absolute deadline deletes the key", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    expect(str(s.run("GETEX", "k", "EXAT", "1"))).toBe("v");
    expect(num(s.run("EXISTS", "k"))).toBe(0);
  });
});

describe("INCR family", () => {
  test("counts up and down from nothing", () => {
    const s = new Server();
    expect(num(s.run("INCR", "n"))).toBe(1);
    expect(num(s.run("INCR", "n"))).toBe(2);
    expect(num(s.run("DECR", "n"))).toBe(1);
    expect(num(s.run("INCRBY", "n", "10"))).toBe(11);
    expect(num(s.run("DECRBY", "n", "5"))).toBe(6);
    expect(str(s.run("GET", "n"))).toBe("6");
  });

  test("rejects everything string2ll rejects", () => {
    const s = new Server();
    for (const bad of ["abc", " 1", "1 ", "01", "-0", "+1", "1.0", "", "0x10"]) {
      s.run("SET", "k", bad);
      expect(err(s.run("INCR", "k"))).toBe(NOT_INT);
    }
    s.run("SET", "k", "0");
    expect(num(s.run("INCR", "k"))).toBe(1);
    s.run("SET", "k", "-5");
    expect(num(s.run("INCR", "k"))).toBe(-4);
  });

  test("overflow past the 64-bit range is refused", () => {
    const s = new Server();
    s.run("SET", "k", "9223372036854775807");
    expect(err(s.run("INCR", "k"))).toBe("ERR increment or decrement would overflow");
    expect(str(s.run("GET", "k"))).toBe("9223372036854775807");

    s.run("SET", "k", "-9223372036854775808");
    expect(err(s.run("DECR", "k"))).toBe("ERR increment or decrement would overflow");

    s.run("SET", "k", "0");
    expect(num(s.run("INCRBY", "k", "9223372036854775807"))).toBe(9223372036854775807);
    expect(err(s.run("INCRBY", "k", "1"))).toBe("ERR increment or decrement would overflow");

    expect(err(s.run("INCRBY", "k", "9223372036854775808"))).toBe(NOT_INT);
    expect(err(s.run("DECRBY", "k", "-9223372036854775808"))).toBe(
      "ERR decrement would overflow",
    );
    expect(err(s.run("INCRBY", "k", "abc"))).toBe(NOT_INT);
  });

  test("preserves the TTL", () => {
    const s = new Server();
    s.run("SET", "k", "1", "EX", "100");
    s.run("INCR", "k");
    expect(num(s.run("TTL", "k"))).toBe(100);
    expect(str(s.run("GET", "k"))).toBe("2");
  });
});

describe("INCRBYFLOAT", () => {
  test("replies with a bulk string trimmed the way Redis trims it", () => {
    const s = new Server();
    s.run("SET", "k", "10.5");
    const reply = s.run("INCRBYFLOAT", "k", "0.1");
    expect(reply.kind).toBe("bulk");
    expect(str(reply)).toBe("10.6");
    expect(str(s.run("GET", "k"))).toBe("10.6");

    expect(str(s.run("INCRBYFLOAT", "fresh", "5.0e3"))).toBe("5000");
    expect(str(s.run("INCRBYFLOAT", "fresh", "2.000"))).toBe("5002");
    expect(str(s.run("INCRBYFLOAT", "tiny", "0.0000001"))).toBe("0.0000001");
    expect(str(s.run("INCRBYFLOAT", "neg", "-5.5"))).toBe("-5.5");
  });

  test("refuses a bad float and a non-finite result", () => {
    const BINARY128_1E300 =
      "1000000000000000000000000000000000041552152361405111863956068954728002352563744" +
      "3067475100676887236804983605207528754077894488238335133468181274878254428524077" +
      "3598041445031004430533712707176444532326347302641015962717804542760572194001541" +
      "8302077278887782971657143239834636920678627670495998467767271424";
    const s = new Server();
    s.run("SET", "k", "abc");
    expect(err(s.run("INCRBYFLOAT", "k", "1.0"))).toBe("ERR value is not a valid float");

    s.run("SET", "k", "1");
    expect(err(s.run("INCRBYFLOAT", "k", "nan"))).toBe("ERR value is not a valid float");
    expect(err(s.run("INCRBYFLOAT", "inf1", "inf"))).toBe(
      "ERR increment would produce NaN or Infinity",
    );
    expect(num(s.run("EXISTS", "inf1"))).toBe(0);
    expect(str(s.run("INCRBYFLOAT", "big", "1e300"))).toBe(BINARY128_1E300);
    expect(err(s.run("INCRBYFLOAT", "big", "1e5000"))).toBe("ERR value is not a valid float");
    expect(err(s.run("INCRBYFLOAT", "big", "1e-5000"))).toBe("ERR value is not a valid float");
    expect(str(s.run("INCRBYFLOAT", "zero", "0.0"))).toBe("0");
  });
});

describe("APPEND / STRLEN / GETRANGE / SETRANGE", () => {
  test("APPEND grows and reports the new length, keeping the TTL", () => {
    const s = new Server();
    expect(num(s.run("APPEND", "k", "a"))).toBe(1);
    expect(num(s.run("APPEND", "k", "bc"))).toBe(3);
    expect(str(s.run("GET", "k"))).toBe("abc");

    s.run("SET", "t", "x", "EX", "100");
    s.run("APPEND", "t", "y");
    expect(num(s.run("TTL", "t"))).toBe(100);
  });

  test("STRLEN is 0 for a missing key", () => {
    const s = new Server();
    expect(num(s.run("STRLEN", "missing"))).toBe(0);
    s.run("SET", "k", "hello");
    expect(num(s.run("STRLEN", "k"))).toBe(5);
  });

  test("GETRANGE clamps both ends, except where both count back and start is past end", () => {
    const s = new Server();
    s.run("SET", "k", "This is a string");
    expect(str(s.run("GETRANGE", "k", "0", "3"))).toBe("This");
    expect(str(s.run("GETRANGE", "k", "-3", "-1"))).toBe("ing");
    expect(str(s.run("GETRANGE", "k", "0", "-1"))).toBe("This is a string");
    expect(str(s.run("GETRANGE", "k", "10", "100"))).toBe("string");
    expect(str(s.run("GETRANGE", "k", "-100", "-1"))).toBe("This is a string");
    expect(str(s.run("GETRANGE", "k", "-100", "-200"))).toBe("");
    expect(str(s.run("GETRANGE", "k", "-100", "-100"))).toBe("T");
    expect(str(s.run("GETRANGE", "k", "5", "2"))).toBe("");
    expect(str(s.run("GETRANGE", "k", "100", "200"))).toBe("");
    expect(str(s.run("GETRANGE", "missing", "0", "-1"))).toBe("");
    expect(str(s.run("SUBSTR", "k", "0", "3"))).toBe("This");
    expect(err(s.run("GETRANGE", "k", "x", "1"))).toBe(NOT_INT);
  });

  test("SETRANGE zero-pads, never shrinks, and refuses a negative offset", () => {
    const s = new Server();
    expect(num(s.run("SETRANGE", "k", "5", "hello"))).toBe(10);
    const padded = s.run("GET", "k");
    expect(raw(padded).slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(str(padded)).toBe("     hello");

    s.run("SET", "w", "abcdef");
    expect(num(s.run("SETRANGE", "w", "1", "xx"))).toBe(6);
    expect(str(s.run("GET", "w"))).toBe("axxdef");

    expect(num(s.run("SETRANGE", "nothing", "0", ""))).toBe(0);
    expect(num(s.run("EXISTS", "nothing"))).toBe(0);
    expect(num(s.run("SETRANGE", "w", "99", ""))).toBe(6);

    expect(err(s.run("SETRANGE", "w", "-1", "x"))).toBe("ERR offset is out of range");

    s.run("SET", "t", "abc", "EX", "100");
    s.run("SETRANGE", "t", "0", "z");
    expect(num(s.run("TTL", "t"))).toBe(100);
  });
});

describe("MGET / MSET / MSETNX", () => {
  test("MGET reads a nil for anything that is not a live string", () => {
    const s = new Server();
    s.run("MSET", "a", "1", "b", "2");
    s.seedList("l", "x");
    expect(list(s.run("MGET", "a", "b", "missing", "l"))).toEqual(["1", "2", null, null]);
  });

  test("MSET insists on key/value pairs", () => {
    const s = new Server();
    expect(status(s.run("MSET", "a", "1"))).toBe("OK");
    expect(err(s.run("MSET", "a", "1", "b"))).toBe(
      "ERR wrong number of arguments for 'mset' command",
    );
    expect(err(s.run("MSETNX", "a", "1", "b"))).toBe(
      "ERR wrong number of arguments for 'msetnx' command",
    );
  });

  test("MSETNX is all or nothing", () => {
    const s = new Server();
    expect(num(s.run("MSETNX", "a", "1", "b", "2"))).toBe(1);
    expect(num(s.run("MSETNX", "b", "9", "c", "3"))).toBe(0);
    expect(num(s.run("EXISTS", "c"))).toBe(0);
    expect(str(s.run("GET", "b"))).toBe("2");
  });
});

describe("WRONGTYPE", () => {
  test("every string command that reads a value raises it", () => {
    const s = new Server();
    s.seedList("l", "a");
    const cases: readonly (readonly string[])[] = [
      ["GET", "l"],
      ["GETSET", "l", "v"],
      ["GETDEL", "l"],
      ["GETEX", "l"],
      ["APPEND", "l", "x"],
      ["STRLEN", "l"],
      ["INCR", "l"],
      ["DECR", "l"],
      ["INCRBY", "l", "1"],
      ["INCRBYFLOAT", "l", "1"],
      ["GETRANGE", "l", "0", "-1"],
      ["SETRANGE", "l", "0", "x"],
      ["SET", "l", "v", "GET"],
    ];
    for (const argv of cases) {
      expect([argv[0], err(s.run(...argv))]).toEqual([argv[0], WRONGTYPE]);
    }
    expect(status(s.run("TYPE", "l"))).toBe("list");
  });
});

describe("keyspace basics", () => {
  test("DEL, UNLINK, EXISTS and TOUCH count keys, repeats included", () => {
    const s = new Server();
    s.run("MSET", "a", "1", "b", "2");
    expect(num(s.run("EXISTS", "a", "a", "b", "missing"))).toBe(3);
    expect(num(s.run("TOUCH", "a", "b", "missing"))).toBe(2);
    expect(num(s.run("DEL", "a", "missing"))).toBe(1);
    expect(num(s.run("UNLINK", "b"))).toBe(1);
    expect(num(s.run("DEL", "b"))).toBe(0);
  });

  test("TYPE names the type, or none", () => {
    const s = new Server();
    s.run("SET", "str", "v");
    s.seedList("l", "x");
    s.seedHash("h", { f: "v" });
    expect(status(s.run("TYPE", "str"))).toBe("string");
    expect(status(s.run("TYPE", "l"))).toBe("list");
    expect(status(s.run("TYPE", "h"))).toBe("hash");
    expect(status(s.run("TYPE", "missing"))).toBe("none");
  });

  test("KEYS uses Redis's glob, not a regex", () => {
    const s = new Server();
    s.run("MSET", "hello", "1", "hallo", "2", "hxllo", "3", "heeello", "4", "a.c", "5");
    expect(list(s.run("KEYS", "h?llo")).sort()).toEqual(["hallo", "hello", "hxllo"]);
    expect(list(s.run("KEYS", "h*llo")).sort()).toEqual([
      "hallo",
      "heeello",
      "hello",
      "hxllo",
    ]);
    expect(list(s.run("KEYS", "h[ae]llo")).sort()).toEqual(["hallo", "hello"]);
    expect(list(s.run("KEYS", "a.c"))).toEqual(["a.c"]);
    expect(list(s.run("KEYS", "abc"))).toEqual([]);
    expect(list(s.run("KEYS", "*")).length).toBe(5);
  });

  test("KEYS and RANDOMKEY skip a key whose deadline has passed", () => {
    const s = new Server();
    s.run("SET", "live", "1");
    s.run("SET", "doomed", "1", "PX", "10");
    s.clock += 50;
    expect(list(s.run("KEYS", "*"))).toEqual(["live"]);
    expect(str(s.run("RANDOMKEY"))).toBe("live");

    s.run("DEL", "live");
    expect(s.run("RANDOMKEY").kind).toBe("null");
  });

  test("SCAN pages the whole keyspace and honours MATCH, COUNT and TYPE", () => {
    const s = new Server();
    for (let i = 0; i < 25; i++) s.run("SET", `k${i}`, "v");
    s.seedList("alist", "x");

    const seen = new Set<string>();
    let cursor = "0";
    let guard = 0;
    do {
      const page = s.run("SCAN", cursor, "COUNT", "5");
      expect(page.kind).toBe("array");
      const [head, body] = items(page);
      cursor = str(head as Reply) ?? "0";
      for (const key of list(body as Reply)) if (key !== null) seen.add(key);
      expect(guard++).toBeLessThan(100);
    } while (cursor !== "0");
    expect(seen.size).toBe(26);

    const typed = s.run("SCAN", "0", "COUNT", "1000", "TYPE", "list");
    expect(list(items(typed)[1] as Reply)).toEqual(["alist"]);

    const matched = s.run("SCAN", "0", "COUNT", "1000", "MATCH", "k1?");
    expect(list(items(matched)[1] as Reply).length).toBe(10);

    expect(err(s.run("SCAN", "-1"))).toBe("ERR invalid cursor");
    expect(err(s.run("SCAN", "abc"))).toBe("ERR invalid cursor");
    expect(err(s.run("SCAN", "0", "COUNT", "0"))).toBe("ERR syntax error");
    expect(err(s.run("SCAN", "0", "BOGUS", "x"))).toBe("ERR syntax error");
    expect(err(s.run("SCAN", "0", "COUNT"))).toBe("ERR syntax error");
  });
});

describe("RENAME / RENAMENX / COPY", () => {
  test("RENAME moves the value and the deadline", () => {
    const s = new Server();
    s.run("SET", "a", "v", "EX", "100");
    expect(status(s.run("RENAME", "a", "b"))).toBe("OK");
    expect(str(s.run("GET", "b"))).toBe("v");
    expect(num(s.run("EXISTS", "a"))).toBe(0);
    expect(num(s.run("TTL", "b"))).toBe(100);
  });

  test("RENAME onto itself is fine; onto a missing source is not", () => {
    const s = new Server();
    expect(err(s.run("RENAME", "missing", "x"))).toBe("ERR no such key");
    expect(err(s.run("RENAMENX", "missing", "x"))).toBe("ERR no such key");

    s.run("SET", "a", "v");
    expect(status(s.run("RENAME", "a", "a"))).toBe("OK");
    expect(str(s.run("GET", "a"))).toBe("v");
    expect(num(s.run("RENAMENX", "a", "a"))).toBe(0);
  });

  test("RENAME overwrites the destination, RENAMENX refuses to", () => {
    const s = new Server();
    s.run("MSET", "a", "1", "b", "2");
    expect(num(s.run("RENAMENX", "a", "b"))).toBe(0);
    expect(str(s.run("GET", "b"))).toBe("2");

    expect(status(s.run("RENAME", "a", "b"))).toBe("OK");
    expect(str(s.run("GET", "b"))).toBe("1");
    expect(num(s.run("EXISTS", "a"))).toBe(0);

    s.run("SET", "c", "3");
    expect(num(s.run("RENAMENX", "c", "d"))).toBe(1);
    expect(str(s.run("GET", "d"))).toBe("3");
  });

  test("RENAME carries a non-string type with it", () => {
    const s = new Server();
    s.seedHash("h", { f1: "a", f2: "b" });
    s.run("RENAME", "h", "h2");
    expect(status(s.run("TYPE", "h2"))).toBe("hash");
    const rows = s.sql.exec("SELECT COUNT(*) AS n FROM hash WHERE key = ?", enc("h2")).one();
    expect(rows.n).toBe(2);
    expect(num(s.run("EXISTS", "h"))).toBe(0);
  });

  test("COPY duplicates the value, the type and the TTL", () => {
    const s = new Server();
    s.run("SET", "a", "v", "EX", "100");
    expect(num(s.run("COPY", "a", "b"))).toBe(1);
    expect(str(s.run("GET", "b"))).toBe("v");
    expect(str(s.run("GET", "a"))).toBe("v");
    expect(num(s.run("TTL", "b"))).toBe(100);

    s.seedHash("h", { f1: "a", f2: "b" });
    expect(num(s.run("COPY", "h", "h2"))).toBe(1);
    expect(status(s.run("TYPE", "h2"))).toBe("hash");
    expect(s.sql.exec("SELECT COUNT(*) AS n FROM hash WHERE key = ?", enc("h2")).one().n).toBe(2);
    expect(s.sql.exec("SELECT COUNT(*) AS n FROM hash WHERE key = ?", enc("h")).one().n).toBe(2);
  });

  test("COPY refuses a collision unless REPLACE, and refuses itself always", () => {
    const s = new Server();
    s.run("MSET", "a", "1", "b", "2");
    expect(num(s.run("COPY", "a", "b"))).toBe(0);
    expect(str(s.run("GET", "b"))).toBe("2");
    expect(num(s.run("COPY", "a", "b", "REPLACE"))).toBe(1);
    expect(str(s.run("GET", "b"))).toBe("1");

    expect(num(s.run("COPY", "missing", "z"))).toBe(0);
    expect(err(s.run("COPY", "a", "a"))).toBe("ERR source and destination objects are the same");
    expect(err(s.run("COPY", "a", "z", "DB", "1"))).toBe("ERR DB index is out of range");
    expect(num(s.run("COPY", "a", "z", "DB", "0"))).toBe(1);
    expect(err(s.run("COPY", "a", "z", "BOGUS"))).toBe("ERR syntax error");
  });
});

describe("expiry", () => {
  test("TTL reports -2, -1, and Redis's rounding in between", () => {
    const s = new Server();
    expect(num(s.run("TTL", "missing"))).toBe(-2);
    expect(num(s.run("PTTL", "missing"))).toBe(-2);

    s.run("SET", "k", "v");
    expect(num(s.run("TTL", "k"))).toBe(-1);
    expect(num(s.run("PTTL", "k"))).toBe(-1);

    const rounding: readonly (readonly [number, number])[] = [
      [1, 0],
      [499, 0],
      [500, 1],
      [1000, 1],
      [1400, 1],
      [1500, 2],
      [2499, 2],
      [2500, 3],
    ];
    for (const [ms, seconds] of rounding) {
      s.run("PEXPIRE", "k", String(ms));
      expect([ms, num(s.run("PTTL", "k"))]).toEqual([ms, ms]);
      expect([ms, num(s.run("TTL", "k"))]).toEqual([ms, seconds]);
    }
  });

  test("a non-positive TTL deletes the key and still reports success", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    expect(num(s.run("EXPIRE", "k", "-1"))).toBe(1);
    expect(num(s.run("EXISTS", "k"))).toBe(0);

    s.run("SET", "k", "v");
    expect(num(s.run("PEXPIRE", "k", "0"))).toBe(1);
    expect(num(s.run("EXISTS", "k"))).toBe(0);

    expect(num(s.run("EXPIRE", "missing", "100"))).toBe(0);
  });

  test("EXPIREAT and PEXPIREAT take an absolute deadline", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    expect(num(s.run("EXPIREAT", "k", String(Math.floor(s.clock / 1000) + 100)))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(100);

    expect(num(s.run("PEXPIREAT", "k", String(s.clock + 5000)))).toBe(1);
    expect(num(s.run("PTTL", "k"))).toBe(5000);

    expect(num(s.run("PEXPIREAT", "k", "1"))).toBe(1);
    expect(num(s.run("EXISTS", "k"))).toBe(0);
  });

  test("NX, XX, GT and LT gate the write", () => {
    const s = new Server();
    s.run("SET", "k", "v");

    expect(num(s.run("EXPIRE", "k", "100", "NX"))).toBe(1);
    expect(num(s.run("EXPIRE", "k", "200", "NX"))).toBe(0);
    expect(num(s.run("TTL", "k"))).toBe(100);

    expect(num(s.run("EXPIRE", "k", "200", "XX"))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(200);
    s.run("PERSIST", "k");
    expect(num(s.run("EXPIRE", "k", "200", "XX"))).toBe(0);

    expect(num(s.run("EXPIRE", "k", "100", "GT"))).toBe(0);
    s.run("EXPIRE", "k", "100");
    expect(num(s.run("EXPIRE", "k", "200", "GT"))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(200);
    expect(num(s.run("EXPIRE", "k", "50", "GT"))).toBe(0);
    expect(num(s.run("TTL", "k"))).toBe(200);

    expect(num(s.run("EXPIRE", "k", "50", "LT"))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(50);
    expect(num(s.run("EXPIRE", "k", "500", "LT"))).toBe(0);
    s.run("PERSIST", "k");
    expect(num(s.run("EXPIRE", "k", "500", "LT"))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(500);
  });

  test("incompatible and unknown flags are refused", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    expect(err(s.run("EXPIRE", "k", "1", "NX", "XX"))).toBe(
      "ERR NX and XX, GT or LT options at the same time are not compatible",
    );
    expect(err(s.run("EXPIRE", "k", "1", "NX", "GT"))).toBe(
      "ERR NX and XX, GT or LT options at the same time are not compatible",
    );
    expect(err(s.run("EXPIRE", "k", "1", "GT", "LT"))).toBe(
      "ERR GT and LT options at the same time are not compatible",
    );
    expect(err(s.run("EXPIRE", "k", "1", "BOGUS"))).toBe("ERR Unsupported option BOGUS");
    expect(err(s.run("EXPIRE", "k", "abc"))).toBe(NOT_INT);
    expect(err(s.run("EXPIRE", "k", "9999999999999999999"))).toBe(NOT_INT);
    expect(err(s.run("EXPIRE", "k", "9223372036854775"))).toBe(
      "ERR invalid expire time in 'expire' command",
    );
  });

  test("PERSIST removes a deadline once", () => {
    const s = new Server();
    s.run("SET", "k", "v", "EX", "100");
    expect(num(s.run("PERSIST", "k"))).toBe(1);
    expect(num(s.run("TTL", "k"))).toBe(-1);
    expect(num(s.run("PERSIST", "k"))).toBe(0);
    expect(num(s.run("PERSIST", "missing"))).toBe(0);
  });

  test("a key really does vanish once its deadline passes", () => {
    const s = new Server();
    s.run("SET", "k", "v", "PX", "100");
    expect(str(s.run("GET", "k"))).toBe("v");
    s.clock += 99;
    expect(str(s.run("GET", "k"))).toBe("v");
    s.clock += 1;
    expect(s.run("GET", "k").kind).toBe("null");
    expect(num(s.run("EXISTS", "k"))).toBe(0);
    expect(num(s.run("TTL", "k"))).toBe(-2);
    expect(num(s.run("DBSIZE"))).toBe(0);
  });
});

describe("server commands", () => {
  test("PING and ECHO", () => {
    const s = new Server();
    expect(status(s.run("PING"))).toBe("PONG");
    expect(str(s.run("PING", "hi"))).toBe("hi");
    expect(err(s.run("PING", "a", "b"))).toBe(
      "ERR wrong number of arguments for 'ping' command",
    );
    expect(str(s.run("ECHO", "hi"))).toBe("hi");
  });

  test("SELECT accepts only the one database this object is", () => {
    const s = new Server();
    expect(status(s.run("SELECT", "0"))).toBe("OK");
    expect(err(s.run("SELECT", "1"))).toBe("ERR DB index is out of range");
    expect(err(s.run("SELECT", "abc"))).toBe(NOT_INT);
  });

  test("HELLO negotiates the protocol by writing to the connection", () => {
    const s = new Server();
    expect(pairs(s.run("HELLO")).proto).toBe("2");

    const three = s.run("HELLO", "3");
    expect(three.kind).toBe("map");
    const fields = pairs(three);
    expect(fields.server).toBe("radish");
    expect(fields.proto).toBe("3");
    expect(fields.mode).toBe("standalone");
    expect(fields.role).toBe("master");
    expect(fields.id).toBe("42");
    expect(s.conn.protocol).toBe(3);

    expect(pairs(s.run("HELLO")).proto).toBe("3");
    expect(s.conn.protocol).toBe(3);

    expect(err(s.run("HELLO", "4"))).toBe("NOPROTO unsupported protocol version");
    expect(err(s.run("HELLO", "abc"))).toBe(
      "ERR Protocol version is not an integer or out of range",
    );
    expect(err(s.run("HELLO", "3", "BOGUS"))).toBe("ERR Syntax error in HELLO option 'BOGUS'");

    s.run("HELLO", "3", "SETNAME", "worker");
    expect(s.conn.name).toBe("worker");
    expect(err(s.run("HELLO", "2", "AUTH", "default", ""))).toBe(
      "ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?",
    );
    expect(s.conn.protocol).toBe(3);
  });

  test("CLIENT ID, SETNAME and GETNAME", () => {
    const s = new Server();
    expect(num(s.run("CLIENT", "ID"))).toBe(42);
    expect(s.run("CLIENT", "GETNAME").kind).toBe("null");
    expect(status(s.run("CLIENT", "SETNAME", "worker"))).toBe("OK");
    expect(str(s.run("CLIENT", "GETNAME"))).toBe("worker");
    expect(err(s.run("CLIENT", "SETNAME", "two words"))).toBe(
      "ERR Client names cannot contain spaces, newlines or special characters.",
    );
    expect(err(s.run("CLIENT", "NOPE"))).toBe(
      "ERR Unknown subcommand or wrong number of arguments for 'NOPE'. Try CLIENT HELP.",
    );
  });

  test("RESET clears what belongs to the connection", () => {
    const s = new Server();
    s.run("HELLO", "3");
    s.run("CLIENT", "SETNAME", "worker");
    expect(status(s.run("RESET"))).toBe("RESET");
    expect(s.conn.protocol).toBe(2);
    expect(s.conn.name).toBeNull();
  });

  test("COMMAND reports the table it was given", () => {
    const s = new Server();
    expect(num(s.run("COMMAND", "COUNT"))).toBe(s.table.size);

    const all = s.run("COMMAND");
    expect(all.kind).toBe("array");
    expect(items(all).length).toBe(s.table.size);

    const one = s.run("COMMAND", "INFO", "get");
    const entry = items(one)[0] as Reply;
    expect(entry.kind).toBe("array");
    const fields = items(entry);
    expect(str(fields[0] as Reply)).toBe("get");
    expect(num(fields[1] as Reply)).toBe(2);

    const missing = s.run("COMMAND", "INFO", "nosuchcommand");
    expect(items(missing)[0]?.kind).toBe("null");

    expect(s.run("COMMAND", "DOCS", "get").kind).toBe("map");
    expect(err(s.run("COMMAND", "NOPE"))).toBe(
      "ERR Unknown subcommand or wrong number of arguments for 'NOPE'. Try COMMAND HELP.",
    );
  });

  test("COMMAND GETKEYS extracts the keys a command names", () => {
    const s = new Server();
    expect(list(s.run("COMMAND", "GETKEYS", "GET", "k"))).toEqual(["k"]);
    expect(list(s.run("COMMAND", "GETKEYS", "SET", "k", "v", "EX", "100"))).toEqual(["k"]);
    expect(list(s.run("COMMAND", "GETKEYS", "DEL", "a", "b", "c"))).toEqual(["a", "b", "c"]);
    expect(list(s.run("COMMAND", "GETKEYS", "MSET", "a", "1", "b", "2"))).toEqual(["a", "b"]);
    expect(list(s.run("COMMAND", "GETKEYS", "MGET", "a", "b"))).toEqual(["a", "b"]);
    expect(list(s.run("COMMAND", "GETKEYS", "RENAME", "a", "b"))).toEqual(["a", "b"]);
    expect(list(s.run("COMMAND", "GETKEYS", "COPY", "a", "b", "REPLACE"))).toEqual(["a", "b"]);
    expect(list(s.run("COMMAND", "GETKEYS", "EXPIRE", "k", "100", "NX"))).toEqual(["k"]);
  });

  test("COMMAND GETKEYS distinguishes its three failure modes", () => {
    const s = new Server();
    expect(err(s.run("COMMAND", "GETKEYS", "NOSUCHCOMMAND", "k"))).toBe(
      "ERR Invalid command specified",
    );
    expect(err(s.run("COMMAND", "GETKEYS", "PING"))).toBe("ERR The command has no key arguments");
    expect(err(s.run("COMMAND", "GETKEYS", "KEYS", "*"))).toBe(
      "ERR The command has no key arguments",
    );
    expect(err(s.run("COMMAND", "GETKEYS", "SCAN", "0"))).toBe(
      "ERR The command has no key arguments",
    );
    expect(err(s.run("COMMAND", "GETKEYS", "GET"))).toBe(
      "ERR Invalid number of arguments specified for command",
    );
    expect(err(s.run("COMMAND", "GETKEYS", "GET", "a", "b"))).toBe(
      "ERR Invalid number of arguments specified for command",
    );
    expect(err(s.run("COMMAND", "GETKEYS", "MSET", "a"))).toBe(
      "ERR Invalid number of arguments specified for command",
    );
    expect(err(s.run("COMMAND", "GETKEYS"))).toBe(
      "ERR wrong number of arguments for 'command|getkeys' command",
    );
  });

  test("INFO renders sections", () => {
    const s = new Server();
    s.run("SET", "k", "v");
    const all = str(s.run("INFO")) ?? "";
    expect(all).toContain("# Server");
    expect(all).toContain("radish_version:");
    expect(all).toContain("# Compatibility");
    expect(all).toContain("redis_compatibility_version:7.4.11");
    expect(all).not.toContain("redis_version:");
    expect(all).toContain("db0:keys=1,expires=0,avg_ttl=0");

    s.run("PEXPIRE", "k", "60000");
    expect(str(s.run("INFO", "keyspace")) ?? "").toContain("db0:keys=1,expires=1,avg_ttl=60000");

    const one = str(s.run("INFO", "replication")) ?? "";
    expect(one).toContain("role:master");
    expect(one).not.toContain("radish_version");
    expect(str(s.run("INFO", "nosuchsection"))).toBe("");
  });

  test("DBSIZE, FLUSHDB and FLUSHALL", () => {
    const s = new Server();
    s.run("MSET", "a", "1", "b", "2");
    expect(num(s.run("DBSIZE"))).toBe(2);
    expect(status(s.run("FLUSHDB"))).toBe("OK");
    expect(num(s.run("DBSIZE"))).toBe(0);

    s.run("SET", "a", "1");
    expect(status(s.run("FLUSHALL", "ASYNC"))).toBe("OK");
    expect(num(s.run("DBSIZE"))).toBe(0);
    expect(err(s.run("FLUSHDB", "BOGUS"))).toBe("ERR syntax error");
    expect(err(s.run("FLUSHDB", "SYNC", "EXTRA"))).toBe("ERR syntax error");
  });

  test("TIME splits the clock into seconds and microseconds", () => {
    const s = new Server();
    s.clock = 1_700_000_000_123;
    const reply = s.run("TIME");
    expect(list(reply)).toEqual(["1700000000", "123000"]);
  });

  test("CONFIG GET globs, CONFIG SET refuses what it would not apply", () => {
    const s = new Server();
    expect(pairs(s.run("CONFIG", "GET", "maxmemory"))).toEqual({ maxmemory: "0" });

    const globbed = pairs(s.run("CONFIG", "GET", "maxmemory*"));
    expect(Object.keys(globbed).sort()).toEqual(["maxmemory", "maxmemory-policy"]);
    expect(pairs(s.run("CONFIG", "GET", "nosuchparam"))).toEqual({});

    expect(status(s.run("CONFIG", "SET", "maxmemory", "0"))).toBe("OK");
    expect(err(s.run("CONFIG", "SET", "maxmemory", "100mb"))).toBe(
      "ERR CONFIG SET failed - radish runs with 'maxmemory' fixed at '0' and cannot change it",
    );
    expect(err(s.run("CONFIG", "SET", "requirepass", "secret"))).toBe(
      "ERR Unknown option or number of arguments for CONFIG SET - 'requirepass'",
    );
    expect(err(s.run("CONFIG", "SET", "maxmemory", "0", "maxmemory", "0"))).toBe(
      "ERR CONFIG SET failed - duplicate parameter 'maxmemory'",
    );
    expect(err(s.run("CONFIG", "RESETSTAT"))).toBe(
      "ERR CONFIG RESETSTAT failed - radish keeps no resettable statistics",
    );
    expect(err(s.run("CONFIG", "REWRITE"))).toBe("ERR The server is running without a config file");
    expect(err(s.run("CONFIG", "NOPE"))).toBe(
      "ERR Unknown subcommand or wrong number of arguments for 'NOPE'. Try CONFIG HELP.",
    );
  });

  test("QUIT replies OK", () => {
    const s = new Server();
    expect(status(s.run("QUIT"))).toBe("OK");
  });
});

describe("arity and key specs", () => {
  test("every spec declares what Redis declares", () => {
    const expected: Readonly<Record<string, readonly [number, KeySpec]>> = {
      get: [2, ONE_KEY],
      set: [-3, ONE_KEY],
      getset: [3, ONE_KEY],
      setnx: [3, ONE_KEY],
      setex: [4, ONE_KEY],
      psetex: [4, ONE_KEY],
      getdel: [2, ONE_KEY],
      getex: [-2, ONE_KEY],
      mget: [-2, ALL_KEYS],
      mset: [-3, ALTERNATING_KEYS],
      msetnx: [-3, ALTERNATING_KEYS],
      append: [3, ONE_KEY],
      strlen: [2, ONE_KEY],
      incr: [2, ONE_KEY],
      decr: [2, ONE_KEY],
      incrby: [3, ONE_KEY],
      decrby: [3, ONE_KEY],
      incrbyfloat: [3, ONE_KEY],
      getrange: [4, ONE_KEY],
      setrange: [4, ONE_KEY],
      substr: [4, ONE_KEY],
      del: [-2, ALL_KEYS],
      unlink: [-2, ALL_KEYS],
      exists: [-2, ALL_KEYS],
      type: [2, ONE_KEY],
      keys: [2, NO_KEYS],
      scan: [-2, NO_KEYS],
      rename: [3, FIRST_TWO_KEYS],
      renamenx: [3, FIRST_TWO_KEYS],
      expire: [-3, ONE_KEY],
      pexpire: [-3, ONE_KEY],
      expireat: [-3, ONE_KEY],
      pexpireat: [-3, ONE_KEY],
      ttl: [2, ONE_KEY],
      pttl: [2, ONE_KEY],
      persist: [2, ONE_KEY],
      randomkey: [1, NO_KEYS],
      copy: [-3, FIRST_TWO_KEYS],
      touch: [-2, ALL_KEYS],
      ping: [-1, NO_KEYS],
      echo: [2, NO_KEYS],
      select: [2, NO_KEYS],
      hello: [-1, NO_KEYS],
      command: [-1, NO_KEYS],
      info: [-1, NO_KEYS],
      dbsize: [1, NO_KEYS],
      flushdb: [-1, NO_KEYS],
      flushall: [-1, NO_KEYS],
      time: [1, NO_KEYS],
      config: [-2, NO_KEYS],
      client: [-2, NO_KEYS],
      quit: [-1, NO_KEYS],
      reset: [1, NO_KEYS],
    };
    const s = new Server();
    expect(s.table.size).toBe(Object.keys(expected).length);

    for (const [name, [arity, keys]] of Object.entries(expected)) {
      const entry = s.table.get(name);
      expect([name, entry?.arity]).toEqual([name, arity]);
      expect([name, entry?.firstKey, entry?.lastKey, entry?.keyStep]).toEqual([
        name,
        keys.firstKey,
        keys.lastKey,
        keys.keyStep,
      ]);
    }
  });

  test("COMMAND INFO reports the key spec, not a placeholder", () => {
    const s = new Server();
    const fields = items(items(s.run("COMMAND", "INFO", "mset"))[0] as Reply);
    expect(num(fields[3] as Reply)).toBe(1);
    expect(num(fields[4] as Reply)).toBe(-1);
    expect(num(fields[5] as Reply)).toBe(2);

    const keyless = items(items(s.run("COMMAND", "INFO", "ping"))[0] as Reply);
    expect([3, 4, 5].map((i) => num(keyless[i] as Reply))).toEqual([0, 0, 0]);
  });

  test("a violation reports the command by name", () => {
    const s = new Server();
    expect(err(s.run("GET"))).toBe("ERR wrong number of arguments for 'get' command");
    expect(err(s.run("SET", "k"))).toBe("ERR wrong number of arguments for 'set' command");
    expect(err(s.run("TTL", "a", "b"))).toBe("ERR wrong number of arguments for 'ttl' command");
  });
});

describe("counted key lists", () => {
  const argvOf = (...args: readonly string[]): Command => args.map(enc);
  const names = (keys: readonly Uint8Array[]): string[] => keys.map(decodeUtf8);

  test("reads numkeys and the fixed positions outside it", () => {
    const zunionstore = keysAfterCount(2, [1]);
    expect(names(zunionstore(argvOf("ZUNIONSTORE", "dst", "2", "a", "b")))).toEqual([
      "dst",
      "a",
      "b",
    ]);

    const zunion = keysAfterCount(1);
    expect(names(zunion(argvOf("ZUNION", "2", "a", "b")))).toEqual(["a", "b"]);
    expect(names(zunion(argvOf("ZUNION", "2", "a", "b", "WITHSCORES")))).toEqual(["a", "b"]);
    expect(names(zunion(argvOf("LMPOP", "2", "a", "b", "LEFT")))).toEqual(["a", "b"]);
  });

  test("fails soft on a numkeys the handler will reject", () => {
    const zunion = keysAfterCount(1);
    expect(names(zunion(argvOf("ZUNION", "abc", "a", "b")))).toEqual([]);
    expect(names(zunion(argvOf("ZUNION", "0", "a")))).toEqual([]);
    expect(names(zunion(argvOf("ZUNION", "-1", "a")))).toEqual([]);
    expect(names(zunion(argvOf("ZUNION", "99999999999999999999", "a")))).toEqual([]);
    expect(names(zunion(argvOf("ZUNION")))).toEqual([]);

    const zunionstore = keysAfterCount(2, [1]);
    expect(names(zunionstore(argvOf("ZUNIONSTORE", "dst", "abc", "a")))).toEqual(["dst"]);
    expect(names(zunionstore(argvOf("ZUNIONSTORE")))).toEqual([]);
  });

  test("clamps a numkeys larger than argv instead of yielding holes", () => {
    const zunion = keysAfterCount(1);
    expect(names(zunion(argvOf("ZUNION", "5", "a", "b")))).toEqual(["a", "b"]);
  });

  test("extractKeys prefers the override and still reports the command as keyed", () => {
    const zunion = spec("zunion", -3, false, keysAt(0, 0, 0), () => NULL, keysAfterCount(1));
    expect(zunion.firstKey).toBe(0);
    expect(zunion.lastKey).toBe(0);
    expect(zunion.keyStep).toBe(0);
    expect(hasKeys(zunion)).toBe(true);
    expect(names(extractKeys(zunion, argvOf("ZUNION", "2", "a", "b")))).toEqual(["a", "b"]);

    const get = spec("get", 2, false, ONE_KEY, () => NULL);
    expect(get.getKeys).toBeUndefined();
    expect(names(extractKeys(get, argvOf("GET", "k")))).toEqual(["k"]);
    expect(hasKeys(spec("ping", -1, false, NO_KEYS, () => NULL))).toBe(false);
  });
});
