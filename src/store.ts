import {
  COUNTER_SCAN_CURSOR_ID,
  DATA_TABLES,
  TABLE_INTERNAL_COUNTERS,
  TABLE_META,
  TABLE_SCAN_CURSOR,
  TABLE_STRING,
  TIER_COLD,
  TIER_HOT,
  TIER_WARM,
  TYPE_TABLE,
  applySchema,
  type SqlBinding,
  type SqlRow,
  type SqlRowShape,
  type SqlStorage,
  type SqlValue,
} from "./schema";
import { GLOB_PATTERN_TOO_LONG, WRONGTYPE, fail } from "./errors";
import { type KeyType, encodeUtf8 } from "./types";

const ABANDONED_CURSOR_AFTER_MS = 60_000;

const CURSOR_EXHAUSTED = 0;

export type Tier = typeof TIER_HOT | typeof TIER_WARM | typeof TIER_COLD;

export interface EvictionCandidate {
  key: Uint8Array;
  tier: Tier;
  type: KeyType;
  bytes: number;
  ttlMs: number | null;
  idleMs: number;
}

const NEVER_TOUCHED = Number.POSITIVE_INFINITY;

const EVICT_ANYTHING_NOT_ALREADY_EXPIRED = 0;

export const TOUCH_CLOCK_RESOLUTION_MS = 1_000;

export const TOUCH_SAMPLE_ONE_IN = 16;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const ESTIMATED_BYTES_PER_ELEMENT = 64;

const NOTHING_TO_RECLAIM = 0;

const DATABASE_SIZE_UNAVAILABLE = 0;

const WARM_NEEDS_A_VERSION = "markWarm needs the R2 version it is vouching for";

const COLD_NEEDS_AN_UPLOAD = "markCold refused: only a warm key has an R2 copy to fall back on";

const touchIsSampled = (key: Uint8Array, nowMs: number): boolean => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of key) hash = Math.imul(hash ^ byte, FNV_PRIME);
  hash = Math.imul(hash ^ Math.floor(nowMs / TOUCH_CLOCK_RESOLUTION_MS), FNV_PRIME);
  return (hash >>> 0) % TOUCH_SAMPLE_ONE_IN === 0;
};

const asTier = (stored: string | null | undefined): Tier =>
  stored === TIER_WARM || stored === TIER_COLD ? stored : TIER_HOT;

const valueTableOf = (type: string): string | undefined =>
  (TYPE_TABLE as Readonly<Record<string, string | undefined>>)[type];

const STRAY_ROWS_OUTSIDE: Readonly<Record<string, string>> = Object.fromEntries(
  DATA_TABLES.map((owned) => [
    owned,
    `${DATA_TABLES.filter((other) => other !== owned)
      .map((other) => `SELECT 1 AS found FROM ${other} WHERE key = ?`)
      .join(" UNION ALL ")} LIMIT 1`,
  ]),
);

export const asBytes = (value: SqlValue | Uint8Array): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`expected a BLOB column, got ${typeof value}`);
};

export const byteKey = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
};

const deadlineReached = (expireAt: number | null, nowMs: number): expireAt is number =>
  expireAt !== null && expireAt <= nowMs;

const GLOB_STAR = 0x2a;
const GLOB_HYPHEN = 0x2d;
const GLOB_QUESTION = 0x3f;
const GLOB_OPEN_CLASS = 0x5b;
const GLOB_ESCAPE = 0x5c;
const GLOB_CLOSE_CLASS = 0x5d;
const GLOB_NEGATE = 0x5e;

const RANGE_WIDTH = 3;
const ESCAPE_WIDTH = 2;
const NO_RESTART = -1;

export const MAX_GLOB_PATTERN_BYTES = 1024;

const ensureMatchable = (pattern: Uint8Array): Uint8Array => {
  if (pattern.length > MAX_GLOB_PATTERN_BYTES) fail(GLOB_PATTERN_TOO_LONG);
  return pattern;
};

interface ClassMatch {
  matched: boolean;
  next: number;
}

