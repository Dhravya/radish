import {
  type Command,
  type Reply,
  EMPTY_ARRAY,
  NULL,
  OK,
  array,
  bulk,
  decodeUtf8,
  error,
  integer,
  map,
  upper,
} from "../types";
import { INT_OVERFLOW, NOT_FLOAT, SYNTAX, fail, wrongArity } from "../errors";
import {
  type SqlValue,
  COUNTER_SCAN_CURSOR_ID,
  TABLE_INTERNAL_COUNTERS,
  TABLE_SCAN_CURSOR,
} from "../schema";
import { asBytes, globToRegExp } from "../store";
import { addToCardinality, cardinality, dropKeyWhenEmpty } from "./cardinality";
import {
  type CommandSpec,
  type Ctx,
  type Handler,
  I64_MAX,
  I64_MIN,
  LONG_DOUBLE_ZERO,
  ONE_KEY,
  addLongDouble,
  argI64,
  argIndex,
  ascii,
  formatLongDouble,
  spec,
  toI64,
  toLongDouble,
} from "./spec";

interface FieldRow {
  readonly field: SqlValue;
}
interface ValueRow {
  readonly val: SqlValue;
}
interface PairRow {
  readonly field: SqlValue;
  readonly val: SqlValue;
}

const HASH_NOT_INTEGER = error("ERR hash value is not an integer");
const HASH_NOT_FLOAT = error("ERR hash value is not a float");
const INCR_NOT_FINITE = error("ERR increment would produce NaN or Infinity");
export const INVALID_CURSOR = error("ERR invalid cursor");

const CURSOR_IDLE_MS = 60_000;
const START_CURSOR = 0;
const FINISHED_CURSOR = 0;
const DEFAULT_SCAN_COUNT = 10;

export interface ScanArgs {
  readonly cursor: number;
  readonly count: number;
  readonly match: RegExp | null;
  readonly noValues: boolean;
}

export interface ScanElement {
  readonly element: Uint8Array;
  readonly extra: SqlValue;
}

interface ScanRow {
  readonly element: SqlValue;
  readonly extra?: SqlValue;
}

const parseCursor = (bytes: Uint8Array): number => {
  const text = decodeUtf8(bytes);
  if (!/^[0-9]+$/.test(text)) fail(INVALID_CURSOR);
  return Number(text);
};

export const parseScanArgs = (argv: Command, allowNoValues: boolean): ScanArgs => {
  const cursor = parseCursor(argv[2]!);
  let count = DEFAULT_SCAN_COUNT;
  let match: RegExp | null = null;
  let noValues = false;
  for (let i = 3; i < argv.length; ) {
    const option = upper(argv[i]!);
    if (option === "COUNT" && i + 1 < argv.length) {
      count = argIndex(argv[i + 1]!);
      if (count < 1) fail(SYNTAX);
      i += 2;
    } else if (option === "MATCH" && i + 1 < argv.length) {
      match = globToRegExp(decodeUtf8(argv[i + 1]!));
      i += 2;
    } else if (option === "NOVALUES" && allowNoValues) {
      noValues = true;
      i += 1;
    } else {
      fail(SYNTAX);
    }
  }
  return { cursor, count, match, noValues };
};

