import { TABLE_META, TABLE_STRING, TYPE_TABLE, type SqlValue } from "../schema";
import { asBytes } from "../store";
import {
  DECR_OVERFLOW,
  FLOAT_NAN_OR_INF,
  INT_OVERFLOW,
  NOT_FLOAT,
  OFFSET_OUT_OF_RANGE,
  PROTO_MAX_BULK_LEN,
  STRING_TOO_LONG,
  SYNTAX,
  WRONGTYPE,
  fail,
  invalidExpire,
  wrongArity,
} from "../errors";
import {
  type Command,
  type KeyType,
  type Reply,
  NULL,
  OK,
  array,
  bulk,
  integer,
  upper,
} from "../types";
import {
  type CommandSpec,
  type Ctx,
  type LongDouble,
  ALL_KEYS,
  ALTERNATING_KEYS,
  addLongDouble,
  argI64,
  argIndex,
  ascii,
  formatLongDouble,
  I64_MAX,
  I64_MIN,
  LONG_DOUBLE_ZERO,
  ONE_KEY,
  spec,
  toLongDouble,
} from "./spec";

const MAX_EXPIRE_SECONDS = I64_MAX / 1000n;
const MS_PER_SECOND = 1000n;

const EMPTY = new Uint8Array(0);

export const rejectOversizedValue = (length: number): void => {
  if (length > PROTO_MAX_BULK_LEN) fail(STRING_TOO_LONG);
};

interface LiveStringRow {
  readonly type: string;
  readonly expire_at: number | null;
  readonly val: SqlValue;
}

const liveRow = (ctx: Ctx, key: Uint8Array): LiveStringRow | null =>
  ctx.store.liveRow<{ val: SqlValue }>(
    key,
    `(SELECT val FROM ${TABLE_STRING} WHERE ${TABLE_STRING}.key = ${TABLE_META}.key) AS val`,
  ) ?? null;

const readString = (ctx: Ctx, key: Uint8Array): Uint8Array | null => {
  const row = liveRow(ctx, key);
  if (row === null) return null;
  if (row.type !== "string") fail(WRONGTYPE);
  return row.val === null ? null : asBytes(row.val);
};

const readStringOrNilOnWrongType = (ctx: Ctx, key: Uint8Array): Uint8Array | null => {
  const row = liveRow(ctx, key);
  if (row === null || row.type !== "string" || row.val === null) return null;
  return asBytes(row.val);
};

type TtlDisposition = "keep" | "discard";

const replaceStringRow = (ctx: Ctx, key: Uint8Array, value: Uint8Array): void => {
  rejectOversizedValue(value.length);
  ctx.sql.exec(`INSERT OR REPLACE INTO ${TABLE_STRING} (key, val) VALUES (?, ?)`, key, value);
};

const dropRowsOfOtherTypes = (ctx: Ctx, key: Uint8Array, previous: KeyType): void => {
  if (previous !== "none" && previous !== "string") {
    ctx.sql.exec(`DELETE FROM ${TYPE_TABLE[previous]} WHERE key = ?`, key);
  }
};

const becomeString = (
  ctx: Ctx,
  key: Uint8Array,
  value: Uint8Array,
  ttl: TtlDisposition,
): void => {
  const previous = ctx.store.typeOf(key);
  replaceStringRow(ctx, key, value);
  dropRowsOfOtherTypes(ctx, key, previous);
  ctx.store.track(key, "string");
  if (ttl === "discard") ctx.store.persist(key);
};

const setDiscardingTtl = (ctx: Ctx, key: Uint8Array, value: Uint8Array): void => {
  becomeString(ctx, key, value, "discard");
};

const setKeepingTtl = (ctx: Ctx, key: Uint8Array, value: Uint8Array): void => {
  becomeString(ctx, key, value, "keep");
};

const editInPlace = (ctx: Ctx, key: Uint8Array, value: Uint8Array): void => {
  rejectOversizedValue(value.length);
  ctx.sql.exec(`UPDATE ${TABLE_STRING} SET val = ? WHERE key = ?`, value, key);
};

