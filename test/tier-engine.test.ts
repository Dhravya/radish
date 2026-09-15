import { beforeEach, describe, expect, test } from "bun:test";

import { FakeSqlStorage } from "./sqlite-adapter";
import type { SqlBinding, SqlCursor, SqlRow, SqlRowShape, SqlStorage, SqlValue } from "../src/schema";
import { Store } from "../src/store";
import { encodeUtf8 } from "../src/types";
import {
  COLD_OBJECT_PREFIX,
  inMemoryColdBucket,
  keyForObject,
  objectKeyFor,
  type InMemoryColdBucket,
} from "../src/tier/bucket";
import { TierCodecError } from "../src/tier/codec";
import { DEFAULT_POLICY, type PlannerPolicy } from "../src/tier/planner";
import {
  ColdKeyNotResident,
  ColdObjectMissing,
  assertFaultedIn,
  coldIndex,
  collectOrphans,
  faultIn,
  maintenanceGate,
  relievePressure,
  type TierDeps,
  type TierPolicy,
} from "../src/tier/engine";

const DATA_TABLE_DELETE = /^\s*DELETE FROM (?:str|hash|sett|list|zset)\b/i;

class TestSql implements SqlStorage {
  readonly inner = new FakeSqlStorage();
  bytes = 0;
  bytesPerEviction = 0;
  queries = 0;
  failOn: { pattern: RegExp; error: Error; remaining: number } | null = null;

  get databaseSize(): number {
    return this.bytes;
  }

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    this.queries += 1;
    const fault = this.failOn;
    if (fault !== null && fault.remaining > 0 && fault.pattern.test(query)) {
      fault.remaining -= 1;
      throw fault.error;
    }
    if (this.bytesPerEviction > 0 && DATA_TABLE_DELETE.test(query)) {
      this.bytes -= this.bytesPerEviction;
    }
    return this.inner.exec<T>(query, ...bindings);
  }

  failNext(pattern: RegExp, message: string): Error {
    const error = new Error(message);
    this.failOn = { pattern, error, remaining: 1 };
    return error;
  }

  healthy(): void {
    this.failOn = null;
  }
}

const NO_EVICTION: TierPolicy = {
  highWatermarkBytes: Number.MAX_SAFE_INTEGER,
  lowWatermarkBytes: Number.MAX_SAFE_INTEGER,
  maxEvictionsPerPass: 0,
};

const NO_SIZE_FLOOR: PlannerPolicy = { ...DEFAULT_POLICY, minEvictableBytes: 0 };

const EVICT_EVERYTHING: TierPolicy = {
  highWatermarkBytes: 0,
  lowWatermarkBytes: 0,
  maxEvictionsPerPass: 1024,
  planner: NO_SIZE_FLOOR,
};

const NOW_MS = 1_700_000_000_000;

let sql: TestSql;
let store: Store;
let bucket: InMemoryColdBucket;
let deps: TierDeps;

const atomically = <T>(run: () => T): T => {
  sql.inner.db.exec("BEGIN");
  try {
    const result = run();
    sql.inner.db.exec("COMMIT");
    return result;
  } catch (cause) {
    sql.inner.db.exec("ROLLBACK");
    throw cause;
  }
};

beforeEach(() => {
  sql = new TestSql();
  store = new Store(sql, () => NOW_MS);
  bucket = inMemoryColdBucket();
  deps = {
    store,
    bucket,
    index: coldIndex(),
    maintenance: maintenanceGate(),
    atomically,
    now: () => NOW_MS,
  };
  deps.index.prime([]);
  sql.bytes = 1;
});

const bytes = (...values: number[]): Uint8Array => Uint8Array.of(...values);

const key = (text: string): Uint8Array => encodeUtf8(text);

const puts = (): number => bucket.calls.filter((call) => call.op === "put").length;

const gets = (): number => bucket.calls.filter((call) => call.op === "get").length;

const seedString = (k: Uint8Array, value: Uint8Array): void => {
  store.track(k, "string");
  sql.exec(
    `INSERT INTO str (key, val) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val`,
    k,
    value,
  );
};

const seedHash = (k: Uint8Array, pairs: [Uint8Array, Uint8Array][]): void => {
  store.track(k, "hash");
  for (const [field, value] of pairs) {
    sql.exec(`INSERT INTO hash (key, field, val) VALUES (?, ?, ?)`, k, field, value);
  }
};

