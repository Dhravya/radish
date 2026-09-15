import type { Socket } from "bun";

type RespValue =
  | { readonly kind: "simple"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "integer"; readonly text: string }
  | { readonly kind: "double"; readonly text: string }
  | { readonly kind: "boolean"; readonly text: string }
  | { readonly kind: "bigNumber"; readonly text: string }
  | { readonly kind: "bulk"; readonly bytes: Uint8Array }
  | { readonly kind: "verbatim"; readonly bytes: Uint8Array }
  | { readonly kind: "blobError"; readonly bytes: Uint8Array }
  | { readonly kind: "null" }
  | { readonly kind: "array"; readonly items: readonly RespValue[] }
  | { readonly kind: "set"; readonly items: readonly RespValue[] }
  | { readonly kind: "push"; readonly items: readonly RespValue[] }
  | { readonly kind: "map"; readonly items: readonly RespValue[] };

interface Parsed {
  readonly value: RespValue;
  readonly next: number;
}

const CR = 0x0d;
const LF = 0x0a;

const SIMPLE_STRING_BYTE = 0x2b;
const ERROR_BYTE = 0x2d;
const INTEGER_BYTE = 0x3a;
const DOUBLE_BYTE = 0x2c;
const BOOLEAN_BYTE = 0x23;
const BIG_NUMBER_BYTE = 0x28;
const NULL_BYTE = 0x5f;
const BULK_STRING_BYTE = 0x24;
const VERBATIM_STRING_BYTE = 0x3d;
const BLOB_ERROR_BYTE = 0x21;
const ARRAY_BYTE = 0x2a;
const SET_BYTE = 0x7e;
const PUSH_BYTE = 0x3e;
const MAP_BYTE = 0x25;

const ENTRIES_PER_MAP_ENTRY = 2;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const findCrlf = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
};

type Aggregate = Extract<RespValue, { items: readonly RespValue[] }>;

const isAggregate = (v: RespValue): v is Aggregate =>
  v.kind === "array" || v.kind === "set" || v.kind === "push" || v.kind === "map";

class ProtocolError extends Error {}

const parseReply = (buf: Uint8Array, at: number): Parsed | null => {
  if (at >= buf.length) return null;
  const type = buf[at];
  const eol = findCrlf(buf, at + 1);
  if (eol < 0) return null;
  const line = decoder.decode(buf.subarray(at + 1, eol));
  const afterLine = eol + 2;

  switch (type) {
    case SIMPLE_STRING_BYTE:
      return { value: { kind: "simple", text: line }, next: afterLine };
    case ERROR_BYTE:
      return { value: { kind: "error", text: line }, next: afterLine };
    case INTEGER_BYTE:
      return { value: { kind: "integer", text: line }, next: afterLine };
    case DOUBLE_BYTE:
      return { value: { kind: "double", text: line }, next: afterLine };
    case BOOLEAN_BYTE:
      return { value: { kind: "boolean", text: line }, next: afterLine };
    case BIG_NUMBER_BYTE:
      return { value: { kind: "bigNumber", text: line }, next: afterLine };
    case NULL_BYTE:
      return { value: { kind: "null" }, next: afterLine };

    case BULK_STRING_BYTE:
    case VERBATIM_STRING_BYTE:
    case BLOB_ERROR_BYTE: {
      const length = Number(line);
      if (!Number.isInteger(length)) throw new ProtocolError(`bad bulk length ${line}`);
      if (length < 0) return { value: { kind: "null" }, next: afterLine };
      const end = afterLine + length;
      if (end + 2 > buf.length) return null;
      const bytes = buf.subarray(afterLine, end);
      const kind =
        type === BULK_STRING_BYTE ? "bulk" : type === VERBATIM_STRING_BYTE ? "verbatim" : "blobError";
      return { value: { kind, bytes }, next: end + 2 };
    }

    case ARRAY_BYTE:
    case SET_BYTE:
    case PUSH_BYTE:
    case MAP_BYTE: {
      const count = Number(line);
      if (!Number.isInteger(count)) throw new ProtocolError(`bad aggregate length ${line}`);
      if (count < 0) return { value: { kind: "null" }, next: afterLine };
      const arity = type === MAP_BYTE ? count * ENTRIES_PER_MAP_ENTRY : count;
      const items: RespValue[] = [];
      let cursor = afterLine;
      for (let i = 0; i < arity; i++) {
        const child = parseReply(buf, cursor);
        if (child === null) return null;
        items.push(child.value);
        cursor = child.next;
      }
      const kind =
        type === ARRAY_BYTE ? "array" : type === SET_BYTE ? "set" : type === PUSH_BYTE ? "push" : "map";
      return { value: { kind, items }, next: cursor };
    }

    default:
      throw new ProtocolError(
        `unknown RESP type byte 0x${(type ?? 0).toString(16)} at offset ${at}`,
      );
  }
};

const CRLF = new Uint8Array([CR, LF]);

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

const encodeCommand = (argv: readonly string[]): Uint8Array => {
  const chunks: Uint8Array[] = [encoder.encode(`*${argv.length}\r\n`)];
  for (const arg of argv) {
    const bytes = encoder.encode(arg);
    chunks.push(encoder.encode(`$${bytes.byteLength}\r\n`), bytes, CRLF);
  }
  return concat(chunks);
};