const mutate = (ctx: Ctx, key: Uint8Array, exists: boolean, value: Uint8Array): void => {
  if (exists) editInPlace(ctx, key, value);
  else setDiscardingTtl(ctx, key, value);
};

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
};

type ExpireUnit = "EX" | "PX" | "EXAT" | "PXAT";
type OptionDialect = "set" | "getex";

interface StringOptions {
  readonly nx: boolean;
  readonly xx: boolean;
  readonly get: boolean;
  readonly keepTtl: boolean;
  readonly persist: boolean;
  readonly unit: ExpireUnit | null;
  readonly amount: Uint8Array | null;
}

const NO_OPTIONS: StringOptions = {
  nx: false,
  xx: false,
  get: false,
  keepTtl: false,
  persist: false,
  unit: null,
  amount: null,
};

const parseStringOptions = (
  argv: Command,
  from: number,
  dialect: OptionDialect,
): StringOptions => {
  const forSet = dialect === "set";
  let nx = false;
  let xx = false;
  let get = false;
  let keepTtl = false;
  let persist = false;
  let unit: ExpireUnit | null = null;
  let amount: Uint8Array | null = null;

  for (let j = from; j < argv.length; j++) {
    const opt = upper(argv[j] as Uint8Array);
    const next = j + 1 < argv.length ? (argv[j + 1] as Uint8Array) : null;

    if (opt === "NX" && forSet && !xx) nx = true;
    else if (opt === "XX" && forSet && !nx) xx = true;
    else if (opt === "GET" && forSet) get = true;
    else if (opt === "KEEPTTL" && forSet && !persist && unit === null) keepTtl = true;
    else if (opt === "PERSIST" && !forSet && !keepTtl && unit === null) persist = true;
    else if (
      (opt === "EX" || opt === "PX" || opt === "EXAT" || opt === "PXAT") &&
      !keepTtl &&
      !persist &&
      unit === null &&
      next !== null
    ) {
      unit = opt;
      amount = next;
      j++;
    } else fail(SYNTAX);
  }

  return { nx, xx, get, keepTtl, persist, unit, amount };
};

const absoluteDeadline = (
  opts: StringOptions,
  command: string,
  now: number,
): number | null => {
  if (opts.unit === null || opts.amount === null) return null;

  const raw = argI64(opts.amount);
  const inSeconds = opts.unit === "EX" || opts.unit === "EXAT";
  if (raw <= 0n || (inSeconds && raw > MAX_EXPIRE_SECONDS)) fail(invalidExpire(command));

  const ms = inSeconds ? raw * MS_PER_SECOND : raw;
  const relativeToNow = opts.unit === "EX" || opts.unit === "PX";
  const at = relativeToNow ? ms + BigInt(now) : ms;
  if (at > I64_MAX) fail(invalidExpire(command));
  return Number(at);
};

const isAbsoluteUnit = (unit: ExpireUnit | null): boolean =>
  unit === "EXAT" || unit === "PXAT";

const get: CommandSpec["handler"] = (ctx, argv) => {
  const value = readString(ctx, argv[1] as Uint8Array);
  return value === null ? NULL : bulk(value);
};

const applySet = (
  ctx: Ctx,
  key: Uint8Array,
  value: Uint8Array,
  opts: StringOptions,
  command: string,
  onOk: Reply,
  onAbort: Reply,
): Reply => {
  rejectOversizedValue(value.length);
  const deadline = absoluteDeadline(opts, command, ctx.now);
  const previous = opts.get ? readString(ctx, key) : null;
  const previousReply = previous === null ? NULL : bulk(previous);
  const exists = ctx.store.typeOf(key) !== "none";

  if ((opts.nx && exists) || (opts.xx && !exists)) {
    return opts.get ? previousReply : onAbort;
  }

  if (opts.keepTtl) setKeepingTtl(ctx, key, value);
  else setDiscardingTtl(ctx, key, value);
  if (deadline !== null) ctx.store.expireAt(key, deadline);

  return opts.get ? previousReply : onOk;
};

