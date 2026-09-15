import {
  type Reply,
  EMPTY_ARRAY,
  NULL,
  array,
  bulk,
  error,
  integer,
  set as setReply,
  upper,
} from "../types";
import { SYNTAX, fail } from "../errors";
import type { SqlValue } from "../schema";
import { asBytes, byteKey } from "../store";
import { rejectOversizedValue } from "./string";
import {
  type CommandSpec,
  type Ctx,
  type Handler,
  ALL_KEYS,
  keysAfterCount,
  FIRST_TWO_KEYS,
  NO_KEYS,
  ONE_KEY,
  argIndex,
  sameBytes,
  spec,
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
}
const MUST_BE_POSITIVE = error("ERR value is out of range, must be positive");
const NUMKEYS_POSITIVE = error("ERR numkeys should be greater than 0");
const TOO_MANY_KEYS = error("ERR Number of keys can't be greater than number of args");
const NEGATIVE_LIMIT = error("ERR LIMIT can't be negative");

const UNLIMITED_INTERSECTION = 0;

type Operator = "INTERSECT" | "UNION" | "EXCEPT";

const membersOf = (ctx: Ctx, key: Uint8Array): Uint8Array[] =>
  ctx.sql
    .exec<MemberRow>("SELECT member FROM sett WHERE key = ?", key)
    .toArray()
    .map((row) => asBytes(row.member));

const memberIdentities = (ctx: Ctx, key: Uint8Array): Set<string> => {
  const ids = new Set<string>();
  for (const member of membersOf(ctx, key)) ids.add(byteKey(member));
  return ids;
};

const combineSets = (
  ctx: Ctx,
  operator: Operator,
  keys: readonly Uint8Array[],
): Uint8Array[] => {
  const first = keys[0];
  if (first === undefined) return [];

  const accumulated = new Map<string, Uint8Array>();
  for (const member of membersOf(ctx, first)) accumulated.set(byteKey(member), member);

  for (let i = 1; i < keys.length; i++) {
    if (operator !== "UNION" && accumulated.size === 0) break;

    if (operator === "UNION") {
      for (const member of membersOf(ctx, keys[i]!)) accumulated.set(byteKey(member), member);
      continue;
    }

    const operand = memberIdentities(ctx, keys[i]!);
    for (const id of [...accumulated.keys()]) {
      const shared = operand.has(id);
      if (operator === "INTERSECT" ? !shared : shared) accumulated.delete(id);
    }
  }

  return [...accumulated.keys()].sort().map((id) => accumulated.get(id)!);
};

const expectSets = (ctx: Ctx, keys: readonly Uint8Array[]): void => {
  for (const key of keys) ctx.store.expectType(key, "set");
};

const isMember = (ctx: Ctx, key: Uint8Array, member: Uint8Array): boolean =>
  ctx.sql.exec("SELECT 1 FROM sett WHERE key = ? AND member = ?", key, member).toArray().length > 0;

const addMember = (ctx: Ctx, key: Uint8Array, member: Uint8Array): number =>
  ctx.sql.exec("INSERT OR IGNORE INTO sett (key, member) VALUES (?, ?)", key, member).rowsWritten;

const sadd: Handler = (ctx, argv) => {
  const key = argv[1]!;
  for (let i = 2; i < argv.length; i++) rejectOversizedValue(argv[i]!.length);
  const existed = ctx.store.expectType(key, "set");
  let added = 0;
  for (let i = 2; i < argv.length; i++) added += addMember(ctx, key, argv[i]!);
  if (added > 0) addToCardinality(ctx, key, "set", added);
  if (!existed) ctx.store.track(key, "set");
  return integer(added);
};

const srem: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "set")) return integer(0);
  let removed = 0;
  for (let i = 2; i < argv.length; i++) {
    removed += ctx.sql.exec("DELETE FROM sett WHERE key = ? AND member = ?", key, argv[i]!).rowsWritten;
  }
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "set", -removed));
  }
  return integer(removed);
};

