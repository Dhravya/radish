import { PROTO_MAX_BULK_LEN } from "../errors";
import type { SqlValue } from "../schema";
import { type KeyType, encodeUtf8 } from "../types";

export type StoredType = Exclude<KeyType, "none">;

export interface EvictedValue<T extends KeyType = KeyType> {
  readonly type: T;
  readonly rows: readonly (readonly SqlValue[])[];
}

export type CodecFailure =
  | "magic"
  | "version"
  | "type"
  | "arity"
  | "cell"
  | "text"
  | "varint"
  | "length"
  | "truncated"
  | "trailing";

export class TierCodecError extends Error {
  constructor(
    readonly failure: CodecFailure,
    detail: string,
  ) {
    super(`tier codec ${failure}: ${detail}`);
    this.name = "TierCodecError";
  }
}

const refuse = (failure: CodecFailure, detail: string): never => {
  throw new TierCodecError(failure, detail);
};

export const TIER_MAGIC: Uint8Array = Uint8Array.of(0x44, 0x4f, 0x52, 0x44);
export const TIER_FORMAT_VERSION = 1;

const VERSION_OFFSET = 4;
const TYPE_OFFSET = 5;
const ROW_COUNT_OFFSET = 6;
const BODY_LENGTH_OFFSET = 10;
export const TIER_HEADER_BYTES = 18;

const CELL_NULL = 0x00;
const CELL_NUMBER = 0x01;
const CELL_BLOB = 0x02;
const CELL_TEXT = 0x03;

const DOUBLE_BYTES = 8;
const MAX_VARINT_BYTES = 5;
const VARINT_PAYLOAD = 0x7f;
const VARINT_CONTINUE = 0x80;
const VARINT_RADIX = 0x80;
const LITTLE_ENDIAN = true;

interface RowLayout {
  readonly code: number;
  readonly arity: number;
}

const LAYOUT: Readonly<Record<StoredType, RowLayout>> = {
  string: { code: 1, arity: 1 },
  hash: { code: 2, arity: 2 },
  list: { code: 3, arity: 2 },
  set: { code: 4, arity: 1 },
  zset: { code: 5, arity: 2 },
};

const TYPE_BY_CODE = new Map<number, StoredType>(
  (Object.keys(LAYOUT) as StoredType[]).map((type) => [LAYOUT[type].code, type]),
);

const layoutOf = (type: KeyType): RowLayout =>
  type === "none" ? refuse("type", "a missing key has no rows to evict") : LAYOUT[type];

const varintSize = (value: number): number =>
  value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : value < 0x10000000 ? 4 : 5;

const writeVarint = (out: Uint8Array, offset: number, value: number): number => {
  let rest = value;
  let at = offset;
  while (rest >= VARINT_RADIX) {
    out[at] = (rest & VARINT_PAYLOAD) | VARINT_CONTINUE;
    at += 1;
    rest >>>= 7;
  }
  out[at] = rest;
  return at + 1;
};

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

const hasUnpairedSurrogate = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < HIGH_SURROGATE_FIRST || unit > LOW_SURROGATE_LAST) continue;
    if (unit > HIGH_SURROGATE_LAST) return true;
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    if (next < LOW_SURROGATE_FIRST || next > LOW_SURROGATE_LAST) return true;
    i += 1;
  }
  return false;
};

const measurePayload = (length: number): number => {
  if (length > PROTO_MAX_BULK_LEN) {
    refuse("length", `column of ${length} bytes exceeds the ${PROTO_MAX_BULK_LEN} byte cap`);
  }
  return varintSize(length) + length;
};

const measureCell = (cell: SqlValue, texts: Uint8Array[]): number => {
  if (cell === null) return 1;
  if (typeof cell === "number") return 1 + DOUBLE_BYTES;
  if (typeof cell === "string") {
    if (hasUnpairedSurrogate(cell)) {
      refuse("text", "a TEXT column holds an unpaired surrogate and has no byte form");
    }
    const encoded = encodeUtf8(cell);
    texts.push(encoded);
    return 1 + measurePayload(encoded.byteLength);
  }
  if (cell instanceof ArrayBuffer) return 1 + measurePayload(cell.byteLength);
  return refuse("cell", `column is neither BLOB, TEXT, REAL nor NULL but ${typeof cell}`);
};

const writePayload = (
  out: Uint8Array,
  offset: number,
  tag: number,
  payload: Uint8Array,
): number => {
  out[offset] = tag;
  const start = writeVarint(out, offset + 1, payload.byteLength);
  out.set(payload, start);
  return start + payload.byteLength;
};

