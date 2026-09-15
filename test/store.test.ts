import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { RedisError, WRONGTYPE } from "../src/errors";
import {
  TABLE_HASH,
  TABLE_LIST,
  TABLE_META,
  TABLE_SCAN_CURSOR,
  TABLE_SET,
  TABLE_STRING,
  TYPE_TABLE,
  type SqlBinding,
  type SqlCursor,
  type SqlRow,
  type SqlRowShape,
  type SqlStorage,
  type SqlValue,
} from "../src/schema";
import {
  ESTIMATED_BYTES_PER_ELEMENT,
  MAX_GLOB_PATTERN_BYTES,
  SCAN_CURSOR_EXPIRED,
  Store,
  TOUCH_CLOCK_RESOLUTION_MS,
  TOUCH_SAMPLE_ONE_IN,
  asBytes,
  byteKey,
  globToRegExp,
  matchGlob,
  type ScanPage,
} from "../src/store";
import { type KeyType, encodeUtf8 } from "../src/types";

const bindTheWayWorkersDoes = (value: SqlBinding): SQLQueryBindings => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value as SQLQueryBindings;
};

const returnBlobsAsArrayBufferTheWayWorkersDoes = (value: unknown): SqlValue => {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (typeof value === "bigint") return Number(value);
  return value as SqlValue;
};

const isReadStatement = (query: string): boolean => /^\s*(?:select|with|pragma)\b/i.test(query);

class FakeSqlStorage implements SqlStorage {
  readonly db = new Database(":memory:");
  readonly #prepared = new Map<string, Statement<SqlRow, SQLQueryBindings[]>>();

  get databaseSize(): number {
    return this.#pragma("page_count") * this.#pragma("page_size");
  }

  #pragma(name: string): number {
    return Number((this.db.query(`PRAGMA ${name}`).values()[0]?.[0] as number | undefined) ?? 0);
  }

  exec<T extends SqlRowShape = SqlRow>(
    query: string,
    ...bindings: SqlBinding[]
  ): SqlCursor<T> {
    const statement = this.#prepare(query);
    const params = bindings.map(bindTheWayWorkersDoes);

    let columnNames: string[] = [];
    let rows: SqlValue[][] = [];
    let rowsWritten = 0;

    if (isReadStatement(query)) {
      columnNames = statement.columnNames;
      rows = (statement.values(...params) as unknown[][]).map((row) =>
        row.map(returnBlobsAsArrayBufferTheWayWorkersDoes),
      );
    } else {
      rowsWritten = Number(statement.run(...params).changes);
    }

    const asObject = (row: SqlValue[]): T => {
      const out: SqlRow = {};
      columnNames.forEach((name, i) => {
        out[name] = row[i] as SqlValue;
      });
      return out as unknown as T;
    };

    return {
      columnNames,
      rowsWritten,
      toArray: () => rows.map(asObject),
      one: () => {
        if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
        return asObject(rows[0] as SqlValue[]);
      },
      raw: <U extends SqlValue[] = SqlValue[]>() => rows.values() as IterableIterator<U>,
    };
  }

  #prepare(query: string): Statement<SqlRow, SQLQueryBindings[]> {
    let statement = this.#prepared.get(query);
    if (statement === undefined) {
      statement = this.db.prepare<SqlRow, SQLQueryBindings[]>(query);
      this.#prepared.set(query, statement);
    }
    return statement;
  }
}

const ALL_TYPES: readonly Exclude<KeyType, "none">[] = ["string", "hash", "list", "set", "zset"];

const bytes = encodeUtf8;

const WRONGTYPE_MESSAGE = WRONGTYPE.kind === "error" ? WRONGTYPE.value : "";

let clock = 1_700_000_000_000;
let sql: FakeSqlStorage;
let store: Store;

beforeEach(() => {
  clock = 1_700_000_000_000;
  sql = new FakeSqlStorage();
  store = new Store(sql, () => clock);
});

const countRows = (table: string): number =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

const livePage = (page: ScanPage | typeof SCAN_CURSOR_EXPIRED): ScanPage => {
  if (page === SCAN_CURSOR_EXPIRED) throw new Error("scan reported an expired cursor");
  return page;
};

const redisErrorFrom = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (thrown) {
    if (thrown instanceof RedisError) {
      return thrown.reply.kind === "error" ? thrown.reply.value : "<not an error reply>";
    }
    throw thrown;
  }
};

describe("byte helpers", () => {
  test("asBytes accepts what SqlStorage actually returns", () => {
    const source = new Uint8Array([0, 1, 255, 128]);
    const buffer = source.buffer.slice(0) as ArrayBuffer;
    expect(Array.from(asBytes(buffer))).toEqual([0, 1, 255, 128]);
    expect(asBytes(source)).toBe(source);
    expect(() => asBytes("not a blob")).toThrow(TypeError);
  });

  test("byteKey is injective where String(bytes) is not", () => {
    expect(byteKey(new Uint8Array([1, 2]))).not.toBe(byteKey(new Uint8Array([1, 2, 0])));
    expect(String(new Uint8Array([1, 2]))).toBe(String([1, 2]));
    expect(byteKey(new Uint8Array([0xff, 0x00]))).toHaveLength(2);
  });
});

describe("type directory", () => {
  test("an untracked key is none", () => {
    expect(store.typeOf(bytes("nope"))).toBe("none");
  });

  test("track then typeOf round-trips every type", () => {
    for (const type of ALL_TYPES) {
      const key = bytes(`k:${type}`);
      store.track(key, type);
      expect(store.typeOf(key)).toBe(type);
    }
  });

  test("expectType reports existence and raises WRONGTYPE on every mismatched pair", () => {
    let pairs = 0;
    for (const held of ALL_TYPES) {
      const key = bytes(`k:${held}`);
      store.track(key, held);
      expect(store.expectType(key, held)).toBe(true);

      for (const want of ALL_TYPES) {
        if (want === held) continue;
        expect(redisErrorFrom(() => store.expectType(key, want))).toBe(WRONGTYPE_MESSAGE);
        pairs += 1;
      }
    }
    expect(pairs).toBe(20);
  });

  test("expectType on an absent key is false, not an error", () => {
    expect(store.expectType(bytes("ghost"), "zset")).toBe(false);
  });
});

describe("lazy expiry", () => {
  test("a key past its deadline reports none and leaves nothing behind", () => {
    const key = bytes("doomed");
    store.track(key, "string");
    sql.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("v"));
    expect(store.expireAt(key, clock + 1_000)).toBe(true);

    clock += 999;
    expect(store.typeOf(key)).toBe("string");

    clock += 1;
    expect(store.typeOf(key)).toBe("none");
    expect(countRows(TABLE_META)).toBe(0);
    expect(countRows(TABLE_STRING)).toBe(0);
  });

  test("a deadline that has exactly arrived counts as passed", () => {
    const key = bytes("edge");
    store.track(key, "string");
    store.expireAt(key, clock + 100);
    clock += 100;
    expect(store.typeOf(key)).toBe("none");
  });

  test("every reader routes through typeOf, so none of them can see a dead key", () => {
    const key = bytes("doomed");
    store.track(key, "hash");
    store.expireAt(key, clock + 10);
    clock += 10;

    expect(store.expectType(key, "hash")).toBe(false);
    expect(store.drop(key)).toBe(false);
    expect(store.ttlMs(key)).toBeNull();
    expect(store.persist(key)).toBe(false);
    expect(store.expireAt(key, clock + 5_000)).toBe(false);
    expect(store.dbsize()).toBe(0);
    expect(livePage(store.scan(0, 100)).keys).toHaveLength(0);
    expect(countRows(TABLE_META)).toBe(0);
  });

  test("a deadline already in the past deletes immediately but still answers 1", () => {
    const key = bytes("now");
    store.track(key, "list");
    expect(store.expireAt(key, clock - 1)).toBe(true);
    expect(countRows(TABLE_META)).toBe(0);
  });

  test("track refreshes the type without disturbing the TTL", () => {
    const key = bytes("ttl");
    store.track(key, "list");
    store.expireAt(key, clock + 5_000);
    store.track(key, "list");
    expect(store.ttlMs(key)).toBe(5_000);
  });

  test("track on a stale directory row does not inherit its dead deadline", () => {
    const key = bytes("reborn");
    store.track(key, "string");
    store.expireAt(key, clock + 100);
    clock += 100;

    store.track(key, "set");
    expect(store.typeOf(key)).toBe("set");
    expect(store.ttlMs(key)).toBeNull();
  });

  test("ttlMs and persist", () => {
    const key = bytes("p");
    store.track(key, "string");
    expect(store.ttlMs(key)).toBeNull();
    expect(store.persist(key)).toBe(false);

    store.expireAt(key, clock + 2_500);
    expect(store.ttlMs(key)).toBe(2_500);
    clock += 500;
    expect(store.ttlMs(key)).toBe(2_000);

    expect(store.persist(key)).toBe(true);
    expect(store.ttlMs(key)).toBeNull();
    expect(store.persist(key)).toBe(false);

    store.expireAt(key, clock + 10);
    expect(store.expireAt(key, null)).toBe(true);
    expect(store.ttlMs(key)).toBeNull();
  });

  test("ttlMs cannot distinguish a missing key from an immortal one", () => {
    store.track(bytes("immortal"), "string");
    expect(store.ttlMs(bytes("immortal"))).toBeNull();
    expect(store.ttlMs(bytes("absent"))).toBeNull();
  });
});

