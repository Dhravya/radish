import {
  type Reply,
  EMPTY_ARRAY,
  NULL,
  NULL_ARRAY,
  array,
  bulk,
  double,
  error,
  integer,
  upper,
} from "../types";
import { NAN_RESULT, SYNTAX, fail, wrongArity } from "../errors";
import { formatDouble } from "../dtoa";
import type { SqlBinding, SqlValue } from "../schema";
import { asBytes } from "../store";
import {
  type CommandSpec,
  type Ctx,
  type Handler,
  ONE_KEY,
  argDouble,
  argIndex,
  spec,
  toDouble,
  toI64,
} from "./spec";
import { elementScan, parseScanArgs, sampleRows } from "./hash";
import {
  addToCardinality,
  cardinality,
  dropKeyWhenEmpty,
  setCardinality,
} from "./cardinality";

interface MemberRow {
  readonly member: SqlValue;
  readonly score: number;
}
interface ScoreRow {
  readonly score: number;
}
interface CountRow {
  readonly n: number;
}

const NX_XX_CONFLICT = error("ERR XX and NX options at the same time are not compatible");
const GT_LT_NX_CONFLICT = error("ERR GT, LT, and/or NX options at the same time are not compatible");
const INCR_SINGLE_PAIR = error("ERR INCR option supports a single increment-element pair");
const MIN_MAX_NOT_FLOAT = error("ERR min or max is not a float");
const MIN_MAX_NOT_LEX = error("ERR min or max not valid string range item");
const LIMIT_NEEDS_BY = error(
  "ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX",
);
const WITHSCORES_NOT_BYLEX = error("ERR syntax error, WITHSCORES not supported in combination with BYLEX");
const MUST_BE_POSITIVE = error("ERR value is out of range, must be positive");

const SQLITE_NO_LIMIT = -1;
const LIMIT_ABSENT = -1;

const tieBreakByMemberBytes = (direction: "ASC" | "DESC"): string =>
  `score ${direction}, member ${direction}`;

const SCORE_THEN_MEMBER = tieBreakByMemberBytes("ASC");

interface ScoreBound {
  readonly value: number;
  readonly exclusive: boolean;
}

const parseScoreBound = (bytes: Uint8Array): ScoreBound => {
  const exclusive = bytes[0] === 0x28;
  const value = toDouble(exclusive ? bytes.subarray(1) : bytes) ?? fail(MIN_MAX_NOT_FLOAT);
  return { value, exclusive };
};

interface LexBound {
  readonly value: Uint8Array | null;
  readonly exclusive: boolean;
}

const parseLexBound = (bytes: Uint8Array): LexBound => {
  if (bytes.length === 0) fail(MIN_MAX_NOT_LEX);
  const lead = bytes[0]!;
  if (bytes.length === 1 && (lead === 0x2d || lead === 0x2b)) return { value: null, exclusive: false };
  if (lead !== 0x5b && lead !== 0x28) fail(MIN_MAX_NOT_LEX);
  return { value: bytes.subarray(1), exclusive: lead === 0x28 };
};

const lexSentinel = (bytes: Uint8Array): "-" | "+" | null => {
  if (bytes.length !== 1) return null;
  return bytes[0] === 0x2d ? "-" : bytes[0] === 0x2b ? "+" : null;
};

type Predicate = { readonly sql: string; readonly bindings: readonly SqlBinding[] };

const admitsEveryScoreBelow = (min: ScoreBound): boolean =>
  min.value === Number.NEGATIVE_INFINITY && !min.exclusive;

const admitsEveryScoreAbove = (max: ScoreBound): boolean =>
  max.value === Number.POSITIVE_INFINITY && !max.exclusive;