const smembers: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "set")) return setReply([]);
  const rows = ctx.sql
    .exec<MemberRow>("SELECT member FROM sett WHERE key = ? ORDER BY member", key)
    .toArray();
  return setReply(rows.map((row) => bulk(asBytes(row.member))));
};

const scard: Handler = (ctx, argv) => {
  const key = argv[1]!;
  return integer(ctx.store.expectType(key, "set") ? cardinality(ctx, key, "set") : 0);
};

const sismember: Handler = (ctx, argv) => {
  const key = argv[1]!;
  if (!ctx.store.expectType(key, "set")) return integer(0);
  return integer(isMember(ctx, key, argv[2]!) ? 1 : 0);
};

const smismember: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const exists = ctx.store.expectType(key, "set");
  const out: Reply[] = [];
  for (let i = 2; i < argv.length; i++) {
    out.push(integer(exists && isMember(ctx, key, argv[i]!) ? 1 : 0));
  }
  return array(out);
};

const smove: Handler = (ctx, argv) => {
  const src = argv[1]!;
  const dst = argv[2]!;
  const member = argv[3]!;
  rejectOversizedValue(member.length);
  const srcExists = ctx.store.expectType(src, "set");
  if (!srcExists) return integer(0);
  const dstExisted = ctx.store.expectType(dst, "set");
  if (!isMember(ctx, src, member)) return integer(0);
  if (sameBytes(src, dst)) return integer(1);

  const landed = addMember(ctx, dst, member);
  if (landed > 0) addToCardinality(ctx, dst, "set", landed);
  if (!dstExisted) ctx.store.track(dst, "set");

  const removed = ctx.sql.exec(
    "DELETE FROM sett WHERE key = ? AND member = ?",
    src,
    member,
  ).rowsWritten;
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, src, addToCardinality(ctx, src, "set", -removed));
  }
  return integer(1);
};

const algebra =
  (operator: Operator): Handler =>
  (ctx, argv) => {
    const keys = argv.slice(1);
    expectSets(ctx, keys);
    return setReply(combineSets(ctx, operator, keys).map((member) => bulk(member)));
  };

const storeInto =
  (operator: Operator): Handler =>
  (ctx, argv) => {
    const dst = argv[1]!;
    const keys = argv.slice(2);
    expectSets(ctx, keys);

    const members = combineSets(ctx, operator, keys);

    ctx.store.drop(dst);
    if (members.length === 0) return integer(0);

    for (const member of members) addMember(ctx, dst, member);
    ctx.store.track(dst, "set");
    setCardinality(ctx, dst, members.length);
    return integer(members.length);
  };

const sintercard: Handler = (ctx, argv) => {
  const parsedKeys = toI64(argv[1]!);
  if (parsedKeys === null || parsedKeys <= 0n) fail(NUMKEYS_POSITIVE);
  const numkeys = Number(parsedKeys);
  if (numkeys > argv.length - 2) fail(TOO_MANY_KEYS);
  const keys = argv.slice(2, 2 + numkeys);

  let limit = UNLIMITED_INTERSECTION;
  const rest = argv.slice(2 + numkeys);
  if (rest.length !== 0) {
    if (rest.length !== 2 || upper(rest[0]!) !== "LIMIT") fail(SYNTAX);
    const parsedLimit = toI64(rest[1]!);
    if (parsedLimit === null || parsedLimit < 0n) fail(NEGATIVE_LIMIT);
    limit = Number(parsedLimit);
  }

  expectSets(ctx, keys);
  const shared = combineSets(ctx, "INTERSECT", keys).length;
  return integer(limit === UNLIMITED_INTERSECTION ? shared : Math.min(shared, limit));
};

