import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  StorageFailure,
  dispatch,
  dispatchOutsideTransaction,
  registry,
} from "../src/commands";
import { PROTO_MAX_BULK_LEN } from "../src/errors";
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
import { type Command, type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import { FakeSqlStorage } from "./sqlite-adapter";

const CLOUDFLARE_MAX_BOUND_PARAMETERS = 100;
const CLOUDFLARE_MAX_STATEMENT_BYTES = 100_000;

class InjectedStorageFailure extends Error {
  constructor(readonly query: string) {
    super(`injected storage failure on: ${query}`);
    this.name = "InjectedStorageFailure";
  }
}

class FaultInjectingSqlStorage implements SqlStorage {
  readonly inner = new FakeSqlStorage();
  readonly statements: { query: string; bindings: number }[] = [];
  #failing: RegExp | null = null;

  failOn(pattern: RegExp): void {
    this.#failing = pattern;
  }

  repair(): void {
    this.#failing = null;
  }

  get widestStatement(): number {
    return Math.max(0, ...this.statements.map((entry) => entry.bindings));
  }

  get longestStatement(): number {
    return Math.max(0, ...this.statements.map((entry) => entry.query.length));
  }

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    if (this.#failing !== null && this.#failing.test(query)) {
      throw new InjectedStorageFailure(query);
    }
    this.statements.push({ query, bindings: bindings.length });
    return this.inner.exec<T>(query, ...bindings);
  }
}

const argv = (parts: readonly (string | Uint8Array)[]): Command =>
  parts.map((part) => (part instanceof Uint8Array ? part : encodeUtf8(part)));

let sql: FaultInjectingSqlStorage;
let ctx: Ctx;

const run = (...parts: (string | Uint8Array)[]): Reply => dispatch(ctx, argv(parts));
const text = (reply: Reply): string =>
  reply.kind === "bulk" ? decodeUtf8(reply.value) : `<${reply.kind}:${String("value" in reply ? reply.value : "")}>`;
const members = (reply: Reply): string[] =>
  reply.kind === "set" || reply.kind === "array" ? reply.value.map(text).sort() : [text(reply)];

const transactionSync = <T>(body: () => T): T => {
  sql.inner.db.exec("BEGIN");
  try {
    const result = body();
    sql.inner.db.exec("COMMIT");
    return result;
  } catch (cause) {
    sql.inner.db.exec("ROLLBACK");
    throw cause;
  }
};

beforeEach(() => {
  sql = new FaultInjectingSqlStorage();
  applySchema(sql);
  ctx = {
    store: new Store(sql),
    sql,
    now: Date.now(),
    conn: { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false },
    commands: registry,
  };
});

describe("a failed write never destroys what it was replacing", () => {
  test("SET keeps the old string when its insert fails", () => {
    run("SET", "k", "old");

    sql.failOn(/INSERT OR REPLACE INTO str/);
    expect(() => run("SET", "k", "replacement")).toThrow(StorageFailure);
    sql.repair();

    expect(text(run("GET", "k"))).toBe("old");
    expect(text(run("TYPE", "k"))).toBe("<simple:string>");
  });

  test("SET over another type keeps that type when its insert fails", () => {
    run("SADD", "s", "x");

    sql.failOn(/INSERT OR REPLACE INTO str/);
    expect(() => run("SET", "s", "replacement")).toThrow(StorageFailure);
    sql.repair();

    expect(text(run("TYPE", "s"))).toBe("<simple:set>");
    expect(members(run("SMEMBERS", "s"))).toEqual(["x"]);
  });

  test("APPEND keeps the old string when its update fails", () => {
    run("SET", "k", "old");

    sql.failOn(/UPDATE str/);
    expect(() => run("APPEND", "k", "-more")).toThrow(StorageFailure);
    sql.repair();

    expect(text(run("GET", "k"))).toBe("old");
  });

  test("a value past the storage limit is refused before anything is written", () => {
    run("SET", "k", "old");
    const oversized = new Uint8Array(PROTO_MAX_BULK_LEN + 1);

    const refusal = run("SET", "k", oversized);
    expect(refusal.kind).toBe("error");
    expect(text(run("GET", "k"))).toBe("old");
    expect(run("SET", "k", new Uint8Array(PROTO_MAX_BULK_LEN)).kind).toBe("simple");
  });

  test("an ordinary command error stays a reply and does not propagate", () => {
    run("SET", "k", "not-a-number");
    const reply = run("INCR", "k");
    expect(reply.kind).toBe("error");
    expect(text(run("GET", "k"))).toBe("not-a-number");
  });

  test("outside a transaction an infrastructure failure becomes an internal error reply", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    run("SET", "k", "old");

    sql.failOn(/INSERT OR REPLACE INTO str/);
    const reply = dispatchOutsideTransaction(ctx, argv(["SET", "k", "replacement"]));
    sql.repair();
    logged.mockRestore();

    expect(reply).toEqual({ kind: "error", value: "ERR internal error" });
    expect(text(run("GET", "k"))).toBe("old");
  });
});