const set: CommandSpec["handler"] = (ctx, argv) =>
  applySet(
    ctx,
    argv[1] as Uint8Array,
    argv[2] as Uint8Array,
    parseStringOptions(argv, 3, "set"),
    "set",
    OK,
    NULL,
  );

const setnx: CommandSpec["handler"] = (ctx, argv) =>
  applySet(
    ctx,
    argv[1] as Uint8Array,
    argv[2] as Uint8Array,
    { ...NO_OPTIONS, nx: true },
    "setnx",
    integer(1),
    integer(0),
  );

const setexGeneric = (
  ctx: Ctx,
  argv: Command,
  command: string,
  unit: ExpireUnit,
): Reply =>
  applySet(
    ctx,
    argv[1] as Uint8Array,
    argv[3] as Uint8Array,
    { ...NO_OPTIONS, unit, amount: argv[2] as Uint8Array },
    command,
    OK,
    NULL,
  );

const getset: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  rejectOversizedValue((argv[2] as Uint8Array).length);
  const previous = readString(ctx, key);
  setDiscardingTtl(ctx, key, argv[2] as Uint8Array);
  return previous === null ? NULL : bulk(previous);
};

const getdel: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  const previous = readString(ctx, key);
  if (previous !== null) ctx.store.drop(key);
  return previous === null ? NULL : bulk(previous);
};

const getex: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  const opts = parseStringOptions(argv, 2, "getex");
  const deadline = absoluteDeadline(opts, "getex", ctx.now);
  const value = readString(ctx, key);
  if (value === null) return NULL;

  if (deadline !== null && isAbsoluteUnit(opts.unit) && deadline <= ctx.now) {
    ctx.store.drop(key);
  } else if (deadline !== null) {
    ctx.store.expireAt(key, deadline);
  } else if (opts.persist) {
    ctx.store.persist(key);
  }

  return bulk(value);
};

const mget: CommandSpec["handler"] = (ctx, argv) => {
  const out: Reply[] = [];
  for (let j = 1; j < argv.length; j++) {
    const value = readStringOrNilOnWrongType(ctx, argv[j] as Uint8Array);
    out.push(value === null ? NULL : bulk(value));
  }
  return array(out);
};

const msetGeneric = (ctx: Ctx, argv: Command, nx: boolean): Reply => {
  if (argv.length % 2 === 0) return wrongArity(nx ? "msetnx" : "mset");

  for (let j = 2; j < argv.length; j += 2) {
    rejectOversizedValue((argv[j] as Uint8Array).length);
  }
  if (nx) {
    for (let j = 1; j < argv.length; j += 2) {
      if (ctx.store.typeOf(argv[j] as Uint8Array) !== "none") return integer(0);
    }
  }
  for (let j = 1; j < argv.length; j += 2) {
    setDiscardingTtl(ctx, argv[j] as Uint8Array, argv[j + 1] as Uint8Array);
  }
  return nx ? integer(1) : OK;
};

const append: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  const tail = argv[2] as Uint8Array;
  const head = readString(ctx, key);

  const total = (head?.length ?? 0) + tail.length;
  rejectOversizedValue(total);
  mutate(ctx, key, head !== null, head === null ? tail : concat(head, tail));
  return integer(total);
};

const strlen: CommandSpec["handler"] = (ctx, argv) =>
  integer(readString(ctx, argv[1] as Uint8Array)?.length ?? 0);

const invertedWhileBothEndsCountBack = (start: number, end: number): boolean =>
  start < 0 && end < 0 && start > end;

const getrange: CommandSpec["handler"] = (ctx, argv) => {
  let start = argIndex(argv[2] as Uint8Array);
  let end = argIndex(argv[3] as Uint8Array);
  const value = readString(ctx, argv[1] as Uint8Array);
  if (value === null || value.length === 0) return bulk(EMPTY);
  if (invertedWhileBothEndsCountBack(start, end)) return bulk(EMPTY);

  const length = value.length;
  if (start < 0) start = length + start;
  if (end < 0) end = length + end;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (end >= length) end = length - 1;

  return start > end ? bulk(EMPTY) : bulk(value.slice(start, end + 1));
};

