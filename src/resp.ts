import { type Command, type Reply, error as errorReply } from "./types";
import { describeBytes } from "./errors";
import { formatDouble } from "./dtoa";

export class ProtocolError extends Error {
  readonly reply: Reply;

  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
    this.reply = errorReply(message);
  }
}

const INVALID_MULTIBULK = "ERR Protocol error: invalid multibulk length";
const INVALID_BULK = "ERR Protocol error: invalid bulk length";
const UNBALANCED_QUOTES = "ERR Protocol error: unbalanced quotes in request";
const TOO_BIG_INLINE = "ERR Protocol error: too big inline request";
const TOO_BIG_MBULK_COUNT = "ERR Protocol error: too big mbulk count string";
const TOO_BIG_BULK_COUNT = "ERR Protocol error: too big bulk count string";

const expectedDollar = (byte: number): string =>
  `ERR Protocol error: expected '$', got '${describeBytes(Uint8Array.of(byte))}'`;

const MAX_BULK_LENGTH = 512 * 1024 * 1024;
const MAX_MULTIBULK_COUNT = 1024 * 1024;
const MAX_LINE_LENGTH = 64 * 1024;
const INITIAL_CAPACITY = 16 * 1024;
const COMPACT_THRESHOLD = 8 * 1024;

const NUL = 0x00;
const BELL = 0x07;
const BACKSPACE = 0x08;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DOLLAR = 0x24;
const PERCENT = 0x25;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const STAR = 0x2a;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const UPPER_A = 0x41;
const UPPER_F = 0x46;
const BACKSLASH = 0x5c;
const LOWER_A = 0x61;
const LOWER_B = 0x62;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
const LOWER_X = 0x78;
const TILDE = 0x7e;
const RIGHT_ANGLE = 0x3e;

const isSpace = (byte: number): boolean => byte === SPACE || (byte >= TAB && byte <= CR);

const nibble = (byte: number): number => {
  if (byte >= ZERO && byte <= NINE) return byte - ZERO;
  if (byte >= LOWER_A && byte <= LOWER_F) return byte - LOWER_A + 10;
  if (byte >= UPPER_A && byte <= UPPER_F) return byte - UPPER_A + 10;
  return -1;
};

const unescape = (byte: number): number => {
  switch (byte) {
    case LOWER_N:
      return LF;
    case LOWER_R:
      return CR;
    case LOWER_T:
      return TAB;
    case LOWER_B:
      return BACKSPACE;
    case LOWER_A:
      return BELL;
    default:
      return byte;
  }
};

const HEX_ESCAPE_LENGTH = 4;

const readHexEscape = (line: Uint8Array, at: number): number => {
  if (at + HEX_ESCAPE_LENGTH > line.length) return -1;
  if (line[at] !== BACKSLASH || line[at + 1] !== LOWER_X) return -1;
  const high = nibble(line[at + 2]!);
  const low = nibble(line[at + 3]!);
  if (high < 0 || low < 0) return -1;
  return high * 16 + low;
};

const closesAgainstNonSpace = (line: Uint8Array, quote: number): boolean =>
  quote + 1 < line.length && !isSpace(line[quote + 1]!);

const splitInline = (line: Uint8Array): Uint8Array[] => {
  const args: Uint8Array[] = [];
  let i = 0;

  while (i < line.length) {
    while (i < line.length && isSpace(line[i]!)) i += 1;
    if (i >= line.length) break;

    const token: number[] = [];
    let inDouble = false;
    let inSingle = false;
    let quoteClosed = false;

    while (!quoteClosed) {
      if (i >= line.length) {
        if (inDouble || inSingle) throw new ProtocolError(UNBALANCED_QUOTES);
        break;
      }
      const byte = line[i]!;

      if (inDouble) {
        const escaped = readHexEscape(line, i);
        if (escaped >= 0) {
          token.push(escaped);
          i += HEX_ESCAPE_LENGTH;
        } else if (byte === BACKSLASH && i + 1 < line.length) {
          token.push(unescape(line[i + 1]!));
          i += 2;
        } else if (byte === DQUOTE) {
          if (closesAgainstNonSpace(line, i)) throw new ProtocolError(UNBALANCED_QUOTES);
          inDouble = false;
          quoteClosed = true;
          i += 1;
        } else {
          token.push(byte);
          i += 1;
        }
        continue;
      }

      if (inSingle) {
        if (byte === BACKSLASH && line[i + 1] === SQUOTE) {
          token.push(SQUOTE);
          i += 2;
        } else if (byte === SQUOTE) {
          if (closesAgainstNonSpace(line, i)) throw new ProtocolError(UNBALANCED_QUOTES);
          inSingle = false;
          quoteClosed = true;
          i += 1;
        } else {
          token.push(byte);
          i += 1;
        }
        continue;
      }

      if (isSpace(byte) || byte === NUL) {
        i += 1;
        break;
      }
      if (byte === DQUOTE) {
        inDouble = true;
        i += 1;
        continue;
      }
      if (byte === SQUOTE) {
        inSingle = true;
        i += 1;
        continue;
      }
      token.push(byte);
      i += 1;
    }

    args.push(Uint8Array.from(token));
  }

  return args;
};