const scorePredicate = (min: ScoreBound, max: ScoreBound): Predicate => {
  let sql = "";
  const bindings: SqlBinding[] = [];
  if (!admitsEveryScoreBelow(min)) {
    sql += ` AND score ${min.exclusive ? ">" : ">="} ?`;
    bindings.push(min.value);
  }
  if (!admitsEveryScoreAbove(max)) {
    sql += ` AND score ${max.exclusive ? "<" : "<="} ?`;
    bindings.push(max.value);
  }
  return { sql, bindings };
};

const lexPredicate = (min: LexBound, max: LexBound): Predicate => {
  let sql = "";
  const bindings: SqlBinding[] = [];
  if (min.value !== null) {
    sql += ` AND member ${min.exclusive ? ">" : ">="} ?`;
    bindings.push(min.value);
  }
  if (max.value !== null) {
    sql += ` AND member ${max.exclusive ? "<" : "<="} ?`;
    bindings.push(max.value);
  }
  return { sql, bindings };
};

const zcardOf = (ctx: Ctx, key: Uint8Array): number => cardinality(ctx, key, "zset");

const scoreOf = (ctx: Ctx, key: Uint8Array, member: Uint8Array): number | null => {
  const rows = ctx.sql
    .exec<ScoreRow>("SELECT score FROM zset WHERE key = ? AND member = ?", key, member)
    .toArray();
  return rows.length === 0 ? null : rows[0]!.score;
};

const flattenMemberScores = (rows: readonly MemberRow[]): Reply[] => {
  const out: Reply[] = [];
  for (const row of rows) {
    out.push(bulk(asBytes(row.member)));
    out.push(double(row.score));
  }
  return out;
};

const memberScorePairs = (ctx: Ctx, rows: readonly MemberRow[]): Reply =>
  ctx.conn.protocol === 3
    ? array(rows.map((row) => array([bulk(asBytes(row.member)), double(row.score)])))
    : array(flattenMemberScores(rows));

const withScores = (ctx: Ctx, rows: readonly MemberRow[], scored: boolean): Reply =>
  scored ? memberScorePairs(ctx, rows) : array(rows.map((row) => bulk(asBytes(row.member))));

const resolveRange = (start: number, stop: number, length: number): readonly [number, number] | null => {
  if (start < 0) start = length + start;
  if (stop < 0) stop = length + stop;
  if (start < 0) start = 0;
  if (start > stop || start >= length) return null;
  if (stop >= length) stop = length - 1;
  return [start, stop];
};

const zadd: Handler = (ctx, argv) => {
  const key = argv[1]!;
  let at = 2;
  let nx = false;
  let xx = false;
  let gt = false;
  let lt = false;
  let ch = false;
  let incr = false;
  for (; at < argv.length; at++) {
    const flag = upper(argv[at]!);
    if (flag === "NX") nx = true;
    else if (flag === "XX") xx = true;
    else if (flag === "GT") gt = true;
    else if (flag === "LT") lt = true;
    else if (flag === "CH") ch = true;
    else if (flag === "INCR") incr = true;
    else break;
  }

  const remaining = argv.length - at;
  if (remaining === 0 || remaining % 2 !== 0) return wrongArity("zadd");
  if (nx && xx) fail(NX_XX_CONFLICT);
  if ((gt && nx) || (lt && nx) || (gt && lt)) fail(GT_LT_NX_CONFLICT);
  if (incr && remaining !== 2) fail(INCR_SINGLE_PAIR);

  const pairs: { score: number; member: Uint8Array }[] = [];
  for (let i = at; i < argv.length; i += 2) {
    pairs.push({ score: argDouble(argv[i]!), member: argv[i + 1]! });
  }

  const existed = ctx.store.expectType(key, "zset");
  let added = 0;
  let changed = 0;
  let incrResult: number | null = null;

  for (const { score, member } of pairs) {
    const current = scoreOf(ctx, key, member);
    if (current !== null) {
      if (nx) continue;
      const next = incr ? current + score : score;
      if (Number.isNaN(next)) fail(NAN_RESULT);
      if ((lt && next >= current) || (gt && next <= current)) {
        if (incr) return NULL;
        continue;
      }
      if (next !== current) {
        ctx.sql.exec("UPDATE zset SET score = ? WHERE key = ? AND member = ?", next, key, member);
        changed++;
      }
      incrResult = next;
    } else {
      if (xx) {
        if (incr) return NULL;
        continue;
      }
      ctx.sql.exec("INSERT INTO zset (key, member, score) VALUES (?, ?, ?)", key, member, score);
      added++;
      incrResult = score;
    }
  }

  if (added > 0) {
    addToCardinality(ctx, key, "zset", added);
    if (!existed) ctx.store.track(key, "zset");
  }
  if (incr) return incrResult === null ? NULL : double(incrResult);
  return integer(ch ? added + changed : added);
};

