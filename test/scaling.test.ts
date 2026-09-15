import { describe, expect, test } from "bun:test";

import { FakeSqlStorage } from "./sqlite-adapter";
import { RedisError } from "../src/errors";
import { Store } from "../src/store";
import type {
  SqlBinding,
  SqlCursor,
  SqlRow,
  SqlRowShape,
  SqlStorage,
} from "../src/schema";
import { type Command, type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import type { CommandSpec, ConnState } from "../src/commands/spec";
import { listCommands } from "../src/commands/list";
import { hashCommands } from "../src/commands/hash";
import { keyspaceCommands } from "../src/commands/keyspace";

const enc = encodeUtf8;

type StatementPredicate = (query: string) => boolean;

interface InjectedFault {
  readonly matches: StatementPredicate;
  readonly afterMatches: number;
}

class RecordingSqlStorage implements SqlStorage {
  readonly inner = new FakeSqlStorage();
  readonly statements: string[] = [];
  #fault: InjectedFault | null = null;
  #faultMatchesSeen = 0;

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    this.statements.push(query);
    const fault = this.#fault;
    if (fault !== null && fault.matches(query)) {
      this.#faultMatchesSeen += 1;
      if (this.#faultMatchesSeen > fault.afterMatches) {
        throw new Error("injected storage failure");
      }
    }
    return this.inner.exec<T>(query, ...bindings);
  }

  failAfter(matches: StatementPredicate, afterMatches: number): void {
    this.#fault = { matches, afterMatches };
    this.#faultMatchesSeen = 0;
  }

  clearFault(): void {
    this.#fault = null;
  }

  forget(): void {
    this.statements.length = 0;
  }

  matching(predicate: StatementPredicate): string[] {
    return this.statements.filter(predicate);
  }
}

const compact = (query: string): string => query.replace(/\s+/g, " ").trim();

const readsTable = (table: string): StatementPredicate => {
  const from = new RegExp(`\\bFROM\\s+${table}\\b`, "i");
  return (query) => from.test(query);
};