const seedSet = (k: Uint8Array, members: Uint8Array[]): void => {
  store.track(k, "set");
  for (const member of members) sql.exec(`INSERT INTO sett (key, member) VALUES (?, ?)`, k, member);
};

const seedList = (k: Uint8Array, entries: [number, Uint8Array][]): void => {
  store.track(k, "list");
  for (const [seq, value] of entries) {
    sql.exec(`INSERT INTO list (key, seq, val) VALUES (?, ?, ?)`, k, seq, value);
  }
};

const seedZset = (k: Uint8Array, entries: [Uint8Array, number][]): void => {
  store.track(k, "zset");
  for (const [member, score] of entries) {
    sql.exec(`INSERT INTO zset (key, member, score) VALUES (?, ?, ?)`, k, member, score);
  }
};

const VALUE_QUERY: Readonly<Record<string, string>> = {
  string: "SELECT val FROM str WHERE key = ? ORDER BY val",
  hash: "SELECT field, val FROM hash WHERE key = ? ORDER BY field",
  list: "SELECT seq, val FROM list WHERE key = ? ORDER BY seq",
  set: "SELECT member FROM sett WHERE key = ? ORDER BY member",
  zset: "SELECT member, score FROM zset WHERE key = ? ORDER BY member",
};

const cell = (value: SqlValue): string => {
  if (value === null) return "null";
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : `n${value}`;
  if (typeof value === "string") return `s${value}`;
  return `b${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const dump = (k: Uint8Array): string => {
  const type = store.typeOf(k);
  if (type === "none") return "none";
  const rows: string[] = [];
  for (const row of sql.exec(VALUE_QUERY[type]!, k).raw()) rows.push(row.map(cell).join(","));
  return `${type}|${rows.join(";")}`;
};

const touchedAt = (k: Uint8Array, at: number): void => {
  sql.exec(`UPDATE meta SET touched_at = ? WHERE key = ?`, at, k);
};

const evictAll = async (): Promise<void> => {
  await relievePressure(deps, EVICT_EVERYTHING);
};

describe("object names survive arbitrary binary keys", () => {
  test("every byte round trips through the object name", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    const name = objectKeyFor(all);
    expect(name.startsWith(COLD_OBJECT_PREFIX)).toBe(true);
    expect(keyForObject(name)).toEqual(all);
  });

  test("keys that differ only in their separators get different names", () => {
    expect(objectKeyFor(bytes(0x61, 0x2f, 0x62))).not.toBe(objectKeyFor(key("ab")));
    expect(objectKeyFor(key(""))).toBe(COLD_OBJECT_PREFIX);
    expect(keyForObject(COLD_OBJECT_PREFIX)).toEqual(new Uint8Array(0));
  });

  test("names that are not ours decode to nothing rather than a wrong key", () => {
    expect(keyForObject("notes/readme")).toBeNull();
    expect(keyForObject(`${COLD_OBJECT_PREFIX}abc`)).toBeNull();
    expect(keyForObject(`${COLD_OBJECT_PREFIX}zz`)).toBeNull();
  });
});

describe("hot to warm uploads before it records anything", () => {
  test("the put lands first and only then is the key warm", async () => {
    const k = key("alpha");
    seedString(k, key("one"));

    await evictAll();

    expect(bucket.objects.has(objectKeyFor(k))).toBe(true);
    expect(store.tierOf(k)).toBe("cold");
    expect(store.r2VersionOf(k)).toBe("v1");
  });

  test("a failed put leaves the key hot with its rows and no object", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    bucket.failAlways({ op: "put", error: new Error("R2 is down") });

    await expect(evictAll()).rejects.toThrow("R2 is down");

    expect(store.tierOf(k)).toBe("hot");
    expect(store.r2VersionOf(k)).toBeNull();
    expect(dump(k)).toBe("string|b6f6e65");
    expect(bucket.objects.size).toBe(0);
  });

  test("a failure after the put leaves a harmless orphan, not a warm key", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    sql.failNext(/UPDATE meta SET tier/i, "storage failed while recording the upload");

    await expect(evictAll()).rejects.toThrow("storage failed while recording the upload");

    expect(store.tierOf(k)).toBe("hot");
    expect(dump(k)).toBe("string|b6f6e65");
    expect(bucket.objects.size).toBe(1);

    sql.healthy();
    expect(await collectOrphans(deps)).toBe(1);
    expect(bucket.objects.size).toBe(0);
  });
});

describe("warm to cold is free", () => {
  test("a key that cycles without being written uploads exactly once", async () => {
    const k = key("alpha");
    seedString(k, key("one"));

    await evictAll();
    expect(puts()).toBe(1);

    await faultIn(deps, [k]);
    expect(store.tierOf(k)).toBe("warm");

    await evictAll();
    expect(puts()).toBe(1);
    expect(store.tierOf(k)).toBe("cold");
    expect(dump(k)).toBe("string|");
  });

  test("a failed eviction transaction leaves the key warm with its rows", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await faultIn(deps, [k]);

    sql.failNext(/DELETE FROM str/i, "storage failed mid eviction");
    await expect(evictAll()).rejects.toThrow("storage failed mid eviction");

    expect(store.tierOf(k)).toBe("warm");
    expect(dump(k)).toBe("string|b6f6e65");

    sql.healthy();
    await evictAll();
    expect(store.tierOf(k)).toBe("cold");
    expect(puts()).toBe(1);
  });
});

describe("cold to warm returns every type byte for byte", () => {
  test("a round trip preserves all five types exactly", async () => {
    const keys = [key("s"), key("h"), key("l"), key("t"), key("z")];
    seedString(keys[0]!, bytes(0x00, 0xff, 0x80, 0x0a));
    seedHash(keys[1]!, [
      [bytes(0x00), bytes(0xff)],
      [key("f"), key("")],
    ]);
    seedList(keys[2]!, [
      [-1.5, key("left")],
      [0, bytes(0x00, 0x01)],
      [2.25, key("right")],
    ]);
    seedSet(keys[3]!, [bytes(0xfe), key("m"), bytes(0x00, 0x00)]);
    seedZset(keys[4]!, [
      [key("a"), -0.5],
      [bytes(0xff), Number.MAX_SAFE_INTEGER],
      [key("c"), 0],
    ]);

    const before = keys.map(dump);

    await evictAll();
    for (const k of keys) expect(store.tierOf(k)).toBe("cold");

    await faultIn(deps, keys);

    expect(keys.map(dump)).toEqual(before);
    for (const k of keys) expect(store.tierOf(k)).toBe("warm");
  });

  test("a missing object is loud, never an empty key", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    bucket.forget(objectKeyFor(k));

    await expect(faultIn(deps, [k])).rejects.toBeInstanceOf(ColdObjectMissing);
    expect(store.tierOf(k)).toBe("cold");
    expect(dump(k)).toBe("string|");
  });

  test("a corrupt object refuses to decode and leaves the key cold", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await bucket.put(objectKeyFor(k), bytes(0x44, 0x4f, 0x52, 0x44, 0x09));

    await expect(faultIn(deps, [k])).rejects.toBeInstanceOf(TierCodecError);
    expect(store.tierOf(k)).toBe("cold");
    expect(dump(k)).toBe("string|");
  });

  test("a failed get leaves it cold and the retry succeeds", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();

    bucket.failNext({ op: "get", error: new Error("R2 read failed") });
    await expect(faultIn(deps, [k])).rejects.toThrow("R2 read failed");
    expect(store.tierOf(k)).toBe("cold");

    await faultIn(deps, [k]);
    expect(dump(k)).toBe("string|b6f6e65");
    expect(store.tierOf(k)).toBe("warm");
  });

  test("a failure inside the insert transaction rolls every row back", async () => {
    const k = key("h");
    seedHash(k, [
      [key("f1"), key("v1")],
      [key("f2"), key("v2")],
      [key("f3"), key("v3")],
    ]);
    await evictAll();

    sql.failNext(/INSERT INTO hash/i, "storage failed mid fault-in");
    await expect(faultIn(deps, [k])).rejects.toThrow("storage failed mid fault-in");

    sql.healthy();
    expect(store.tierOf(k)).toBe("cold");
    expect(dump(k)).toBe("hash|");

    await faultIn(deps, [k]);
    expect(dump(k)).toBe("hash|b6631,b7631;b6632,b7632;b6633,b7633");
  });
});

describe("a write to a warm key invalidates the R2 copy", () => {
  test("the write marks the key hot and drops the recorded version", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await faultIn(deps, [k]);
    expect(store.tierOf(k)).toBe("warm");

    seedString(k, key("two"));

    expect(store.tierOf(k)).toBe("hot");
    expect(store.r2VersionOf(k)).toBeNull();
  });

  test("a later fault-in can never resurrect the stale copy", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await faultIn(deps, [k]);
    seedString(k, key("two"));

    await evictAll();
    expect(puts()).toBe(2);
    expect(store.tierOf(k)).toBe("cold");

    await faultIn(deps, [k]);
    expect(dump(k)).toBe("string|b74776f");
  });

  test("while the fresh upload fails the key can never go cold", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await faultIn(deps, [k]);
    seedString(k, key("two"));

    bucket.failAlways({ op: "put", error: new Error("R2 is down") });
    await expect(evictAll()).rejects.toThrow("R2 is down");

    expect(store.tierOf(k)).toBe("hot");
    expect(dump(k)).toBe("string|b74776f");
    expect((await bucket.get(objectKeyFor(k)))?.version).toBe("v1");

    bucket.clearFaults();
    await evictAll();
    await faultIn(deps, [k]);
    expect(dump(k)).toBe("string|b74776f");
  });

  test("a write that lands during the upload abandons the promotion", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    sql.bytes = 1000;
    sql.bytesPerEviction = 100;

    let releasePut: (() => void) | null = null;
    const gated: TierDeps = {
      ...deps,
      bucket: {
        ...bucket,
        put: async (objectKey, payload) => {
          await new Promise<void>((resolve) => {
            releasePut = resolve;
          });
          return bucket.put(objectKey, payload);
        },
      },
    };

    const pass = relievePressure(gated, {
      highWatermarkBytes: 500,
      lowWatermarkBytes: 0,
      maxEvictionsPerPass: 1,
      planner: NO_SIZE_FLOOR,
    });
    while (releasePut === null) await new Promise((resolve) => setTimeout(resolve, 0));

    seedString(k, key("two"));
    (releasePut as () => void)();

    expect(await pass).toEqual({ promoted: 0, demoted: 0, bytesReclaimed: 0 });
    expect(store.tierOf(k)).toBe("hot");
    expect(dump(k)).toBe("string|b74776f");
    expect(await collectOrphans(gated)).toBe(1);
  });

  test("a cold key deleted before its fault-in is not resurrected", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();

    expect(store.drop(k)).toBe(true);
    bucket.calls.length = 0;

    await faultIn(deps, [k]);

    expect(gets()).toBe(0);
    expect(dump(k)).toBe("none");
    expect(await collectOrphans(deps)).toBe(1);
  });

  test("a write that reaches a cold key without faulting in is refused", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();

    expect(() => assertFaultedIn(deps, [key("other"), k])).toThrow(ColdKeyNotResident);
    expect(() => assertFaultedIn(deps, [key("other")])).not.toThrow();

    await faultIn(deps, [k]);
    expect(() => assertFaultedIn(deps, [k])).not.toThrow();
  });
});

describe("faultIn stays off the hot path", () => {
  test("resident keys cost no R2 call and no SQL", async () => {
    seedString(key("alpha"), key("one"));
    const before = sql.queries;

    await faultIn(deps, [key("alpha"), key("beta")]);

    expect(sql.queries).toBe(before);
    expect(bucket.calls).toHaveLength(0);
  });

  test("one cold key among many costs exactly one get", async () => {
    const cold = key("alpha");
    seedString(cold, key("one"));
    seedString(key("beta"), key("two"));
    await evictAll();
    seedString(key("beta"), key("two"));
    bucket.calls.length = 0;

    await faultIn(deps, [key("beta"), cold, cold, key("gamma")]);

    expect(gets()).toBe(1);
    expect(dump(cold)).toBe("string|b6f6e65");
  });

  test("without a primed index the store is consulted instead", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();

    const unprimed: TierDeps = { ...deps, index: coldIndex() };
    await faultIn(unprimed, [k]);

    expect(dump(k)).toBe("string|b6f6e65");
    expect(store.tierOf(k)).toBe("warm");
  });
});

const EVICTABLE_VALUE_BYTES = 8 * 1024;

const EVICTABLE_KEY_BYTES = 2;

const PER_KEY_BYTES = EVICTABLE_KEY_BYTES + EVICTABLE_VALUE_BYTES;

const MINUTE_MS = 60_000;

describe("relievePressure is bounded by its policy", () => {
  const seedTen = (): Uint8Array[] => {
    const keys: Uint8Array[] = [];
    for (let i = 0; i < 10; i += 1) {
      const k = key(`k${i}`);
      seedString(k, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x61 + i));
      touchedAt(k, NOW_MS - (10 - i) * MINUTE_MS);
      keys.push(k);
    }
    sql.bytes = 10 * PER_KEY_BYTES;
    sql.bytesPerEviction = PER_KEY_BYTES;
    return keys;
  };

  test("nothing happens below the high watermark", async () => {
    seedTen();
    const pass = await relievePressure(deps, {
      highWatermarkBytes: 20 * PER_KEY_BYTES,
      lowWatermarkBytes: 10 * PER_KEY_BYTES,
      maxEvictionsPerPass: 10,
    });

    expect(pass).toEqual({ promoted: 0, demoted: 0, bytesReclaimed: 0 });
    expect(bucket.calls).toHaveLength(0);
  });

  test("eviction stops as soon as the low watermark is reached", async () => {
    const keys = seedTen();
    const pass = await relievePressure(deps, {
      highWatermarkBytes: 9 * PER_KEY_BYTES,
      lowWatermarkBytes: 6 * PER_KEY_BYTES,
      maxEvictionsPerPass: 10,
    });

    expect(pass.demoted).toBe(4);
    expect(pass.promoted).toBe(4);
    expect(pass.bytesReclaimed).toBe(4 * PER_KEY_BYTES);
    expect(sql.bytes).toBe(6 * PER_KEY_BYTES);
    expect(store.tierOf(keys[0]!)).toBe("cold");
    expect(store.tierOf(keys[9]!)).toBe("hot");
  });

  test("the least recently touched keys go first", async () => {
    const keys = seedTen();
    touchedAt(keys[7]!, NOW_MS - 60 * MINUTE_MS);

    await relievePressure(deps, {
      highWatermarkBytes: 9 * PER_KEY_BYTES,
      lowWatermarkBytes: 8 * PER_KEY_BYTES,
      maxEvictionsPerPass: 10,
    });

    expect(store.tierOf(keys[7]!)).toBe("cold");
    expect(store.tierOf(keys[1]!)).toBe("hot");
  });

  test("a pass never exceeds its eviction bound", async () => {
    seedTen();
    const pass = await relievePressure(deps, {
      highWatermarkBytes: 9 * PER_KEY_BYTES,
      lowWatermarkBytes: 0,
      maxEvictionsPerPass: 3,
    });

    expect(pass.demoted).toBe(3);
    expect(puts()).toBe(3);
    expect(sql.bytes).toBe(7 * PER_KEY_BYTES);
  });

  test("a zero budget does nothing at all", async () => {
    seedTen();
    expect(await relievePressure(deps, { ...NO_EVICTION, highWatermarkBytes: 0 })).toEqual({
      promoted: 0,
      demoted: 0,
      bytesReclaimed: 0,
    });
    expect(bucket.calls).toHaveLength(0);
  });
});

describe("orphan collection never takes an object a key still needs", () => {
  test("cold keys keep their objects, everything else is reclaimed", async () => {
    const cold = key("cold");
    const hot = key("hot");
    seedString(cold, key("one"));
    await evictAll();
    seedString(hot, key("two"));
    await bucket.put(objectKeyFor(hot), bytes(0x00));
    await bucket.put(objectKeyFor(key("deleted")), bytes(0x00));
    await bucket.put(`${COLD_OBJECT_PREFIX}notahexname`, bytes(0x00));
    await bucket.put("notes/readme", bytes(0x00));

    expect(await collectOrphans(deps)).toBe(2);

    expect(bucket.objects.has(objectKeyFor(cold))).toBe(true);
    expect(bucket.objects.has(objectKeyFor(hot))).toBe(false);
    expect(bucket.objects.has(`${COLD_OBJECT_PREFIX}notahexname`)).toBe(true);
    expect(bucket.objects.has("notes/readme")).toBe(true);

    await faultIn(deps, [cold]);
    expect(dump(cold)).toBe("string|b6f6e65");
  });

  test("a warm key keeps the object it may still fall back on", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    await evictAll();
    await faultIn(deps, [k]);

    expect(await collectOrphans(deps)).toBe(0);
    expect(bucket.objects.has(objectKeyFor(k))).toBe(true);
  });

  test("collection cannot interleave with an eviction pass", async () => {
    const k = key("alpha");
    seedString(k, key("one"));
    sql.bytes = 1000;
    sql.bytesPerEviction = 100;
    bucket.latencyMs = 1;

    const pass = relievePressure(deps, {
      highWatermarkBytes: 500,
      lowWatermarkBytes: 0,
      maxEvictionsPerPass: 4,
      planner: NO_SIZE_FLOOR,
    });
    const collected = collectOrphans(deps);

    await pass;
    expect(await collected).toBe(0);
    expect(store.tierOf(k)).toBe("cold");

    bucket.latencyMs = 0;
    await faultIn(deps, [k]);
    expect(dump(k)).toBe("string|b6f6e65");
  });
});

describe("the planner decides what is worth evicting", () => {
  const UNDER_PRESSURE: TierPolicy = {
    highWatermarkBytes: 0,
    lowWatermarkBytes: 0,
    maxEvictionsPerPass: 10,
    planner: DEFAULT_POLICY,
  };

  test("a key smaller than one round trip is left alone", async () => {
    const k = key("tiny");
    seedString(k, key("one"));
    sql.bytes = 100_000;

    const pass = await relievePressure(deps, UNDER_PRESSURE);

    expect(pass.demoted).toBe(0);
    expect(puts()).toBe(0);
    expect(store.tierOf(k)).toBe("hot");
  });

  test("a collection of unknown size is measured, never skipped", async () => {
    const k = key("ks");
    const members: Uint8Array[] = [];
    for (let i = 0; i < 100; i += 1) members.push(key(`member-${i}`));
    seedSet(k, members);
    touchedAt(k, NOW_MS - 60 * MINUTE_MS);
    sql.bytes = 100_000;

    expect(sql.exec(`SELECT card FROM meta WHERE key = ?`, k).one().card).toBeNull();

    const pass = await relievePressure(deps, UNDER_PRESSURE);

    expect(store.tierOf(k)).toBe("cold");
    expect(pass.demoted).toBe(1);
    expect(pass.bytesReclaimed).toBeGreaterThan(DEFAULT_POLICY.minEvictableBytes);
  });

  test("a key expiring inside the ttl horizon frees itself", async () => {
    const expiring = key("e");
    const lasting = key("l");
    seedString(expiring, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x61));
    seedString(lasting, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x62));
    store.expireAt(expiring, NOW_MS + MINUTE_MS);
    touchedAt(expiring, NOW_MS - 60 * MINUTE_MS);
    touchedAt(lasting, NOW_MS - MINUTE_MS);
    sql.bytes = 100_000;

    await relievePressure(deps, UNDER_PRESSURE);

    expect(store.tierOf(expiring)).toBe("hot");
    expect(store.tierOf(lasting)).toBe("cold");
  });

  test("every free eviction happens before any upload", async () => {
    const warm = key("W");
    const hot = key("H");
    seedString(warm, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x61));
    await evictAll();
    await faultIn(deps, [warm]);
    expect(store.tierOf(warm)).toBe("warm");

    seedString(hot, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x62));
    touchedAt(hot, NOW_MS - 600 * MINUTE_MS);
    touchedAt(warm, NOW_MS - MINUTE_MS);
    const uploadsBefore = puts();
    sql.bytes = 5_000;
    sql.bytesPerEviction = 5_000;

    const pass = await relievePressure(deps, UNDER_PRESSURE);

    expect(pass).toEqual({
      promoted: 0,
      demoted: 1,
      bytesReclaimed: warm.length + EVICTABLE_VALUE_BYTES,
    });
    expect(puts()).toBe(uploadsBefore);
    expect(store.tierOf(warm)).toBe("cold");
    expect(store.tierOf(hot)).toBe("hot");
  });
});

describe("a never touched key ranks as maximally idle", () => {
  test("an infinite idle time evicts rather than producing a broken score", async () => {
    const migrated = key("m");
    const recent = key("r");
    seedString(migrated, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x61));
    seedString(recent, new Uint8Array(EVICTABLE_VALUE_BYTES).fill(0x62));
    sql.exec(`UPDATE meta SET touched_at = NULL WHERE key = ?`, migrated);
    touchedAt(recent, NOW_MS - MINUTE_MS);
    sql.bytes = 100_000;
    sql.bytesPerEviction = 100_000;

    const candidates = store.evictionCandidates(10, 0);
    expect(candidates.find((row) => row.key.length === 1 && row.key[0] === 0x6d)?.idleMs).toBe(
      Number.POSITIVE_INFINITY,
    );

    const pass = await relievePressure(deps, {
      highWatermarkBytes: 0,
      lowWatermarkBytes: 0,
      maxEvictionsPerPass: 10,
      planner: DEFAULT_POLICY,
    });

    expect(pass.demoted).toBe(1);
    expect(pass.bytesReclaimed).toBeGreaterThan(0);
    expect(Number.isNaN(pass.bytesReclaimed)).toBe(false);
    expect(store.tierOf(migrated)).toBe("cold");
    expect(store.tierOf(recent)).toBe("hot");
  });
});