const zincrby: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const increment = argDouble(argv[2]!);
  const member = argv[3]!;
  const existed = ctx.store.expectType(key, "zset");
  const current = scoreOf(ctx, key, member);
  const next = (current ?? 0) + increment;
  if (Number.isNaN(next)) fail(NAN_RESULT);
  if (current === null) {
    ctx.sql.exec("INSERT INTO zset (key, member, score) VALUES (?, ?, ?)", key, member, next);
    addToCardinality(ctx, key, "zset", 1);
    if (!existed) ctx.store.track(key, "zset");
  } else {
    ctx.sql.exec("UPDATE zset SET score = ? WHERE key = ? AND member = ?", next, key, member);
  }
  return double(next);
};

const zrem: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "zset")) return integer(0);
  let removed = 0;
  for (let i = 2; i < argv.length; i++) {
    removed += ctx.sql.exec("DELETE FROM zset WHERE key = ? AND member = ?", key, argv[i]!).rowsWritten;
  }
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "zset", -removed));
  }
  return integer(removed);
};

const zscore: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "zset")) return NULL;
  const score = scoreOf(ctx, key, argv[2]!);
  return score === null ? NULL : double(score);
};

const zmscore: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const exists = ctx.store.expectType(key, "zset");
  const out: Reply[] = [];
  for (let i = 2; i < argv.length; i++) {
    const score = exists ? scoreOf(ctx, key, argv[i]!) : null;
    out.push(score === null ? NULL : double(score));
  }
  return array(out);
};

const zcard: Handler = (ctx, argv) => {
  const key = argv[1]!;
  return integer(ctx.store.expectType(key, "zset") ? zcardOf(ctx, key) : 0);
};

const zcount: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const where = scorePredicate(parseScoreBound(argv[2]!), parseScoreBound(argv[3]!));
  if (!ctx.store.expectType(key, "zset")) return integer(0);
  return integer(
    ctx.sql
      .exec<CountRow>(`SELECT COUNT(*) AS n FROM zset WHERE key = ?${where.sql}`, key, ...where.bindings)
      .one().n,
  );
};