const aggregatesRows: StatementPredicate = (query) =>
  /\b(?:COUNT|MIN|MAX|SUM|TOTAL|AVG)\s*\(/i.test(query);

const shiftsAListPosition: StatementPredicate = (query) =>
  /^\s*UPDATE\s+list\s+SET\s+seq\b/i.test(query);

class Server {
  readonly sql = new RecordingSqlStorage();
  clock = 1_700_000_000_000;
  readonly store = new Store(this.sql, () => this.clock);
  readonly conn: ConnState = { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false };
  readonly table: ReadonlyMap<string, CommandSpec> = new Map(
    [...listCommands, ...hashCommands, ...keyspaceCommands].map((c) => [c.name, c]),
  );

  run(...args: readonly (string | number | Uint8Array)[]): Reply {
    const argv: Command = args.map((a) =>
      a instanceof Uint8Array ? a : enc(typeof a === "number" ? String(a) : a),
    );
    const name = String(args[0]).toLowerCase();
    const entry = this.table.get(name);
    if (entry === undefined) throw new Error(`no such command: ${name}`);
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

  number(...args: readonly (string | number | Uint8Array)[]): number {
    const reply = this.run(...args);
    if (reply.kind !== "integer") throw new Error(`expected an integer, got ${reply.kind}`);
    return Number(reply.value);
  }

  values(...args: readonly (string | number | Uint8Array)[]): string[] {
    const reply = this.run(...args);
    if (reply.kind !== "array") throw new Error(`expected an array, got ${reply.kind}`);
    return reply.value.map((item) => {
      if (item.kind !== "bulk") throw new Error(`expected a bulk item, got ${item.kind}`);
      return decodeUtf8(item.value);
    });
  }

  rowCount(table: string, key: string): number {
    return this.sql.inner.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`,
      enc(key),
    ).one().n;
  }

  storedCardinality(key: string): number | null | undefined {
    return this.sql.inner
      .exec<{ card: number | null }>("SELECT card FROM meta WHERE key = ?", enc(key))
      .toArray()[0]?.card;
  }

  seedListAtSeqs(key: string, seqs: readonly number[]): string[] {
    this.store.track(enc(key), "list");
    const values = seqs.map((_, i) => `v${i}`);
    seqs.forEach((seq, i) => {
      this.sql.inner.exec(
        "INSERT INTO list (key, seq, val) VALUES (?, ?, ?)",
        enc(key),
        seq,
        enc(values[i]!),
      );
    });
    return values;
  }
}

const nextUp = (value: number): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
};

const denseRunAfter = (start: number, length: number): number[] => {
  const run: number[] = [];
  let current = start;
  for (let i = 0; i < length; i++) {
    current = nextUp(current);
    run.push(current);
  }
  return run;
};

const pushRepeatedly = (server: Server, key: string, from: number, to: number): void => {
  for (let i = from; i < to; i++) server.run("rpush", key, `e${i}`);
};

const MEASURED_PUSHES = 200;
const TRIALS = 3;

const nanosecondsPerPushAt = (length: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < TRIALS; trial++) {
    const server = new Server();
    pushRepeatedly(server, "bench", 0, length);
    const started = Bun.nanoseconds();
    pushRepeatedly(server, "bench", length, length + MEASURED_PUSHES);
    best = Math.min(best, (Bun.nanoseconds() - started) / MEASURED_PUSHES);
  }
  return best;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("collection cardinality is maintained, not counted", () => {
  test("a push executes the same bounded statements whatever the list length", () => {
    const statementsForPushIntoListOf = (length: number): string[] => {
      const server = new Server();
      pushRepeatedly(server, "k", 0, length);
      server.sql.forget();
      server.run("lpush", "k", "one more");
      return server.sql.statements.map(compact);
    };

    const small = statementsForPushIntoListOf(100);
    const large = statementsForPushIntoListOf(10_000);

    expect(large).toEqual(small);
    expect(small.filter(readsTable("list")).filter(aggregatesRows)).toEqual([]);
  });

  test("push cost stays flat as the list grows sixteenfold", () => {
    const small = nanosecondsPerPushAt(500);
    const large = nanosecondsPerPushAt(8_000);

    expect(large / small).toBeLessThan(4);
  });

  test("LLEN reports the maintained count without reading the list table", () => {
    const server = new Server();
    pushRepeatedly(server, "k", 0, 50);
    server.sql.forget();

    expect(server.number("llen", "k")).toBe(50);
    expect(server.sql.matching(readsTable("list"))).toEqual([]);
  });

  test("a directly seeded collection is counted once and then remembered", () => {
    const server = new Server();
    server.seedListAtSeqs("k", [0, 1, 2, 3]);

    expect(server.storedCardinality("k")).toBe(null);
    expect(server.number("llen", "k")).toBe(4);
    expect(server.storedCardinality("k")).toBe(4);

    server.sql.forget();
    expect(server.number("llen", "k")).toBe(4);
    expect(server.sql.matching(readsTable("list"))).toEqual([]);
  });

  test("HLEN reports the maintained count without reading the hash table", () => {
    const server = new Server();
    for (let i = 0; i < 40; i++) server.run("hset", "h", `f${i}`, `v${i}`);
    server.sql.forget();

    expect(server.number("hlen", "h")).toBe(40);
    expect(server.sql.matching(readsTable("hash"))).toEqual([]);
  });
});

describe("cardinality survives a long randomized mutation sequence", () => {
  const LIST_KEYS = ["l0", "l1", "l2"];
  const HASH_KEYS = ["h0", "h1"];

  const checkAgainstStoredRows = (server: Server, table: string, key: string): void => {
    const reported = server.number(table === "list" ? "llen" : "hlen", key);
    const rows = server.rowCount(table, key);
    expect(reported).toBe(rows);
    const stored = server.storedCardinality(key);
    if (stored === undefined) expect(rows).toBe(0);
    else if (stored !== null) expect(stored).toBe(rows);
  };

  const checkEveryKey = (server: Server): void => {
    for (const key of LIST_KEYS) checkAgainstStoredRows(server, "list", key);
    for (const key of HASH_KEYS) checkAgainstStoredRows(server, "hash", key);
  };

  test("pushes, pops, inserts, removals, trims, deletes and expiry all agree with COUNT(*)", () => {
    const server = new Server();
    const random = mulberry32(0x5ca1e);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const small = (): number => Math.floor(random() * 5);

    for (let step = 0; step < 1_500; step++) {
      const list = pick(LIST_KEYS);
      const hash = pick(HASH_KEYS);
      const value = `v${small()}`;

      switch (Math.floor(random() * 14)) {
        case 0:
          server.run("lpush", list, value, `w${small()}`);
          break;
        case 1:
          server.run("rpush", list, value);
          break;
        case 2:
          server.run("rpushx", list, value);
          break;
        case 3:
          server.run("lpop", list, small());
          break;
        case 4:
          server.run("rpop", list);
          break;
        case 5:
          server.run("linsert", list, random() < 0.5 ? "BEFORE" : "AFTER", value, `i${small()}`);
          break;
        case 6:
          server.run("lrem", list, small() - 2, value);
          break;
        case 7:
          server.run("ltrim", list, small() - 2, small() + 1);
          break;
        case 8:
          server.run("lmove", pick(LIST_KEYS), list, "LEFT", "RIGHT");
          break;
        case 9:
          server.run("hset", hash, `f${small()}`, value);
          break;
        case 10:
          server.run("hdel", hash, `f${small()}`);
          break;
        case 11:
          server.run("hincrby", hash, `n${small()}`, 1);
          break;
        case 12:
          server.run("del", random() < 0.5 ? list : hash);
          break;
        default:
          server.run("pexpire", random() < 0.5 ? list : hash, 1);
          server.clock += 2;
          break;
      }

      checkEveryKey(server);
    }
  });
});

describe("list position exhaustion is bounded and recoverable", () => {
  const DENSE_RUN = 3;

  const listWithADenseRunAfterTheHead = (length: number): { server: Server; head: string } => {
    const server = new Server();
    const seqs = [1, ...denseRunAfter(1, DENSE_RUN)];
    const tail = length - seqs.length;
    for (let i = 0; i < tail; i++) seqs.push(i + 2);
    const values = server.seedListAtSeqs("dense", seqs);
    return { server, head: values[0]! };
  };

  test("renumbering touches only the dense run, not the whole list", () => {
    const shiftsWhenInsertingInto = (length: number): number => {
      const { server, head } = listWithADenseRunAfterTheHead(length);
      server.sql.forget();
      expect(server.number("linsert", "dense", "AFTER", head, "wedged")).toBe(length + 1);
      return server.sql.matching(shiftsAListPosition).length;
    };

    expect(shiftsWhenInsertingInto(200)).toBe(DENSE_RUN);
    expect(shiftsWhenInsertingInto(2_000)).toBe(DENSE_RUN);
  });

  test("the renumbered list keeps every element in order", () => {
    const { server, head } = listWithADenseRunAfterTheHead(20);
    const before = server.values("lrange", "dense", 0, -1);

    server.run("linsert", "dense", "AFTER", head, "wedged");

    const after = server.values("lrange", "dense", 0, -1);
    expect(after).toEqual([before[0]!, "wedged", ...before.slice(1)]);
    expect(server.number("llen", "dense")).toBe(before.length + 1);
  });

  test("a failed renumber leaves every element present and ordered", () => {
    const { server, head } = listWithADenseRunAfterTheHead(20);
    const before = server.values("lrange", "dense", 0, -1);

    server.sql.failAfter(shiftsAListPosition, 1);
    expect(() => server.run("linsert", "dense", "AFTER", head, "wedged")).toThrow(
      "injected storage failure",
    );
    server.sql.clearFault();

    expect(server.values("lrange", "dense", 0, -1)).toEqual(before);
    expect(server.rowCount("list", "dense")).toBe(before.length);
  });

  test("pushing past the end of the position space is refused, not silently drifted", () => {
    const server = new Server();
    server.seedListAtSeqs("edge", [Number.MAX_SAFE_INTEGER]);

    const refused = server.run("rpush", "edge", "beyond");
    expect(refused.kind).toBe("error");
    expect(refused.kind === "error" && refused.value).toContain("position space exhausted");

    expect(server.number("llen", "edge")).toBe(1);
    expect(server.number("lpush", "edge", "below")).toBe(2);
  });

  test("the low end of the position space is refused symmetrically", () => {
    const server = new Server();
    server.seedListAtSeqs("edge", [-Number.MAX_SAFE_INTEGER]);

    const refused = server.run("lpush", "edge", "beyond");
    expect(refused.kind).toBe("error");
    expect(server.number("llen", "edge")).toBe(1);
    expect(server.number("rpush", "edge", "above")).toBe(2);
  });
});