const DELETE_BYTE = 0x7f;
const FIRST_PRINTABLE_BYTE = 0x20;

const escapeNonPrintable = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < FIRST_PRINTABLE_BYTE || code === DELETE_BYTE
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : char;
  }).join("");

const showCommand = (argv: readonly string[]): string =>
  argv
    .map((arg) => {
      const safe = escapeNonPrintable(arg);
      return safe === "" || /\s/.test(safe) ? JSON.stringify(safe) : safe;
    })
    .join(" ");

const copyOfReusedBuffer = (chunk: Uint8Array): Uint8Array => new Uint8Array(chunk);

class Conn {
  private socket: Socket<Conn> | null = null;
  private inbox = new Uint8Array(0);
  private readonly outbox: Uint8Array[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private failure: Error | null = null;

  private constructor(
    readonly label: string,
    readonly address: string,
  ) {}

  static async open(label: string, address: string): Promise<Conn> {
    const { hostname, port } = splitAddress(address);
    const conn = new Conn(label, address);
    try {
      conn.socket = await Bun.connect<Conn>({
        hostname,
        port,
        data: conn,
        socket: {
          data(socket, chunk) {
            socket.data.absorb(copyOfReusedBuffer(chunk));
          },
          drain(socket) {
            socket.data.flush();
          },
          close(socket) {
            socket.data.closed = true;
            socket.data.wake();
          },
          error(socket, error) {
            socket.data.failure = error;
            socket.data.wake();
          },
        },
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${label}: cannot connect to ${address} — ${detail}`);
    }
    return conn;
  }

  private absorb(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.inbox.byteLength + chunk.byteLength);
    merged.set(this.inbox);
    merged.set(chunk, this.inbox.byteLength);
    this.inbox = merged;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  write(bytes: Uint8Array): void {
    const socket = this.socket;
    if (socket === null) throw new Error(`${this.label}: not connected`);
    if (this.outbox.length > 0) {
      this.outbox.push(bytes);
      return;
    }
    const written = socket.write(bytes);
    if (written < 0) throw new Error(`${this.label}: socket closed while writing`);
    if (written < bytes.byteLength) this.outbox.push(bytes.subarray(written));
  }

  private flush(): void {
    const socket = this.socket;
    if (socket === null) return;
    while (this.outbox.length > 0) {
      const head = this.outbox[0];
      if (head === undefined) break;
      const written = socket.write(head);
      if (written < 0) {
        this.outbox.length = 0;
        return;
      }
      if (written < head.byteLength) {
        this.outbox[0] = head.subarray(written);
        return;
      }
      this.outbox.shift();
    }
  }

  async readReply(timeoutMs: number): Promise<{ raw: Uint8Array; value: RespValue }> {
    for (;;) {
      if (this.inbox.byteLength > 0) {
        const parsed = parseReply(this.inbox, 0);
        if (parsed !== null) {
          const raw = this.inbox.slice(0, parsed.next);
          this.inbox = this.inbox.slice(parsed.next);
          return { raw, value: parsed.value };
        }
      }
      if (this.failure !== null) throw new Error(`${this.label}: ${this.failure.message}`);
      if (this.closed) {
        throw new Error(
          `${this.label}: connection closed with ${this.inbox.byteLength} unparsed bytes`,
        );
      }
      await this.pause(timeoutMs);
    }
  }

  private pause(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`${this.label}: no reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  close(): void {
    this.socket?.end();
  }
}

const MAX_PORT = 65535;

const splitAddress = (address: string): { hostname: string; port: number } => {
  const colon = address.lastIndexOf(":");
  if (colon <= 0) throw new Error(`address must be host:port, got ${address}`);
  const port = Number(address.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT) {
    throw new Error(`bad port in ${address}`);
  }
  return { hostname: address.slice(0, colon), port };
};

type Policy =
  | { readonly mode: "exact" }
  | { readonly mode: "unordered"; readonly why: string }
  | { readonly mode: "unorderedPairs"; readonly why: string }
  | { readonly mode: "shape"; readonly depth: number; readonly why: string }
  | { readonly mode: "integerSlack"; readonly slack: number; readonly why: string };

type RelaxedPolicy = Exclude<Policy, { mode: "exact" }>;

const NO_DEFINED_ORDER = "Redis defines no order for this reply";

const UNORDERED: ReadonlyMap<string, RelaxedPolicy> = new Map<string, RelaxedPolicy>([
  ["SMEMBERS", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["SINTER", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["SUNION", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["SDIFF", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["KEYS", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["HKEYS", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["HVALS", { mode: "unordered", why: NO_DEFINED_ORDER }],
  ["HGETALL", { mode: "unorderedPairs", why: NO_DEFINED_ORDER }],
  ["CONFIG", { mode: "unorderedPairs", why: NO_DEFINED_ORDER }],
]);

const UNSPECIFIED_CURSOR = "cursor encoding and batch size are unspecified";
const RANDOM_SELECTION = "the server picks at random";
const CLOCK_TICK_SECONDS = "a second may tick between the two sends";
const CLOCK_TICK_MILLIS = "milliseconds elapse between the two sends";

const ALLOWLIST: ReadonlyMap<string, RelaxedPolicy> = new Map<string, RelaxedPolicy>([
  ["INFO", { mode: "shape", depth: 1, why: "uptime, memory, pid and version always differ" }],
  ["TIME", { mode: "shape", depth: 2, why: "wall clock" }],
  ["RANDOMKEY", { mode: "shape", depth: 1, why: RANDOM_SELECTION }],
  ["SRANDMEMBER", { mode: "shape", depth: 1, why: RANDOM_SELECTION }],
  ["HRANDFIELD", { mode: "shape", depth: 1, why: RANDOM_SELECTION }],
  ["ZRANDMEMBER", { mode: "shape", depth: 1, why: RANDOM_SELECTION }],
  ["SPOP", { mode: "shape", depth: 1, why: RANDOM_SELECTION }],
  ["SCAN", { mode: "shape", depth: 2, why: UNSPECIFIED_CURSOR }],
  ["HSCAN", { mode: "shape", depth: 2, why: UNSPECIFIED_CURSOR }],
  ["SSCAN", { mode: "shape", depth: 2, why: UNSPECIFIED_CURSOR }],
  ["ZSCAN", { mode: "shape", depth: 2, why: UNSPECIFIED_CURSOR }],
  ["TTL", { mode: "integerSlack", slack: 1, why: CLOCK_TICK_SECONDS }],
  ["EXPIRETIME", { mode: "integerSlack", slack: 1, why: CLOCK_TICK_SECONDS }],
  ["PTTL", { mode: "integerSlack", slack: 100, why: CLOCK_TICK_MILLIS }],
  ["PEXPIRETIME", { mode: "integerSlack", slack: 100, why: CLOCK_TICK_MILLIS }],
  ["DEBUG", { mode: "shape", depth: 1, why: "server internals" }],
  ["OBJECT", { mode: "shape", depth: 1, why: "encoding internals" }],
]);

const NEVER_GENERATED: ReadonlyMap<string, string> = new Map([
  ["SPOP", "removes a randomly chosen member, so the two databases drift apart"],
  ["DEBUG", "server internals, not part of the data model"],
  ["OBJECT", "reports encoding internals the Durable Object does not have"],
]);

const commandNameOf = (argv: readonly string[]): string => (argv[0] ?? "").toUpperCase();

const policyFor = (argv: readonly string[]): { policy: Policy; relaxed: boolean } => {
  const name = commandNameOf(argv);
  const unordered = UNORDERED.get(name);
  if (unordered !== undefined) return { policy: unordered, relaxed: false };
  const allowed = ALLOWLIST.get(name);
  if (allowed !== undefined) return { policy: allowed, relaxed: true };
  return { policy: { mode: "exact" }, relaxed: false };
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

const firstDifference = (a: Uint8Array, b: Uint8Array): number => {
  const limit = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return limit;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const canonical = (value: RespValue): string => {
  switch (value.kind) {
    case "bulk":
    case "verbatim":
    case "blobError":
      return `${value.kind}:${hex(value.bytes)}`;
    case "null":
      return "null";
    case "array":
    case "set":
    case "push":
    case "map":
      return `${value.kind}[${value.items.map(canonical).join(",")}]`;
    default:
      return `${value.kind}:${value.text}`;
  }
};

const shapeOf = (value: RespValue, depth: number): string => {
  if (!isAggregate(value)) return value.kind;
  if (depth <= 1) return value.kind;
  return `${value.kind}[${value.items.map((item) => shapeOf(item, depth - 1)).join(",")}]`;
};

const multiset = (items: readonly string[]): string => [...items].sort().join("\n");

const pairsOf = (value: Aggregate): string[] => {
  const out: string[] = [];
  for (let i = 0; i + 1 < value.items.length; i += ENTRIES_PER_MAP_ENTRY) {
    const key = value.items[i];
    const val = value.items[i + 1];
    if (key === undefined || val === undefined) break;
    out.push(`${canonical(key)}=${canonical(val)}`);
  }
  return out;
};

const isErrorReply = (v: RespValue): boolean => v.kind === "error" || v.kind === "blobError";

const compareErrorOutcome = (
  ref: RespValue,
  sut: RespValue,
  refRaw: Uint8Array,
  sutRaw: Uint8Array,
): string | null => {
  if (isErrorReply(ref) !== isErrorReply(sut)) {
    return `one side returned an error and the other did not (ref=${ref.kind}, sut=${sut.kind})`;
  }
  if (isErrorReply(ref) && !bytesEqual(refRaw, sutRaw)) return "error strings differ";
  return null;
};

const compareReplies = (
  policy: Policy,
  ref: RespValue,
  sut: RespValue,
  refRaw: Uint8Array,
  sutRaw: Uint8Array,
): string | null => {
  const errorOutcome = compareErrorOutcome(ref, sut, refRaw, sutRaw);
  if (errorOutcome !== null) return errorOutcome;

  switch (policy.mode) {
    case "exact":
      return bytesEqual(refRaw, sutRaw)
        ? null
        : `bytes differ at offset ${firstDifference(refRaw, sutRaw)}`;

    case "unordered": {
      if (!isAggregate(ref) || !isAggregate(sut)) {
        return bytesEqual(refRaw, sutRaw) ? null : "replies differ (and are not aggregates)";
      }
      if (ref.kind !== sut.kind) return `aggregate kind differs (${ref.kind} vs ${sut.kind})`;
      if (ref.items.length !== sut.items.length) {
        return `element count differs (${ref.items.length} vs ${sut.items.length})`;
      }
      return multiset(ref.items.map(canonical)) === multiset(sut.items.map(canonical))
        ? null
        : "same length, different elements";
    }

    case "unorderedPairs": {
      if (!isAggregate(ref) || !isAggregate(sut)) {
        return bytesEqual(refRaw, sutRaw) ? null : "replies differ (and are not aggregates)";
      }
      if (ref.items.length !== sut.items.length) {
        return `element count differs (${ref.items.length} vs ${sut.items.length})`;
      }
      return multiset(pairsOf(ref)) === multiset(pairsOf(sut))
        ? null
        : "same length, different pairs";
    }

    case "shape": {
      const a = shapeOf(ref, policy.depth);
      const b = shapeOf(sut, policy.depth);
      return a === b ? null : `reply shape differs (${a} vs ${b})`;
    }

    case "integerSlack": {
      if (ref.kind !== "integer" || sut.kind !== "integer") {
        return bytesEqual(refRaw, sutRaw)
          ? null
          : `expected integers, got ${ref.kind} and ${sut.kind}`;
      }
      const a = Number(ref.text);
      const b = Number(sut.text);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return "non-numeric integer reply";
      return Math.abs(a - b) <= policy.slack
        ? null
        : `integers differ by more than ${policy.slack} (${a} vs ${b})`;
    }
  }
};

const HEXDUMP_LIMIT = 320;
const BYTES_PER_HEXDUMP_ROW = 16;

const hexdump = (label: string, bytes: Uint8Array, markAt: number): string => {
  const shown = bytes.subarray(0, HEXDUMP_LIMIT);
  const lines: string[] = [`  ${label} (${bytes.byteLength} bytes)`];
  for (let offset = 0; offset < shown.byteLength; offset += BYTES_PER_HEXDUMP_ROW) {
    const row = shown.subarray(offset, offset + BYTES_PER_HEXDUMP_ROW);
    const cells: string[] = [];
    for (let i = 0; i < BYTES_PER_HEXDUMP_ROW; i++) {
      const byte = row[i];
      cells.push(byte === undefined ? "  " : byte.toString(16).padStart(2, "0"));
      if (i === BYTES_PER_HEXDUMP_ROW / 2 - 1) cells.push("");
    }
    const ascii = Array.from(row, (b) =>
      b >= FIRST_PRINTABLE_BYTE && b < DELETE_BYTE ? String.fromCharCode(b) : ".",
    )
      .join("")
      .padEnd(BYTES_PER_HEXDUMP_ROW, " ");
    const marker =
      markAt >= offset && markAt < offset + BYTES_PER_HEXDUMP_ROW ? " <-- first difference" : "";
    lines.push(`    ${offset.toString(16).padStart(8, "0")}  ${cells.join(" ")}  |${ascii}|${marker}`);
  }
  if (shown.byteLength === 0) lines.push("    (empty)");
  if (bytes.byteLength > HEXDUMP_LIMIT) {
    lines.push(`    ... ${bytes.byteLength - HEXDUMP_LIMIT} more bytes`);
  }
  return lines.join("\n");
};

interface Divergence {
  readonly index: number;
  readonly argv: readonly string[];
  readonly why: string;
  readonly ref: Uint8Array;
  readonly sut: Uint8Array;
}

const reportDivergence = (d: Divergence, refLabel: string, sutLabel: string): void => {
  const at = firstDifference(d.ref, d.sut);
  console.error("");
  console.error(`DIVERGENCE #${d.index}`);
  console.error(`  command  ${showCommand(d.argv)}`);
  console.error(`  reason   ${d.why}`);
  console.error("");
  console.error(hexdump(`reference ${refLabel}`, d.ref, at));
  console.error("");
  console.error(hexdump(`subject   ${sutLabel}`, d.sut, at));
};

const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const KEY_POOL = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"] as const;
const FIELD_POOL = ["f0", "f1", "f2", "f3"] as const;
const MEMBER_POOL = ["m0", "m1", "m2", "m3", "m4", "m5"] as const;

const EDGE_CASE_VALUES = [
  "",
  "a",
  "hello",
  "0",
  "42",
  "-1",
  "3.5",
  "9223372036854775807",
  "-9223372036854775808",
  "18446744073709551616",
  " leading",
  "trailing ",
  "with nul",
  " ",
  "unicode-é中",
  "x".repeat(200),
] as const;

const SCORES = ["0", "1", "-1", "2.5", "-3.25", "1e3", "inf", "-inf", "1000000"] as const;
const INDEXES = ["0", "1", "-1", "-2", "2", "10", "-10"] as const;
const COUNTS = ["1", "2", "0", "-1", "3"] as const;

interface Gen {
  readonly rng: () => number;
  pick<T>(pool: readonly T[]): T;
  int(maxExclusive: number): number;
}

const makeGen = (seed: number): Gen => {
  const rng = makeRng(seed);
  const int = (maxExclusive: number): number => Math.floor(rng() * maxExclusive);
  return {
    rng,
    int,
    pick<T>(pool: readonly T[]): T {
      const item = pool[int(pool.length)];
      if (item === undefined) throw new Error("cannot pick from an empty pool");
      return item;
    },
  };
};

type Family = (g: Gen) => string[];

const STRING_COMMANDS: readonly Family[] = [
  (g) => ["SET", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["SET", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES), g.pick(["NX", "XX"] as const)],
  (g) => ["SET", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES), "EX", "100"],
  (g) => ["SETNX", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["SETEX", g.pick(KEY_POOL), "100", g.pick(EDGE_CASE_VALUES)],
  (g) => ["GET", g.pick(KEY_POOL)],
  (g) => ["GETDEL", g.pick(KEY_POOL)],
  (g) => ["GETSET", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["APPEND", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["STRLEN", g.pick(KEY_POOL)],
  (g) => ["INCR", g.pick(KEY_POOL)],
  (g) => ["DECR", g.pick(KEY_POOL)],
  (g) => ["INCRBY", g.pick(KEY_POOL), g.pick(["1", "-1", "100", "9223372036854775807"] as const)],
  (g) => ["DECRBY", g.pick(KEY_POOL), g.pick(["1", "-1", "100"] as const)],
  (g) => ["INCRBYFLOAT", g.pick(KEY_POOL), g.pick(["0.1", "-1.5", "3.0e3", "1"] as const)],
  (g) => ["GETRANGE", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES)],
  (g) => ["SETRANGE", g.pick(KEY_POOL), g.pick(["0", "1", "5"] as const), g.pick(EDGE_CASE_VALUES)],
  (g) => [
    "MSET",
    g.pick(KEY_POOL),
    g.pick(EDGE_CASE_VALUES),
    g.pick(KEY_POOL),
    g.pick(EDGE_CASE_VALUES),
  ],
  (g) => ["MGET", g.pick(KEY_POOL), g.pick(KEY_POOL), g.pick(KEY_POOL)],
];

const HASH_COMMANDS: readonly Family[] = [
  (g) => ["HSET", g.pick(KEY_POOL), g.pick(FIELD_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => [
    "HSET",
    g.pick(KEY_POOL),
    g.pick(FIELD_POOL),
    g.pick(EDGE_CASE_VALUES),
    g.pick(FIELD_POOL),
    g.pick(EDGE_CASE_VALUES),
  ],
  (g) => ["HSETNX", g.pick(KEY_POOL), g.pick(FIELD_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["HGET", g.pick(KEY_POOL), g.pick(FIELD_POOL)],
  (g) => ["HDEL", g.pick(KEY_POOL), g.pick(FIELD_POOL)],
  (g) => ["HLEN", g.pick(KEY_POOL)],
  (g) => ["HEXISTS", g.pick(KEY_POOL), g.pick(FIELD_POOL)],
  (g) => ["HSTRLEN", g.pick(KEY_POOL), g.pick(FIELD_POOL)],
  (g) => ["HINCRBY", g.pick(KEY_POOL), g.pick(FIELD_POOL), g.pick(["1", "-2", "1000"] as const)],
  (g) => ["HINCRBYFLOAT", g.pick(KEY_POOL), g.pick(FIELD_POOL), g.pick(["0.5", "-1.25"] as const)],
  (g) => ["HMGET", g.pick(KEY_POOL), g.pick(FIELD_POOL), g.pick(FIELD_POOL)],
  (g) => ["HKEYS", g.pick(KEY_POOL)],
  (g) => ["HVALS", g.pick(KEY_POOL)],
  (g) => ["HGETALL", g.pick(KEY_POOL)],
];

const LIST_COMMANDS: readonly Family[] = [
  (g) => ["LPUSH", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["RPUSH", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES), g.pick(EDGE_CASE_VALUES)],
  (g) => ["LPUSHX", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["RPUSHX", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["LPOP", g.pick(KEY_POOL)],
  (g) => ["RPOP", g.pick(KEY_POOL)],
  (g) => ["LPOP", g.pick(KEY_POOL), g.pick(["1", "2", "0"] as const)],
  (g) => ["LLEN", g.pick(KEY_POOL)],
  (g) => ["LRANGE", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES)],
  (g) => ["LINDEX", g.pick(KEY_POOL), g.pick(INDEXES)],
  (g) => ["LSET", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(EDGE_CASE_VALUES)],
  (g) => [
    "LINSERT",
    g.pick(KEY_POOL),
    g.pick(["BEFORE", "AFTER"] as const),
    g.pick(EDGE_CASE_VALUES),
    g.pick(EDGE_CASE_VALUES),
  ],
  (g) => ["LREM", g.pick(KEY_POOL), g.pick(COUNTS), g.pick(EDGE_CASE_VALUES)],
  (g) => ["LTRIM", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES)],
  (g) => ["LPOS", g.pick(KEY_POOL), g.pick(EDGE_CASE_VALUES)],
  (g) => ["RPOPLPUSH", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => [
    "LMOVE",
    g.pick(KEY_POOL),
    g.pick(KEY_POOL),
    g.pick(["LEFT", "RIGHT"] as const),
    g.pick(["LEFT", "RIGHT"] as const),
  ],
];

const SET_COMMANDS: readonly Family[] = [
  (g) => ["SADD", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SADD", g.pick(KEY_POOL), g.pick(MEMBER_POOL), g.pick(MEMBER_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SREM", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SCARD", g.pick(KEY_POOL)],
  (g) => ["SISMEMBER", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SMISMEMBER", g.pick(KEY_POOL), g.pick(MEMBER_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SMEMBERS", g.pick(KEY_POOL)],
  (g) => ["SINTER", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SUNION", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SDIFF", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SINTERCARD", "2", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SMOVE", g.pick(KEY_POOL), g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["SINTERSTORE", g.pick(KEY_POOL), g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SUNIONSTORE", g.pick(KEY_POOL), g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["SDIFFSTORE", g.pick(KEY_POOL), g.pick(KEY_POOL), g.pick(KEY_POOL)],
];

const ZSET_COMMANDS: readonly Family[] = [
  (g) => ["ZADD", g.pick(KEY_POOL), g.pick(SCORES), g.pick(MEMBER_POOL)],
  (g) => [
    "ZADD",
    g.pick(KEY_POOL),
    g.pick(["NX", "XX", "GT", "LT", "CH"] as const),
    g.pick(SCORES),
    g.pick(MEMBER_POOL),
  ],
  (g) => ["ZINCRBY", g.pick(KEY_POOL), g.pick(SCORES), g.pick(MEMBER_POOL)],
  (g) => ["ZSCORE", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["ZMSCORE", g.pick(KEY_POOL), g.pick(MEMBER_POOL), g.pick(MEMBER_POOL)],
  (g) => ["ZCARD", g.pick(KEY_POOL)],
  (g) => [
    "ZCOUNT",
    g.pick(KEY_POOL),
    g.pick(["-inf", "0", "1"] as const),
    g.pick(["+inf", "2", "(3"] as const),
  ],
  (g) => ["ZRANGE", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES)],
  (g) => ["ZRANGE", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES), "WITHSCORES"],
  (g) => ["ZREVRANGE", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES), "WITHSCORES"],
  (g) => [
    "ZRANGEBYSCORE",
    g.pick(KEY_POOL),
    g.pick(["-inf", "0", "(1"] as const),
    g.pick(["+inf", "3", "(2"] as const),
  ],
  (g) => [
    "ZRANGEBYLEX",
    g.pick(KEY_POOL),
    g.pick(["-", "[m1", "(m0"] as const),
    g.pick(["+", "[m4", "(m5"] as const),
  ],
  (g) => ["ZRANK", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["ZREVRANK", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["ZREM", g.pick(KEY_POOL), g.pick(MEMBER_POOL)],
  (g) => ["ZREMRANGEBYRANK", g.pick(KEY_POOL), g.pick(INDEXES), g.pick(INDEXES)],
  (g) => ["ZPOPMIN", g.pick(KEY_POOL)],
  (g) => ["ZPOPMAX", g.pick(KEY_POOL), "2"],
];

const PROBE_COMMANDS: readonly Family[] = [
  (g) => ["TYPE", g.pick(KEY_POOL)],
  (g) => ["TTL", g.pick(KEY_POOL)],
  (g) => ["PTTL", g.pick(KEY_POOL)],
  (g) => ["EXISTS", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  (g) => ["EXPIRE", g.pick(KEY_POOL), g.pick(["100", "1000"] as const)],
  (g) => ["PERSIST", g.pick(KEY_POOL)],
  (g) => ["DEL", g.pick(KEY_POOL)],
  (g) => ["UNLINK", g.pick(KEY_POOL)],
  (g) => ["RENAME", g.pick(KEY_POOL), g.pick(KEY_POOL)],
  () => ["DBSIZE"],
  () => ["SCAN", "0", "COUNT", "10"],
  (g) => ["SRANDMEMBER", g.pick(KEY_POOL)],
  () => ["RANDOMKEY"],
  () => ["PING"],
  (g) => ["ECHO", g.pick(EDGE_CASE_VALUES)],
];

const ERROR_PATH_COMMANDS: readonly Family[] = [
  (g) => ["GET", g.pick(KEY_POOL), "extra"],
  () => ["SET"],
  () => ["NOSUCHCOMMAND", "a", "b"],
  (g) => ["LPUSH", g.pick(KEY_POOL)],
  (g) => ["EXPIRE", g.pick(KEY_POOL), "not-a-number"],
];

const FAMILIES: readonly (readonly [readonly Family[], number])[] = [
  [STRING_COMMANDS, 22],
  [HASH_COMMANDS, 18],
  [LIST_COMMANDS, 18],
  [SET_COMMANDS, 16],
  [ZSET_COMMANDS, 18],
  [PROBE_COMMANDS, 8],
  [ERROR_PATH_COMMANDS, 3],
];

const TOTAL_WEIGHT = FAMILIES.reduce((sum, [, weight]) => sum + weight, 0);

const nextCommand = (g: Gen): string[] => {
  let roll = g.int(TOTAL_WEIGHT);
  for (const [family, weight] of FAMILIES) {
    if (roll < weight) {
      const argv = g.pick(family)(g);
      return NEVER_GENERATED.has(commandNameOf(argv)) ? ["PING"] : argv;
    }
    roll -= weight;
  }
  return ["PING"];
};

interface Config {
  readonly ref: string;
  readonly sut: string;
  readonly seed: number;
  readonly commands: number;
  readonly maxDivergences: number;
  readonly timeoutMs: number;
  readonly verbose: boolean;
}

interface Summary {
  readonly commandsRun: number;
  readonly divergences: number;
  readonly relaxedHits: ReadonlyMap<string, number>;
}

class StopRun extends Error {}

class Runner {
  private commandsRun = 0;
  private divergences = 0;
  private readonly relaxedHits = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly ref: Conn,
    private readonly sut: Conn,
  ) {}

  async send(batch: readonly (readonly string[])[]): Promise<void> {
    const wire = concat(batch.map(encodeCommand));
    this.ref.write(wire);
    this.sut.write(wire);

    for (const argv of batch) {
      this.commandsRun += 1;
      if (this.config.verbose) console.log(`  > ${showCommand(argv)}`);

      const [refReply, sutReply] = await Promise.all([
        this.ref.readReply(this.config.timeoutMs),
        this.sut.readReply(this.config.timeoutMs),
      ]);

      const { policy, relaxed } = policyFor(argv);
      const why = compareReplies(policy, refReply.value, sutReply.value, refReply.raw, sutReply.raw);
      if (why === null) {
        if (relaxed && !bytesEqual(refReply.raw, sutReply.raw)) {
          const name = commandNameOf(argv);
          this.relaxedHits.set(name, (this.relaxedHits.get(name) ?? 0) + 1);
        }
        continue;
      }

      this.divergences += 1;
      reportDivergence(
        { index: this.divergences, argv, why, ref: refReply.raw, sut: sutReply.raw },
        this.ref.address,
        this.sut.address,
      );
      if (this.divergences >= this.config.maxDivergences) {
        throw new StopRun(`stopping after ${this.divergences} divergences`);
      }
    }
  }

  async askReference(argv: readonly string[]): Promise<RespValue> {
    this.ref.write(encodeCommand(argv));
    const reply = await this.ref.readReply(this.config.timeoutMs);
    return reply.value;
  }

  summary(): Summary {
    return {
      commandsRun: this.commandsRun,
      divergences: this.divergences,
      relaxedHits: this.relaxedHits,
    };
  }
}

const asText = (value: RespValue): string | null => {
  if (value.kind === "bulk" || value.kind === "verbatim") return decoder.decode(value.bytes);
  if (value.kind === "simple" || value.kind === "integer") return value.text;
  return null;
};

const DUMP_COMMANDS_FOR_TYPE: Readonly<Record<string, (key: string) => string[][]>> = {
  string: (key) => [
    ["GET", key],
    ["STRLEN", key],
  ],
  list: (key) => [
    ["LRANGE", key, "0", "-1"],
    ["LLEN", key],
  ],
  set: (key) => [
    ["SMEMBERS", key],
    ["SCARD", key],
  ],
  hash: (key) => [
    ["HGETALL", key],
    ["HLEN", key],
  ],
  zset: (key) => [
    ["ZRANGE", key, "0", "-1", "WITHSCORES"],
    ["ZCARD", key],
  ],
};

const compareEveryKey = async (runner: Runner): Promise<void> => {
  const keysReply = await runner.askReference(["KEYS", "*"]);
  if (!isAggregate(keysReply)) return;

  const keys = keysReply.items
    .map(asText)
    .filter((key): key is string => key !== null)
    .sort();
  console.log(`  final sweep: ${keys.length} keys`);

  await runner.send([["DBSIZE"], ["KEYS", "*"]]);

  for (const key of keys) {
    const type = asText(await runner.askReference(["TYPE", key]));
    await runner.send([["TYPE", key]]);
    const dump = type === null ? undefined : DUMP_COMMANDS_FOR_TYPE[type];
    if (dump !== undefined) await runner.send(dump(key));
  }
};

const PIPELINE_BURST_PROBABILITY = 1 / 12;
const MIN_PIPELINE_BURST = 2;
const MAX_EXTRA_PIPELINE_COMMANDS = 7;

const nextBatchSize = (g: Gen): number =>
  g.rng() < PIPELINE_BURST_PROBABILITY
    ? MIN_PIPELINE_BURST + g.int(MAX_EXTRA_PIPELINE_COMMANDS)
    : 1;

const describePolicies = (table: ReadonlyMap<string, RelaxedPolicy>): string[] =>
  [...table].map(([name, policy]) => `    ${name.padEnd(13)} ${policy.why}`);

const printBanner = (config: Config): void => {
  console.log("dored differential test");
  console.log(`  reference    ${config.ref}`);
  console.log(`  subject      ${config.sut}`);
  console.log(`  seed         ${config.seed}`);
  console.log(`  commands     ${config.commands}`);
  console.log("");
  console.log("  compared byte for byte, except:");
  for (const line of describePolicies(UNORDERED)) console.log(line);
  for (const line of describePolicies(ALLOWLIST)) console.log(line);
  console.log("");
  console.log("  never generated:");
  for (const [name, reason] of NEVER_GENERATED) console.log(`    ${name.padEnd(13)} ${reason}`);
  console.log("");
};

const run = async (config: Config): Promise<Summary> => {
  printBanner(config);

  const [ref, sut] = await Promise.all([
    Conn.open("reference", config.ref),
    Conn.open("subject", config.sut),
  ]);

  const runner = new Runner(config, ref, sut);
  const gen = makeGen(config.seed);

  try {
    await runner.send([["FLUSHALL"]]);

    let issued = 0;
    while (issued < config.commands) {
      const size = nextBatchSize(gen);
      const batch: string[][] = [];
      for (let i = 0; i < size && issued < config.commands; i++, issued++) {
        batch.push(nextCommand(gen));
      }
      await runner.send(batch);
    }

    console.log("");
    await compareEveryKey(runner);
  } catch (cause) {
    if (!(cause instanceof StopRun)) throw cause;
  } finally {
    ref.close();
    sut.close();
  }

  return runner.summary();
};

const USAGE = `dored differential test — diff raw RESP replies against a real redis-server

  bun test/differential.ts [options]

Options
  --ref <host:port>        reference redis-server  (env REF, default localhost:6380)
  --sut <host:port>        the shim under test     (env SUT, default localhost:6379)
  --seed <n>               reproduce a run         (env SEED, default: random, printed)
  --commands <n>           commands to generate    (env COMMANDS, default 2000)
  --max-divergences <n>    stop after this many    (env MAX_DIVERGENCES, default 5)
  --timeout <ms>           per-reply timeout       (env TIMEOUT_MS, default 5000)
  --verbose                print every command
  -h, --help               this text

Start a reference server with:
  docker run --rm -p 6380:6379 redis:7
`;

const DEFAULT_REF = "localhost:6380";
const DEFAULT_SUT = "localhost:6379";
const DEFAULT_COMMANDS = 2000;
const DEFAULT_MAX_DIVERGENCES = 5;
const DEFAULT_TIMEOUT_MS = 5000;
const SEED_RANGE = 0xffffffff;

const parseConfig = (argv: readonly string[]): Config => {
  const env = Bun.env;
  const nonNegativeInteger = (label: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer, got ${raw}`);
    }
    return value;
  };

  let ref = env.REF ?? DEFAULT_REF;
  let sut = env.SUT ?? DEFAULT_SUT;
  let seed =
    env.SEED === undefined
      ? (Math.random() * SEED_RANGE) >>> 0
      : nonNegativeInteger("SEED", env.SEED);
  let commands =
    env.COMMANDS === undefined ? DEFAULT_COMMANDS : nonNegativeInteger("COMMANDS", env.COMMANDS);
  let maxDivergences =
    env.MAX_DIVERGENCES === undefined
      ? DEFAULT_MAX_DIVERGENCES
      : nonNegativeInteger("MAX_DIVERGENCES", env.MAX_DIVERGENCES);
  let timeoutMs =
    env.TIMEOUT_MS === undefined
      ? DEFAULT_TIMEOUT_MS
      : nonNegativeInteger("TIMEOUT_MS", env.TIMEOUT_MS);
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--ref":
        ref = next();
        break;
      case "--sut":
        sut = next();
        break;
      case "--seed":
        seed = nonNegativeInteger("--seed", next());
        break;
      case "--commands":
        commands = nonNegativeInteger("--commands", next());
        break;
      case "--max-divergences":
        maxDivergences = nonNegativeInteger("--max-divergences", next());
        break;
      case "--timeout":
        timeoutMs = nonNegativeInteger("--timeout", next());
        break;
      case "--verbose":
        verbose = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }

  return { ref, sut, seed, commands, maxDivergences, timeoutMs, verbose };
};

const MILLIS_PER_SECOND = 1000;

if (import.meta.main) {
  let config: Config;
  try {
    config = parseConfig(Bun.argv.slice(2));
  } catch (cause) {
    console.error(`differential: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error(USAGE);
    process.exit(2);
  }

  const startedAt = performance.now();
  let summary: Summary;
  try {
    summary = await run(config);
  } catch (cause) {
    console.error("");
    console.error(`differential: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error(`  reproduce with SEED=${config.seed}`);
    process.exit(1);
  }

  const elapsed = ((performance.now() - startedAt) / MILLIS_PER_SECOND).toFixed(1);
  console.log("");
  console.log("summary");
  console.log(`  commands     ${summary.commandsRun}`);
  console.log(`  divergences  ${summary.divergences}`);
  console.log(`  seed         ${config.seed}`);
  console.log(`  elapsed      ${elapsed}s`);
  if (summary.relaxedHits.size > 0) {
    const used = [...summary.relaxedHits]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}x${count}`)
      .join(" ");
    console.log(`  relaxations  ${used}`);
  }

  if (summary.divergences > 0) {
    console.log("");
    console.log(`FAIL — ${summary.divergences} divergence(s); reproduce with SEED=${config.seed}`);
    process.exit(1);
  }
  console.log("");
  console.log(`PASS — ${summary.commandsRun} commands, replies byte-identical`);
}