const rank =
  (reverse: boolean): Handler =>
  (ctx, argv) => {
    if (argv.length > 4) fail(wrongArity(reverse ? "zrevrank" : "zrank"));
    let scored = false;
    if (argv.length === 4) {
      if (upper(argv[3]!) !== "WITHSCORE") fail(SYNTAX);
      scored = true;
    }
    const key = argv[1]!;
    const member = argv[2]!;
    const missing = scored ? NULL_ARRAY : NULL;
    if (!ctx.store.expectType(key, "zset")) return missing;
    const score = scoreOf(ctx, key, member);
    if (score === null) return missing;

    const aheadOfMember = reverse ? "(score, member) > (?, ?)" : "(score, member) < (?, ?)";

    const position = ctx.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS n FROM zset WHERE key = ? AND ${aheadOfMember}`,
        key,
        score,
        member,
      )
      .one().n;
    return scored ? array([integer(position), double(score)]) : integer(position);
  };

type RangeKind = "index" | "score" | "lex";

type Bounds =
  | { readonly kind: "index"; readonly start: number; readonly stop: number }
  | { readonly kind: "score"; readonly min: ScoreBound; readonly max: ScoreBound }
  | { readonly kind: "lex"; readonly min: LexBound; readonly max: LexBound; readonly empty: boolean };

const sentinelsCrossOver = (low: Uint8Array, high: Uint8Array): boolean =>
  lexSentinel(low) === "+" || lexSentinel(high) === "-";

const parseBounds = (kind: RangeKind, low: Uint8Array, high: Uint8Array): Bounds => {
  if (kind === "index") return { kind, start: argIndex(low), stop: argIndex(high) };
  if (kind === "score") return { kind, min: parseScoreBound(low), max: parseScoreBound(high) };
  return {
    kind,
    min: parseLexBound(low),
    max: parseLexBound(high),
    empty: sentinelsCrossOver(low, high),
  };
};

const rangeRows = (
  ctx: Ctx,
  key: Uint8Array,
  bounds: Bounds,
  reverse: boolean,
  offset: number,
  count: number,
): MemberRow[] => {
  const direction = reverse ? "DESC" : "ASC";

  if (bounds.kind === "index") {
    const span = resolveRange(bounds.start, bounds.stop, zcardOf(ctx, key));
    if (span === null) return [];
    return ctx.sql
      .exec<MemberRow>(
        `SELECT member, score FROM zset WHERE key = ?
         ORDER BY ${tieBreakByMemberBytes(direction)} LIMIT ? OFFSET ?`,
        key,
        span[1] - span[0] + 1,
        span[0],
      )
      .toArray();
  }

  if (bounds.kind === "lex" && bounds.empty) return [];
  if (offset < 0) return [];

  const where =
    bounds.kind === "score"
      ? scorePredicate(bounds.min, bounds.max)
      : lexPredicate(bounds.min, bounds.max);
  const order = bounds.kind === "lex" ? `member ${direction}` : tieBreakByMemberBytes(direction);

  return ctx.sql
    .exec<MemberRow>(
      `SELECT member, score FROM zset WHERE key = ?${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      key,
      ...where.bindings,
      count < 0 ? SQLITE_NO_LIMIT : count,
      offset,
    )
    .toArray();
};

const parseLimit = (argv: readonly Uint8Array[], i: number): readonly [number, number] => {
  if (i + 2 >= argv.length) fail(SYNTAX);
  return [argIndex(argv[i + 1]!), argIndex(argv[i + 2]!)];
};

const zrange: Handler = (ctx, argv) => {
  let kind: RangeKind = "index";
  let reverse = false;
  let scored = false;
  let offset = 0;
  let count = LIMIT_ABSENT;
  let limited = false;

  for (let i = 4; i < argv.length; ) {
    const option = upper(argv[i]!);
    if (option === "WITHSCORES") {
      scored = true;
      i += 1;
    } else if (option === "REV") {
      reverse = true;
      i += 1;
    } else if (option === "BYSCORE") {
      kind = "score";
      i += 1;
    } else if (option === "BYLEX") {
      kind = "lex";
      i += 1;
    } else if (option === "LIMIT") {
      [offset, count] = parseLimit(argv, i);
      limited = true;
      i += 3;
    } else {
      fail(SYNTAX);
    }
  }

  if (limited && kind === "index") fail(LIMIT_NEEDS_BY);
  if (scored && kind === "lex") fail(WITHSCORES_NOT_BYLEX);

  const boundsWrittenDescending = reverse && kind !== "index";
  const low = boundsWrittenDescending ? argv[3]! : argv[2]!;
  const high = boundsWrittenDescending ? argv[2]! : argv[3]!;

  const bounds = parseBounds(kind, low, high);
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "zset")) return EMPTY_ARRAY;
  return withScores(ctx, rangeRows(ctx, key, bounds, reverse, offset, count), scored);
};

