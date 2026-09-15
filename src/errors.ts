import { type Reply, encodeUtf8, error } from "./types";

export const WRONGTYPE = error("WRONGTYPE Operation against a key holding the wrong kind of value");
export const NOT_INTEGER = error("ERR value is not an integer or out of range");
export const NOT_FLOAT = error("ERR value is not a valid float");
export const INT_OVERFLOW = error("ERR increment or decrement would overflow");
export const SYNTAX = error("ERR syntax error");
export const INDEX_OUT_OF_RANGE = error("ERR index out of range");
export const OFFSET_OUT_OF_RANGE = error("ERR offset is out of range");
export const DECR_OVERFLOW = error("ERR decrement would overflow");
export const FLOAT_NAN_OR_INF = error("ERR increment would produce NaN or Infinity");
export const NAN_RESULT = error("ERR resulting score is not a number (NaN)");
export const NO_SUCH_KEY = error("ERR no such key");
export const INVALID_COMMAND_SPECIFIED = error("ERR Invalid command specified");
export const COMMAND_HAS_NO_KEYS = error("ERR The command has no key arguments");
export const INVALID_ARGCOUNT_FOR_COMMAND = error(
  "ERR Invalid number of arguments specified for command",
);
export const STRING_TOO_LONG = error("ERR string exceeds maximum allowed size (proto-max-bulk-len)");
export const PROTO_MAX_BULK_LEN = 1024 * 1024;
export const GLOB_PATTERN_TOO_LONG = error("ERR pattern exceeds the maximum supported length");

export type Diagnostic = string | Uint8Array;

const DIAGNOSTIC_BUDGET = 128;

const SQUOTE = 0x27;
const BACKSLASH = 0x5c;
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

const ELLIPSIS = "...";

const hexEscape = (byte: number): string => `\\x${byte.toString(16).padStart(2, "0")}`;

const diagnosticBytes = (value: Diagnostic): Uint8Array =>
  typeof value === "string" ? encodeUtf8(value) : value;

export const describeBytes = (value: Diagnostic, budget: number = DIAGNOSTIC_BUDGET): string => {
  const bytes = diagnosticBytes(value);
  const shown = Math.min(bytes.length, Math.max(budget, 0));
  let out = "";
  for (let i = 0; i < shown; i += 1) {
    const byte = bytes[i]!;
    if (byte === BACKSLASH || byte === SQUOTE) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= FIRST_PRINTABLE && byte <= LAST_PRINTABLE) {
      out += String.fromCharCode(byte);
    } else {
      out += hexEscape(byte);
    }
  }
  return bytes.length > shown ? out + ELLIPSIS : out;
};

const describeCommandName = (command: Diagnostic): string => describeBytes(command).toLowerCase();

export const invalidExpire = (command: Diagnostic): Reply =>
  error(`ERR invalid expire time in '${describeCommandName(command)}' command`);

export const wrongArity = (command: Diagnostic): Reply =>
  error(`ERR wrong number of arguments for '${describeCommandName(command)}' command`);

const UNKNOWN_COMMAND_ARG_BUDGET = 128;

export const unknownCommand = (command: Diagnostic, args: readonly Diagnostic[]): Reply => {
  let rendered = "";
  for (const arg of args) {
    if (rendered.length >= UNKNOWN_COMMAND_ARG_BUDGET) break;
    rendered += `'${describeBytes(arg, UNKNOWN_COMMAND_ARG_BUDGET - rendered.length)}' `;
  }
  return error(
    `ERR unknown command '${describeBytes(command)}', with args beginning with: ${rendered}`,
  );
};

export class RedisError extends Error {
  constructor(readonly reply: Reply) {
    super(reply.kind === "error" ? reply.value : "redis error");
    this.name = "RedisError";
  }
}

export const fail = (reply: Reply): never => {
  throw new RedisError(reply);
};
