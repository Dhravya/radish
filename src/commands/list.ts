import {
  type Reply,
  EMPTY_ARRAY,
  NULL,
  NULL_ARRAY,
  OK,
  array,
  bulk,
  decodeUtf8,
  error,
  integer,
  upper,
} from "../types";
import { INDEX_OUT_OF_RANGE, SYNTAX, fail, wrongArity } from "../errors";
import type { SqlValue } from "../schema";
import { asBytes } from "../store";
import { addToCardinality, cardinality, dropKeyWhenEmpty } from "./cardinality";
import {
  type CommandSpec,
  type Ctx,
  type Handler,
  FIRST_TWO_KEYS,
  ONE_KEY,
  argIndex,
  sameBytes,
  spec,
  toI64,
} from "./spec";

interface ValRow {
  readonly val: SqlValue;
}
interface SeqRow {
  readonly seq: number;
}
interface ElementRow {
  readonly seq: number;
  readonly val: SqlValue;
}
interface SeqShift {
  readonly from: number;
  readonly to: number;
}

const NO_SUCH_KEY = error("ERR no such key");
const MUST_BE_POSITIVE = error("ERR value is out of range, must be positive");
const RANK_ZERO = error(
  "ERR RANK can't be zero. Use 1 to start searching from the first matching element in the head of the list or a negative rank to start searching from the tail. A value of zero is not allowed",
);
const NEGATIVE_COUNT = error("ERR COUNT can't be negative");
const NEGATIVE_MAXLEN = error("ERR MAXLEN can't be negative");
const SEQ_SPACE_EXHAUSTED = error(
  "ERR list position space exhausted at this end of the list; no further elements can be added there",
);

const FIRST_SEQ_IN_EMPTY_LIST = 0;
const COUNT_ABSENT = -1;
const COUNT_ALL = 0;
const MAXLEN_UNLIMITED = 0;
const LIST_IS_EMPTY = null;

const listLength = (ctx: Ctx, key: Uint8Array): number => cardinality(ctx, key, "list");

const endpointSeq = (ctx: Ctx, key: Uint8Array, left: boolean): number | null => {
  const rows = ctx.sql
    .exec<SeqRow>(
      `SELECT seq FROM list WHERE key = ? ORDER BY seq ${left ? "ASC" : "DESC"} LIMIT 1`,
      key,
    )
    .toArray();
  return rows.length === 0 ? LIST_IS_EMPTY : rows[0]!.seq;
};

const withinSeqSpace = (seq: number): boolean => Math.abs(seq) <= Number.MAX_SAFE_INTEGER;

const seqStepAwayFrom = (seq: number, left: boolean): number => {
  const next = left ? seq - 1 : seq + 1;
  if (!withinSeqSpace(next)) fail(SEQ_SPACE_EXHAUSTED);
  return next;
};

const seqJustBeyondEnd = (endpoint: number | null, left: boolean): number =>
  endpoint === LIST_IS_EMPTY ? FIRST_SEQ_IN_EMPTY_LIST : seqStepAwayFrom(endpoint, left);

const insertAtSeq = (ctx: Ctx, key: Uint8Array, seq: number, val: Uint8Array): void => {
  ctx.sql.exec("INSERT INTO list (key, seq, val) VALUES (?, ?, ?)", key, seq, val);
};

const insertBeyondEnd = (ctx: Ctx, key: Uint8Array, left: boolean, val: Uint8Array): void => {
  insertAtSeq(ctx, key, seqJustBeyondEnd(endpointSeq(ctx, key, left), left), val);
};

const midpointBetween = (a: number, b: number): number => a / 2 + b / 2;

const hasRoomForAMidpointBetween = (a: number, b: number): boolean => {
  const mid = midpointBetween(a, b);
  return mid !== a && mid !== b;
};

const neighbourSeq = (ctx: Ctx, key: Uint8Array, at: number, before: boolean): number | null => {
  const rows = before
    ? ctx.sql
        .exec<SeqRow>("SELECT seq FROM list WHERE key = ? AND seq < ? ORDER BY seq DESC LIMIT 1", key, at)
        .toArray()
    : ctx.sql
        .exec<SeqRow>("SELECT seq FROM list WHERE key = ? AND seq > ? ORDER BY seq ASC LIMIT 1", key, at)
        .toArray();
  return rows.length === 0 ? null : rows[0]!.seq;
};