describe("nextExpiry and sweep", () => {
  test("nextExpiry is the earliest pending deadline, or null", () => {
    expect(store.nextExpiry()).toBeNull();

    store.track(bytes("a"), "string");
    store.track(bytes("b"), "string");
    store.track(bytes("c"), "string");
    store.expireAt(bytes("a"), clock + 3_000);
    store.expireAt(bytes("b"), clock + 1_000);
    expect(store.nextExpiry()).toBe(clock + 1_000);

    store.persist(bytes("b"));
    expect(store.nextExpiry()).toBe(clock + 3_000);
    store.persist(bytes("a"));
    expect(store.nextExpiry()).toBeNull();
  });

  test("sweep deletes exactly the keys due at or before the given instant", () => {
    for (let i = 0; i < 6; i += 1) {
      const key = bytes(`s:${i}`);
      store.track(key, "set");
      sql.exec(`INSERT INTO ${TABLE_SET} (key, member) VALUES (?, ?)`, key, bytes("m"));
      store.expireAt(key, clock + 1_000 * (i + 1));
    }

    expect(store.sweep(clock)).toBe(0);
    expect(store.sweep(clock + 3_000)).toBe(3);
    expect(countRows(TABLE_META)).toBe(3);
    expect(countRows(TABLE_SET)).toBe(3);

    clock += 100_000;
    expect(store.sweep()).toBe(3);
    expect(countRows(TABLE_META)).toBe(0);
  });

  test("sweep leaves immortal keys alone", () => {
    store.track(bytes("forever"), "string");
    store.track(bytes("fleeting"), "string");
    store.expireAt(bytes("fleeting"), clock + 1);
    expect(store.sweep(clock + 10_000)).toBe(1);
    expect(store.typeOf(bytes("forever"))).toBe("string");
  });
});

describe("drop and dropIfEmpty", () => {
  test("drop removes rows from every type table the key could own", () => {
    const key = bytes("multi");
    store.track(key, "hash");
    sql.exec(
      `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
      key,
      bytes("f"),
      bytes("v"),
    );
    sql.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("stale"));

    expect(store.drop(key)).toBe(true);
    expect(store.drop(key)).toBe(false);
    expect(store.typeOf(key)).toBe("none");
    expect(countRows(TABLE_HASH)).toBe(0);
    expect(countRows(TABLE_STRING)).toBe(0);
  });

  test("dropIfEmpty keeps a non-empty collection and deletes an emptied one", () => {
    const key = bytes("s");
    store.track(key, "set");
    sql.exec(`INSERT INTO ${TABLE_SET} (key, member) VALUES (?, ?)`, key, bytes("a"));
    sql.exec(`INSERT INTO ${TABLE_SET} (key, member) VALUES (?, ?)`, key, bytes("b"));

    sql.exec(`DELETE FROM ${TABLE_SET} WHERE key = ? AND member = ?`, key, bytes("a"));
    store.dropIfEmpty(key, "set");
    expect(store.typeOf(key)).toBe("set");

    sql.exec(`DELETE FROM ${TABLE_SET} WHERE key = ? AND member = ?`, key, bytes("b"));
    store.dropIfEmpty(key, "set");
    expect(store.typeOf(key)).toBe("none");
    expect(countRows(TABLE_META)).toBe(0);
  });

  test("dropIfEmpty only inspects the table for the type it is given", () => {
    const key = bytes("h");
    store.track(key, "hash");
    sql.exec(
      `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
      key,
      bytes("f"),
      bytes("v"),
    );
    store.dropIfEmpty(key, "hash");
    expect(store.typeOf(key)).toBe("hash");
    store.dropIfEmpty(key, "none");
    expect(store.typeOf(key)).toBe("hash");
  });
});

describe("globToRegExp", () => {
  const matches = (pattern: string, subject: string): boolean =>
    globToRegExp(pattern).test(subject);

  test("star and question mark", () => {
    expect(matches("*", "")).toBe(true);
    expect(matches("*", "anything at all")).toBe(true);
    expect(matches("h?llo", "hello")).toBe(true);
    expect(matches("h?llo", "hllo")).toBe(false);
    expect(matches("h?llo", "heello")).toBe(false);
    expect(matches("h*llo", "hllo")).toBe(true);
    expect(matches("h*llo", "heeeeello")).toBe(true);
    expect(matches("h*llo", "hello world")).toBe(false);
    expect(matches("*:*", "user:1")).toBe(true);
  });

  test("star and question mark span newlines, as Redis's byte matcher does", () => {
    expect(matches("a*b", "a\nb")).toBe(true);
    expect(matches("a?b", "a\nb")).toBe(true);
  });

  test("regex metacharacters are literals", () => {
    expect(matches("a.c", "abc")).toBe(false);
    expect(matches("a.c", "a.c")).toBe(true);
    expect(matches("a+", "aaa")).toBe(false);
    expect(matches("a+", "a+")).toBe(true);
    expect(matches("(x)", "(x)")).toBe(true);
    expect(matches("a{2}", "aa")).toBe(false);
    expect(matches("a|b", "a")).toBe(false);
    expect(matches("a|b", "a|b")).toBe(true);
    expect(matches("^a$", "^a$")).toBe(true);
  });

  test("character classes", () => {
    expect(matches("h[ae]llo", "hello")).toBe(true);
    expect(matches("h[ae]llo", "hallo")).toBe(true);
    expect(matches("h[ae]llo", "hillo")).toBe(false);
    expect(matches("h[^e]llo", "hallo")).toBe(true);
    expect(matches("h[^e]llo", "hello")).toBe(false);
    expect(matches("h[a-c]llo", "hbllo")).toBe(true);
    expect(matches("h[a-c]llo", "hdllo")).toBe(false);
    expect(matches("[a-c][0-9]", "b7")).toBe(true);
  });

  test("a reversed range is normalised, not rejected", () => {
    expect(matches("h[c-a]llo", "hbllo")).toBe(true);
    expect(matches("h[c-a]llo", "hdllo")).toBe(false);
  });

  test("an empty class matches nothing; a negated empty class matches anything", () => {
    expect(matches("h[]llo", "hello")).toBe(false);
    expect(matches("h[]llo", "hllo")).toBe(false);
    expect(matches("h[^]llo", "hxllo")).toBe(true);
    expect(matches("h[^]llo", "hllo")).toBe(false);
  });

  test("an unterminated class runs to the end of the pattern", () => {
    expect(matches("h[ae", "ha")).toBe(true);
    expect(matches("h[ae", "he")).toBe(true);
    expect(matches("h[ae", "hi")).toBe(false);
  });

  test("backslash escapes, inside and outside a class", () => {
    expect(matches("\\*", "*")).toBe(true);
    expect(matches("\\*", "anything")).toBe(false);
    expect(matches("\\?", "?")).toBe(true);
    expect(matches("\\[a\\]", "[a]")).toBe(true);
    expect(matches("[\\]]", "]")).toBe(true);
    expect(matches("[\\^a]", "^")).toBe(true);
    expect(matches("[\\^a]", "a")).toBe(true);
    expect(matches("a\\", "a\\")).toBe(true);
  });

  test("a leading hyphen is a class member", () => {
    expect(matches("a-b", "a-b")).toBe(true);
    expect(matches("[-a]", "-")).toBe(true);
    expect(matches("[-a]", "a")).toBe(true);
  });

  test("a trailing hyphen is a range against the closing bracket, as in Redis", () => {
    expect(matches("[a-]", "-")).toBe(false);
    expect(matches("[a-]", "a")).toBe(true);
    expect(matches("[a-]", "]")).toBe(true);
    expect(matches("[a-]", "_")).toBe(true);
    expect(matches("[a-]", "b")).toBe(false);
  });
});

