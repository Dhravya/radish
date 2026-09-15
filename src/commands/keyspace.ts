import { TABLE_META, TYPE_TABLE, type SqlValue } from "../schema";
import { SCAN_CURSOR_EXPIRED, asBytes, globToRegExp } from "../store";
import { NO_SUCH_KEY, SYNTAX, invalidExpire } from "../errors";
import {
  type Command,
  type KeyType,
  type Reply,
  NULL,
  OK,
  array,
  bulk,
  error,
  integer,
  simple,
  upper,
  decodeUtf8,
} from "../types";
import {
  type CommandSpec,
  type Ctx,
  ALL_KEYS,
  argI64,
  argIndex,
  ascii,
  deadlineOf,
  FIRST_TWO_KEYS,
  I64_MAX,
  I64_MIN,
  NO_KEYS,
  ONE_KEY,
  sameBytes,
  spec,
} from "./spec";

const INVALID_CURSOR = error("ERR invalid cursor");
const EXPIRED_CURSOR = error("ERR scan cursor expired");
const DB_OUT_OF_RANGE = error("ERR DB index is out of range");
const SAME_OBJECT = error("ERR source and destination objects are the same");
const NX_NOT_COMPATIBLE = error(
  "ERR NX and XX, GT or LT options at the same time are not compatible",
);
const GT_LT_NOT_COMPATIBLE = error(
  "ERR GT and LT options at the same time are not compatible",
);
const unsupportedOption = (opt: string): Reply => error(`ERR Unsupported option ${opt}`);

const DEFAULT_SCAN_COUNT = 10;
const STRTOULL_DECIMAL = /^[ \t\n\v\f\r]*\+?[0-9]+$/;
const U64_MAX = 2n ** 64n - 1n;
const LARGEST_ISSUABLE_CURSOR = BigInt(Number.MAX_SAFE_INTEGER);

const toU64 = (bytes: Uint8Array): bigint | null => {
  const text = decodeUtf8(bytes);
  if (!STRTOULL_DECIMAL.test(text)) return null;
  const value = BigInt(text);
  return value > U64_MAX ? null : value;
};

const finishedScan = (): Reply => array([bulk(ascii("0")), array([])]);

const MS_PER_SECOND = 1000;
const HALF_SECOND_MS = 500;
const MAX_EXPIRE_SECONDS = I64_MAX / 1000n;
const MIN_EXPIRE_SECONDS = I64_MIN / 1000n;
const LARGEST_EXACT_DEADLINE_MS = BigInt(Number.MAX_SAFE_INTEGER);

const PAYLOAD_COLUMNS: Readonly<Record<Exclude<KeyType, "none">, string>> = {
  string: "val",
  hash: "field, val",
  set: "member",
  list: "seq, val",
  zset: "member, score",
};

const del: CommandSpec["handler"] = (ctx, argv) => {
  let removed = 0;
  for (let j = 1; j < argv.length; j++) {
    if (ctx.store.drop(argv[j] as Uint8Array)) removed++;
  }
  return integer(removed);
};

const countExisting: CommandSpec["handler"] = (ctx, argv) => {
  let found = 0;
  for (let j = 1; j < argv.length; j++) {
    if (ctx.store.typeOf(argv[j] as Uint8Array) !== "none") found++;
  }
  return integer(found);
};

const type: CommandSpec["handler"] = (ctx, argv) =>
  simple(ctx.store.typeOf(argv[1] as Uint8Array));

const liveKeys = (ctx: Ctx): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (const [key] of ctx.sql
    .exec<{ key: SqlValue }>(
      `SELECT key FROM ${TABLE_META} WHERE expire_at IS NULL OR expire_at > ? ORDER BY key`,
      ctx.now,
    )
    .raw()) {
    out.push(asBytes(key as SqlValue));
  }
  return out;
};

const keys: CommandSpec["handler"] = (ctx, argv) => {
  const pattern = globToRegExp(decodeUtf8(argv[1] as Uint8Array));
  const out: Reply[] = [];
  for (const key of liveKeys(ctx)) {
    if (pattern.test(decodeUtf8(key))) out.push(bulk(key));
  }
  return array(out);
};