describe("an enclosing transaction sees the failure it needs to roll back", () => {
  test("an infrastructure failure rolls the whole transaction back", () => {
    run("SET", "k", "old");

    expect(() =>
      transactionSync(() => {
        dispatch(ctx, argv(["SET", "sibling", "written"]));
        sql.failOn(/INSERT OR REPLACE INTO str/);
        dispatch(ctx, argv(["SET", "k", "replacement"]));
      }),
    ).toThrow(StorageFailure);
    sql.repair();

    expect(text(run("GET", "k"))).toBe("old");
    expect(run("GET", "sibling").kind).toBe("null");
  });

  test("an ordinary command error preserves its successful siblings", () => {
    const replies = transactionSync(() => [
      dispatch(ctx, argv(["SET", "sibling", "written"])),
      dispatch(ctx, argv(["INCR", "sibling"])),
    ]);

    expect(replies[1]?.kind).toBe("error");
    expect(text(run("GET", "sibling"))).toBe("written");
  });
});

describe("set algebra stays inside the platform's SQL limits", () => {
  const operands = (count: number, prefix: string): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);

  const fill = (keys: readonly string[], shared: string): void => {
    for (const [i, key] of keys.entries()) run("SADD", key, shared, `only-${i}`);
  };

  test("150 operands never exceed 100 bound parameters or a 100 KB statement", () => {
    const keys = operands(150, "s");
    fill(keys, "shared");
    sql.statements.length = 0;

    expect(members(run("SINTER", ...keys))).toEqual(["shared"]);
    expect(text(run("SINTERSTORE", "dst", ...keys))).toBe("<integer:1>");
    expect(text(run("SUNIONSTORE", "dst", ...keys))).toBe(`<integer:${String(keys.length + 1)}>`);
    expect(text(run("SDIFFSTORE", "dst", ...keys))).toBe("<integer:1>");
    expect(text(run("SINTERCARD", String(keys.length), ...keys))).toBe("<integer:1>");

    expect(sql.widestStatement).toBeLessThanOrEqual(CLOUDFLARE_MAX_BOUND_PARAMETERS);
    expect(sql.longestStatement).toBeLessThanOrEqual(CLOUDFLARE_MAX_STATEMENT_BYTES);
  });

  test("a store keeps its destination when the operands cannot be read", () => {
    run("SADD", "a", "x", "y");
    run("SADD", "b", "y");
    run("SADD", "dst", "keep");

    sql.failOn(/SELECT member FROM sett WHERE key = \?$/);
    expect(() => run("SINTERSTORE", "dst", "a", "b")).toThrow(StorageFailure);
    sql.repair();

    expect(members(run("SMEMBERS", "dst"))).toEqual(["keep"]);
    expect(text(run("TYPE", "dst"))).toBe("<simple:set>");
  });

  test("a store still replaces a destination that is also an operand", () => {
    run("SADD", "a", "a", "b", "c");
    run("SADD", "b", "b", "c", "d");

    expect(text(run("SINTERSTORE", "a", "a", "b"))).toBe("<integer:2>");
    expect(members(run("SMEMBERS", "a"))).toEqual(["b", "c"]);
  });
});

describe("SMOVE", () => {
  test("keeps the member in its source when the destination write fails", () => {
    run("SADD", "src", "m");
    run("SADD", "dst", "other");

    sql.failOn(/INSERT OR IGNORE INTO sett/);
    expect(() => run("SMOVE", "src", "dst", "m")).toThrow(StorageFailure);
    sql.repair();

    expect(members(run("SMEMBERS", "src"))).toEqual(["m"]);
    expect(members(run("SMEMBERS", "dst"))).toEqual(["other"]);
  });
});

describe("set cardinality never drifts from the rows it counts", () => {
  const count = (reply: Reply): number => (reply.kind === "integer" ? Number(reply.value) : NaN);

  const storedRows = (key: string): number =>
    sql.inner.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sett WHERE key = ?",
      encodeUtf8(key),
    ).one().n;

  const agrees = (key: string): void => {
    expect(count(run("SCARD", key))).toBe(storedRows(key));
  };

  test("every mutating set command leaves SCARD equal to COUNT(*)", () => {
    const seeded = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(count(run("SADD", "s", ...seeded))).toBe(10);
    agrees("s");

    expect(count(run("SADD", "s", "m0", "m1"))).toBe(0);
    agrees("s");

    expect(count(run("SREM", "s", "m0", "m1", "never-added"))).toBe(2);
    agrees("s");

    expect(count(run("SMOVE", "s", "dst", "m2"))).toBe(1);
    agrees("s");
    agrees("dst");

    expect(members(run("SPOP", "s", "3")).length).toBe(3);
    agrees("s");

    expect(count(run("SUNIONSTORE", "combined", "s", "dst"))).toBe(5);
    agrees("combined");

    expect(count(run("SINTERSTORE", "combined", "s", "dst"))).toBe(0);
    expect(count(run("EXISTS", "combined"))).toBe(0);
  });

  test("emptying a set through SREM or SPOP deletes the key", () => {
    run("SADD", "byRem", "a", "b");
    expect(count(run("SREM", "byRem", "a", "b"))).toBe(2);
    expect(count(run("EXISTS", "byRem"))).toBe(0);

    run("SADD", "byPop", "a", "b");
    expect(members(run("SPOP", "byPop", "1")).length).toBe(1);
    agrees("byPop");
    run("SPOP", "byPop", "1");
    expect(count(run("EXISTS", "byPop"))).toBe(0);
  });
});