const matchClass = (pattern: Uint8Array, openBracket: number, subject: number): ClassMatch => {
  let i = openBracket + 1;
  const negated = pattern[i] === GLOB_NEGATE;
  if (negated) i += 1;

  let matched = false;
  for (;;) {
    const remaining = pattern.length - i;
    if (remaining === 0) break;

    const byte = pattern[i]!;
    if (byte === GLOB_ESCAPE && remaining >= ESCAPE_WIDTH) {
      i += 1;
      if (pattern[i] === subject) matched = true;
    } else if (byte === GLOB_CLOSE_CLASS) {
      return { matched: matched !== negated, next: i + 1 };
    } else if (remaining >= RANGE_WIDTH && pattern[i + 1] === GLOB_HYPHEN) {
      const other = pattern[i + 2]!;
      const low = byte <= other ? byte : other;
      const high = byte <= other ? other : byte;
      if (subject >= low && subject <= high) matched = true;
      i += 2;
    } else if (byte === subject) {
      matched = true;
    }
    i += 1;
  }

  return { matched: matched !== negated, next: pattern.length };
};

export const matchGlob = (pattern: Uint8Array, subject: Uint8Array): boolean => {
  ensureMatchable(pattern);

  let p = 0;
  let s = 0;
  let restartPattern = NO_RESTART;
  let restartSubject = 0;

  while (s < subject.length) {
    const byte = p < pattern.length ? pattern[p]! : NO_RESTART;

    if (byte === GLOB_STAR) {
      restartPattern = p;
      restartSubject = s;
      p += 1;
      continue;
    }
    if (byte === GLOB_QUESTION) {
      p += 1;
      s += 1;
      continue;
    }
    if (byte === GLOB_OPEN_CLASS) {
      const klass = matchClass(pattern, p, subject[s]!);
      if (klass.matched) {
        p = klass.next;
        s += 1;
        continue;
      }
    } else if (byte === GLOB_ESCAPE && p + 1 < pattern.length) {
      if (pattern[p + 1] === subject[s]) {
        p += ESCAPE_WIDTH;
        s += 1;
        continue;
      }
    } else if (byte === subject[s]) {
      p += 1;
      s += 1;
      continue;
    }

    if (restartPattern === NO_RESTART) return false;
    restartSubject += 1;
    s = restartSubject;
    p = restartPattern + 1;
  }

  while (p < pattern.length && pattern[p] === GLOB_STAR) p += 1;
  return p === pattern.length;
};

const patternBytes = (pattern: string | Uint8Array): Uint8Array =>
  typeof pattern === "string" ? encodeUtf8(pattern) : pattern;

const UNUSED_REGEXP_SOURCE = "(?:)";

class ByteGlobRegExp extends RegExp {
  readonly #pattern: Uint8Array;

  constructor(pattern: string) {
    super(UNUSED_REGEXP_SOURCE);
    this.#pattern = ensureMatchable(encodeUtf8(pattern));
  }

  override test(subject: string): boolean {
    return matchGlob(this.#pattern, encodeUtf8(subject));
  }
}

export const globToRegExp = (pattern: string): RegExp => new ByteGlobRegExp(pattern);

interface MetaRow {
  readonly type: string;
  readonly expire_at: number | null;
}

const NO_MEMOIZED_EPOCH = Number.NaN;

const KEY_IS_ABSENT = null;

interface TierRow {
  tier: string;
  r2_version: string | null;
}

interface CandidateRow {
  key: SqlValue;
  type: string;
  tier: string;
  card: number | null;
  expire_at: number | null;
  touched_at: number | null;
  val_bytes: number | null;
}

interface KeyPageRow extends MetaRow {
  key: SqlValue;
}

interface CountRow {
  n: number;
}

interface FoundRow {
  found: number;
}

export interface ScanPage {
  cursor: number;
  keys: Uint8Array[];
}

export const SCAN_CURSOR_EXPIRED = null;

export class Store {
  readonly sql: SqlStorage;
  readonly #clock: () => number;
  #memoizedKey: Uint8Array | null = null;
  #memoizedRow: MetaRow | typeof KEY_IS_ABSENT = KEY_IS_ABSENT;
  #memoizedAt = NO_MEMOIZED_EPOCH;

  constructor(sql: SqlStorage, clock: () => number = Date.now) {
    this.sql = sql;
    this.#clock = clock;
    applySchema(sql);
  }