const scan: CommandSpec["handler"] = (ctx, argv) => {
  const cursor = toU64(argv[1] as Uint8Array);
  if (cursor === null) return INVALID_CURSOR;

  let count = DEFAULT_SCAN_COUNT;
  let match: string | undefined;
  let want: KeyType | undefined;

  for (let j = 2; j < argv.length; j++) {
    const opt = upper(argv[j] as Uint8Array);
    const next = j + 1 < argv.length ? (argv[j + 1] as Uint8Array) : null;
    if (next === null) return SYNTAX;

    if (opt === "COUNT") {
      count = argIndex(next);
      if (count < 1) return SYNTAX;
    } else if (opt === "MATCH") {
      match = decodeUtf8(next);
    } else if (opt === "TYPE") {
      want = decodeUtf8(next).toLowerCase() as KeyType;
    } else return SYNTAX;
    j++;
  }

  if (cursor > LARGEST_ISSUABLE_CURSOR) return finishedScan();

  const page = ctx.store.scan(Number(cursor), count, match, want);
  if (page === SCAN_CURSOR_EXPIRED) return EXPIRED_CURSOR;
  return array([bulk(ascii(String(page.cursor))), array(page.keys.map(bulk))]);
};

const randomkey: CommandSpec["handler"] = (ctx) => {
  const row = ctx.sql
    .exec<{ key: SqlValue }>(
      `SELECT key FROM ${TABLE_META}
       WHERE expire_at IS NULL OR expire_at > ?
       ORDER BY RANDOM() LIMIT 1`,
      ctx.now,
    )
    .toArray()[0];
  return row === undefined ? NULL : bulk(asBytes(row.key));
};

const moveKey = (
  ctx: Ctx,
  from: Uint8Array,
  to: Uint8Array,
  type: Exclude<KeyType, "none">,
  deadline: number | null,
): void => {
  ctx.store.drop(to);
  ctx.sql.exec(`UPDATE ${TYPE_TABLE[type]} SET key = ? WHERE key = ?`, to, from);
  ctx.store.untrack(from);
  ctx.store.track(to, type);
  if (deadline !== null) ctx.store.expireAt(to, deadline);
};

const renameGeneric = (ctx: Ctx, argv: Command, nx: boolean): Reply => {
  const from = argv[1] as Uint8Array;
  const to = argv[2] as Uint8Array;

  const type = ctx.store.typeOf(from);
  if (type === "none") return NO_SUCH_KEY;
  if (sameBytes(from, to)) return nx ? integer(0) : OK;
  if (nx && ctx.store.typeOf(to) !== "none") return integer(0);

  moveKey(ctx, from, to, type, deadlineOf(ctx, from));
  return nx ? integer(1) : OK;
};

const copy: CommandSpec["handler"] = (ctx, argv) => {
  const from = argv[1] as Uint8Array;
  const to = argv[2] as Uint8Array;
  let replace = false;

  for (let j = 3; j < argv.length; j++) {
    const opt = upper(argv[j] as Uint8Array);
    if (opt === "REPLACE") replace = true;
    else if (opt === "DB" && j + 1 < argv.length) {
      if (argI64(argv[j + 1] as Uint8Array) !== 0n) return DB_OUT_OF_RANGE;
      j++;
    } else return SYNTAX;
  }

  if (sameBytes(from, to)) return SAME_OBJECT;

  const type = ctx.store.typeOf(from);
  if (type === "none") return integer(0);

  const deadline = deadlineOf(ctx, from);
  if (ctx.store.typeOf(to) !== "none") {
    if (!replace) return integer(0);
    ctx.store.drop(to);
  }

  const table = TYPE_TABLE[type];
  const payload = PAYLOAD_COLUMNS[type];
  ctx.sql.exec(
    `INSERT INTO ${table} (key, ${payload})
     SELECT ?, ${payload} FROM ${table} WHERE key = ?`,
    to,
    from,
  );
  ctx.store.track(to, type);
  if (deadline !== null) ctx.store.expireAt(to, deadline);
  return integer(1);
};

interface ExpireFlags {
  readonly nx: boolean;
  readonly xx: boolean;
  readonly gt: boolean;
  readonly lt: boolean;
}