const parseLength = (digits: Uint8Array, message: string): number => {
  if (digits.length === 0) throw new ProtocolError(message);

  const negative = digits[0] === MINUS;
  const start = negative ? 1 : 0;
  if (start === digits.length) throw new ProtocolError(message);

  let value = 0;
  for (let i = start; i < digits.length; i += 1) {
    const byte = digits[i]!;
    if (byte < ZERO || byte > NINE) throw new ProtocolError(message);
    value = value * 10 + (byte - ZERO);
    if (value > Number.MAX_SAFE_INTEGER) throw new ProtocolError(message);
  }
  return negative ? -value : value;
};

const carriesNoCommand = (multibulkCount: number): boolean => multibulkCount <= 0;

const concatBytes = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
};

export class RequestDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #readOffset = 0;
  #writeOffset = 0;

  #pendingArgs: Uint8Array[] | null = null;
  #missingArgs = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#reserve(chunk.length);
    this.#buffer.set(chunk, this.#writeOffset);
    this.#writeOffset += chunk.length;
  }

  next(): Command | null {
    for (;;) {
      let args = this.#pendingArgs;

      if (args === null) {
        if (this.#readOffset === this.#writeOffset) return null;

        if (this.#buffer[this.#readOffset] !== STAR) {
          const inline = this.#takeInline();
          if (inline === null) return null;
          if (inline.length === 0) continue;
          return inline;
        }

        const frameStart = this.#readOffset;
        this.#readOffset += 1;
        const header = this.#takeLine(TOO_BIG_MBULK_COUNT);
        if (header === null) {
          this.#readOffset = frameStart;
          return null;
        }
        const count = parseLength(header, INVALID_MULTIBULK);
        if (count > MAX_MULTIBULK_COUNT) throw new ProtocolError(INVALID_MULTIBULK);
        if (carriesNoCommand(count)) continue;

        args = [];
        this.#pendingArgs = args;
        this.#missingArgs = count;
      }

      while (this.#missingArgs > 0) {
        const arg = this.#takeBulk();
        if (arg === null) return null;
        args.push(arg);
        this.#missingArgs -= 1;
      }

      this.#pendingArgs = null;
      return args;
    }
  }

  drain(): Command[] {
    const commands: Command[] = [];
    for (;;) {
      const command = this.next();
      if (command === null) return commands;
      commands.push(command);
    }
  }

  remaining(): Uint8Array {
    const unparsed = this.#buffer.slice(this.#readOffset, this.#writeOffset);
    const args = this.#pendingArgs;
    if (args === null) return unparsed;
    return concatBytes(this.#reframePendingCommand(args), unparsed);
  }

  #reframePendingCommand(args: readonly Uint8Array[]): Uint8Array {
    const header = `*${args.length + this.#missingArgs}\r\n`;
    let size = header.length;
    for (const arg of args) size += bulkSize(arg.length);

    const frame = new Uint8Array(size);
    let at = writeAscii(frame, 0, header);
    for (const arg of args) at = writeBulk(frame, at, arg);
    return frame;
  }

  #takeBulk(): Uint8Array | null {
    const elementStart = this.#readOffset;
    if (elementStart === this.#writeOffset) return null;

    const type = this.#buffer[elementStart]!;
    if (type !== DOLLAR) throw new ProtocolError(expectedDollar(type));

    this.#readOffset = elementStart + 1;
    const header = this.#takeLine(TOO_BIG_BULK_COUNT);
    if (header === null) {
      this.#readOffset = elementStart;
      return null;
    }

    const length = parseLength(header, INVALID_BULK);
    if (length < 0 || length > MAX_BULK_LENGTH) throw new ProtocolError(INVALID_BULK);

    if (this.#writeOffset - this.#readOffset < length + 2) {
      this.#readOffset = elementStart;
      return null;
    }

    const payload = this.#buffer.slice(this.#readOffset, this.#readOffset + length);
    this.#readOffset += length + 2;
    return payload;
  }

  #takeLine(tooBigMessage: string): Uint8Array | null {
    const buffer = this.#buffer;
    const limit = this.#writeOffset - 1;
    for (let i = this.#readOffset; i < limit; i += 1) {
      if (buffer[i] !== CR || buffer[i + 1] !== LF) continue;
      const line = buffer.subarray(this.#readOffset, i);
      this.#readOffset = i + 2;
      return line;
    }
    if (this.#writeOffset - this.#readOffset > MAX_LINE_LENGTH) {
      throw new ProtocolError(tooBigMessage);
    }
    return null;
  }

  #takeInline(): Command | null {
    const buffer = this.#buffer;
    let newline = -1;
    for (let i = this.#readOffset; i < this.#writeOffset; i += 1) {
      if (buffer[i] === LF) {
        newline = i;
        break;
      }
    }
    if (newline === -1) {
      if (this.#writeOffset - this.#readOffset > MAX_LINE_LENGTH) {
        throw new ProtocolError(TOO_BIG_INLINE);
      }
      return null;
    }

    let stop = newline;
    if (stop > this.#readOffset && buffer[stop - 1] === CR) stop -= 1;
    const line = buffer.subarray(this.#readOffset, stop);
    this.#readOffset = newline + 1;
    return splitInline(line);
  }

  #reserve(extra: number): void {
    if (this.#readOffset === this.#writeOffset) {
      this.#readOffset = 0;
      this.#writeOffset = 0;
    } else if (
      this.#readOffset >= COMPACT_THRESHOLD &&
      this.#readOffset * 2 >= this.#writeOffset
    ) {
      this.#compact();
    }

    if (this.#writeOffset + extra <= this.#buffer.length) return;

    const live = this.#writeOffset - this.#readOffset;
    if (this.#readOffset > 0 && live + extra <= this.#buffer.length) {
      this.#compact();
      return;
    }

    let capacity = Math.max(this.#buffer.length, INITIAL_CAPACITY);
    while (capacity < live + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(this.#readOffset, this.#writeOffset));
    this.#buffer = grown;
    this.#readOffset = 0;
    this.#writeOffset = live;
  }

  #compact(): void {
    this.#buffer.copyWithin(0, this.#readOffset, this.#writeOffset);
    this.#writeOffset -= this.#readOffset;
    this.#readOffset = 0;
  }
}

export type ProtocolVersion = 2 | 3;

const ENCODER = new TextEncoder();

const RESP2_NULL_BULK = "$-1\r\n";
const RESP2_NULL_ARRAY = "*-1\r\n";
const RESP3_NULL = "_\r\n";
const RESP2_TRUE = ":1\r\n";
const RESP2_FALSE = ":0\r\n";
const RESP3_TRUE = "#t\r\n";
const RESP3_FALSE = "#f\r\n";

const nullLiteral = (kind: "null" | "nullArray", version: ProtocolVersion): string => {
  if (version === 3) return RESP3_NULL;
  return kind === "null" ? RESP2_NULL_BULK : RESP2_NULL_ARRAY;
};

const booleanLiteral = (value: boolean, version: ProtocolVersion): string => {
  if (version === 3) return value ? RESP3_TRUE : RESP3_FALSE;
  return value ? RESP2_TRUE : RESP2_FALSE;
};

const FRAMING_BYTES = /[\r\n]/g;
const FRAMING_REPLACEMENT = " ";

const sanitizeLine = (text: string): string => text.replace(FRAMING_BYTES, FRAMING_REPLACEMENT);

const mapHeaderCount = (pairs: number, version: ProtocolVersion): number =>
  version === 3 ? pairs : pairs * 2;

const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const bulkSize = (payload: number): number => 1 + payload.toString().length + 2 + payload + 2;

const aggregateSize = (
  count: number,
  items: readonly Reply[],
  version: ProtocolVersion,
): number => {
  let total = 1 + count.toString().length + 2;
  for (const item of items) total += sizeOf(item, version);
  return total;
};

const sizeOf = (reply: Reply, version: ProtocolVersion): number => {
  switch (reply.kind) {
    case "simple":
    case "error":
      return 1 + utf8Length(sanitizeLine(reply.value)) + 2;

    case "integer":
      return 1 + reply.value.toString().length + 2;

    case "bulk":
      return bulkSize(reply.value.length);

    case "array":
      return aggregateSize(reply.value.length, reply.value, version);

    case "double": {
      const text = formatDouble(reply.value);
      return version === 3 ? 1 + text.length + 2 : bulkSize(text.length);
    }

    case "boolean":
      return booleanLiteral(reply.value, version).length;

    case "map": {
      const pairs = reply.value;
      let total = 1 + mapHeaderCount(pairs.length, version).toString().length + 2;
      for (const [key, value] of pairs) {
        total += sizeOf(key, version) + sizeOf(value, version);
      }
      return total;
    }

    case "set":
    case "push":
      return aggregateSize(reply.value.length, reply.value, version);

    case "null":
    case "nullArray":
      return nullLiteral(reply.kind, version).length;
  }
};

const writeCrlf = (out: Uint8Array, offset: number): number => {
  out[offset] = CR;
  out[offset + 1] = LF;
  return offset + 2;
};

const writeAscii = (out: Uint8Array, offset: number, text: string): number => {
  for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  return offset + text.length;
};

const writeHeader = (
  out: Uint8Array,
  offset: number,
  prefix: number,
  count: number | string,
): number => {
  out[offset] = prefix;
  return writeCrlf(out, writeAscii(out, offset + 1, count.toString()));
};

const writeTextLine = (out: Uint8Array, offset: number, prefix: number, text: string): number => {
  out[offset] = prefix;
  const { written } = ENCODER.encodeInto(text, out.subarray(offset + 1));
  return writeCrlf(out, offset + 1 + written);
};

const writeBulk = (out: Uint8Array, offset: number, payload: Uint8Array): number => {
  let at = writeHeader(out, offset, DOLLAR, payload.length);
  out.set(payload, at);
  at += payload.length;
  return writeCrlf(out, at);
};

const writeItems = (
  out: Uint8Array,
  offset: number,
  items: readonly Reply[],
  version: ProtocolVersion,
): number => {
  let at = offset;
  for (const item of items) at = writeReply(out, at, item, version);
  return at;
};

const writeReply = (
  out: Uint8Array,
  offset: number,
  reply: Reply,
  version: ProtocolVersion,
): number => {
  switch (reply.kind) {
    case "simple":
      return writeTextLine(out, offset, PLUS, sanitizeLine(reply.value));

    case "error":
      return writeTextLine(out, offset, MINUS, sanitizeLine(reply.value));

    case "integer":
      return writeHeader(out, offset, COLON, reply.value.toString());

    case "bulk":
      return writeBulk(out, offset, reply.value);

    case "array":
      return writeItems(
        out,
        writeHeader(out, offset, STAR, reply.value.length),
        reply.value,
        version,
      );

    case "double": {
      const text = formatDouble(reply.value);
      if (version === 3) {
        out[offset] = COMMA;
        return writeCrlf(out, writeAscii(out, offset + 1, text));
      }
      return writeBulk(out, offset, ENCODER.encode(text));
    }

    case "boolean":
      return writeAscii(out, offset, booleanLiteral(reply.value, version));

    case "map": {
      const pairs = reply.value;
      let at = writeHeader(
        out,
        offset,
        version === 3 ? PERCENT : STAR,
        mapHeaderCount(pairs.length, version),
      );
      for (const [key, value] of pairs) {
        at = writeReply(out, at, key, version);
        at = writeReply(out, at, value, version);
      }
      return at;
    }

    case "set":
      return writeItems(
        out,
        writeHeader(out, offset, version === 3 ? TILDE : STAR, reply.value.length),
        reply.value,
        version,
      );

    case "push":
      return writeItems(
        out,
        writeHeader(out, offset, version === 3 ? RIGHT_ANGLE : STAR, reply.value.length),
        reply.value,
        version,
      );

    case "null":
    case "nullArray":
      return writeAscii(out, offset, nullLiteral(reply.kind, version));
  }
};

export function encodeReply(reply: Reply, version: ProtocolVersion): Uint8Array {
  const out = new Uint8Array(sizeOf(reply, version));
  const written = writeReply(out, 0, reply, version);
  if (written !== out.length) {
    throw new Error(`resp: encoded ${written} bytes into a ${out.length}-byte frame`);
  }
  return out;
}
