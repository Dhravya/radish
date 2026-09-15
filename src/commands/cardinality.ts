import { TABLE_META, TYPE_TABLE } from "../schema";
import type { KeyType } from "../types";
import type { Ctx } from "./spec";

export type AggregateType = Exclude<KeyType, "none" | "string">;

const NO_META_ROW = 0;

const NOT_YET_COUNTED = null;

interface CardRow {
  readonly card: number | null;
}

const storedCardinality = (ctx: Ctx, key: Uint8Array): number | null | undefined =>
  ctx.sql.exec<CardRow>(`SELECT card FROM ${TABLE_META} WHERE key = ?`, key).toArray()[0]?.card;

const countOnceAndRemember = (ctx: Ctx, key: Uint8Array, type: AggregateType): void => {
  ctx.sql.exec(
    `UPDATE ${TABLE_META}
        SET card = (SELECT COUNT(*) FROM ${TYPE_TABLE[type]} WHERE key = ?)
      WHERE key = ? AND card IS NULL`,
    key,
    key,
  );
};

export const cardinality = (ctx: Ctx, key: Uint8Array, type: AggregateType): number => {
  const stored = storedCardinality(ctx, key);
  if (stored === undefined) return NO_META_ROW;
  if (stored !== NOT_YET_COUNTED) return stored;
  countOnceAndRemember(ctx, key, type);
  return storedCardinality(ctx, key) ?? NO_META_ROW;
};

export const addToCardinality = (
  ctx: Ctx,
  key: Uint8Array,
  type: AggregateType,
  delta: number,
): number => {
  ctx.sql.exec(
    `INSERT INTO ${TABLE_META} (key, type, expire_at, card) VALUES (?, ?, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET card = card + excluded.card`,
    key,
    type,
    delta,
  );
  return cardinality(ctx, key, type);
};

export const setCardinality = (ctx: Ctx, key: Uint8Array, total: number): void => {
  ctx.sql.exec(`UPDATE ${TABLE_META} SET card = ? WHERE key = ?`, total, key);
};

export const forgetCardinality = (ctx: Ctx, key: Uint8Array): void => {
  ctx.sql.exec(`UPDATE ${TABLE_META} SET card = NULL WHERE key = ?`, key);
};

export const dropKeyWhenEmpty = (ctx: Ctx, key: Uint8Array, remaining: number): void => {
  if (remaining <= 0) ctx.store.drop(key);
};