const parseExpireFlags = (argv: Command, from: number): ExpireFlags | Reply => {
  let nx = false;
  let xx = false;
  let gt = false;
  let lt = false;

  for (let j = from; j < argv.length; j++) {
    switch (upper(argv[j] as Uint8Array)) {
      case "NX":
        nx = true;
        break;
      case "XX":
        xx = true;
        break;
      case "GT":
        gt = true;
        break;
      case "LT":
        lt = true;
        break;
      default:
        return unsupportedOption(decodeUtf8(argv[j] as Uint8Array));
    }
  }

  if (nx && (xx || gt || lt)) return NX_NOT_COMPATIBLE;
  if (gt && lt) return GT_LT_NOT_COMPATIBLE;
  return { nx, xx, gt, lt };
};

const blockedByFlags = (
  flags: ExpireFlags,
  when: bigint,
  current: number | null,
): boolean => {
  if (flags.nx && current !== null) return true;
  if (flags.xx && current === null) return true;
  if (flags.gt && (current === null || when <= BigInt(current))) return true;
  if (flags.lt && current !== null && when >= BigInt(current)) return true;
  return false;
};

const applyExpire = (
  ctx: Ctx,
  argv: Command,
  command: string,
  basetime: number,
  inSeconds: boolean,
): Reply => {
  const flags = parseExpireFlags(argv, 3);
  if (!("nx" in flags)) return flags;

  let when = argI64(argv[2] as Uint8Array);
  if (inSeconds) {
    if (when > MAX_EXPIRE_SECONDS || when < MIN_EXPIRE_SECONDS) return invalidExpire(command);
    when *= BigInt(MS_PER_SECOND);
  }
  if (when > I64_MAX - BigInt(basetime)) return invalidExpire(command);
  when += BigInt(basetime);
  if (when > LARGEST_EXACT_DEADLINE_MS) return invalidExpire(command);

  const key = argv[1] as Uint8Array;
  if (ctx.store.typeOf(key) === "none") return integer(0);
  if (blockedByFlags(flags, when, deadlineOf(ctx, key))) return integer(0);

  ctx.store.expireAt(key, Number(when));
  return integer(1);
};

const reportTtl = (ctx: Ctx, argv: Command, inMilliseconds: boolean): Reply => {
  const key = argv[1] as Uint8Array;
  if (ctx.store.typeOf(key) === "none") return integer(-2);

  const deadline = deadlineOf(ctx, key);
  if (deadline === null) return integer(-1);

  const remaining = Math.max(0, deadline - ctx.now);
  if (inMilliseconds) return integer(remaining);
  return integer(Math.floor((remaining + HALF_SECOND_MS) / MS_PER_SECOND));
};

const persist: CommandSpec["handler"] = (ctx, argv) =>
  integer(ctx.store.persist(argv[1] as Uint8Array) ? 1 : 0);

export const keyspaceCommands: readonly CommandSpec[] = [
  spec("del", -2, true, ALL_KEYS, del),
  spec("unlink", -2, true, ALL_KEYS, del),
  spec("exists", -2, false, ALL_KEYS, countExisting),
  spec("type", 2, false, ONE_KEY, type),
  spec("keys", 2, false, NO_KEYS, keys),
  spec("scan", -2, false, NO_KEYS, scan),
  spec("rename", 3, true, FIRST_TWO_KEYS, (ctx, argv) => renameGeneric(ctx, argv, false)),
  spec("renamenx", 3, true, FIRST_TWO_KEYS, (ctx, argv) => renameGeneric(ctx, argv, true)),
  spec("expire", -3, true, ONE_KEY, (ctx, argv) => applyExpire(ctx, argv, "expire", ctx.now, true)),
  spec("pexpire", -3, true, ONE_KEY, (ctx, argv) => applyExpire(ctx, argv, "pexpire", ctx.now, false)),
  spec("expireat", -3, true, ONE_KEY, (ctx, argv) => applyExpire(ctx, argv, "expireat", 0, true)),
  spec("pexpireat", -3, true, ONE_KEY, (ctx, argv) => applyExpire(ctx, argv, "pexpireat", 0, false)),
  spec("ttl", 2, false, ONE_KEY, (ctx, argv) => reportTtl(ctx, argv, false)),
  spec("pttl", 2, false, ONE_KEY, (ctx, argv) => reportTtl(ctx, argv, true)),
  spec("persist", 2, true, ONE_KEY, persist),
  spec("randomkey", 1, false, NO_KEYS, randomkey),
  spec("copy", -3, true, FIRST_TWO_KEYS, copy),
  spec("touch", -2, false, ALL_KEYS, countExisting),
];