export const encodeValue = (value: EvictedValue): Uint8Array => {
  const layout = layoutOf(value.type);
  const texts: Uint8Array[] = [];
  let bodyLength = 0;
  for (const row of value.rows) {
    if (row.length !== layout.arity) {
      refuse("arity", `${value.type} rows hold ${layout.arity} columns, got ${row.length}`);
    }
    bodyLength += varintSize(row.length);
    for (const cell of row) bodyLength += measureCell(cell, texts);
  }

  const out = new Uint8Array(TIER_HEADER_BYTES + bodyLength);
  const view = new DataView(out.buffer);
  out.set(TIER_MAGIC, 0);
  out[VERSION_OFFSET] = TIER_FORMAT_VERSION;
  out[TYPE_OFFSET] = layout.code;
  view.setUint32(ROW_COUNT_OFFSET, value.rows.length, LITTLE_ENDIAN);
  view.setBigUint64(BODY_LENGTH_OFFSET, BigInt(bodyLength), LITTLE_ENDIAN);

  let at = TIER_HEADER_BYTES;
  let textAt = 0;
  for (const row of value.rows) {
    at = writeVarint(out, at, row.length);
    for (const cell of row) {
      if (cell === null) {
        out[at] = CELL_NULL;
        at += 1;
      } else if (typeof cell === "number") {
        out[at] = CELL_NUMBER;
        view.setFloat64(at + 1, cell, LITTLE_ENDIAN);
        at += 1 + DOUBLE_BYTES;
      } else if (typeof cell === "string") {
        at = writePayload(out, at, CELL_TEXT, texts[textAt]!);
        textAt += 1;
      } else {
        at = writePayload(out, at, CELL_BLOB, new Uint8Array(cell));
      }
    }
  }
  return out;
};

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const copyBuffer = (source: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
};

export const decodeValue = (bytes: Uint8Array): EvictedValue<StoredType> => {
  if (bytes.byteLength < TIER_HEADER_BYTES) {
    refuse("truncated", `header needs ${TIER_HEADER_BYTES} bytes, got ${bytes.byteLength}`);
  }
  for (let i = 0; i < TIER_MAGIC.length; i += 1) {
    if (bytes[i] !== TIER_MAGIC[i]) refuse("magic", "these bytes are not a tier value");
  }
  const version = bytes[VERSION_OFFSET];
  if (version !== TIER_FORMAT_VERSION) {
    refuse("version", `format version ${version} is not ${TIER_FORMAT_VERSION}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = bytes[TYPE_OFFSET]!;
  const type = TYPE_BY_CODE.get(code) ?? refuse("type", `unknown type code ${code}`);
  const arity = LAYOUT[type].arity;
  const rowCount = view.getUint32(ROW_COUNT_OFFSET, LITTLE_ENDIAN);
  const declared = view.getBigUint64(BODY_LENGTH_OFFSET, LITTLE_ENDIAN);
  const present = BigInt(bytes.byteLength - TIER_HEADER_BYTES);
  if (declared > present) refuse("truncated", `body declares ${declared} bytes, ${present} present`);
  if (declared < present) refuse("trailing", `body declares ${declared} bytes, ${present} present`);
  if (rowCount * (1 + arity) > Number(present)) {
    refuse("truncated", `${rowCount} ${type} rows cannot fit in ${present} bytes`);
  }

  let at = TIER_HEADER_BYTES;

  const take = (count: number): number => {
    if (at + count > bytes.byteLength) {
      refuse("truncated", `${count} more bytes needed at offset ${at}`);
    }
    const start = at;
    at += count;
    return start;
  };

  const readVarint = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
      const byte = bytes[take(1)]!;
      result += (byte & VARINT_PAYLOAD) * scale;
      if ((byte & VARINT_CONTINUE) === 0) {
        if (i > 0 && byte === 0) refuse("varint", `non-minimal varint ending at offset ${at}`);
        return result;
      }
      scale *= VARINT_RADIX;
    }
    return refuse("varint", `varint exceeds ${MAX_VARINT_BYTES} bytes at offset ${at}`);
  };

  const readCell = (): SqlValue => {
    const tag = bytes[take(1)]!;
    if (tag === CELL_NULL) return null;
    if (tag === CELL_NUMBER) return view.getFloat64(take(DOUBLE_BYTES), LITTLE_ENDIAN);
    if (tag !== CELL_BLOB && tag !== CELL_TEXT) {
      refuse("cell", `unknown cell tag ${tag} at offset ${at - 1}`);
    }
    const length = readVarint();
    if (length > PROTO_MAX_BULK_LEN) {
      refuse("length", `column of ${length} bytes exceeds the ${PROTO_MAX_BULK_LEN} byte cap`);
    }
    const start = take(length);
    const payload = bytes.subarray(start, start + length);
    if (tag === CELL_BLOB) return copyBuffer(payload);
    try {
      return STRICT_UTF8.decode(payload);
    } catch {
      return refuse("text", `TEXT column at offset ${start} is not valid UTF-8`);
    }
  };

  const rows: SqlValue[][] = new Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    const cells = readVarint();
    if (cells !== arity) refuse("arity", `${type} rows hold ${arity} columns, found ${cells}`);
    const values: SqlValue[] = new Array(arity);
    for (let cell = 0; cell < arity; cell += 1) values[cell] = readCell();
    rows[row] = values;
  }
  if (at !== bytes.byteLength) {
    refuse("trailing", `${bytes.byteLength - at} bytes follow the last row`);
  }
  return { type, rows };
};