  now(): number {
    return this.#clock();
  }

  // The sole existence check: it deletes an expired key before answering "none", so read rows directly only after this says the key is live.
  typeOf(key: Uint8Array): KeyType {
    const nowMs = this.now();
    const row = this.#metaRow(key, nowMs);
    if (row === undefined) return "none";
    if (deadlineReached(row.expire_at, nowMs)) {
      this.#purge(key, row.type);
      return "none";
    }
    return row.type as KeyType;
  }

  liveRow<T extends SqlRowShape = SqlRow>(
    key: Uint8Array,
    alsoSelect: string,
    ...alsoSelectBindings: SqlBinding[]
  ): (MetaRow & T) | undefined {
    const nowMs = this.now();
    const row = this.sql
      .exec<MetaRow & T>(
        `SELECT type, expire_at, ${alsoSelect} FROM ${TABLE_META} WHERE key = ?`,
        ...alsoSelectBindings,
        key,
      )
      .toArray()[0];

    if (row === undefined) {
      this.#remember(key, KEY_IS_ABSENT, nowMs);
      return undefined;
    }
    if (deadlineReached(row.expire_at, nowMs)) {
      this.#purge(key, row.type);
      return undefined;
    }

    this.#remember(key, { type: row.type, expire_at: row.expire_at }, nowMs);
    return row;
  }

  expectType(key: Uint8Array, want: KeyType): boolean {
    const actual = this.typeOf(key);
    if (actual === "none") return false;
    if (actual !== want) fail(WRONGTYPE);
    return true;
  }