const zrangeLegacy =
  (kind: RangeKind, reverse: boolean): Handler =>
  (ctx, argv) => {
    let scored = false;
    let offset = 0;
    let count = LIMIT_ABSENT;
    for (let i = 4; i < argv.length; ) {
      const option = upper(argv[i]!);
      if (option === "WITHSCORES" && kind !== "lex") {
        scored = true;
        i += 1;
      } else if (option === "LIMIT" && kind !== "index") {
        [offset, count] = parseLimit(argv, i);
        i += 3;
      } else {
        fail(SYNTAX);
      }
    }

    const boundsWrittenDescending = reverse && kind !== "index";
    const low = boundsWrittenDescending ? argv[3]! : argv[2]!;
    const high = boundsWrittenDescending ? argv[2]! : argv[3]!;

    const bounds = parseBounds(kind, low, high);
    const key = argv[1]!;
    if (!ctx.store.expectType(key, "zset")) return EMPTY_ARRAY;
    return withScores(ctx, rangeRows(ctx, key, bounds, reverse, offset, count), scored);
  };

const zremrangebyrank: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const start = argIndex(argv[2]!);
  const stop = argIndex(argv[3]!);
  if (!ctx.store.expectType(key, "zset")) return integer(0);
  const total = zcardOf(ctx, key);
  const span = resolveRange(start, stop, total);
  if (span === null) return integer(0);
  const removed = ctx.sql.exec(
    `DELETE FROM zset WHERE key = ? AND member IN (
       SELECT member FROM zset WHERE key = ? ORDER BY ${SCORE_THEN_MEMBER} LIMIT ? OFFSET ?
     )`,
    key,
    key,
    span[1] - span[0] + 1,
    span[0],
  ).rowsWritten;
  setCardinality(ctx, key, total - removed);
  dropKeyWhenEmpty(ctx, key, total - removed);
  return integer(removed);
};

const zremrangebyscore: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const where = scorePredicate(parseScoreBound(argv[2]!), parseScoreBound(argv[3]!));
  if (!ctx.store.expectType(key, "zset")) return integer(0);
  const removed = ctx.sql.exec(
    `DELETE FROM zset WHERE key = ?${where.sql}`,
    key,
    ...where.bindings,
  ).rowsWritten;
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "zset", -removed));
  }
  return integer(removed);
};

const zremrangebylex: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const bounds = parseBounds("lex", argv[2]!, argv[3]!);
  if (bounds.kind !== "lex" || bounds.empty) return integer(0);
  const where = lexPredicate(bounds.min, bounds.max);
  if (!ctx.store.expectType(key, "zset")) return integer(0);
  const removed = ctx.sql.exec(
    `DELETE FROM zset WHERE key = ?${where.sql}`,
    key,
    ...where.bindings,
  ).rowsWritten;
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "zset", -removed));
  }
  return integer(removed);
};

const zpop =
  (lowest: boolean): Handler =>
  (ctx, argv) => {
    if (argv.length > 3) fail(SYNTAX);
    const counted = argv.length === 3;
    let count = 1;
    if (counted) {
      const parsed = toI64(argv[2]!);
      if (parsed === null || parsed < 0n) fail(MUST_BE_POSITIVE);
      count = Number(parsed);
    }
    const key = argv[1]!;
    if (!ctx.store.expectType(key, "zset") || count === 0) return EMPTY_ARRAY;

    const direction = lowest ? "ASC" : "DESC";
    const rows = ctx.sql
      .exec<MemberRow>(
        `SELECT member, score FROM zset WHERE key = ? ORDER BY ${tieBreakByMemberBytes(direction)} LIMIT ?`,
        key,
        count,
      )
      .toArray();
    let removed = 0;
    for (const row of rows) {
      removed += ctx.sql.exec(
        "DELETE FROM zset WHERE key = ? AND member = ?",
        key,
        asBytes(row.member),
      ).rowsWritten;
    }
    if (removed > 0) {
      dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "zset", -removed));
    }
    return counted ? memberScorePairs(ctx, rows) : array(flattenMemberScores(rows));
  };

