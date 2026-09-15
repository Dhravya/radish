import type { KeyType } from "./types";

export type SqlValue = ArrayBuffer | string | number | null;

export type SqlBinding = ArrayBuffer | ArrayBufferView | string | number | null;

export type SqlRow = Record<string, SqlValue>;

export type SqlRowShape = NonNullable<unknown>;

export interface SqlCursor<T extends SqlRowShape = SqlRow> {
  toArray(): T[];
  one(): T;
  raw<U extends SqlValue[] = SqlValue[]>(): IterableIterator<U>;
  readonly columnNames: string[];
  readonly rowsWritten: number;
}

export interface SqlStorage {
  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T>;
  readonly databaseSize?: number;
}

export const TABLE_META = "meta";
export const TABLE_STRING = "str";
export const TABLE_HASH = "hash";
export const TABLE_SET = "sett";
export const TABLE_LIST = "list";
export const TABLE_ZSET = "zset";
export const TABLE_SCAN_CURSOR = "scan_cursor";
export const TABLE_INTERNAL_COUNTERS = "state";

export const COUNTER_SCAN_CURSOR_ID = "scan_cursor_seq";

export const TIER_HOT = "hot";
export const TIER_WARM = "warm";
export const TIER_COLD = "cold";

export const TYPE_TABLE: Readonly<Record<Exclude<KeyType, "none">, string>> = {
  string: TABLE_STRING,
  hash: TABLE_HASH,
  list: TABLE_LIST,
  set: TABLE_SET,
  zset: TABLE_ZSET,
};

export const DATA_TABLES: readonly string[] = [
  TABLE_STRING,
  TABLE_HASH,
  TABLE_LIST,
  TABLE_SET,
  TABLE_ZSET,
];

export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE_META} (
     key BLOB PRIMARY KEY,
     type TEXT NOT NULL,
     expire_at INTEGER,
     card INTEGER,
     tier TEXT NOT NULL DEFAULT '${TIER_HOT}',
     r2_version TEXT,
     touched_at INTEGER
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS meta_expire ON ${TABLE_META}(expire_at)`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_STRING} (
     key BLOB PRIMARY KEY,
     val BLOB NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_HASH} (
     key BLOB,
     field BLOB,
     val BLOB NOT NULL,
     PRIMARY KEY(key, field)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_SET} (
     key BLOB,
     member BLOB,
     PRIMARY KEY(key, member)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_LIST} (
     key BLOB,
     seq REAL,
     val BLOB NOT NULL,
     PRIMARY KEY(key, seq)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_ZSET} (
     key BLOB,
     member BLOB,
     score REAL NOT NULL,
     PRIMARY KEY(key, member)
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS zset_by_score ON ${TABLE_ZSET}(key, score, member)`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_SCAN_CURSOR} (
     id INTEGER PRIMARY KEY,
     last BLOB NOT NULL,
     touched INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_INTERNAL_COUNTERS} (
     name TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   ) WITHOUT ROWID`,
];

const COLUMNS_ADDED_TO_EXISTING_META: readonly string[] = [
  `ALTER TABLE ${TABLE_META} ADD COLUMN card INTEGER`,
  `ALTER TABLE ${TABLE_META} ADD COLUMN tier TEXT NOT NULL DEFAULT '${TIER_HOT}'`,
  `ALTER TABLE ${TABLE_META} ADD COLUMN r2_version TEXT`,
  `ALTER TABLE ${TABLE_META} ADD COLUMN touched_at INTEGER`,
];

const demotesToHot = (row: string): string =>
  `UPDATE ${TABLE_META}
      SET tier = '${TIER_HOT}', r2_version = NULL
    WHERE key = ${row}.key AND tier <> '${TIER_HOT}';`;

const invalidatesTheR2Copy = (
  table: string,
  event: string,
  suffix: string,
  rows: readonly string[],
): string =>
  `CREATE TRIGGER IF NOT EXISTS ${table}_${suffix}_is_hot AFTER ${event} ON ${table}
   BEGIN
     ${rows.map(demotesToHot).join("\n     ")}
   END`;

const TIER_SCHEMA: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS meta_evictable ON ${TABLE_META}(touched_at)
     WHERE tier <> '${TIER_COLD}'`,

  ...DATA_TABLES.flatMap((table) => [
    invalidatesTheR2Copy(table, "INSERT", "insert", ["NEW"]),
    invalidatesTheR2Copy(table, "UPDATE", "update", ["OLD", "NEW"]),
    invalidatesTheR2Copy(table, "DELETE", "delete", ["OLD"]),
  ]),
];

export const applySchema = (sql: SqlStorage): void => {
  for (const statement of SCHEMA) sql.exec(statement);
  for (const statement of COLUMNS_ADDED_TO_EXISTING_META) {
    try {
      sql.exec(statement);
    } catch {
      continue;
    }
  }
  for (const statement of TIER_SCHEMA) sql.exec(statement);
};