describe("matchGlob", () => {
  const raw = (...values: number[]): Uint8Array => Uint8Array.from(values);

  test("bytes that decode to the same replacement character stay distinct", () => {
    expect(matchGlob(raw(0xff), raw(0xff))).toBe(true);
    expect(matchGlob(raw(0xff), raw(0xfe))).toBe(false);
    expect(matchGlob(raw(0xfe), raw(0xff))).toBe(false);
  });

  test("a class of invalid bytes selects only its own members", () => {
    expect(matchGlob(raw(0x5b, 0xfe, 0x5d), raw(0xfe))).toBe(true);
    expect(matchGlob(raw(0x5b, 0xfe, 0x5d), raw(0xff))).toBe(false);
    expect(matchGlob(raw(0x5b, 0x80, 0x2d, 0x8f, 0x5d), raw(0x85))).toBe(true);
    expect(matchGlob(raw(0x5b, 0x80, 0x2d, 0x8f, 0x5d), raw(0x90))).toBe(false);
  });

  test("? matches one byte, not one code point", () => {
    const euro = bytes("\u20ac");
    expect(euro).toHaveLength(3);
    expect(matchGlob(bytes("?"), euro)).toBe(false);
    expect(matchGlob(bytes("??"), euro)).toBe(false);
    expect(matchGlob(bytes("???"), euro)).toBe(true);
  });

  test("* spans whole bytes of a multi-byte character", () => {
    expect(matchGlob(bytes("a*b"), bytes("a\u20acb"))).toBe(true);
    expect(matchGlob(bytes("a*"), raw(0x61, 0xff, 0x00))).toBe(true);
  });

  test("a pathological star pattern finishes promptly instead of backtracking", () => {
    const pattern = bytes("a*a*a*a*a*a*a*b");
    const subject = bytes("a".repeat(50_000));
    const startedAt = performance.now();
    expect(matchGlob(pattern, subject)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("a pattern longer than the bound is refused rather than matched", () => {
    const oversized = bytes("a".repeat(MAX_GLOB_PATTERN_BYTES + 1));
    expect(() => matchGlob(oversized, bytes("a"))).toThrow(RedisError);
    expect(matchGlob(bytes("a".repeat(MAX_GLOB_PATTERN_BYTES)), bytes("a"))).toBe(false);
  });
});

describe("scan", () => {
  const seed = (count: number, prefix = "key"): void => {
    for (let i = 0; i < count; i += 1) store.track(bytes(`${prefix}:${i}`), "string");
  };

  const scanFrom = (start: number, page: number, match?: string, type?: KeyType) => {
    const keys: string[] = [];
    let cursor = start;
    let calls = 0;
    do {
      const result = livePage(store.scan(cursor, page, match, type));
      cursor = result.cursor;
      for (const key of result.keys) keys.push(byteKey(key));
      calls += 1;
      if (calls > 10_000) throw new Error("scan did not terminate");
    } while (cursor !== 0);
    return { keys, calls };
  };

  const fullScan = (page: number, match?: string, type?: KeyType) =>
    scanFrom(0, page, match, type);

  test("an empty database finishes in one call", () => {
    expect(store.scan(0, 10)).toEqual({ cursor: 0, keys: [] });
  });

  test("500 keys in pages of 10: every key exactly once, no duplicates, no misses", () => {
    seed(500);
    const { keys, calls } = fullScan(10);

    expect(keys).toHaveLength(500);
    expect(new Set(keys).size).toBe(500);
    const expected = new Set(Array.from({ length: 500 }, (_, i) => byteKey(bytes(`key:${i}`))));
    expect(new Set(keys)).toEqual(expected);
    expect(calls).toBe(51);
    expect(countRows(TABLE_SCAN_CURSOR)).toBe(0);
  });

  test("a page larger than the database finishes immediately", () => {
    seed(7);
    const result = livePage(store.scan(0, 100));
    expect(result.cursor).toBe(0);
    expect(result.keys).toHaveLength(7);
  });

  test("the empty key is reachable even though it sorts before every other key", () => {
    store.track(new Uint8Array(0), "string");
    seed(3);
    const { keys } = fullScan(2);
    expect(keys).toContain("");
    expect(keys).toHaveLength(4);
  });

  test("MATCH compares pattern bytes against key bytes", () => {
    const high = new Uint8Array([0xff]);
    const lower = new Uint8Array([0xfe]);
    store.track(high, "string");
    store.track(lower, "string");
    const page = livePage(store.scan(0, 100, high));
    expect(page.keys.map(byteKey)).toEqual([byteKey(high)]);
  });

  test("binary keys survive the round trip", () => {
    const binary = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    store.track(binary, "zset");
    const { keys } = fullScan(10);
    expect(keys).toContain(byteKey(binary));
  });

  test("MATCH filters the page without stalling the iteration", () => {
    seed(100, "user");
    seed(100, "post");
    const { keys } = fullScan(10, "user:*");
    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100);
  });

  test("COUNT bounds work examined, not results returned, so empty pages are legal", () => {
    seed(200, "aaa");
    store.track(bytes("zzz:only"), "string");
    const { keys, calls } = fullScan(10, "zzz:*");
    expect(keys).toEqual([byteKey(bytes("zzz:only"))]);
    expect(calls).toBeGreaterThan(20);
  });

  test("TYPE filters by key type", () => {
    for (let i = 0; i < 20; i += 1) {
      store.track(bytes(`t:${i}`), i % 2 === 0 ? "list" : "hash");
    }
    expect(fullScan(3, undefined, "list").keys).toHaveLength(10);
    expect(fullScan(3, undefined, "hash").keys).toHaveLength(10);
    expect(fullScan(3, "t:1?", "hash").keys).toHaveLength(5);
  });

  test("expired keys are collected mid-iteration and never reported", () => {
    seed(30);
    for (let i = 0; i < 30; i += 2) store.expireAt(bytes(`key:${i}`), clock + 1_000);
    clock += 1_000;

    const { keys } = fullScan(4);
    expect(keys).toHaveLength(15);
    expect(countRows(TABLE_META)).toBe(15);
  });

  test("a live iteration holds exactly one cursor row", () => {
    seed(25);
    const first = livePage(store.scan(0, 10));
    expect(first.cursor).not.toBe(0);
    expect(countRows(TABLE_SCAN_CURSOR)).toBe(1);
    scanFrom(first.cursor, 10);
    expect(countRows(TABLE_SCAN_CURSOR)).toBe(0);
  });

  test("an abandoned cursor is reported as expired, not as a completed iteration", () => {
    seed(50);
    const first = livePage(store.scan(0, 10));
    expect(first.cursor).not.toBe(0);

    clock += 61_000;
    store.scan(0, 10);

    expect(store.scan(first.cursor, 10)).toBe(SCAN_CURSOR_EXPIRED);
  });

  test("a cursor the server never issued completes, as it does on real Redis", () => {
    seed(50);
    expect(store.scan(999_999, 10)).toEqual({ cursor: 0, keys: [] });
  });

  test("an evicted cursor stays distinguishable from a never-issued one", () => {
    seed(50);
    const first = livePage(store.scan(0, 10));
    clock += 61_000;
    store.scan(0, 10);

    expect(store.scan(first.cursor, 10)).toBe(SCAN_CURSOR_EXPIRED);
    expect(store.scan(999_999, 10)).toEqual({ cursor: 0, keys: [] });
  });

  test("a cursor invalidated by flush is reported as expired", () => {
    seed(50);
    const first = livePage(store.scan(0, 10));
    store.flush();
    expect(store.scan(first.cursor, 10)).toBe(SCAN_CURSOR_EXPIRED);
  });

  test("a cursor id is never reissued, even after every cursor is gone", () => {
    seed(50);
    const seen = new Set<number>();
    for (let round = 0; round < 5; round += 1) {
      const first = livePage(store.scan(0, 10)).cursor;
      expect(seen.has(first)).toBe(false);
      seen.add(first);
      scanFrom(first, 10);
      expect(countRows(TABLE_SCAN_CURSOR)).toBe(0);
    }
    expect(seen.size).toBe(5);
  });

  test("a cursor id survives a flush without being reissued", () => {
    seed(50);
    const first = livePage(store.scan(0, 10)).cursor;
    store.flush();
    seed(50);
    expect(livePage(store.scan(0, 10)).cursor).not.toBe(first);
  });

  test("returning to a live cursor after a long pause still works", () => {
    seed(50);
    const first = livePage(store.scan(0, 10));
    clock += 61_000;
    expect(livePage(store.scan(first.cursor, 10)).keys).toHaveLength(10);
  });

  test("two interleaved iterations do not share a position", () => {
    seed(40);
    const a1 = livePage(store.scan(0, 10));
    const b1 = livePage(store.scan(0, 10));
    expect(a1.cursor).not.toBe(b1.cursor);

    const a2 = livePage(store.scan(a1.cursor, 10));
    const b2 = livePage(store.scan(b1.cursor, 10));
    expect(a2.keys.map(byteKey)).toEqual(b2.keys.map(byteKey));
  });

  test("keys inserted behind the cursor are not revisited", () => {
    seed(20);
    const first = livePage(store.scan(0, 5));
    store.track(bytes("aaa"), "string");
    expect(scanFrom(first.cursor, 5).keys).not.toContain(byteKey(bytes("aaa")));
  });
});

describe("whole-database operations", () => {
  test("dbsize counts live keys only", () => {
    expect(store.dbsize()).toBe(0);
    for (let i = 0; i < 5; i += 1) store.track(bytes(`d:${i}`), "string");
    expect(store.dbsize()).toBe(5);

    store.expireAt(bytes("d:0"), clock + 100);
    expect(store.dbsize()).toBe(5);
    clock += 100;
    expect(store.dbsize()).toBe(4);
  });

  test("flush empties every table, cursors included", () => {
    for (let i = 0; i < 20; i += 1) {
      const key = bytes(`f:${i}`);
      store.track(key, "hash");
      sql.exec(
        `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
        key,
        bytes("a"),
        bytes("b"),
      );
    }
    store.scan(0, 5);

    store.flush();
    expect(store.dbsize()).toBe(0);
    expect(countRows(TABLE_META)).toBe(0);
    expect(countRows(TABLE_HASH)).toBe(0);
    expect(countRows(TABLE_SCAN_CURSOR)).toBe(0);
    expect(store.nextExpiry()).toBeNull();
  });

  test("a second Store over the same database sees the same data", () => {
    store.track(bytes("shared"), "list");
    const other = new Store(sql, () => clock);
    expect(other.typeOf(bytes("shared"))).toBe("list");
  });
});

const VALUE_COLUMNS: Readonly<Record<Exclude<KeyType, "none">, readonly string[]>> = {
  string: ["val"],
  hash: ["field", "val"],
  set: ["member"],
  list: ["seq", "val"],
  zset: ["member", "score"],
};

const VALUE_BINDINGS: Readonly<Record<Exclude<KeyType, "none">, readonly SqlBinding[]>> = {
  string: [bytes("v")],
  hash: [bytes("f"), bytes("v")],
  set: [bytes("m")],
  list: [1, bytes("v")],
  zset: [bytes("m"), 1],
};

const insertValueRow = (key: Uint8Array, type: Exclude<KeyType, "none">): void => {
  const columns = VALUE_COLUMNS[type];
  const placeholders = new Array(columns.length + 1).fill("?").join(", ");
  sql.exec(
    `INSERT INTO ${TYPE_TABLE[type]} (key, ${columns.join(", ")}) VALUES (${placeholders})`,
    key,
    ...VALUE_BINDINGS[type],
  );
};

const storeStringIn = (storage: FakeSqlStorage, key: Uint8Array, value: Uint8Array): void => {
  storage.exec(
    `INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET val = excluded.val`,
    key,
    value,
  );
};

const storeString = (key: Uint8Array, value: Uint8Array): void => {
  store.track(key, "string");
  storeStringIn(sql, key, value);
};

const touchedAtIn = (storage: FakeSqlStorage, key: Uint8Array): number | null =>
  storage
    .exec<{ touched_at: number | null }>(
      `SELECT touched_at FROM ${TABLE_META} WHERE key = ?`,
      key,
    )
    .toArray()[0]?.touched_at ?? null;

const touchedAt = (key: Uint8Array): number | null => touchedAtIn(sql, key);

const setTouchedAt = (key: Uint8Array, at: number | null): void => {
  sql.exec(`UPDATE ${TABLE_META} SET touched_at = ? WHERE key = ?`, at, key);
};

const setCardinality = (key: Uint8Array, card: number | null): void => {
  sql.exec(`UPDATE ${TABLE_META} SET card = ? WHERE key = ?`, card, key);
};

const storedCardinality = (key: Uint8Array): number | null =>
  sql
    .exec<{ card: number | null }>(`SELECT card FROM ${TABLE_META} WHERE key = ?`, key)
    .toArray()[0]?.card ?? null;


describe("value tiers", () => {
  test("a key is hot the moment it is tracked, and owes nothing to R2", () => {
    const key = bytes("t:new");
    store.track(key, "string");
    expect(store.tierOf(key)).toBe("hot");
    expect(store.r2VersionOf(key)).toBeNull();
  });

  test("hot to warm to cold: the value leaves SQLite, the metadata does not", () => {
    const key = bytes("t:cycle");
    storeString(key, bytes("payload"));

    store.markWarm(key, "v-1");
    expect(store.tierOf(key)).toBe("warm");
    expect(store.r2VersionOf(key)).toBe("v-1");
    expect(countRows(TABLE_STRING)).toBe(1);

    store.markCold(key);
    expect(store.tierOf(key)).toBe("cold");
    expect(store.r2VersionOf(key)).toBe("v-1");
    expect(countRows(TABLE_STRING)).toBe(0);
    expect(store.typeOf(key)).toBe("string");
    expect(store.ttlMs(key)).toBeNull();
    expect(store.dbsize()).toBe(1);
  });

  test("a key that cycles without being written keeps the copy it already uploaded", () => {
    const key = bytes("t:free");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");
    store.markCold(key);

    sql.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("payload"));
    store.markWarm(key, "v-1");
    expect(store.tierOf(key)).toBe("warm");

    store.markCold(key);
    expect(store.tierOf(key)).toBe("cold");
    expect(store.r2VersionOf(key)).toBe("v-1");
  });

  test("markHot is what makes an uploaded copy stale", () => {
    const key = bytes("t:stale");
    storeString(key, bytes("first"));
    store.markWarm(key, "v-1");

    store.markHot(key);
    expect(store.tierOf(key)).toBe("hot");
    expect(store.r2VersionOf(key)).toBeNull();
  });

  test("markCold refuses a hot key rather than delete a value R2 does not have", () => {
    const key = bytes("t:hot");
    storeString(key, bytes("payload"));
    expect(() => store.markCold(key)).toThrow(/only a warm key/);
    expect(store.tierOf(key)).toBe("hot");
    expect(countRows(TABLE_STRING)).toBe(1);
  });

  test("markCold refuses a key whose upload was invalidated before it ran", () => {
    const key = bytes("t:raced");
    storeString(key, bytes("first"));
    store.markWarm(key, "v-1");
    storeString(key, bytes("second"));
    expect(() => store.markCold(key)).toThrow(/only a warm key/);
    expect(countRows(TABLE_STRING)).toBe(1);
  });

  test("marking a cold key cold again changes nothing", () => {
    const key = bytes("t:twice");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");
    store.markCold(key);
    store.markCold(key);
    expect(store.tierOf(key)).toBe("cold");
    expect(store.r2VersionOf(key)).toBe("v-1");
  });

  test("marking a key that does not exist is a no-op, not a phantom meta row", () => {
    const ghost = bytes("t:ghost");
    store.markHot(ghost);
    store.markWarm(ghost, "v-1");
    store.markCold(ghost);
    expect(countRows(TABLE_META)).toBe(0);
    expect(store.tierOf(ghost)).toBe("hot");
    expect(store.r2VersionOf(ghost)).toBeNull();
  });

  test("markWarm without a version is refused: warm without one cannot be faulted in", () => {
    const key = bytes("t:noversion");
    storeString(key, bytes("payload"));
    expect(() => store.markWarm(key, "")).toThrow(/version/);
    expect(store.tierOf(key)).toBe("hot");
  });

  test("an expired key reports hot, which is the tier that owes R2 nothing", () => {
    const key = bytes("t:expired");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");
    store.expireAt(key, clock + 10);
    clock += 10;
    expect(store.tierOf(key)).toBe("hot");
    expect(countRows(TABLE_META)).toBe(0);
  });

  test("a tier this version does not recognise reads as hot", () => {
    const key = bytes("t:unknown");
    storeString(key, bytes("payload"));
    sql.exec(`UPDATE ${TABLE_META} SET tier = ?, r2_version = ? WHERE key = ?`, "lukewarm", "v-1", key);
    expect(store.tierOf(key)).toBe("hot");
    expect(() => store.markCold(key)).toThrow(/only a warm key/);
  });

  test("writing a value row in any table invalidates the uploaded copy", () => {
    for (const type of ALL_TYPES) {
      const key = bytes(`t:write:${type}`);
      store.track(key, type);
      store.markWarm(key, "v-1");
      expect(store.tierOf(key)).toBe("warm");

      insertValueRow(key, type);
      expect(store.tierOf(key)).toBe("hot");
      expect(store.r2VersionOf(key)).toBeNull();
    }
  });

  test("deleting a value row invalidates the uploaded copy as surely as writing one", () => {
    for (const type of ALL_TYPES) {
      const key = bytes(`t:delete:${type}`);
      store.track(key, type);
      insertValueRow(key, type);
      store.markWarm(key, "v-1");

      sql.exec(`DELETE FROM ${TYPE_TABLE[type]} WHERE key = ?`, key);
      expect(store.tierOf(key)).toBe("hot");
      expect(store.r2VersionOf(key)).toBeNull();
    }
  });

  test("moving value rows to another key invalidates both ends", () => {
    const from = bytes("t:from");
    const to = bytes("t:to");
    storeString(from, bytes("payload"));
    store.track(to, "string");
    store.markWarm(from, "v-from");
    store.markWarm(to, "v-to");

    sql.exec(`UPDATE ${TABLE_STRING} SET key = ? WHERE key = ?`, to, from);
    expect(store.tierOf(from)).toBe("hot");
    expect(store.tierOf(to)).toBe("hot");
  });

  test("track marks a warm key hot, so an overwrite can never be evicted as free", () => {
    const key = bytes("t:track");
    storeString(key, bytes("first"));
    store.markWarm(key, "v-1");
    store.track(key, "string");
    expect(store.tierOf(key)).toBe("hot");
    expect(store.r2VersionOf(key)).toBeNull();
  });

  test("reading a warm key leaves it warm", () => {
    const key = bytes("t:read");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");

    expect(store.typeOf(key)).toBe("string");
    expect(store.expectType(key, "string")).toBe(true);
    expect(store.dbsize()).toBe(1);
    livePage(store.scan(0, 100));
    store.touch(key, clock);
    expect(store.tierOf(key)).toBe("warm");
    expect(store.r2VersionOf(key)).toBe("v-1");
  });

  test("a TTL is metadata, not value, so it does not invalidate the copy", () => {
    const key = bytes("t:ttl");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");

    store.expireAt(key, clock + 60_000);
    expect(store.tierOf(key)).toBe("warm");
    store.persist(key);
    expect(store.tierOf(key)).toBe("warm");
    expect(store.r2VersionOf(key)).toBe("v-1");
  });

  test("drop takes the tier state with the key", () => {
    const key = bytes("t:dropped");
    storeString(key, bytes("payload"));
    store.markWarm(key, "v-1");
    store.markCold(key);

    expect(store.drop(key)).toBe(true);
    expect(countRows(TABLE_META)).toBe(0);
    expect(store.tierOf(key)).toBe("hot");
    expect(store.r2VersionOf(key)).toBeNull();

    store.track(key, "string");
    expect(store.tierOf(key)).toBe("hot");
    expect(store.r2VersionOf(key)).toBeNull();
  });

  test("dropIfEmpty does not mistake a cold key for an empty one", () => {
    const key = bytes("t:coldset");
    store.track(key, "set");
    insertValueRow(key, "set");
    store.markWarm(key, "v-1");
    store.markCold(key);

    store.dropIfEmpty(key, "set");
    expect(store.typeOf(key)).toBe("set");
    expect(store.tierOf(key)).toBe("cold");

    store.markHot(key);
    store.dropIfEmpty(key, "set");
    expect(store.typeOf(key)).toBe("none");
  });

  test("sweep and flush leave no tier state behind", () => {
    const swept = bytes("t:swept");
    const flushed = bytes("t:flushed");
    storeString(swept, bytes("payload"));
    storeString(flushed, bytes("payload"));
    store.markWarm(swept, "v-1");
    store.markCold(swept);
    store.markWarm(flushed, "v-2");

    store.expireAt(swept, clock + 10);
    clock += 10;
    expect(store.sweep()).toBe(1);
    expect(store.tierOf(swept)).toBe("hot");

    store.flush();
    expect(countRows(TABLE_META)).toBe(0);
    expect(store.tierOf(flushed)).toBe("hot");
  });
});

describe("touch sampling", () => {
  test("the first touch of a key that has never been touched is always recorded", () => {
    const key = bytes("u:first");
    store.track(key, "string");
    setTouchedAt(key, null);

    store.touch(key, clock);
    expect(touchedAt(key)).toBe(clock);
  });

  test("a read does not become a write on every access", () => {
    const key = bytes("u:sampled");
    store.track(key, "string");
    const ticks = 320;
    let recorded = 0;

    for (let tick = 0; tick < ticks; tick += 1) {
      clock += TOUCH_CLOCK_RESOLUTION_MS;
      const before = touchedAt(key);
      store.touch(key, clock);
      if (touchedAt(key) !== before) recorded += 1;
    }

    const expected = ticks / TOUCH_SAMPLE_ONE_IN;
    expect(recorded).toBeGreaterThan(expected / 4);
    expect(recorded).toBeLessThan(expected * 4);
  });

  test("about one key in TOUCH_SAMPLE_ONE_IN is recorded within a single tick", () => {
    const population = 2_000;
    let recorded = 0;

    for (let i = 0; i < population; i += 1) {
      const key = bytes(`u:pop:${i}`);
      store.track(key, "string");
      setTouchedAt(key, clock - 10 * TOUCH_CLOCK_RESOLUTION_MS);
      store.touch(key, clock);
      if (touchedAt(key) === clock) recorded += 1;
    }

    const expected = population / TOUCH_SAMPLE_ONE_IN;
    expect(recorded).toBeGreaterThan(expected / 2);
    expect(recorded).toBeLessThan(expected * 2);
  });

  test("repeated touches inside one clock tick write at most once", () => {
    const key = bytes("u:burst");
    store.track(key, "string");

    let recordedAt: number | null = null;
    for (let tick = 0; tick < TOUCH_SAMPLE_ONE_IN * 4 && recordedAt === null; tick += 1) {
      clock += TOUCH_CLOCK_RESOLUTION_MS;
      const before = touchedAt(key);
      store.touch(key, clock);
      if (touchedAt(key) !== before) recordedAt = touchedAt(key);
    }
    expect(recordedAt).toBe(clock);

    for (let again = 0; again < 50; again += 1) {
      store.touch(key, clock + again);
    }
    expect(touchedAt(key)).toBe(recordedAt);
  });

  test("sampling is a function of the key and the injected clock, so it never flakes", () => {
    const run = (): (number | null)[] => {
      const storage = new FakeSqlStorage();
      const fresh = new Store(storage, () => clock);
      const key = bytes("u:deterministic");
      fresh.track(key, "string");

      const seen: (number | null)[] = [];
      let when = 1_800_000_000_000;
      for (let tick = 0; tick < 64; tick += 1) {
        when += TOUCH_CLOCK_RESOLUTION_MS;
        fresh.touch(key, when);
        seen.push(touchedAtIn(storage, key));
      }
      return seen;
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  test("touching a key that is not there writes nothing", () => {
    store.touch(bytes("u:ghost"), clock);
    expect(countRows(TABLE_META)).toBe(0);
  });
});

describe("eviction candidates", () => {
  const trackedAt = (name: string, at: number | null, type: KeyType = "string"): Uint8Array => {
    const key = bytes(name);
    store.track(key, type);
    setTouchedAt(key, at);
    return key;
  };

  test("the least recently touched key comes first", () => {
    trackedAt("e:middle", clock - 5_000);
    trackedAt("e:oldest", clock - 90_000);
    trackedAt("e:newest", clock);

    expect(store.evictionCandidates(10).map((c) => byteKey(c.key))).toEqual([
      byteKey(bytes("e:oldest")),
      byteKey(bytes("e:middle")),
      byteKey(bytes("e:newest")),
    ]);
  });

  test("a key that has never been touched is the oldest thing there is", () => {
    trackedAt("e:recent", clock);
    trackedAt("e:never", null);
    expect(byteKey(store.evictionCandidates(1)[0]!.key)).toBe(byteKey(bytes("e:never")));
  });

  test("cold keys are never candidates: their value is already gone", () => {
    const cold = trackedAt("e:cold", clock - 90_000);
    insertValueRow(cold, "string");
    store.markWarm(cold, "v-1");
    store.markCold(cold);
    const warm = trackedAt("e:warm", clock - 1_000);
    store.markWarm(warm, "v-2");
    trackedAt("e:hot", clock);

    const candidates = store.evictionCandidates(10);
    expect(candidates.map((c) => byteKey(c.key))).toEqual([
      byteKey(bytes("e:warm")),
      byteKey(bytes("e:hot")),
    ]);
    expect(candidates.map((c) => c.tier)).toEqual(["warm", "hot"]);
  });

  test("a key that has already expired is not worth uploading", () => {
    const doomed = trackedAt("e:doomed", clock - 90_000);
    store.expireAt(doomed, clock + 10);
    trackedAt("e:live", clock);

    expect(store.evictionCandidates(10)).toHaveLength(2);
    clock += 10;
    expect(store.evictionCandidates(10).map((c) => byteKey(c.key))).toEqual([
      byteKey(bytes("e:live")),
    ]);
  });

  test("the limit bounds the page, and asking for none returns none", () => {
    for (let i = 0; i < 10; i += 1) trackedAt(`e:many:${i}`, clock - i * 1_000);
    expect(store.evictionCandidates(3)).toHaveLength(3);
    expect(store.evictionCandidates(0)).toHaveLength(0);
    expect(store.evictionCandidates(-5)).toHaveLength(0);
  });

  test("bytes estimates what evicting the key would actually free", () => {
    const value = new Uint8Array(1_000);
    const string = bytes("e:string");
    storeString(string, value);
    setTouchedAt(string, clock - 90_000);

    const set = trackedAt("e:set", clock - 80_000, "set");
    setCardinality(set, 10);

    const byName = new Map(store.evictionCandidates(10).map((c) => [byteKey(c.key), c.bytes]));
    expect(byName.get(byteKey(string))).toBe(string.length + value.length);
    expect(byName.get(byteKey(set))).toBe(10 * (set.length + ESTIMATED_BYTES_PER_ELEMENT));
  });

  test("an uncounted collection is counted, not reported as empty", () => {
    const hash = trackedAt("e:uncounted", clock - 70_000, "hash");
    for (const field of ["a", "b", "c"]) {
      sql.exec(
        `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
        hash,
        bytes(field),
        bytes("v"),
      );
    }
    setCardinality(hash, null);

    const candidate = store.evictionCandidates(10)[0]!;
    expect(candidate.bytes).toBe(3 * (hash.length + ESTIMATED_BYTES_PER_ELEMENT));
    expect(storedCardinality(hash)).toBe(3);
  });

  test("the count a sweep repairs is remembered, so the next sweep is free", () => {
    const counted = new CountingSqlStorage();
    const sweeping = new Store(counted, () => clock);
    const hash = bytes("e:repaired");
    sweeping.track(hash, "hash");
    counted.exec(
      `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
      hash,
      bytes("a"),
      bytes("v"),
    );
    counted.exec(
      `UPDATE ${TABLE_META} SET card = NULL, touched_at = ? WHERE key = ?`,
      clock - 70_000,
      hash,
    );

    expect(sweeping.evictionCandidates(10)[0]!.bytes).toBe(
      hash.length + ESTIMATED_BYTES_PER_ELEMENT,
    );

    const from = counted.statements.length;
    sweeping.evictionCandidates(10);
    expect(
      counted.statements.slice(from).filter((query) => query.includes("COUNT(*)")),
    ).toHaveLength(0);
  });

  test("a cardinality that is already known is trusted, not recounted", () => {
    const set = trackedAt("e:counted", clock - 70_000, "set");
    insertValueRow(set, "set");
    setCardinality(set, 10);

    expect(store.evictionCandidates(10)[0]!.bytes).toBe(
      10 * (set.length + ESTIMATED_BYTES_PER_ELEMENT),
    );
    expect(storedCardinality(set)).toBe(10);
  });

  test("a candidate carries the type, deadline and idle time the planner needs", () => {
    for (const type of ALL_TYPES) {
      const key = trackedAt(`e:shape:${type}`, clock - 1_000, type);
      store.expireAt(key, clock + 60_000);
    }
    const untouched = bytes("e:shape:untouched");
    store.track(untouched, "string");
    setTouchedAt(untouched, null);

    const byName = new Map(store.evictionCandidates(10).map((c) => [byteKey(c.key), c]));
    for (const type of ALL_TYPES) {
      const candidate = byName.get(byteKey(bytes(`e:shape:${type}`)))!;
      expect(candidate.type).toBe(type);
      expect(candidate.ttlMs).toBe(60_000);
      expect(candidate.idleMs).toBe(1_000);
    }

    const never = byName.get(byteKey(untouched))!;
    expect(never.ttlMs).toBeNull();
    expect(never.idleMs).toBe(Number.POSITIVE_INFINITY);
  });

  test("the expiry horizon drops keys that are about to free themselves", () => {
    const soon = trackedAt("e:soon", clock - 90_000);
    store.expireAt(soon, clock + 60_000);
    const later = trackedAt("e:later", clock - 80_000);
    store.expireAt(later, clock + 600_000);
    const forever = trackedAt("e:forever", clock - 70_000);

    expect(store.evictionCandidates(10).map((c) => byteKey(c.key))).toEqual([
      byteKey(soon),
      byteKey(later),
      byteKey(forever),
    ]);
    expect(store.evictionCandidates(10, 300_000).map((c) => byteKey(c.key))).toEqual([
      byteKey(later),
      byteKey(forever),
    ]);
  });
});

describe("database size", () => {
  test("databaseBytes grows as rows are written", () => {
    const empty = store.databaseBytes();
    expect(empty).toBeGreaterThan(0);

    const value = new Uint8Array(4_000);
    for (let i = 0; i < 200; i += 1) storeString(bytes(`z:${i}`), value);
    expect(store.databaseBytes()).toBeGreaterThan(empty);
  });

  test("a storage adapter that cannot report its size reports zero rather than a guess", () => {
    const sizeless: SqlStorage = {
      exec: <T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]) =>
        sql.exec<T>(query, ...bindings),
    };
    expect(new Store(sizeless, () => clock).databaseBytes()).toBe(0);
  });
});

describe("schema migration", () => {
  const oldDatabase = (columns: string): FakeSqlStorage => {
    const storage = new FakeSqlStorage();
    storage.db.run(
      `CREATE TABLE ${TABLE_META} (key BLOB PRIMARY KEY, type TEXT NOT NULL, expire_at INTEGER${columns}) WITHOUT ROWID`,
    );
    storage.exec(
      `INSERT INTO ${TABLE_META} (key, type, expire_at) VALUES (?, ?, NULL)`,
      bytes("old"),
      "string",
    );
    return storage;
  };

  test("a database written before the cold tier keeps its keys and reads as hot", () => {
    const storage = oldDatabase("");
    const migrated = new Store(storage, () => clock);

    expect(migrated.typeOf(bytes("old"))).toBe("string");
    expect(migrated.tierOf(bytes("old"))).toBe("hot");
    expect(migrated.r2VersionOf(bytes("old"))).toBeNull();
    expect(migrated.evictionCandidates(10).map((c) => byteKey(c.key))).toEqual([
      byteKey(bytes("old")),
    ]);
  });

  test("a column that is already there does not stop the columns behind it", () => {
    const storage = oldDatabase(", card INTEGER");
    const migrated = new Store(storage, () => clock);

    expect(migrated.tierOf(bytes("old"))).toBe("hot");
    migrated.touch(bytes("old"), clock);
    expect(touchedAtIn(storage, bytes("old"))).toBe(clock);

    storeStringIn(storage, bytes("old"), bytes("payload"));
    migrated.markWarm(bytes("old"), "v-1");
    migrated.markCold(bytes("old"));
    expect(migrated.tierOf(bytes("old"))).toBe("cold");
  });

  test("applying the schema twice over a live database changes nothing", () => {
    storeString(bytes("m:key"), bytes("payload"));
    store.markWarm(bytes("m:key"), "v-1");

    const second = new Store(sql, () => clock);
    expect(second.tierOf(bytes("m:key"))).toBe("warm");
    expect(second.r2VersionOf(bytes("m:key"))).toBe("v-1");
    expect(countRows(TABLE_STRING)).toBe(1);
  });
});

class CountingSqlStorage implements SqlStorage {
  readonly inner = new FakeSqlStorage();
  readonly statements: string[] = [];

  get databaseSize(): number {
    return this.inner.databaseSize;
  }

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    this.statements.push(query);
    return this.inner.exec<T>(query, ...bindings);
  }
}

describe("meta memo", () => {
  let counted: CountingSqlStorage;
  let memoized: Store;

  beforeEach(() => {
    counted = new CountingSqlStorage();
    memoized = new Store(counted, () => clock);
  });

  const mark = (): number => counted.statements.length;

  const since = (from: number): string[] => counted.statements.slice(from);

  const metaReads = (from: number): number =>
    since(from).filter((query) => query.includes("SELECT type, expire_at")).length;

  const agreesWithStorage = (key: Uint8Array): void => {
    const unmemoized = new Store(counted, () => clock);
    expect(memoized.typeOf(key)).toBe(unmemoized.typeOf(key));
    expect(memoized.deadlineOf(key)).toBe(unmemoized.deadlineOf(key));
    expect(memoized.ttlMs(key)).toBe(unmemoized.ttlMs(key));
  };

  test("reading one key repeatedly in one tick reads meta once", () => {
    const key = bytes("m:repeat");
    memoized.track(key, "string");
    clock += 1;

    const from = mark();
    expect(memoized.typeOf(key)).toBe("string");
    expect(memoized.typeOf(key)).toBe("string");
    expect(memoized.expectType(key, "string")).toBe(true);
    expect(memoized.ttlMs(key)).toBeNull();
    expect(metaReads(from)).toBe(1);
  });

  test("the write path reads meta once where it used to read it four times", () => {
    const key = bytes("m:write");
    memoized.track(key, "string");
    clock += 1;

    const from = mark();
    memoized.typeOf(key);
    counted.exec(
      `INSERT OR REPLACE INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`,
      key,
      bytes("v"),
    );
    memoized.track(key, "string");
    memoized.persist(key);

    expect(metaReads(from)).toBe(1);
    expect(since(from)).toHaveLength(3);
  });

  test("the clock moving on drops the memo", () => {
    const key = bytes("m:tick");
    memoized.track(key, "string");
    clock += 1;

    const from = mark();
    memoized.typeOf(key);
    memoized.typeOf(key);
    expect(metaReads(from)).toBe(1);

    clock += 1;
    memoized.typeOf(key);
    expect(metaReads(from)).toBe(2);
  });

  test("a memoized key cannot outlive its deadline", () => {
    const key = bytes("m:doomed");
    memoized.track(key, "string");
    counted.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("v"));
    memoized.expireAt(key, clock + 10);
    expect(memoized.typeOf(key)).toBe("string");

    clock += 10;
    expect(memoized.typeOf(key)).toBe("none");
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_STRING}`).one().n).toBe(0);
  });

  test("every Store mutation leaves the memo agreeing with the table", () => {
    const key = bytes("m:agree");
    memoized.track(key, "string");
    agreesWithStorage(key);

    memoized.expireAt(key, clock + 5_000);
    agreesWithStorage(key);

    memoized.persist(key);
    agreesWithStorage(key);

    memoized.expireAt(key, clock + 5_000);
    memoized.track(key, "hash");
    agreesWithStorage(key);
    expect(memoized.ttlMs(key)).toBe(5_000);

    memoized.markWarm(key, "v-1");
    agreesWithStorage(key);

    memoized.drop(key);
    agreesWithStorage(key);

    memoized.track(key, "set");
    memoized.flush();
    agreesWithStorage(key);
  });

  test("a meta row deleted behind Store's back is not served from the memo after a track", () => {
    const from = bytes("m:from");
    const to = bytes("m:to");
    memoized.track(from, "string");
    expect(memoized.typeOf(from)).toBe("string");

    counted.exec(`DELETE FROM ${TABLE_META} WHERE key = ?`, from);
    memoized.track(to, "string");

    expect(memoized.typeOf(from)).toBe("none");
  });

  test("untrack drops the metadata and the memo with it", () => {
    const key = bytes("m:untrack");
    memoized.track(key, "string");
    expect(memoized.typeOf(key)).toBe("string");

    memoized.untrack(key);
    expect(memoized.typeOf(key)).toBe("none");
    expect(memoized.dbsize()).toBe(0);
  });

  test("forget sends the next read back to the table", () => {
    const key = bytes("m:forget");
    memoized.track(key, "string");
    expect(memoized.typeOf(key)).toBe("string");

    counted.exec(`UPDATE ${TABLE_META} SET type = ? WHERE key = ?`, "hash", key);
    expect(memoized.typeOf(key)).toBe("string");

    memoized.forget(key);
    expect(memoized.typeOf(key)).toBe("hash");
  });

  test("the tier is never memoized, because a trigger can change it", () => {
    const key = bytes("m:tier");
    memoized.track(key, "string");
    memoized.typeOf(key);
    memoized.markWarm(key, "v-1");
    expect(memoized.tierOf(key)).toBe("warm");

    counted.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("v"));
    expect(memoized.tierOf(key)).toBe("hot");
    expect(memoized.r2VersionOf(key)).toBeNull();
  });

  test("keys do not share the memo with one another", () => {
    const a = bytes("m:a");
    const b = bytes("m:b");
    memoized.track(a, "string");
    memoized.track(b, "hash");

    expect(memoized.typeOf(a)).toBe("string");
    expect(memoized.typeOf(b)).toBe("hash");
    expect(memoized.typeOf(a)).toBe("string");
    expect(memoized.typeOf(b)).toBe("hash");
  });

  test("the same key in a different array is a miss, never a stale answer", () => {
    const key = bytes("m:copy");
    memoized.track(key, "string");
    memoized.typeOf(key);

    const from = mark();
    expect(memoized.typeOf(bytes("m:copy"))).toBe("string");
    expect(metaReads(from)).toBe(1);
  });

  test("persist on a key with no deadline costs nothing", () => {
    const key = bytes("m:persist");
    memoized.track(key, "string");

    const from = mark();
    expect(memoized.persist(key)).toBe(false);
    expect(since(from)).toHaveLength(0);
  });

  test("persist still clears a deadline it can see", () => {
    const key = bytes("m:clear");
    memoized.track(key, "string");
    memoized.expireAt(key, clock + 5_000);

    expect(memoized.persist(key)).toBe(true);
    expect(memoized.persist(key)).toBe(false);
    agreesWithStorage(key);
    expect(memoized.ttlMs(key)).toBeNull();
  });
});