const seqOfFirstMatch = (ctx: Ctx, key: Uint8Array, val: Uint8Array): SeqRow | undefined =>
  ctx.sql
    .exec<SeqRow>("SELECT seq FROM list WHERE key = ? AND val = ? ORDER BY seq LIMIT 1", key, val)
    .toArray()[0];

const shiftsThatVacate = (
  ctx: Ctx,
  key: Uint8Array,
  occupied: number,
  outwardLeft: boolean,
): readonly SeqShift[] => {
  const shifts: SeqShift[] = [];
  let from = occupied;
  for (;;) {
    const beyond = neighbourSeq(ctx, key, from, outwardLeft);
    if (beyond === null) {
      shifts.push({ from, to: seqStepAwayFrom(from, outwardLeft) });
      return shifts;
    }
    if (hasRoomForAMidpointBetween(from, beyond)) {
      shifts.push({ from, to: midpointBetween(from, beyond) });
      return shifts;
    }
    shifts.push({ from, to: beyond });
    from = beyond;
  }
};

const applyShiftsOutermostFirst = (
  ctx: Ctx,
  key: Uint8Array,
  shifts: readonly SeqShift[],
): void => {
  for (let i = shifts.length - 1; i >= 0; i--) {
    const shift = shifts[i]!;
    ctx.sql.exec("UPDATE list SET seq = ? WHERE key = ? AND seq = ?", shift.to, key, shift.from);
  }
};

const insertBesidePivot = (
  ctx: Ctx,
  key: Uint8Array,
  at: number,
  before: boolean,
  val: Uint8Array,
): void => {
  const other = neighbourSeq(ctx, key, at, before);
  if (other === null) {
    insertAtSeq(ctx, key, seqStepAwayFrom(at, before), val);
    return;
  }
  if (hasRoomForAMidpointBetween(at, other)) {
    insertAtSeq(ctx, key, midpointBetween(at, other), val);
    return;
  }
  applyShiftsOutermostFirst(ctx, key, shiftsThatVacate(ctx, key, other, before));
  insertAtSeq(ctx, key, other, val);
};

const resolveRange = (start: number, stop: number, length: number): readonly [number, number] | null => {
  if (start < 0) start = length + start;
  if (stop < 0) stop = length + stop;
  if (start < 0) start = 0;
  if (start > stop || start >= length) return null;
  if (stop >= length) stop = length - 1;
  return [start, stop];
};

const push =
  (left: boolean, requireExisting: boolean): Handler =>
  (ctx, argv) => {
    const key = argv[1]!;
    const existed = ctx.store.expectType(key, "list");
    if (requireExisting && !existed) return integer(0);

    let seq = seqJustBeyondEnd(endpointSeq(ctx, key, left), left);
    for (let i = 2; i < argv.length; i++) {
      insertAtSeq(ctx, key, seq, argv[i]!);
      seq = seqStepAwayFrom(seq, left);
    }
    const total = addToCardinality(ctx, key, "list", argv.length - 2);
    if (!existed) ctx.store.track(key, "list");
    return integer(total);
  };

const popCount = (bytes: Uint8Array): number => {
  const parsed = toI64(bytes);
  if (parsed === null || parsed < 0n) fail(MUST_BE_POSITIVE);
  return Number(parsed);
};

const pop =
  (left: boolean): Handler =>
  (ctx, argv) => {
    if (argv.length > 3) fail(wrongArity(decodeUtf8(argv[0]!)));
    const key = argv[1]!;
    const counted = argv.length === 3;
    const count = counted ? popCount(argv[2]!) : 1;

    if (!ctx.store.expectType(key, "list")) return counted ? NULL_ARRAY : NULL;
    if (count === 0) return EMPTY_ARRAY;

    const order = left ? "ASC" : "DESC";
    const rows = ctx.sql
      .exec<ElementRow>(`SELECT seq, val FROM list WHERE key = ? ORDER BY seq ${order} LIMIT ?`, key, count)
      .toArray();
    if (rows.length === 0) return counted ? NULL_ARRAY : NULL;

    const lastTaken = rows[rows.length - 1]!.seq;
    const removed = ctx.sql.exec(
      `DELETE FROM list WHERE key = ? AND seq ${left ? "<=" : ">="} ?`,
      key,
      lastTaken,
    ).rowsWritten;
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "list", -removed));

    return counted ? array(rows.map((row) => bulk(asBytes(row.val)))) : bulk(asBytes(rows[0]!.val));
  };

