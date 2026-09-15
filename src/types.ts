export type Command = readonly Uint8Array[];

export type Reply =
  | { readonly kind: "simple"; readonly value: string }
  | { readonly kind: "error"; readonly value: string }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "bulk"; readonly value: Uint8Array }
  | { readonly kind: "array"; readonly value: readonly Reply[] }
  | { readonly kind: "double"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "map"; readonly value: readonly (readonly [Reply, Reply])[] }
  | { readonly kind: "set"; readonly value: readonly Reply[] }
  | { readonly kind: "push"; readonly value: readonly Reply[] }
  | { readonly kind: "null" }
  | { readonly kind: "nullArray" };

export type KeyType = "none" | "string" | "hash" | "list" | "set" | "zset";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export const simple = (value: string): Reply => ({ kind: "simple", value });
export const error = (value: string): Reply => ({ kind: "error", value });
export const integer = (value: bigint | number): Reply => ({ kind: "integer", value: BigInt(value) });
export const bulk = (value: Uint8Array | string): Reply => ({
  kind: "bulk",
  value: typeof value === "string" ? ENCODER.encode(value) : value,
});
export const array = (value: readonly Reply[]): Reply => ({ kind: "array", value });
export const double = (value: number): Reply => ({ kind: "double", value });
export const boolean = (value: boolean): Reply => ({ kind: "boolean", value });
export const map = (value: readonly (readonly [Reply, Reply])[]): Reply => ({ kind: "map", value });
export const set = (value: readonly Reply[]): Reply => ({ kind: "set", value });
export const push = (value: readonly Reply[]): Reply => ({ kind: "push", value });

export const OK: Reply = { kind: "simple", value: "OK" };
export const PONG: Reply = { kind: "simple", value: "PONG" };
export const NULL: Reply = { kind: "null" };
export const NULL_ARRAY: Reply = { kind: "nullArray" };
export const EMPTY_ARRAY: Reply = { kind: "array", value: [] };

export const decodeUtf8 = (bytes: Uint8Array): string => DECODER.decode(bytes);
export const encodeUtf8 = (text: string): Uint8Array => ENCODER.encode(text);
export const upper = (bytes: Uint8Array): string => DECODER.decode(bytes).toUpperCase();