describe("purging only the tables a key can own", () => {
  let counted: CountingSqlStorage;
  let purging: Store;

  beforeEach(() => {
    counted = new CountingSqlStorage();
    purging = new Store(counted, () => clock);
  });

  const deletesSince = (from: number): string[] =>
    counted.statements.slice(from).filter((query) => query.startsWith("DELETE"));

  test("a healthy key is not deleted from four tables it cannot own", () => {
    const key = bytes("p:string");
    purging.track(key, "string");
    counted.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("v"));

    const from = counted.statements.length;
    expect(purging.drop(key)).toBe(true);

    const deletes = deletesSince(from);
    expect(deletes).toHaveLength(2);
    expect(deletes.some((query) => query.includes(TABLE_META))).toBe(true);
    expect(deletes.some((query) => query.includes(TABLE_STRING))).toBe(true);
    for (const table of [TABLE_HASH, TABLE_SET]) {
      expect(deletes.some((query) => query.includes(table))).toBe(false);
    }
  });

  test("a stray row in another table is still found and removed", () => {
    const key = bytes("p:stray");
    purging.track(key, "hash");
    counted.exec(
      `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
      key,
      bytes("f"),
      bytes("v"),
    );
    counted.exec(`INSERT INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes("stale"));

    expect(purging.drop(key)).toBe(true);
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_STRING}`).one().n).toBe(0);
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_HASH}`).one().n).toBe(0);
  });

  test("a type this version cannot place is purged from every table", () => {
    const key = bytes("p:unknown");
    purging.track(key, "string");
    counted.exec(`INSERT INTO ${TABLE_SET} (key, member) VALUES (?, ?)`, key, bytes("m"));
    counted.exec(`UPDATE ${TABLE_META} SET type = ? WHERE key = ?`, "quantum", key);
    purging.forget(key);

    expect(purging.drop(key)).toBe(true);
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_SET}`).one().n).toBe(0);
  });

  test("an expiry sweep purges by type too", () => {
    const key = bytes("p:swept");
    purging.track(key, "list");
    counted.exec(`INSERT INTO ${TABLE_LIST} (key, seq, val) VALUES (?, ?, ?)`, key, 1, bytes("v"));
    purging.expireAt(key, clock + 10);
    clock += 10;

    const from = counted.statements.length;
    expect(purging.sweep()).toBe(1);
    expect(deletesSince(from)).toHaveLength(2);
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_LIST}`).one().n).toBe(0);
  });
});