const llen: Handler = (ctx, argv) => {
  const key = argv[1]!;
  return integer(ctx.store.expectType(key, "list") ? listLength(ctx, key) : 0);
};

const lrange: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const start = argIndex(argv[2]!);
  const stop = argIndex(argv[3]!);
  if (!ctx.store.expectType(key, "list")) return EMPTY_ARRAY;

  const span = resolveRange(start, stop, listLength(ctx, key));
  if (span === null) return EMPTY_ARRAY;
  const rows = ctx.sql
    .exec<ValRow>(
      "SELECT val FROM list WHERE key = ? ORDER BY seq LIMIT ? OFFSET ?",
      key,
      span[1] - span[0] + 1,
      span[0],
    )
    .toArray();
  return array(rows.map((row) => bulk(asBytes(row.val))));
};

const elementAtIndex = (ctx: Ctx, key: Uint8Array, index: number): ElementRow | null => {
  const [order, offset] = index < 0 ? (["DESC", -index - 1] as const) : (["ASC", index] as const);
  const rows = ctx.sql
    .exec<ElementRow>(`SELECT seq, val FROM list WHERE key = ? ORDER BY seq ${order} LIMIT 1 OFFSET ?`, key, offset)
    .toArray();
  return rows.length === 0 ? null : rows[0]!;
};

const lindex: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const index = argIndex(argv[2]!);
  if (!ctx.store.expectType(key, "list")) return NULL;
  const row = elementAtIndex(ctx, key, index);
  return row === null ? NULL : bulk(asBytes(row.val));
};

const lset: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const index = argIndex(argv[2]!);
  if (!ctx.store.expectType(key, "list")) fail(NO_SUCH_KEY);
  const row = elementAtIndex(ctx, key, index) ?? fail(INDEX_OUT_OF_RANGE);
  ctx.sql.exec("UPDATE list SET val = ? WHERE key = ? AND seq = ?", argv[3]!, key, row.seq);
  return OK;
};

const linsert: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const where = upper(argv[2]!);
  if (where !== "BEFORE" && where !== "AFTER") fail(SYNTAX);
  const pivot = argv[3]!;
  if (!ctx.store.expectType(key, "list")) return integer(0);

  const hit = seqOfFirstMatch(ctx, key, pivot);
  if (hit === undefined) return integer(-1);

  insertBesidePivot(ctx, key, hit.seq, where === "BEFORE", argv[4]!);
  return integer(addToCardinality(ctx, key, "list", 1));
};

const lrem: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const count = argIndex(argv[2]!);
  const element = argv[3]!;
  if (!ctx.store.expectType(key, "list")) return integer(0);

  const removed =
    count === COUNT_ALL
      ? ctx.sql.exec("DELETE FROM list WHERE key = ? AND val = ?", key, element).rowsWritten
      : ctx.sql.exec(
          `DELETE FROM list WHERE key = ? AND seq IN (
             SELECT seq FROM list WHERE key = ? AND val = ? ORDER BY seq ${count > 0 ? "ASC" : "DESC"} LIMIT ?
           )`,
          key,
          key,
          element,
          Math.abs(count),
        ).rowsWritten;

  dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "list", -removed));
  return integer(removed);
};

const ltrim: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const start = argIndex(argv[2]!);
  const stop = argIndex(argv[3]!);
  if (!ctx.store.expectType(key, "list")) return OK;

  const span = resolveRange(start, stop, listLength(ctx, key));
  if (span === null) {
    ctx.store.drop(key);
    return OK;
  }
  const removed = ctx.sql.exec(
    `DELETE FROM list WHERE key = ? AND seq NOT IN (
       SELECT seq FROM list WHERE key = ? ORDER BY seq LIMIT ? OFFSET ?
     )`,
    key,
    key,
    span[1] - span[0] + 1,
    span[0],
  ).rowsWritten;
  dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "list", -removed));
  return OK;
};

