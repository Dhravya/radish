import type { SqlStorage } from "../schema";
import type { Store } from "../store";
import { NOT_FLOAT, NOT_INTEGER, fail } from "../errors";
import type { Command, Reply } from "../types";
import { decodeUtf8 } from "../types";

export interface ConnState {
  protocol: 2 | 3;
  readonly id: number;
  name: string | null;
  db: number;
  closeAfterReply: boolean;
}

export interface Ctx {
  readonly store: Store;
  readonly sql: SqlStorage;
  readonly now: number;
  readonly conn: ConnState;
  readonly commands: ReadonlyMap<string, CommandSpec>;
}

export type Handler = (ctx: Ctx, argv: Command) => Reply;

export interface KeySpec {
  readonly firstKey: number;
  readonly lastKey: number;
  readonly keyStep: number;
}

export const NO_KEYS: KeySpec = { firstKey: 0, lastKey: 0, keyStep: 0 };
export const ONE_KEY: KeySpec = { firstKey: 1, lastKey: 1, keyStep: 1 };
export const FIRST_TWO_KEYS: KeySpec = { firstKey: 1, lastKey: 2, keyStep: 1 };
export const ALL_KEYS: KeySpec = { firstKey: 1, lastKey: -1, keyStep: 1 };
export const ALTERNATING_KEYS: KeySpec = { firstKey: 1, lastKey: -1, keyStep: 2 };

export const keysAt = (firstKey: number, lastKey: number, keyStep: number): KeySpec => ({
  firstKey,
  lastKey,
  keyStep,
});

export type GetKeys = (argv: Command) => Uint8Array[];

export interface KeyExtraction extends KeySpec {
  readonly getKeys?: GetKeys;
}

export const hasKeyRange = (keys: KeySpec): boolean =>
  keys.firstKey !== 0 && keys.keyStep !== 0;

export const hasKeys = (command: KeyExtraction): boolean =>
  command.getKeys !== undefined || hasKeyRange(command);

export const keysAfterCount =
  (countAt: number, extra: readonly number[] = []): GetKeys =>
  (argv) => {
    const keys: Uint8Array[] = [];
    for (const at of extra) {
      const key = argv[at];
      if (key !== undefined) keys.push(key);
    }

    const declared = argv[countAt];
    if (declared === undefined) return keys;
    const count = toI64(declared);
    if (count === null || count <= 0n) return keys;

    const last = Math.min(countAt + Number(count), argv.length - 1);
    for (let at = countAt + 1; at <= last; at++) {
      const key = argv[at];
      if (key !== undefined) keys.push(key);
    }
    return keys;
  };

export const extractKeys = (command: KeyExtraction, argv: Command): Uint8Array[] => {
  if (command.getKeys !== undefined) return command.getKeys(argv);
  if (!hasKeyRange(command)) return [];

  const countsBackFromEnd = command.lastKey < 0;
  const last = countsBackFromEnd
    ? argv.length + command.lastKey
    : Math.min(command.lastKey, argv.length - 1);

  const keys: Uint8Array[] = [];
  for (let at = command.firstKey; at <= last; at += command.keyStep) {
    const key = argv[at];
    if (key !== undefined) keys.push(key);
  }
  return keys;
};

export const satisfiesArity = (arity: number, argc: number): boolean =>
  arity >= 0 ? argc === arity : argc >= -arity;

export interface CommandSpec extends KeySpec {
  readonly name: string;
  readonly arity: number;
  readonly write: boolean;
  readonly getKeys?: GetKeys;
  readonly handler: Handler;
}

export const spec = (
  name: string,
  arity: number,
  write: boolean,
  keys: KeySpec,
  handler: Handler,
  getKeys?: GetKeys,
): CommandSpec =>
  getKeys === undefined
    ? { name, arity, write, ...keys, handler }
    : { name, arity, write, ...keys, handler, getKeys };

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const ENCODER = new TextEncoder();