const zrandmember: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const exists = ctx.store.expectType(key, "zset");

  if (argv.length === 2) {
    if (!exists) return NULL;
    const rows = ctx.sql
      .exec<MemberRow>("SELECT member, score FROM zset WHERE key = ? ORDER BY RANDOM() LIMIT 1", key)
      .toArray();
    return rows.length === 0 ? NULL : bulk(asBytes(rows[0]!.member));
  }

  if (argv.length > 4) fail(SYNTAX);
  const count = argIndex(argv[2]!);
  let scored = false;
  if (argv.length === 4) {
    if (upper(argv[3]!) !== "WITHSCORES") fail(SYNTAX);
    scored = true;
  }
  if (!exists || count === 0) return EMPTY_ARRAY;

  const size = zcardOf(ctx, key);
  const picked = sampleRows<MemberRow>(
    ctx,
    key,
    size,
    count,
    "SELECT member, score FROM zset WHERE key = ? ORDER BY RANDOM() LIMIT ?",
    `SELECT member, score FROM zset WHERE key = ? ORDER BY ${SCORE_THEN_MEMBER}`,
    `SELECT member, score FROM zset WHERE key = ? ORDER BY ${SCORE_THEN_MEMBER} LIMIT 1 OFFSET ?`,
  );
  return withScores(ctx, picked, scored);
};

const zscan: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const args = parseScanArgs(argv, false);
  if (!ctx.store.expectType(key, "zset")) return array([bulk("0"), EMPTY_ARRAY]);

  const page = elementScan(ctx, key, "zset", "member", "score", args);
  const out: Reply[] = [];
  for (const row of page.rows) {
    out.push(bulk(row.element));
    out.push(bulk(formatDouble(row.extra as number)));
  }
  return array([bulk(String(page.cursor)), array(out)]);
};

export const zsetCommands: readonly CommandSpec[] = [
  spec("zadd", -4, true, ONE_KEY, zadd),
  spec("zrem", -3, true, ONE_KEY, zrem),
  spec("zscore", 3, false, ONE_KEY, zscore),
  spec("zmscore", -3, false, ONE_KEY, zmscore),
  spec("zcard", 2, false, ONE_KEY, zcard),
  spec("zcount", 4, false, ONE_KEY, zcount),
  spec("zincrby", 4, true, ONE_KEY, zincrby),
  spec("zrange", -4, false, ONE_KEY, zrange),
  spec("zrevrange", -4, false, ONE_KEY, zrangeLegacy("index", true)),
  spec("zrangebyscore", -4, false, ONE_KEY, zrangeLegacy("score", false)),
  spec("zrevrangebyscore", -4, false, ONE_KEY, zrangeLegacy("score", true)),
  spec("zrangebylex", -4, false, ONE_KEY, zrangeLegacy("lex", false)),
  spec("zrevrangebylex", -4, false, ONE_KEY, zrangeLegacy("lex", true)),
  spec("zrank", -3, false, ONE_KEY, rank(false)),
  spec("zrevrank", -3, false, ONE_KEY, rank(true)),
  spec("zpopmin", -2, true, ONE_KEY, zpop(true)),
  spec("zpopmax", -2, true, ONE_KEY, zpop(false)),
  spec("zrandmember", -2, false, ONE_KEY, zrandmember),
  spec("zremrangebyrank", 4, true, ONE_KEY, zremrangebyrank),
  spec("zremrangebyscore", 4, true, ONE_KEY, zremrangebyscore),
  spec("zremrangebylex", 4, true, ONE_KEY, zremrangebylex),
  spec("zscan", -3, false, ONE_KEY, zscan),
];