  track(key: Uint8Array, type: KeyType): void {
    const deadline = this.typeOf(key) === "none" ? null : (this.#metaRow(key)?.expire_at ?? null);
    this.#forgetEveryKey();
    this.sql.exec(
      `INSERT INTO ${TABLE_META} (key, type, expire_at, tier, r2_version, touched_at)
       VALUES (?, ?, NULL, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         type = excluded.type,
         tier = excluded.tier,
         r2_version = NULL,
         touched_at = excluded.touched_at`,
      key,
      type,
      TIER_HOT,
      this.now(),
    );
    this.#remember(key, { type, expire_at: deadline });
  }

  forget(key: Uint8Array): void {
    if (this.#memoizedKey !== null && byteKey(this.#memoizedKey) === byteKey(key)) {
      this.#forgetEveryKey();
    }
  }

  untrack(key: Uint8Array): void {
    this.sql.exec(`DELETE FROM ${TABLE_META} WHERE key = ?`, key);
    this.#remember(key, KEY_IS_ABSENT);
  }

  drop(key: Uint8Array): boolean {
    const type = this.typeOf(key);
    if (type === "none") return false;
    this.#purge(key, type);
    return true;
  }

  dropIfEmpty(key: Uint8Array, type: KeyType): void {
    if (type === "none") return;
    const remaining = this.sql
      .exec<CountRow>(`SELECT COUNT(*) AS n FROM ${TYPE_TABLE[type]} WHERE key = ?`, key)
      .one().n;
    if (remaining === 0 && this.tierOf(key) !== TIER_COLD) this.#purge(key, type);
  }

  tierOf(key: Uint8Array): Tier {
    if (this.typeOf(key) === "none") return TIER_HOT;
    return asTier(this.#tierRow(key)?.tier);
  }

  r2VersionOf(key: Uint8Array): string | null {
    if (this.typeOf(key) === "none") return null;
    return this.#tierRow(key)?.r2_version ?? null;
  }

  markHot(key: Uint8Array): void {
    this.sql.exec(
      `UPDATE ${TABLE_META} SET tier = ?, r2_version = NULL, touched_at = ? WHERE key = ?`,
      TIER_HOT,
      this.now(),
      key,
    );
  }

  markWarm(key: Uint8Array, version: string): void {
    if (version.length === 0) throw new Error(WARM_NEEDS_A_VERSION);
    if (this.typeOf(key) === "none") return;
    this.sql.exec(
      `UPDATE ${TABLE_META} SET tier = ?, r2_version = ? WHERE key = ?`,
      TIER_WARM,
      version,
      key,
    );
  }

  markCold(key: Uint8Array): void {
    const type = this.typeOf(key);
    if (type === "none") return;
    const row = this.#tierRow(key);
    if (row === undefined) return;

    const tier = asTier(row.tier);
    if (tier === TIER_COLD) return;
    if (tier !== TIER_WARM) throw new Error(COLD_NEEDS_AN_UPLOAD);

    this.sql.exec(`DELETE FROM ${TYPE_TABLE[type]} WHERE key = ?`, key);
    this.sql.exec(
      `UPDATE ${TABLE_META} SET tier = ?, r2_version = ? WHERE key = ?`,
      TIER_COLD,
      row.r2_version,
      key,
    );
  }

  touch(key: Uint8Array, nowMs: number): void {
    if (touchIsSampled(key, nowMs)) {
      this.sql.exec(
        `UPDATE ${TABLE_META} SET touched_at = ?
          WHERE key = ? AND (touched_at IS NULL OR touched_at <= ?)`,
        nowMs,
        key,
        nowMs - TOUCH_CLOCK_RESOLUTION_MS,
      );
      return;
    }
    this.sql.exec(
      `UPDATE ${TABLE_META} SET touched_at = ? WHERE key = ? AND touched_at IS NULL`,
      nowMs,
      key,
    );
  }

  evictionCandidates(
    limit: number,
    expiringWithinMs: number = EVICT_ANYTHING_NOT_ALREADY_EXPIRED,
  ): EvictionCandidate[] {
    const nowMs = this.now();
    const rows = this.sql
      .exec<CandidateRow>(
        `SELECT key, type, tier, card, expire_at, touched_at,
                CASE WHEN type = 'string'
                     THEN (SELECT LENGTH(val) FROM ${TABLE_STRING}
                            WHERE ${TABLE_STRING}.key = ${TABLE_META}.key)
                     END AS val_bytes
           FROM ${TABLE_META}
          WHERE tier <> '${TIER_COLD}'
            AND (expire_at IS NULL OR expire_at > ?)
          ORDER BY touched_at ASC
          LIMIT ?`,
        nowMs + Math.max(0, expiringWithinMs),
        Math.max(0, Math.trunc(limit)),
      )
      .toArray();

    return rows.map((row) => {
      const key = asBytes(row.key);
      const type = row.type as KeyType;
      return {
        key,
        tier: asTier(row.tier),
        type,
        bytes: this.#reclaimableBytes(row, key, type),
        ttlMs: row.expire_at === null ? null : row.expire_at - nowMs,
        idleMs: row.touched_at === null ? NEVER_TOUCHED : nowMs - row.touched_at,
      };
    });
  }

  databaseBytes(): number {
    return this.sql.databaseSize ?? DATABASE_SIZE_UNAVAILABLE;
  }

  expireAt(key: Uint8Array, atMs: number | null): boolean {
    const type = this.typeOf(key);
    if (type === "none") return false;
    if (deadlineReached(atMs, this.now())) {
      this.#purge(key, type);
      return true;
    }
    this.sql.exec(`UPDATE ${TABLE_META} SET expire_at = ? WHERE key = ?`, atMs, key);
    this.#remember(key, { type, expire_at: atMs });
    return true;
  }

  deadlineOf(key: Uint8Array): number | null {
    if (this.typeOf(key) === "none") return null;
    return this.#metaRow(key)?.expire_at ?? null;
  }

  ttlMs(key: Uint8Array): number | null {
    if (this.typeOf(key) === "none") return null;
    const row = this.#metaRow(key);
    if (row === undefined || row.expire_at === null) return null;
    return row.expire_at - this.now();
  }

  persist(key: Uint8Array): boolean {
    const type = this.typeOf(key);
    if (type === "none") return false;
    if (this.#metaRow(key)?.expire_at == null) return false;
    this.sql.exec(
      `UPDATE ${TABLE_META} SET expire_at = NULL WHERE key = ? AND expire_at IS NOT NULL`,
      key,
    );
    this.#remember(key, { type, expire_at: null });
    return true;
  }

  nextExpiry(): number | null {
    return this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(expire_at) AS at FROM ${TABLE_META} WHERE expire_at IS NOT NULL`,
      )
      .one().at;
  }

  sweep(nowMs: number = this.now()): number {
    const expired: { key: Uint8Array; type: string }[] = [];
    for (const [key, type] of this.sql
      .exec(
        `SELECT key, type FROM ${TABLE_META} WHERE expire_at IS NOT NULL AND expire_at <= ?`,
        nowMs,
      )
      .raw()) {
      expired.push({ key: asBytes(key as SqlValue), type: type as string });
    }
    for (const row of expired) this.#purge(row.key, row.type);
    return expired.length;
  }

  scan(
    cursor: number,
    count: number,
    match?: string | Uint8Array,
    type?: KeyType,
  ): ScanPage | typeof SCAN_CURSOR_EXPIRED {
    const limit = Math.max(1, Math.trunc(count));
    this.#collectAbandonedCursors(cursor);

    let resumeAfter: Uint8Array | null = null;
    if (cursor !== CURSOR_EXHAUSTED) {
      resumeAfter = this.#resumePosition(cursor);
      if (resumeAfter === null) {
        if (this.#cursorWasIssued(cursor)) return SCAN_CURSOR_EXPIRED;
        return { cursor: CURSOR_EXHAUSTED, keys: [] };
      }
    }

    const rows =
      resumeAfter === null ? this.#firstKeyPage(limit) : this.#keyPageAfter(resumeAfter, limit);

    const pattern = match === undefined ? null : ensureMatchable(patternBytes(match));
    const nowMs = this.now();
    const keys: Uint8Array[] = [];
    const expired: { key: Uint8Array; type: string }[] = [];
    let examinedLast: Uint8Array | null = null;

    for (const row of rows) {
      const key = asBytes(row.key);
      examinedLast = key;

      if (deadlineReached(row.expire_at, nowMs)) {
        expired.push({ key, type: row.type });
      } else if (
        (type === undefined || row.type === type) &&
        (pattern === null || matchGlob(pattern, key))
      ) {
        keys.push(key);
      }
    }

    for (const row of expired) this.#purge(row.key, row.type);

    const pageWasFull = rows.length === limit;
    if (!pageWasFull || examinedLast === null) {
      if (cursor !== CURSOR_EXHAUSTED) this.#forgetCursor(cursor);
      return { cursor: CURSOR_EXHAUSTED, keys };
    }

    const id = cursor !== CURSOR_EXHAUSTED ? cursor : this.#mintNeverUsedCursorId();
    this.#rememberPosition(id, examinedLast);
    return { cursor: id, keys };
  }

  flush(): void {
    this.#forgetEveryKey();
    this.sql.exec(`DELETE FROM ${TABLE_META}`);
    for (const table of DATA_TABLES) this.sql.exec(`DELETE FROM ${table}`);
    this.sql.exec(`DELETE FROM ${TABLE_SCAN_CURSOR}`);
  }

  dbsize(): number {
    return this.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS n FROM ${TABLE_META} WHERE expire_at IS NULL OR expire_at > ?`,
        this.now(),
      )
      .one().n;
  }

  #reclaimableBytes(row: CandidateRow, key: Uint8Array, type: KeyType): number {
    if (type === "none") return NOTHING_TO_RECLAIM;
    if (type === "string") return key.length + (row.val_bytes ?? 0);
    const elements = row.card ?? this.#countOnceAndRemember(key, type);
    return elements * (key.length + ESTIMATED_BYTES_PER_ELEMENT);
  }

  #countOnceAndRemember(key: Uint8Array, type: Exclude<KeyType, "none">): number {
    const counted = this.sql
      .exec<CountRow>(`SELECT COUNT(*) AS n FROM ${TYPE_TABLE[type]} WHERE key = ?`, key)
      .one().n;
    this.sql.exec(
      `UPDATE ${TABLE_META} SET card = ? WHERE key = ? AND card IS NULL`,
      counted,
      key,
    );
    return counted;
  }