const move = (ctx: Ctx, src: Uint8Array, dst: Uint8Array, fromLeft: boolean, toLeft: boolean): Reply => {
  if (!ctx.store.expectType(src, "list")) return NULL;
  const dstExisted = ctx.store.expectType(dst, "list");

  const order = fromLeft ? "ASC" : "DESC";
  const rows = ctx.sql
    .exec<ElementRow>(`SELECT seq, val FROM list WHERE key = ? ORDER BY seq ${order} LIMIT 1`, src)
    .toArray();
  if (rows.length === 0) return NULL;

  const value = asBytes(rows[0]!.val);
  ctx.sql.exec("DELETE FROM list WHERE key = ? AND seq = ?", src, rows[0]!.seq);
  addToCardinality(ctx, src, "list", -1);
  insertBeyondEnd(ctx, dst, toLeft, value);
  addToCardinality(ctx, dst, "list", 1);

  if (!dstExisted) ctx.store.track(dst, "list");
  dropKeyWhenEmpty(ctx, src, cardinality(ctx, src, "list"));
  return bulk(value);
};

const lmove: Handler = (ctx, argv) => {
  const from = upper(argv[3]!);
  const to = upper(argv[4]!);
  if ((from !== "LEFT" && from !== "RIGHT") || (to !== "LEFT" && to !== "RIGHT")) fail(SYNTAX);
  return move(ctx, argv[1]!, argv[2]!, from === "LEFT", to === "LEFT");
};

const rpoplpush: Handler = (ctx, argv) => move(ctx, argv[1]!, argv[2]!, false, true);

interface PosOptions {
  readonly rank: number;
  readonly count: number;
  readonly maxlen: number;
}

const parsePosOptions = (argv: readonly Uint8Array[]): PosOptions => {
  let rank = 1;
  let count = COUNT_ABSENT;
  let maxlen = MAXLEN_UNLIMITED;
  for (let i = 3; i < argv.length; i += 2) {
    if (i + 1 >= argv.length) fail(SYNTAX);
    const option = upper(argv[i]!);
    const value = argIndex(argv[i + 1]!);
    if (option === "RANK") {
      if (value === 0) fail(RANK_ZERO);
      rank = value;
    } else if (option === "COUNT") {
      if (value < 0) fail(NEGATIVE_COUNT);
      count = value;
    } else if (option === "MAXLEN") {
      if (value < 0) fail(NEGATIVE_MAXLEN);
      maxlen = value;
    } else {
      fail(SYNTAX);
    }
  }
  return { rank, count, maxlen };
};

const lpos: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const element = argv[2]!;
  const { rank, count, maxlen } = parsePosOptions(argv);

  const found: Reply[] = [];
  if (ctx.store.expectType(key, "list")) {
    const forward = rank > 0;
    const matchesToSkip = Math.abs(rank) - 1;
    const wanted = count === COUNT_ALL ? Number.POSITIVE_INFINITY : Math.max(count, 1);
    let index = forward ? 0 : listLength(ctx, key) - 1;
    let examined = 0;
    let matches = 0;

    for (const row of ctx.sql
      .exec<ValRow>(`SELECT val FROM list WHERE key = ? ORDER BY seq ${forward ? "ASC" : "DESC"}`, key)
      .raw()) {
      if (maxlen !== MAXLEN_UNLIMITED && examined >= maxlen) break;
      examined++;
      if (sameBytes(asBytes(row[0]!), element)) {
        matches++;
        if (matches > matchesToSkip) {
          found.push(integer(index));
          if (found.length >= wanted) break;
        }
      }
      index += forward ? 1 : -1;
    }
  }

  if (count === COUNT_ABSENT) return found.length === 0 ? NULL : found[0]!;
  return array(found);
};

export const listCommands: readonly CommandSpec[] = [
  spec("lpush", -3, true, ONE_KEY, push(true, false)),
  spec("rpush", -3, true, ONE_KEY, push(false, false)),
  spec("lpushx", -3, true, ONE_KEY, push(true, true)),
  spec("rpushx", -3, true, ONE_KEY, push(false, true)),
  spec("lpop", -2, true, ONE_KEY, pop(true)),
  spec("rpop", -2, true, ONE_KEY, pop(false)),
  spec("llen", 2, false, ONE_KEY, llen),
  spec("lrange", 4, false, ONE_KEY, lrange),
  spec("lindex", 3, false, ONE_KEY, lindex),
  spec("lset", 4, true, ONE_KEY, lset),
  spec("linsert", 5, true, ONE_KEY, linsert),
  spec("lrem", 4, true, ONE_KEY, lrem),
  spec("ltrim", 4, true, ONE_KEY, ltrim),
  spec("rpoplpush", 3, true, FIRST_TWO_KEYS, rpoplpush),
  spec("lmove", 5, true, FIRST_TWO_KEYS, lmove),
  spec("lpos", -3, false, ONE_KEY, lpos),
];