const setrange: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  const offset = argIndex(argv[2] as Uint8Array);
  const patch = argv[3] as Uint8Array;
  if (offset < 0) return OFFSET_OUT_OF_RANGE;

  const current = readString(ctx, key);
  if (patch.length === 0) return integer(current?.length ?? 0);

  rejectOversizedValue(offset + patch.length);
  const size = Math.max(current?.length ?? 0, offset + patch.length);
  const out = new Uint8Array(size);
  if (current !== null) out.set(current);
  out.set(patch, offset);

  mutate(ctx, key, current !== null, out);
  return integer(size);
};

const incrDecr = (ctx: Ctx, key: Uint8Array, by: bigint): Reply => {
  const current = readString(ctx, key);
  const value = current === null ? 0n : argI64(current);
  const next = value + by;
  if (next < I64_MIN || next > I64_MAX) fail(INT_OVERFLOW);

  mutate(ctx, key, current !== null, ascii(next.toString()));
  return integer(next);
};

const decrby: CommandSpec["handler"] = (ctx, argv) => {
  const by = argI64(argv[2] as Uint8Array);
  if (by === I64_MIN) return DECR_OVERFLOW;
  return incrDecr(ctx, argv[1] as Uint8Array, -by);
};

const argLongDouble = (bytes: Uint8Array): LongDouble => toLongDouble(bytes) ?? fail(NOT_FLOAT);

const incrbyfloat: CommandSpec["handler"] = (ctx, argv) => {
  const key = argv[1] as Uint8Array;
  const current = readString(ctx, key);
  const value = current === null ? LONG_DOUBLE_ZERO : argLongDouble(current);
  const next = addLongDouble(value, argLongDouble(argv[2] as Uint8Array));
  if (next === null) return FLOAT_NAN_OR_INF;

  const rendered = ascii(formatLongDouble(next));
  mutate(ctx, key, current !== null, rendered);
  return bulk(rendered);
};

export const stringCommands: readonly CommandSpec[] = [
  spec("get", 2, false, ONE_KEY, get),
  spec("set", -3, true, ONE_KEY, set),
  spec("getset", 3, true, ONE_KEY, getset),
  spec("setnx", 3, true, ONE_KEY, setnx),
  spec("setex", 4, true, ONE_KEY, (ctx, argv) => setexGeneric(ctx, argv, "setex", "EX")),
  spec("psetex", 4, true, ONE_KEY, (ctx, argv) => setexGeneric(ctx, argv, "psetex", "PX")),
  spec("getdel", 2, true, ONE_KEY, getdel),
  spec("getex", -2, true, ONE_KEY, getex),
  spec("mget", -2, false, ALL_KEYS, mget),
  spec("mset", -3, true, ALTERNATING_KEYS, (ctx, argv) => msetGeneric(ctx, argv, false)),
  spec("msetnx", -3, true, ALTERNATING_KEYS, (ctx, argv) => msetGeneric(ctx, argv, true)),
  spec("append", 3, true, ONE_KEY, append),
  spec("strlen", 2, false, ONE_KEY, strlen),
  spec("incr", 2, true, ONE_KEY, (ctx, argv) => incrDecr(ctx, argv[1] as Uint8Array, 1n)),
  spec("decr", 2, true, ONE_KEY, (ctx, argv) => incrDecr(ctx, argv[1] as Uint8Array, -1n)),
  spec("incrby", 3, true, ONE_KEY, (ctx, argv) =>
    incrDecr(ctx, argv[1] as Uint8Array, argI64(argv[2] as Uint8Array)),
  ),
  spec("decrby", 3, true, ONE_KEY, decrby),
  spec("incrbyfloat", 3, true, ONE_KEY, incrbyfloat),
  spec("getrange", 4, false, ONE_KEY, getrange),
  spec("setrange", 4, true, ONE_KEY, setrange),
  spec("substr", 4, false, ONE_KEY, getrange),
];