export const ascii = (text: string): Uint8Array => ENCODER.encode(text);

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

const STRING2LL = /^(0|-?[1-9][0-9]*)$/;
const INFINITY_LITERAL = /^[+-]?inf(inity)?$/i;
const STRTOLD_DECIMAL = /^([+-]?)([0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?$/;
const TRAILING_ZEROES = /0+$/;

const HUMAN_FRACTION_DIGITS = 17;
const HUMAN_SCALE = 10n ** 17n;

export const toI64 = (bytes: Uint8Array): bigint | null => {
  const text = decodeUtf8(bytes);
  if (!STRING2LL.test(text)) return null;
  const value = BigInt(text);
  return value < I64_MIN || value > I64_MAX ? null : value;
};

export const argI64 = (bytes: Uint8Array): bigint => toI64(bytes) ?? fail(NOT_INTEGER);

export const argIndex = (bytes: Uint8Array): number => {
  const value = argI64(bytes);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(value);
};

interface DecimalText {
  readonly negative: boolean;
  readonly digits: bigint;
  readonly scale: number;
}

const parseDecimalText = (text: string): DecimalText | null => {
  const parsed = STRTOLD_DECIMAL.exec(text);
  if (parsed === null) return null;

  const mantissa = parsed[2] as string;
  const point = mantissa.indexOf(".");
  const digits = point < 0 ? mantissa : mantissa.slice(0, point) + mantissa.slice(point + 1);
  const fractionDigits = point < 0 ? 0 : mantissa.length - point - 1;
  const exponent = parsed[3] === undefined ? 0 : Number(parsed[3]);

  return {
    negative: parsed[1] === "-",
    digits: digits === "" ? 0n : BigInt(digits),
    scale: exponent - fractionDigits,
  };
};

export const toDouble = (bytes: Uint8Array): number | null => {
  const text = decodeUtf8(bytes);
  if (INFINITY_LITERAL.test(text)) return text.startsWith("-") ? -Infinity : Infinity;

  const decimal = parseDecimalText(text);
  if (decimal === null) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (value === 0 && decimal.digits !== 0n) return null;
  return value;
};

export const argDouble = (bytes: Uint8Array): number => toDouble(bytes) ?? fail(NOT_FLOAT);

const QUAD_SIGNIFICAND_BITS = 113;
const QUAD_MAX_EXPONENT = 16383;
const QUAD_MIN_NORMAL_EXPONENT = -16382;
const DECIMAL_MAGNITUDE_LIMIT = 5000;

export interface LongDouble {
  readonly negative: boolean;
  readonly significand: bigint;
  readonly exponent: number;
  readonly infinite: boolean;
}

export const LONG_DOUBLE_ZERO: LongDouble = {
  negative: false,
  significand: 0n,
  exponent: 0,
  infinite: false,
};

const bitLength = (value: bigint): number => (value === 0n ? 0 : value.toString(2).length);

interface Scaled {
  readonly significand: bigint;
  readonly exponent: number;
}

const roundQuotient = (num: bigint, den: bigint, bits: number): Scaled => {
  const headroom = bits + 2 - (bitLength(num) - bitLength(den));
  const scaledNum = headroom > 0 ? num << BigInt(headroom) : num;
  const scaledDen = headroom > 0 ? den : den << BigInt(-headroom);

  let quotient = scaledNum / scaledDen;
  const remainder = scaledNum % scaledDen;
  let exponent = -headroom;

  const excess = bitLength(quotient) - bits;
  const drop = BigInt(excess);
  const dropped = quotient & ((1n << drop) - 1n);
  const half = 1n << (drop - 1n);
  quotient >>= drop;
  exponent += excess;

  if (dropped > half || (dropped === half && (remainder !== 0n || (quotient & 1n) === 1n))) {
    quotient += 1n;
    if (bitLength(quotient) > bits) {
      quotient >>= 1n;
      exponent += 1;
    }
  }
  return { significand: quotient, exponent };
};

type Rounded = LongDouble | "overflowed" | "underflowed";

const roundToLongDouble = (negative: boolean, num: bigint, den: bigint): Rounded => {
  let scaled = roundQuotient(num, den, QUAD_SIGNIFICAND_BITS);
  const unbiased = scaled.exponent + QUAD_SIGNIFICAND_BITS - 1;
  if (unbiased > QUAD_MAX_EXPONENT) return "overflowed";

  if (unbiased < QUAD_MIN_NORMAL_EXPONENT) {
    const bits = QUAD_SIGNIFICAND_BITS - (QUAD_MIN_NORMAL_EXPONENT - unbiased);
    if (bits <= 0) return "underflowed";
    scaled = roundQuotient(num, den, bits);
    if (scaled.significand === 0n) return "underflowed";
  }

  return { negative, significand: scaled.significand, exponent: scaled.exponent, infinite: false };
};

const scaleToRatio = (digits: bigint, scale: number): readonly [bigint, bigint] =>
  scale >= 0 ? [digits * 10n ** BigInt(scale), 1n] : [digits, 10n ** BigInt(-scale)];

export const toLongDouble = (bytes: Uint8Array): LongDouble | null => {
  const text = decodeUtf8(bytes);
  if (INFINITY_LITERAL.test(text)) {
    return { negative: text.startsWith("-"), significand: 0n, exponent: 0, infinite: true };
  }

  const decimal = parseDecimalText(text);
  if (decimal === null) return null;
  if (decimal.digits === 0n) return LONG_DOUBLE_ZERO;

  const magnitude = decimal.digits.toString().length + decimal.scale;
  if (magnitude > DECIMAL_MAGNITUDE_LIMIT || magnitude < -DECIMAL_MAGNITUDE_LIMIT) return null;

  const [num, den] = scaleToRatio(decimal.digits, decimal.scale);
  const rounded = roundToLongDouble(decimal.negative, num, den);
  return typeof rounded === "string" ? null : rounded;
};

export const addLongDouble = (a: LongDouble, b: LongDouble): LongDouble | null => {
  if (a.infinite || b.infinite) return null;
  if (a.significand === 0n) return b;
  if (b.significand === 0n) return a;

  const exponent = Math.min(a.exponent, b.exponent);
  const left = (a.negative ? -a.significand : a.significand) << BigInt(a.exponent - exponent);
  const right = (b.negative ? -b.significand : b.significand) << BigInt(b.exponent - exponent);
  const sum = left + right;
  if (sum === 0n) return LONG_DOUBLE_ZERO;

  const negative = sum < 0n;
  const [num, den] =
    exponent >= 0
      ? [(negative ? -sum : sum) << BigInt(exponent), 1n]
      : [negative ? -sum : sum, 1n << BigInt(-exponent)];

  const rounded = roundToLongDouble(negative, num as bigint, den as bigint);
  if (rounded === "overflowed") return null;
  if (rounded === "underflowed") return LONG_DOUBLE_ZERO;
  return rounded;
};

export const formatLongDouble = (value: LongDouble): string => {
  const scaled = value.significand * HUMAN_SCALE;
  let units: bigint;

  if (value.exponent >= 0) {
    units = scaled << BigInt(value.exponent);
  } else {
    const shift = BigInt(-value.exponent);
    units = scaled >> shift;
    const dropped = scaled & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    if (dropped > half || (dropped === half && (units & 1n) === 1n)) units += 1n;
  }

  const digits = units.toString().padStart(HUMAN_FRACTION_DIGITS + 1, "0");
  const split = digits.length - HUMAN_FRACTION_DIGITS;
  const whole = digits.slice(0, split);
  const frac = digits.slice(split).replace(TRAILING_ZEROES, "");
  const magnitude = frac === "" ? whole : `${whole}.${frac}`;
  return value.negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
};

export const deadlineOf = (ctx: Ctx, key: Uint8Array): number | null =>
  ctx.store.deadlineOf(key);