describe("liveRow", () => {
  let counted: CountingSqlStorage;
  let reading: Store;

  const VALUE = `(SELECT val FROM ${TABLE_STRING} WHERE ${TABLE_STRING}.key = ${TABLE_META}.key) AS val`;

  beforeEach(() => {
    counted = new CountingSqlStorage();
    reading = new Store(counted, () => clock);
  });

  const write = (key: Uint8Array, value: string): void => {
    reading.track(key, "string");
    counted.exec(`INSERT OR REPLACE INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, bytes(value));
  };

  test("the metadata and the value arrive in one statement", () => {
    const key = bytes("l:one");
    write(key, "payload");
    clock += 1;

    const from = counted.statements.length;
    const row = reading.liveRow<{ val: SqlValue }>(key, VALUE);
    expect(row?.type).toBe("string");
    expect(asBytes(row!.val)).toEqual(bytes("payload"));
    expect(counted.statements.slice(from)).toHaveLength(1);
  });

  test("what it read is memoized, so a write that follows re-reads nothing", () => {
    const key = bytes("l:memo");
    write(key, "payload");
    clock += 1;

    const from = counted.statements.length;
    reading.liveRow<{ val: SqlValue }>(key, VALUE);
    expect(reading.typeOf(key)).toBe("string");
    expect(reading.ttlMs(key)).toBeNull();
    expect(
      counted.statements.slice(from).filter((query) => query.includes("SELECT type, expire_at")),
    ).toHaveLength(1);
  });

  test("an expired key is purged by the read, not merely hidden from it", () => {
    const key = bytes("l:expired");
    write(key, "payload");
    reading.expireAt(key, clock + 10);
    clock += 10;

    expect(reading.liveRow<{ val: SqlValue }>(key, VALUE)).toBeUndefined();
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_STRING}`).one().n).toBe(0);
    expect(counted.inner.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE_META}`).one().n).toBe(0);
  });

  test("a missing key answers undefined and is remembered as absent", () => {
    const key = bytes("l:ghost");
    expect(reading.liveRow<{ val: SqlValue }>(key, VALUE)).toBeUndefined();

    const from = counted.statements.length;
    expect(reading.typeOf(key)).toBe("none");
    expect(counted.statements.slice(from)).toHaveLength(0);
  });

  test("a wrong-type key still comes back, so the caller can raise WRONGTYPE", () => {
    const key = bytes("l:hash");
    reading.track(key, "hash");
    const row = reading.liveRow<{ val: SqlValue }>(key, VALUE);
    expect(row?.type).toBe("hash");
    expect(row?.val).toBeNull();
  });

  test("bindings for the extra columns come before the key", () => {
    const key = bytes("l:field");
    reading.track(key, "hash");
    counted.exec(
      `INSERT INTO ${TABLE_HASH} (key, field, val) VALUES (?, ?, ?)`,
      key,
      bytes("f"),
      bytes("v"),
    );

    const row = reading.liveRow<{ val: SqlValue }>(
      key,
      `(SELECT val FROM ${TABLE_HASH} WHERE ${TABLE_HASH}.key = ${TABLE_META}.key AND field = ?) AS val`,
      bytes("f"),
    );
    expect(asBytes(row!.val)).toEqual(bytes("v"));
  });
});