const mintCursorId = (ctx: Ctx): number => {
  ctx.sql.exec(
    `INSERT INTO ${TABLE_INTERNAL_COUNTERS} (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    COUNTER_SCAN_CURSOR_ID,
  );
  return ctx.sql
    .exec<{ value: number }>(
      `SELECT value FROM ${TABLE_INTERNAL_COUNTERS} WHERE name = ?`,
      COUNTER_SCAN_CURSOR_ID,
    )
    .one().value;
};

const collectIdleCursorsExcept = (ctx: Ctx, keep: number): void => {
  ctx.sql.exec(
    `DELETE FROM ${TABLE_SCAN_CURSOR} WHERE touched < ? AND id != ?`,
    ctx.now - CURSOR_IDLE_MS,
    keep,
  );
};

const lastElementHandedOutBy = (ctx: Ctx, cursor: number): Uint8Array | null | undefined => {
  const row = ctx.sql
    .exec<{ last: SqlValue }>(`SELECT last FROM ${TABLE_SCAN_CURSOR} WHERE id = ?`, cursor)
    .toArray()[0];
  return row === undefined ? undefined : asBytes(row.last);
};

const rememberPosition = (ctx: Ctx, id: number, last: Uint8Array): void => {
  ctx.sql.exec(
    `INSERT INTO ${TABLE_SCAN_CURSOR} (id, last, touched) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last = excluded.last, touched = excluded.touched`,
    id,
    last,
    ctx.now,
  );
};

const forgetPosition = (ctx: Ctx, cursor: number): void => {
  if (cursor !== START_CURSOR) {
    ctx.sql.exec(`DELETE FROM ${TABLE_SCAN_CURSOR} WHERE id = ?`, cursor);
  }
};

const selectElements = (table: string, column: string, extra: string | null): string =>
  `SELECT ${column} AS element${extra === null ? "" : `, ${extra} AS extra`} FROM ${table}`;

const firstElementPage = (
  ctx: Ctx,
  key: Uint8Array,
  table: string,
  column: string,
  extra: string | null,
  limit: number,
): ScanRow[] =>
  ctx.sql
    .exec<ScanRow>(
      `${selectElements(table, column, extra)} WHERE key = ? ORDER BY ${column} LIMIT ?`,
      key,
      limit,
    )
    .toArray();

const elementPageAfter = (
  ctx: Ctx,
  key: Uint8Array,
  table: string,
  column: string,
  extra: string | null,
  after: Uint8Array,
  limit: number,
): ScanRow[] =>
  ctx.sql
    .exec<ScanRow>(
      `${selectElements(table, column, extra)} WHERE key = ? AND ${column} > ? ORDER BY ${column} LIMIT ?`,
      key,
      after,
      limit,
    )
    .toArray();

export const elementScan = (
  ctx: Ctx,
  key: Uint8Array,
  table: string,
  column: string,
  extra: string | null,
  args: ScanArgs,
): { readonly cursor: number; readonly rows: readonly ScanElement[] } => {
  collectIdleCursorsExcept(ctx, args.cursor);

  let resumeAfter: Uint8Array | null = null;
  if (args.cursor !== START_CURSOR) {
    const remembered = lastElementHandedOutBy(ctx, args.cursor);
    if (remembered === undefined) return { cursor: FINISHED_CURSOR, rows: [] };
    resumeAfter = remembered;
  }

  const raw =
    resumeAfter === null
      ? firstElementPage(ctx, key, table, column, extra, args.count)
      : elementPageAfter(ctx, key, table, column, extra, resumeAfter, args.count);

  const rows: ScanElement[] = [];
  let lastExamined: Uint8Array | null = null;
  for (const row of raw) {
    const element = asBytes(row.element);
    lastExamined = element;
    if (args.match !== null && !args.match.test(decodeUtf8(element))) continue;
    rows.push({ element, extra: row.extra ?? null });
  }

  if (raw.length < args.count || lastExamined === null) {
    forgetPosition(ctx, args.cursor);
    return { cursor: FINISHED_CURSOR, rows };
  }

  const id = args.cursor !== START_CURSOR ? args.cursor : mintCursorId(ctx);
  rememberPosition(ctx, id, lastExamined);
  return { cursor: id, rows };
};

export const sampleRows = <T extends object>(
  ctx: Ctx,
  key: Uint8Array,
  size: number,
  count: number,
  randomDistinctQuery: string,
  wholeCollectionQuery: string,
  oneAtOffsetQuery: string,
): T[] => {
  if (size === 0 || count === 0) return [];
  if (count > 0) {
    return ctx.sql.exec<T>(randomDistinctQuery, key, Math.min(count, size)).toArray();
  }

  const drawsWithRepeats = -count;
  const out: T[] = [];
  if (drawsWithRepeats >= size) {
    const all = ctx.sql.exec<T>(wholeCollectionQuery, key).toArray();
    for (let i = 0; i < drawsWithRepeats; i++) out.push(all[Math.floor(Math.random() * size)]!);
    return out;
  }
  for (let i = 0; i < drawsWithRepeats; i++) {
    out.push(ctx.sql.exec<T>(oneAtOffsetQuery, key, Math.floor(Math.random() * size)).one());
  }
  return out;
};

const readField = (ctx: Ctx, key: Uint8Array, field: Uint8Array): Uint8Array | null => {
  const rows = ctx.sql
    .exec<ValueRow>("SELECT val FROM hash WHERE key = ? AND field = ?", key, field)
    .toArray();
  return rows.length === 0 ? null : asBytes(rows[0]!.val);
};

const hashLength = (ctx: Ctx, key: Uint8Array): number => cardinality(ctx, key, "hash");

const insertFieldIfAbsent = (
  ctx: Ctx,
  key: Uint8Array,
  field: Uint8Array,
  val: Uint8Array,
): boolean =>
  ctx.sql.exec("INSERT OR IGNORE INTO hash (key, field, val) VALUES (?, ?, ?)", key, field, val)
    .rowsWritten > 0;

const putField = (ctx: Ctx, key: Uint8Array, field: Uint8Array, val: Uint8Array): boolean => {
  if (insertFieldIfAbsent(ctx, key, field, val)) return true;
  ctx.sql.exec("UPDATE hash SET val = ? WHERE key = ? AND field = ?", val, key, field);
  return false;
};

const hset: Handler = (ctx, argv) => {
  if ((argv.length - 2) % 2 !== 0) return wrongArity(decodeUtf8(argv[0]!));
  const key = argv[1]!;
  const existed = ctx.store.expectType(key, "hash");
  let added = 0;
  for (let i = 2; i < argv.length; i += 2) {
    if (putField(ctx, key, argv[i]!, argv[i + 1]!)) added++;
  }
  if (added > 0) addToCardinality(ctx, key, "hash", added);
  if (!existed) ctx.store.track(key, "hash");
  return integer(added);
};

const hmset: Handler = (ctx, argv) => {
  const reply = hset(ctx, argv);
  return reply.kind === "integer" ? OK : reply;
};

const hsetnx: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const existed = ctx.store.expectType(key, "hash");
  const inserted = insertFieldIfAbsent(ctx, key, argv[2]!, argv[3]!);
  if (inserted) addToCardinality(ctx, key, "hash", 1);
  if (inserted && !existed) ctx.store.track(key, "hash");
  return integer(inserted ? 1 : 0);
};

const hget: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "hash")) return NULL;
  const value = readField(ctx, key, argv[2]!);
  return value === null ? NULL : bulk(value);
};

const hmget: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const exists = ctx.store.expectType(key, "hash");
  const out: Reply[] = [];
  for (let i = 2; i < argv.length; i++) {
    const value = exists ? readField(ctx, key, argv[i]!) : null;
    out.push(value === null ? NULL : bulk(value));
  }
  return array(out);
};

const hdel: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "hash")) return integer(0);
  let removed = 0;
  for (let i = 2; i < argv.length; i++) {
    removed += ctx.sql.exec("DELETE FROM hash WHERE key = ? AND field = ?", key, argv[i]!).rowsWritten;
  }
  dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "hash", -removed));
  return integer(removed);
};

const hlen: Handler = (ctx, argv) => {
  const key = argv[1]!;
  return integer(ctx.store.expectType(key, "hash") ? hashLength(ctx, key) : 0);
};

const hexists: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "hash")) return integer(0);
  return integer(readField(ctx, key, argv[2]!) === null ? 0 : 1);
};

const hstrlen: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "hash")) return integer(0);
  const value = readField(ctx, key, argv[2]!);
  return integer(value === null ? 0 : value.length);
};

const projection =
  (column: "field" | "val"): Handler =>
  (ctx, argv) => {
    const key = argv[1]!;
    if (!ctx.store.expectType(key, "hash")) return EMPTY_ARRAY;
    const rows = ctx.sql
      .exec<{ out: SqlValue }>(`SELECT ${column} AS out FROM hash WHERE key = ? ORDER BY field`, key)
      .toArray();
    return array(rows.map((row) => bulk(asBytes(row.out))));
  };

const hgetall: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "hash")) return map([]);
  const rows = ctx.sql
    .exec<PairRow>("SELECT field, val FROM hash WHERE key = ? ORDER BY field", key)
    .toArray();
  return map(rows.map((row) => [bulk(asBytes(row.field)), bulk(asBytes(row.val))] as const));
};

const hincrby: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const field = argv[2]!;
  const increment = argI64(argv[3]!);
  const existed = ctx.store.expectType(key, "hash");
  const current = existed ? readField(ctx, key, field) : null;
  const before = current === null ? 0n : (toI64(current) ?? fail(HASH_NOT_INTEGER));
  const after = before + increment;
  if (after < I64_MIN || after > I64_MAX) fail(INT_OVERFLOW);
  if (putField(ctx, key, field, ascii(after.toString()))) {
    addToCardinality(ctx, key, "hash", 1);
  }
  if (!existed) ctx.store.track(key, "hash");
  return integer(after);
};

const hincrbyfloat: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const field = argv[2]!;
  const increment = toLongDouble(argv[3]!) ?? fail(NOT_FLOAT);
  const existed = ctx.store.expectType(key, "hash");
  const current = existed ? readField(ctx, key, field) : null;
  const before = current === null ? LONG_DOUBLE_ZERO : (toLongDouble(current) ?? fail(HASH_NOT_FLOAT));
  const after = addLongDouble(before, increment) ?? fail(INCR_NOT_FINITE);
  const text = formatLongDouble(after);
  if (putField(ctx, key, field, ascii(text))) addToCardinality(ctx, key, "hash", 1);
  if (!existed) ctx.store.track(key, "hash");
  return bulk(text);
};

const hrandfield: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const exists = ctx.store.expectType(key, "hash");

  if (argv.length === 2) {
    if (!exists) return NULL;
    const rows = ctx.sql
      .exec<FieldRow>("SELECT field FROM hash WHERE key = ? ORDER BY RANDOM() LIMIT 1", key)
      .toArray();
    return rows.length === 0 ? NULL : bulk(asBytes(rows[0]!.field));
  }

  if (argv.length > 4) fail(SYNTAX);
  const count = argIndex(argv[2]!);
  let withValues = false;
  if (argv.length === 4) {
    if (upper(argv[3]!) !== "WITHVALUES") fail(SYNTAX);
    withValues = true;
  }
  if (!exists) return EMPTY_ARRAY;

  const picked = sampleRows<PairRow>(
    ctx,
    key,
    hashLength(ctx, key),
    count,
    "SELECT field, val FROM hash WHERE key = ? ORDER BY RANDOM() LIMIT ?",
    "SELECT field, val FROM hash WHERE key = ? ORDER BY field",
    "SELECT field, val FROM hash WHERE key = ? ORDER BY field LIMIT 1 OFFSET ?",
  );
  const out: Reply[] = [];
  for (const row of picked) {
    out.push(bulk(asBytes(row.field)));
    if (withValues) out.push(bulk(asBytes(row.val)));
  }
  return array(out);
};

const hscan: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const args = parseScanArgs(argv, true);
  if (!ctx.store.expectType(key, "hash")) return array([bulk("0"), EMPTY_ARRAY]);

  const page = elementScan(ctx, key, "hash", "field", args.noValues ? null : "val", args);
  const out: Reply[] = [];
  for (const row of page.rows) {
    out.push(bulk(row.element));
    if (!args.noValues) out.push(bulk(asBytes(row.extra)));
  }
  return array([bulk(String(page.cursor)), array(out)]);
};

export const hashCommands: readonly CommandSpec[] = [
  spec("hset", -4, true, ONE_KEY, hset),
  spec("hsetnx", 4, true, ONE_KEY, hsetnx),
  spec("hget", 3, false, ONE_KEY, hget),
  spec("hmget", -3, false, ONE_KEY, hmget),
  spec("hmset", -4, true, ONE_KEY, hmset),
  spec("hdel", -3, true, ONE_KEY, hdel),
  spec("hlen", 2, false, ONE_KEY, hlen),
  spec("hexists", 3, false, ONE_KEY, hexists),
  spec("hkeys", 2, false, ONE_KEY, projection("field")),
  spec("hvals", 2, false, ONE_KEY, projection("val")),
  spec("hgetall", 2, false, ONE_KEY, hgetall),
  spec("hincrby", 4, true, ONE_KEY, hincrby),
  spec("hincrbyfloat", 4, true, ONE_KEY, hincrbyfloat),
  spec("hstrlen", 3, false, ONE_KEY, hstrlen),
  spec("hrandfield", -2, false, ONE_KEY, hrandfield),
  spec("hscan", -3, false, ONE_KEY, hscan),
];
