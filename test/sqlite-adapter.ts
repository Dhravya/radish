import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

import type {
  SqlBinding,
  SqlCursor,
  SqlRow,
  SqlRowShape,
  SqlStorage,
  SqlValue,
} from "../src/schema";

const bindTheWayWorkersDoes = (value: SqlBinding): SQLQueryBindings => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value as SQLQueryBindings;
};

const returnBlobsAsArrayBufferTheWayWorkersDoes = (value: unknown): SqlValue => {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (typeof value === "bigint") return Number(value);
  return value as SqlValue;
};

const isReadStatement = (query: string): boolean => /^\s*(?:select|with|pragma)\b/i.test(query);

export class FakeSqlStorage implements SqlStorage {
  readonly db = new Database(":memory:");

  get databaseSize(): number {
    const pages = Number(this.db.query("PRAGMA page_count").values()[0]?.[0] ?? 0);
    const pageBytes = Number(this.db.query("PRAGMA page_size").values()[0]?.[0] ?? 0);
    return pages * pageBytes;
  }
  readonly #prepared = new Map<string, Statement<SqlRow, SQLQueryBindings[]>>();

  exec<T extends SqlRowShape = SqlRow>(query: string, ...bindings: SqlBinding[]): SqlCursor<T> {
    const statement = this.#prepare(query);
    const params = bindings.map(bindTheWayWorkersDoes);

    let columnNames: string[] = [];
    let rows: SqlValue[][] = [];
    let rowsWritten = 0;

    if (isReadStatement(query)) {
      columnNames = statement.columnNames;
      rows = (statement.values(...params) as unknown[][]).map((row) =>
        row.map(returnBlobsAsArrayBufferTheWayWorkersDoes),
      );
    } else {
      rowsWritten = Number(statement.run(...params).changes);
    }

    const asObject = (row: SqlValue[]): T => {
      const out: SqlRow = {};
      columnNames.forEach((name, i) => {
        out[name] = row[i] as SqlValue;
      });
      return out as unknown as T;
    };

    return {
      columnNames,
      rowsWritten,
      toArray: () => rows.map(asObject),
      one: () => {
        if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
        return asObject(rows[0] as SqlValue[]);
      },
      raw: <U extends SqlValue[] = SqlValue[]>() => rows.values() as IterableIterator<U>,
    };
  }

  #prepare(query: string): Statement<SqlRow, SQLQueryBindings[]> {
    let statement = this.#prepared.get(query);
    if (statement === undefined) {
      statement = this.db.prepare<SqlRow, SQLQueryBindings[]>(query);
      this.#prepared.set(query, statement);
    }
    return statement;
  }
}