const spop: Handler = (ctx, argv) => {
  if (argv.length > 3) fail(SYNTAX);
  const key = argv[1]!;
  const counted = argv.length === 3;
  let count = 1;
  if (counted) {
    const parsed = toI64(argv[2]!);
    if (parsed === null || parsed < 0n) fail(MUST_BE_POSITIVE);
    count = Number(parsed);
  }

  const exists = ctx.store.expectType(key, "set");
  if (!exists) return counted ? setReply([]) : NULL;
  if (count === 0) return setReply([]);

  const size = cardinality(ctx, key, "set");
  if (counted && count >= size) {
    const rows = ctx.sql
      .exec<MemberRow>("SELECT member FROM sett WHERE key = ? ORDER BY member", key)
      .toArray();
    ctx.store.drop(key);
    return setReply(rows.map((row) => bulk(asBytes(row.member))));
  }

  const rows = ctx.sql
    .exec<MemberRow>("SELECT member FROM sett WHERE key = ? ORDER BY RANDOM() LIMIT ?", key, count)
    .toArray();
  let removed = 0;
  for (const row of rows) {
    removed += ctx.sql.exec(
      "DELETE FROM sett WHERE key = ? AND member = ?",
      key,
      asBytes(row.member),
    ).rowsWritten;
  }
  if (removed > 0) {
    dropKeyWhenEmpty(ctx, key, addToCardinality(ctx, key, "set", -removed));
  }

  return counted
    ? setReply(rows.map((row) => bulk(asBytes(row.member))))
    : bulk(asBytes(rows[0]!.member));
};

const srandmember: Handler = (ctx, argv) => {
  if (argv.length > 3) fail(SYNTAX);
  const key = argv[1]!;
  const count = argv.length === 2 ? null : argIndex(argv[2]!);
  const exists = ctx.store.expectType(key, "set");

  if (count === null) {
    if (!exists) return NULL;
    const rows = ctx.sql
      .exec<MemberRow>("SELECT member FROM sett WHERE key = ? ORDER BY RANDOM() LIMIT 1", key)
      .toArray();
    return rows.length === 0 ? NULL : bulk(asBytes(rows[0]!.member));
  }

  if (!exists || count === 0) return EMPTY_ARRAY;

  const picked = sampleRows<MemberRow>(
    ctx,
    key,
    cardinality(ctx, key, "set"),
    count,
    "SELECT member FROM sett WHERE key = ? ORDER BY RANDOM() LIMIT ?",
    "SELECT member FROM sett WHERE key = ? ORDER BY member",
    "SELECT member FROM sett WHERE key = ? ORDER BY member LIMIT 1 OFFSET ?",
  );
  return array(picked.map((row) => bulk(asBytes(row.member))));
};

const sscan: Handler = (ctx, argv) => {
  const key = argv[1]!;
  const args = parseScanArgs(argv, false);
  if (!ctx.store.expectType(key, "set")) return array([bulk("0"), EMPTY_ARRAY]);
  const page = elementScan(ctx, key, "sett", "member", null, args);
  return array([
    bulk(String(page.cursor)),
    array(page.rows.map((row) => bulk(row.element))),
  ]);
};

export const setCommands: readonly CommandSpec[] = [
  spec("sadd", -3, true, ONE_KEY, sadd),
  spec("srem", -3, true, ONE_KEY, srem),
  spec("smembers", 2, false, ONE_KEY, smembers),
  spec("sismember", 3, false, ONE_KEY, sismember),
  spec("smismember", -3, false, ONE_KEY, smismember),
  spec("scard", 2, false, ONE_KEY, scard),
  spec("spop", -2, true, ONE_KEY, spop),
  spec("srandmember", -2, false, ONE_KEY, srandmember),
  spec("smove", 4, true, FIRST_TWO_KEYS, smove),
  spec("sinter", -2, false, ALL_KEYS, algebra("INTERSECT")),
  spec("sintercard", -3, false, NO_KEYS, sintercard, keysAfterCount(1)),
  spec("sunion", -2, false, ALL_KEYS, algebra("UNION")),
  spec("sdiff", -2, false, ALL_KEYS, algebra("EXCEPT")),
  spec("sinterstore", -3, true, ALL_KEYS, storeInto("INTERSECT")),
  spec("sunionstore", -3, true, ALL_KEYS, storeInto("UNION")),
  spec("sdiffstore", -3, true, ALL_KEYS, storeInto("EXCEPT")),
  spec("sscan", -3, false, ONE_KEY, sscan),
];