  #tierRow(key: Uint8Array): TierRow | undefined {
    return this.sql
      .exec<TierRow>(`SELECT tier, r2_version FROM ${TABLE_META} WHERE key = ?`, key)
      .toArray()[0];
  }

  #remember(key: Uint8Array, row: MetaRow | typeof KEY_IS_ABSENT, nowMs = this.now()): void {
    this.#memoizedKey = key;
    this.#memoizedRow = row;
    this.#memoizedAt = nowMs;
  }

  #forgetEveryKey(): void {
    this.#memoizedKey = null;
    this.#memoizedAt = NO_MEMOIZED_EPOCH;
  }

  #metaRow(key: Uint8Array, nowMs = this.now()): MetaRow | undefined {
    if (this.#memoizedKey === key && this.#memoizedAt === nowMs) {
      return this.#memoizedRow ?? undefined;
    }

    const row = this.sql
      .exec<MetaRow>(`SELECT type, expire_at FROM ${TABLE_META} WHERE key = ?`, key)
      .toArray()[0];
    this.#remember(key, row ?? KEY_IS_ABSENT, nowMs);
    return row;
  }

  #purge(key: Uint8Array, type: string): void {
    this.#remember(key, KEY_IS_ABSENT);
    this.sql.exec(`DELETE FROM ${TABLE_META} WHERE key = ?`, key);

    const owned = valueTableOf(type);
    if (owned === undefined) {
      this.#purgeEveryValueTable(key);
      return;
    }
    this.sql.exec(`DELETE FROM ${owned} WHERE key = ?`, key);
    if (this.#strayRowsOutside(owned, key)) this.#purgeEveryValueTable(key);
  }

  #purgeEveryValueTable(key: Uint8Array): void {
    for (const table of DATA_TABLES) {
      this.sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
    }
  }

  #strayRowsOutside(owned: string, key: Uint8Array): boolean {
    const probe = STRAY_ROWS_OUTSIDE[owned] as string;
    return (
      this.sql.exec<FoundRow>(probe, key, key, key, key).toArray().length > 0
    );
  }

  #firstKeyPage(limit: number): KeyPageRow[] {
    return this.sql
      .exec<KeyPageRow>(
        `SELECT key, type, expire_at FROM ${TABLE_META} ORDER BY key LIMIT ?`,
        limit,
      )
      .toArray();
  }

  #keyPageAfter(after: Uint8Array, limit: number): KeyPageRow[] {
    return this.sql
      .exec<KeyPageRow>(
        `SELECT key, type, expire_at FROM ${TABLE_META} WHERE key > ? ORDER BY key LIMIT ?`,
        after,
        limit,
      )
      .toArray();
  }

  #resumePosition(cursor: number): Uint8Array | null {
    const row = this.sql
      .exec<{ last: SqlValue }>(`SELECT last FROM ${TABLE_SCAN_CURSOR} WHERE id = ?`, cursor)
      .toArray()[0];
    return row === undefined ? null : asBytes(row.last);
  }

  #rememberPosition(id: number, last: Uint8Array): void {
    this.sql.exec(
      `INSERT INTO ${TABLE_SCAN_CURSOR} (id, last, touched) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last = excluded.last, touched = excluded.touched`,
      id,
      last,
      this.now(),
    );
  }

  #forgetCursor(cursor: number): void {
    this.sql.exec(`DELETE FROM ${TABLE_SCAN_CURSOR} WHERE id = ?`, cursor);
  }

  #collectAbandonedCursors(exceptCursor: number): void {
    this.sql.exec(
      `DELETE FROM ${TABLE_SCAN_CURSOR} WHERE touched < ? AND id != ?`,
      this.now() - ABANDONED_CURSOR_AFTER_MS,
      exceptCursor,
    );
  }

  #cursorWasIssued(cursor: number): boolean {
    const row = this.sql
      .exec<{ value: number }>(
        `SELECT value FROM ${TABLE_INTERNAL_COUNTERS} WHERE name = ?`,
        COUNTER_SCAN_CURSOR_ID,
      )
      .toArray()[0];
    return row !== undefined && cursor <= row.value;
  }

  #mintNeverUsedCursorId(): number {
    this.sql.exec(
      `INSERT INTO ${TABLE_INTERNAL_COUNTERS} (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      COUNTER_SCAN_CURSOR_ID,
    );
    return this.sql
      .exec<{ value: number }>(
        `SELECT value FROM ${TABLE_INTERNAL_COUNTERS} WHERE name = ?`,
        COUNTER_SCAN_CURSOR_ID,
      )
      .one().value;
  }
}
