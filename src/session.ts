import { ProtocolError, RequestDecoder, encodeReply } from "./resp";
import {
  dispatch,
  dispatchOutsideTransaction,
  internalErrorFor,
  keysOf,
  lookup,
  registry,
  satisfiesArity,
} from "./commands";
import type { ConnState } from "./commands/spec";
import { TABLE_INTERNAL_COUNTERS, TABLE_META, TIER_COLD, type SqlStorage } from "./schema";
import { asBytes, byteKey, type Store } from "./store";
import type { ColdBucket } from "./tier/bucket";
import {
  DEFAULT_TIER_POLICY,
  assertFaultedIn,
  coldIndex,
  faultIn,
  maintenanceGate,
  relievePressure,
  type TierDeps,
  type TierPass,
  type TierPolicy,
} from "./tier/engine";
import { describeBytes, unknownCommand, wrongArity } from "./errors";
import {
  type Command,
  type Reply,
  NULL,
  NULL_ARRAY,
  OK,
  array,
  bulk,
  decodeUtf8,
  encodeUtf8,
  error,
  integer,
  push,
  simple,
} from "./types";

export const MAX_QUEUED_COMMANDS = 1024;
export const MAX_QUEUED_BYTES = 512 * 1024;
export const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
export const MAX_SUBSCRIPTIONS = 1024;
export const MAX_SUBSCRIPTION_BYTES = 64 * 1024;
export const MAX_INLINE_ATTACHMENT_BYTES = 12 * 1024;

export const MAX_PRIMED_COLD_KEYS = 100_000;

export const ATTACHMENT_FORMAT = 1;
export const SNAPSHOT_FORMAT = 1;

const TABLE_CONN_SPILL = "conn_spill";
const TABLE_CONN_WATCH = "conn_watch";
const TABLE_CONN_DIRTY = "conn_dirty";
const COUNTER_CLIENT_ID = "client_id_seq";

const SESSION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE_CONN_SPILL} (
     conn INTEGER PRIMARY KEY,
     state BLOB NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_CONN_WATCH} (
     conn INTEGER NOT NULL,
     key BLOB NOT NULL,
     PRIMARY KEY (conn, key)
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS conn_watch_key ON ${TABLE_CONN_WATCH}(key)`,

  `CREATE TABLE IF NOT EXISTS ${TABLE_CONN_DIRTY} (
     conn INTEGER PRIMARY KEY
   )`,
];

export const applySessionSchema = (sql: SqlStorage): void => {
  for (const statement of SESSION_SCHEMA) sql.exec(statement);
};

type Bytes = Uint8Array<ArrayBufferLike>;

const NO_BYTES: Bytes = new Uint8Array(0);

const EMPTY_COMMAND = error("ERR empty command");
const EXECABORT = error("EXECABORT Transaction discarded because of previous errors.");
const NESTED_MULTI = error("ERR MULTI calls can not be nested");
const DISCARD_WITHOUT_MULTI = error("ERR DISCARD without MULTI");
const EXEC_WITHOUT_MULTI = error("ERR EXEC without MULTI");
const WATCH_INSIDE_MULTI = error("ERR WATCH inside MULTI is not allowed");
const QUEUED = simple("QUEUED");
const RESET_REPLY = simple("RESET");

const QUEUE_BUDGET_EXCEEDED = error(
  `ERR transaction queue exceeds the ${MAX_QUEUED_BYTES} byte connection budget`,
);
const SUBSCRIPTION_BUDGET_EXCEEDED = error(
  `ERR subscriptions exceed the ${MAX_SUBSCRIPTION_BYTES} byte connection budget`,
);
const INPUT_BUDGET_EXCEEDED = error(
  `ERR Protocol error: request exceeds the ${MAX_PENDING_INPUT_BYTES} byte connection input budget`,
);

const subscribedContext = (name: string): Reply =>
  error(
    `ERR Can't execute '${describeBytes(name)}': only (P|S)SUBSCRIBE / ` +
      `(P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
  );

export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

const GLOB_STAR = 0x2a;
const GLOB_QUESTION = 0x3f;
const GLOB_OPEN = 0x5b;
const GLOB_CLOSE = 0x5d;
const GLOB_CARET = 0x5e;
const GLOB_DASH = 0x2d;
const GLOB_ESCAPE = 0x5c;

const matchClass = (pattern: Uint8Array, open: number, byte: number): readonly [boolean, number] => {
  const end = pattern.length;
  let at = open + 1;
  let negated = false;
  if (at < end && pattern[at] === GLOB_CARET) {
    negated = true;
    at += 1;
  }

  let matched = false;
  for (;;) {
    if (at >= end) {
      at = end;
      break;
    }
    const current = pattern[at] as number;
    if (current === GLOB_ESCAPE && at + 1 < end) {
      at += 1;
      if (pattern[at] === byte) matched = true;
    } else if (current === GLOB_CLOSE) {
      at += 1;
      break;
    } else if (at + 2 < end && pattern[at + 1] === GLOB_DASH) {
      const first = current;
      const second = pattern[at + 2] as number;
      const low = first <= second ? first : second;
      const high = first <= second ? second : first;
      if (byte >= low && byte <= high) matched = true;
      at += 2;
    } else if (current === byte) {
      matched = true;
    }
    at += 1;
  }

  return [negated ? !matched : matched, at];
};

const matchElement = (
  pattern: Uint8Array,
  at: number,
  byte: number,
): readonly [boolean, number] => {
  const current = pattern[at] as number;
  if (current === GLOB_QUESTION) return [true, at + 1];
  if (current === GLOB_OPEN) return matchClass(pattern, at, byte);
  if (current === GLOB_ESCAPE && at + 1 < pattern.length) {
    return [pattern[at + 1] === byte, at + 2];
  }
  return [current === byte, at + 1];
};

export const matchGlobBytes = (pattern: Uint8Array, subject: Uint8Array): boolean => {
  let patternAt = 0;
  let subjectAt = 0;
  let starPattern = -1;
  let starSubject = -1;

  while (subjectAt < subject.length) {
    if (patternAt < pattern.length) {
      if (pattern[patternAt] === GLOB_STAR) {
        while (patternAt < pattern.length && pattern[patternAt] === GLOB_STAR) patternAt += 1;
        if (patternAt === pattern.length) return true;
        starPattern = patternAt;
        starSubject = subjectAt;
        continue;
      }
      const [ok, next] = matchElement(pattern, patternAt, subject[subjectAt] as number);
      if (ok) {
        patternAt = next;
        subjectAt += 1;
        continue;
      }
    }
    if (starPattern < 0) return false;
    starSubject += 1;
    subjectAt = starSubject;
    patternAt = starPattern;
  }

  while (patternAt < pattern.length && pattern[patternAt] === GLOB_STAR) patternAt += 1;
  return patternAt === pattern.length;
};

class SnapshotWriter {
  #buffer = new Uint8Array(256);
  #at = 0;

  #room(extra: number): void {
    const needed = this.#at + extra;
    if (needed <= this.#buffer.length) return;
    let capacity = this.#buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#at));
    this.#buffer = grown;
  }

  u8(value: number): void {
    this.#room(1);
    this.#buffer[this.#at] = value & 0xff;
    this.#at += 1;
  }

  u32(value: number): void {
    this.#room(4);
    const at = this.#at;
    this.#buffer[at] = (value >>> 24) & 0xff;
    this.#buffer[at + 1] = (value >>> 16) & 0xff;
    this.#buffer[at + 2] = (value >>> 8) & 0xff;
    this.#buffer[at + 3] = value & 0xff;
    this.#at = at + 4;
  }

  bytes(value: Bytes): void {
    this.u32(value.length);
    this.#room(value.length);
    this.#buffer.set(value, this.#at);
    this.#at += value.length;
  }

  done(): Uint8Array {
    return this.#buffer.slice(0, this.#at);
  }
}

class SnapshotReader {
  #buffer: Uint8Array;
  #at = 0;

  constructor(buffer: Uint8Array) {
    this.#buffer = buffer;
  }

  u8(): number {
    if (this.#at + 1 > this.#buffer.length) throw new RangeError("session: truncated snapshot");
    const value = this.#buffer[this.#at] as number;
    this.#at += 1;
    return value;
  }

  u32(): number {
    if (this.#at + 4 > this.#buffer.length) throw new RangeError("session: truncated snapshot");
    const at = this.#at;
    const value =
      ((this.#buffer[at] as number) << 24) |
      ((this.#buffer[at + 1] as number) << 16) |
      ((this.#buffer[at + 2] as number) << 8) |
      (this.#buffer[at + 3] as number);
    this.#at = at + 4;
    return value >>> 0;
  }

  bytes(): Uint8Array {
    const length = this.u32();
    if (this.#at + length > this.#buffer.length) throw new RangeError("session: truncated snapshot");
    const value = this.#buffer.slice(this.#at, this.#at + length);
    this.#at += length;
    return value;
  }
}

const HAS_NAME = 1;
const HAS_QUEUE = 2;
const QUEUE_DIRTY = 4;
const WATCHING = 8;

const ignoreSettled = (): void => undefined;

const commandBytes = (argv: Command): number => {
  let total = 8;
  for (const arg of argv) total += arg.length + 8;
  return total;
};

export class Session {
  readonly decoder = new RequestDecoder();
  readonly conn: ConnState;
  queue: Command[] | null = null;
  queueDirty = false;
  queuedBytes = 0;
  readonly channels = new Map<string, Uint8Array>();
  readonly patterns = new Map<string, Uint8Array>();
  subscriptionBytes = 0;
  watching = false;
  closing = false;
  spilled = false;
  #arrivals: Promise<void> = Promise.resolve();

  private constructor(conn: ConnState) {
    this.conn = conn;
  }

  inOrder(body: () => Promise<void>): Promise<void> {
    const next = this.#arrivals.then(body, body);
    this.#arrivals = next.then(ignoreSettled, ignoreSettled);
    return next;
  }

  static blank(id: number): Session {
    return new Session({
      protocol: 2,
      id,
      name: null,
      db: 0,
      closeAfterReply: false,
    });
  }

  static restore(snapshot: Uint8Array): Session {
    const reader = new SnapshotReader(snapshot);
    if (reader.u8() !== SNAPSHOT_FORMAT) throw new RangeError("session: unknown snapshot format");

    const protocol = reader.u8() === 3 ? 3 : 2;
    const db = reader.u8();
    const id = reader.u32();
    const flags = reader.u8();

    const session = Session.blank(id);
    session.conn.protocol = protocol;
    session.conn.db = db;
    if ((flags & HAS_NAME) !== 0) session.conn.name = decodeUtf8(reader.bytes());

    const pending = reader.bytes();
    if (pending.length > 0) session.decoder.push(pending);

    if ((flags & HAS_QUEUE) !== 0) {
      const queue: Command[] = [];
      const commands = reader.u32();
      for (let i = 0; i < commands; i++) {
        const argc = reader.u32();
        const argv: Uint8Array[] = [];
        for (let a = 0; a < argc; a++) argv.push(reader.bytes());
        queue.push(argv);
        session.queuedBytes += commandBytes(argv);
      }
      session.queue = queue;
    }
    session.queueDirty = (flags & QUEUE_DIRTY) !== 0;
    session.watching = (flags & WATCHING) !== 0;

    const channels = reader.u32();
    for (let i = 0; i < channels; i++) session.addSubscription(session.channels, reader.bytes());
    const patterns = reader.u32();
    for (let i = 0; i < patterns; i++) session.addSubscription(session.patterns, reader.bytes());

    return session;
  }

  addSubscription(index: Map<string, Uint8Array>, target: Uint8Array): boolean {
    const id = byteKey(target);
    if (index.has(id)) return false;
    index.set(id, target);
    this.subscriptionBytes += target.length;
    return true;
  }

  removeSubscription(index: Map<string, Uint8Array>, target: Uint8Array): boolean {
    const id = byteKey(target);
    const held = index.get(id);
    if (held === undefined) return false;
    index.delete(id);
    this.subscriptionBytes -= held.length;
    return true;
  }

  snapshot(pending: Bytes = NO_BYTES): Uint8Array {
    const writer = new SnapshotWriter();
    writer.u8(SNAPSHOT_FORMAT);
    writer.u8(this.conn.protocol);
    writer.u8(this.conn.db);
    writer.u32(this.conn.id);

    const name = this.conn.name;
    const queue = this.queue;
    writer.u8(
      (name === null ? 0 : HAS_NAME) |
        (queue === null ? 0 : HAS_QUEUE) |
        (this.queueDirty ? QUEUE_DIRTY : 0) |
        (this.watching ? WATCHING : 0),
    );

    if (name !== null) writer.bytes(encodeUtf8(name));
    writer.bytes(pending);

    if (queue !== null) {
      writer.u32(queue.length);
      for (const argv of queue) {
        writer.u32(argv.length);
        for (const arg of argv) writer.bytes(arg);
      }
    }

    writer.u32(this.channels.size);
    for (const channel of this.channels.values()) writer.bytes(channel);
    writer.u32(this.patterns.size);
    for (const pattern of this.patterns.values()) writer.bytes(pattern);

    return writer.done();
  }

  get inMulti(): boolean {
    return this.queue !== null;
  }

  get subscriptionCount(): number {
    return this.channels.size + this.patterns.size;
  }

  get subscribed(): boolean {
    return this.subscriptionCount > 0;
  }
}

export interface Peer {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface Host {
  readonly sql: SqlStorage;
  readonly store: Store;
  readonly bucket: ColdBucket | null;
  readonly coldIndexLimit?: number;
  peers(): Iterable<Peer>;
  atomically<T>(run: () => T): T;
}

interface ConnectionSpec {
  readonly name: string;
  readonly arity: number;
  readonly immediate: boolean;
}

const connection = (name: string, arity: number, immediate: boolean): ConnectionSpec => ({
  name,
  arity,
  immediate,
});

export const CONNECTION_COMMANDS: ReadonlyMap<string, ConnectionSpec> = new Map(
  [
    connection("multi", 1, true),
    connection("exec", 1, true),
    connection("discard", 1, true),
    connection("watch", -2, true),
    connection("reset", 1, true),
    connection("quit", -1, true),
    connection("unwatch", 1, false),
    connection("subscribe", -2, false),
    connection("unsubscribe", -1, false),
    connection("psubscribe", -2, false),
    connection("punsubscribe", -1, false),
    connection("publish", 3, false),
  ].map((spec) => [spec.name, spec]),
);

const ALLOWED_WHILE_SUBSCRIBED: ReadonlySet<string> = new Set([
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "ping",
  "quit",
  "reset",
]);

const FLUSH_COMMANDS: ReadonlySet<string> = new Set(["flushall", "flushdb"]);

const subscriptionAck = (name: string, target: Uint8Array | null, count: number): Reply =>
  push([bulk(name), target === null ? NULL : bulk(target), integer(count)]);

const collapse = (replies: readonly Reply[]): Reply =>
  replies.length === 1 ? (replies[0] as Reply) : array(replies);

interface Attachment {
  readonly v: number;
  readonly i: number;
  readonly s: Uint8Array | null;
}

const readAttachment = (raw: unknown): Attachment | null => {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as Partial<Attachment>;
  if (candidate.v !== ATTACHMENT_FORMAT) return null;
  if (typeof candidate.i !== "number" || !Number.isSafeInteger(candidate.i)) return null;
  const snapshot = candidate.s;
  if (snapshot !== null && !(snapshot instanceof Uint8Array)) return null;
  return { v: ATTACHMENT_FORMAT, i: candidate.i, s: snapshot ?? null };
};

export class SessionExecutor {
  readonly #host: Host;
  readonly #sessions = new WeakMap<Peer, Session>();
  readonly #closed = new WeakSet<Peer>();
  readonly #tier: TierDeps | null;
  #watchersExist: boolean | null = null;

  constructor(host: Host) {
    this.#host = host;
    applySessionSchema(host.sql);
    this.#tier =
      host.bucket === null
        ? null
        : {
            store: host.store,
            bucket: host.bucket,
            index: coldIndex(),
            maintenance: maintenanceGate(),
            atomically: (run) => host.atomically(run),
            now: () => Date.now(),
          };
    const tier = this.#tier;
    if (tier !== null) {
      const limit = host.coldIndexLimit ?? MAX_PRIMED_COLD_KEYS;
      const cold = this.#coldKeys(limit + 1);
      if (cold.length <= limit) tier.index.prime(cold);
    }
  }

  get tiering(): TierDeps | null {
    return this.#tier;
  }

  async relieve(policy: TierPolicy = DEFAULT_TIER_POLICY): Promise<TierPass | null> {
    const tier = this.#tier;
    if (tier === null || tier.maintenance.busy) return null;
    try {
      return await relievePressure(tier, policy);
    } catch (cause) {
      console.error("radish: eviction pass failed", cause);
      return null;
    }
  }

  #coldKeys(limit: number): Uint8Array[] {
    return this.#host.sql
      .exec(`SELECT key FROM ${TABLE_META} WHERE tier = ? LIMIT ?`, TIER_COLD, limit)
      .toArray()
      .map((row) => asBytes(row["key"] as ArrayBuffer));
  }

  #tierEngaged(): boolean {
    const tier = this.#tier;
    return tier !== null && !(tier.index.primed && tier.index.size === 0);
  }

  #faultInFor(session: Session, argv: Command): Promise<void> | null {
    if (!this.#tierEngaged()) return null;
    const keys = this.#keysReachedBy(session, argv);
    return keys.length === 0 ? null : faultIn(this.#tier as TierDeps, keys);
  }

  #keysReachedBy(session: Session, argv: Command): Uint8Array[] {
    const head = argv[0];
    if (head === undefined) return [];
    if (session.inMulti && decodeUtf8(head).toLowerCase() === "exec") {
      const keys: Uint8Array[] = [];
      for (const queued of session.queue ?? []) for (const key of keysOf(queued)) keys.push(key);
      return keys;
    }
    return keysOf(argv);
  }

  open(peer: Peer): Session {
    this.#closed.delete(peer);
    const session = Session.blank(this.#mintConnectionId());
    this.#persist(peer, session);
    return session;
  }

  close(peer: Peer): void {
    const session = this.#sessions.get(peer);
    if (session === undefined) {
      const attachment = readAttachment(peer.deserializeAttachment());
      this.#closed.add(peer);
      if (attachment !== null) this.#release(attachment.i);
      return;
    }
    this.#forget(peer, session);
  }

  sessionOf(peer: Peer): Session {
    const live = this.#sessions.get(peer);
    if (live !== undefined) return live;
    const revived = this.#revive(peer);
    this.#sessions.set(peer, revived);
    return revived;
  }

  message(peer: Peer, chunk: Uint8Array, now: number): Promise<void> {
    if (this.#closed.has(peer)) return Promise.resolve();
    const session = this.sessionOf(peer);
    session.decoder.push(chunk);
    return session.inOrder(() => this.#drain(session, peer, now));
  }

  async #drain(session: Session, peer: Peer, now: number): Promise<void> {
    if (session.closing || this.#closed.has(peer)) return;

    const out: Uint8Array[] = [];
    let fatal: Reply | null = null;

    for (;;) {
      let argv: Command | null;
      try {
        argv = session.decoder.next();
      } catch (cause) {
        if (!(cause instanceof ProtocolError)) throw cause;
        fatal = cause.reply;
        break;
      }
      if (argv === null) break;

      const faulting = this.#faultInFor(session, argv);
      if (faulting !== null) {
        try {
          await faulting;
        } catch (cause) {
          out.push(encodeReply(internalErrorFor(cause), session.conn.protocol));
          continue;
        }
      }

      for (const reply of this.#run(session, peer, argv, now)) {
        out.push(encodeReply(reply, session.conn.protocol));
      }
      if (session.closing) break;
    }

    let pending: Bytes = NO_BYTES;
    if (fatal === null && !session.closing) {
      pending = session.decoder.remaining();
      if (pending.byteLength > MAX_PENDING_INPUT_BYTES) fatal = INPUT_BUDGET_EXCEEDED;
    }

    if (fatal !== null) {
      out.push(encodeReply(fatal, session.conn.protocol));
      session.closing = true;
    }

    if (out.length > 0 && !this.#deliver(peer, session, concatBytes(out))) return;

    if (session.closing) {
      this.#forget(peer, session);
      peer.close(1000, fatal === null ? "QUIT" : "protocol error");
      return;
    }

    this.#persist(peer, session, pending);
  }

  #deliver(peer: Peer, session: Session, frame: Uint8Array): boolean {
    try {
      peer.send(frame);
      return true;
    } catch {
      this.#drop(peer, session);
      return false;
    }
  }

  reap(): void {
    const live = new Set<number>();
    for (const peer of this.#host.peers()) live.add(this.sessionOf(peer).conn.id);

    for (const table of [TABLE_CONN_SPILL, TABLE_CONN_WATCH, TABLE_CONN_DIRTY]) {
      const rows = this.#host.sql
        .exec<{ conn: number }>(`SELECT DISTINCT conn FROM ${table}`)
        .toArray();
      for (const row of rows) {
        if (live.has(row.conn)) continue;
        this.#host.sql.exec(`DELETE FROM ${table} WHERE conn = ?`, row.conn);
      }
    }
    this.#watchersExist = null;
  }

  #run(session: Session, peer: Peer, argv: Command, now: number): readonly Reply[] {
    const head = argv[0];
    if (head === undefined) return [EMPTY_COMMAND];

    const spelling = decodeUtf8(head);
    const name = spelling.toLowerCase();
    const spec = CONNECTION_COMMANDS.get(name);
    const known = spec !== undefined || lookup(name) !== undefined;

    if (
      known &&
      session.conn.protocol === 2 &&
      session.subscribed &&
      !ALLOWED_WHILE_SUBSCRIBED.has(name)
    ) {
      if (session.inMulti) session.queueDirty = true;
      return [subscribedContext(name)];
    }

    if (session.inMulti) {
      if (spec !== undefined && spec.immediate) {
        return this.#connectionCommand(session, peer, spec, argv, now);
      }
      return [this.#enqueue(session, spec, head, name, argv)];
    }

    if (spec !== undefined) return this.#connectionCommand(session, peer, spec, argv, now);

    if (name === "ping" && session.conn.protocol === 2 && session.subscribed) {
      if (argv.length > 2) return [wrongArity("ping")];
      return [push([bulk("pong"), bulk(argv[1] ?? NO_BYTES)])];
    }

    return [this.#execute(session, name, argv, now, false)];
  }

  #enqueue(
    session: Session,
    spec: ConnectionSpec | undefined,
    head: Uint8Array,
    name: string,
    argv: Command,
  ): Reply {
    if (spec === undefined) {
      const registered = registry.get(name);
      if (registered === undefined) {
        session.queueDirty = true;
        return unknownCommand(head, argv.slice(1));
      }
      if (!satisfiesArity(registered.arity, argv.length)) {
        session.queueDirty = true;
        return wrongArity(head);
      }
    } else if (!satisfiesArity(spec.arity, argv.length)) {
      session.queueDirty = true;
      return wrongArity(head);
    }

    const queue = session.queue as Command[];
    const size = commandBytes(argv);
    if (queue.length >= MAX_QUEUED_COMMANDS || session.queuedBytes + size > MAX_QUEUED_BYTES) {
      session.queueDirty = true;
      return QUEUE_BUDGET_EXCEEDED;
    }

    queue.push(argv);
    session.queuedBytes += size;
    return QUEUED;
  }

  #connectionCommand(
    session: Session,
    peer: Peer,
    spec: ConnectionSpec,
    argv: Command,
    now: number,
  ): readonly Reply[] {
    if (!satisfiesArity(spec.arity, argv.length)) {
      if (session.inMulti) session.queueDirty = true;
      return [wrongArity(spec.name)];
    }

    switch (spec.name) {
      case "multi":
        if (session.inMulti) return [NESTED_MULTI];
        session.queue = [];
        session.queueDirty = false;
        session.queuedBytes = 0;
        return [OK];

      case "discard":
        if (!session.inMulti) return [DISCARD_WITHOUT_MULTI];
        this.#discard(session);
        return [OK];

      case "exec":
        return [this.#exec(session, peer, now)];

      case "watch":
        if (session.inMulti) return [WATCH_INSIDE_MULTI];
        this.#watch(session, argv.slice(1));
        return [OK];

      case "unwatch":
        this.#unwatch(session);
        return [OK];

      case "reset":
        this.#reset(session);
        return [RESET_REPLY];

      case "quit":
        session.closing = true;
        session.conn.closeAfterReply = true;
        return [OK];

      case "publish":
        return [integer(this.#publish(argv[1] as Uint8Array, argv[2] as Uint8Array))];

      default:
        return this.#subscription(session, spec.name, argv);
    }
  }

  #exec(session: Session, peer: Peer, now: number): Reply {
    if (!session.inMulti) return EXEC_WITHOUT_MULTI;

    const queued = session.queue as Command[];
    const abortedByErrors = session.queueDirty;
    const abortedByWatch = !abortedByErrors && this.#watchDirty(session);
    this.#discard(session);

    if (abortedByErrors) return EXECABORT;
    if (abortedByWatch) return NULL_ARRAY;

    const replies: Reply[] = [];
    try {
      this.#host.atomically(() => {
        replies.length = 0;
        for (const argv of queued) replies.push(collapse(this.#queued(session, peer, argv, now)));
      });
    } catch (cause) {
      return internalErrorFor(cause);
    }
    return array(replies);
  }

  #queued(session: Session, peer: Peer, argv: Command, now: number): readonly Reply[] {
    const head = argv[0] as Uint8Array;
    const name = decodeUtf8(head).toLowerCase();
    const spec = CONNECTION_COMMANDS.get(name);
    if (spec !== undefined) return this.#connectionCommand(session, peer, spec, argv, now);
    return [this.#execute(session, name, argv, now, true)];
  }

  #execute(
    session: Session,
    name: string,
    argv: Command,
    now: number,
    insideTransaction: boolean,
  ): Reply {
    const spec = registry.get(name);
    if (spec?.write === true && this.#tierEngaged()) {
      if (insideTransaction) {
        assertFaultedIn(this.#tier as TierDeps, keysOf(argv));
      } else {
        try {
          assertFaultedIn(this.#tier as TierDeps, keysOf(argv));
        } catch (cause) {
          return internalErrorFor(cause);
        }
      }
    }
    const ctx = {
      store: this.#host.store,
      sql: this.#host.sql,
      now,
      conn: session.conn,
      commands: registry,
    };
    const reply = insideTransaction
      ? dispatch(ctx, argv)
      : dispatchOutsideTransaction(ctx, argv);
    if (spec?.write === true) this.#touchWatchers(name, argv);
    if (session.conn.closeAfterReply) session.closing = true;
    return reply;
  }

  #discard(session: Session): void {
    session.queue = null;
    session.queueDirty = false;
    session.queuedBytes = 0;
    this.#unwatch(session);
  }

  #reset(session: Session): void {
    this.#discard(session);
    session.channels.clear();
    session.patterns.clear();
    session.subscriptionBytes = 0;
    session.conn.protocol = 2;
    session.conn.name = null;
    session.conn.db = 0;
    session.conn.closeAfterReply = false;
  }

  #subscription(session: Session, name: string, argv: Command): readonly Reply[] {
    const patterned = name === "psubscribe" || name === "punsubscribe";
    const adding = name === "subscribe" || name === "psubscribe";
    const index = patterned ? session.patterns : session.channels;

    const targets = argv.length > 1 ? argv.slice(1) : [...index.values()];
    if (targets.length === 0) {
      return [subscriptionAck(name, null, session.subscriptionCount)];
    }

    const replies: Reply[] = [];
    for (const target of targets) {
      if (adding) {
        const fresh = !index.has(byteKey(target));
        if (fresh) {
          if (
            session.subscriptionCount >= MAX_SUBSCRIPTIONS ||
            session.subscriptionBytes + target.length > MAX_SUBSCRIPTION_BYTES
          ) {
            replies.push(SUBSCRIPTION_BUDGET_EXCEEDED);
            continue;
          }
          session.addSubscription(index, target);
        }
      } else {
        session.removeSubscription(index, target);
      }
      replies.push(subscriptionAck(name, target, session.subscriptionCount));
    }
    return replies;
  }

  #publish(channel: Uint8Array, payload: Uint8Array): number {
    const id = byteKey(channel);
    let delivered = 0;

    for (const peer of this.#host.peers()) {
      let session: Session;
      try {
        session = this.sessionOf(peer);
      } catch {
        continue;
      }

      const frames: Reply[] = [];
      if (session.channels.has(id)) {
        frames.push(push([bulk("message"), bulk(channel), bulk(payload)]));
      }
      for (const pattern of session.patterns.values()) {
        if (!matchGlobBytes(pattern, channel)) continue;
        frames.push(push([bulk("pmessage"), bulk(pattern), bulk(channel), bulk(payload)]));
      }
      if (frames.length === 0) continue;

      const encoded = concatBytes(
        frames.map((frame) => encodeReply(frame, session.conn.protocol)),
      );
      try {
        peer.send(encoded);
        delivered += frames.length;
      } catch {
        this.#drop(peer, session);
      }
    }

    return delivered;
  }

  #drop(peer: Peer, session: Session): void {
    this.#forget(peer, session);
    try {
      peer.close(1011, "delivery failed");
    } catch {
      return;
    }
  }

  #watch(session: Session, keys: readonly Uint8Array[]): void {
    for (const key of keys) {
      this.#host.sql.exec(
        `INSERT OR IGNORE INTO ${TABLE_CONN_WATCH} (conn, key) VALUES (?, ?)`,
        session.conn.id,
        key,
      );
    }
    session.watching = true;
    this.#watchersExist = true;
  }

  #unwatch(session: Session): void {
    if (!session.watching) return;
    this.#host.sql.exec(`DELETE FROM ${TABLE_CONN_WATCH} WHERE conn = ?`, session.conn.id);
    this.#host.sql.exec(`DELETE FROM ${TABLE_CONN_DIRTY} WHERE conn = ?`, session.conn.id);
    session.watching = false;
    this.#watchersExist = null;
  }

  #watchDirty(session: Session): boolean {
    if (!session.watching) return false;
    return (
      this.#host.sql
        .exec<{ present: number }>(
          `SELECT EXISTS(SELECT 1 FROM ${TABLE_CONN_DIRTY} WHERE conn = ?) AS present`,
          session.conn.id,
        )
        .one().present === 1
    );
  }

  #touchWatchers(name: string, argv: Command): void {
    if (this.#watchersExist === null) {
      this.#watchersExist =
        this.#host.sql
          .exec<{ present: number }>(
            `SELECT EXISTS(SELECT 1 FROM ${TABLE_CONN_WATCH}) AS present`,
          )
          .one().present === 1;
    }
    if (!this.#watchersExist) return;

    if (FLUSH_COMMANDS.has(name)) {
      this.#host.sql.exec(
        `INSERT OR IGNORE INTO ${TABLE_CONN_DIRTY} (conn)
         SELECT DISTINCT conn FROM ${TABLE_CONN_WATCH}`,
      );
      return;
    }

    for (const key of keysOf(argv)) {
      this.#host.sql.exec(
        `INSERT OR IGNORE INTO ${TABLE_CONN_DIRTY} (conn)
         SELECT conn FROM ${TABLE_CONN_WATCH} WHERE key = ?`,
        key,
      );
    }
  }

  #mintConnectionId(): number {
    this.#host.sql.exec(
      `INSERT INTO ${TABLE_INTERNAL_COUNTERS} (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      COUNTER_CLIENT_ID,
    );
    return this.#host.sql
      .exec<{ value: number }>(
        `SELECT value FROM ${TABLE_INTERNAL_COUNTERS} WHERE name = ?`,
        COUNTER_CLIENT_ID,
      )
      .one().value;
  }

  #revive(peer: Peer): Session {
    const attachment = readAttachment(peer.deserializeAttachment());
    if (attachment === null) return Session.blank(this.#mintConnectionId());

    const snapshot = attachment.s ?? this.#readSpill(attachment.i);
    if (snapshot === null) return Session.blank(attachment.i);

    try {
      const session = Session.restore(snapshot);
      session.spilled = attachment.s === null;
      return session;
    } catch {
      return Session.blank(attachment.i);
    }
  }

  #persist(peer: Peer, session: Session, pending: Bytes = NO_BYTES): void {
    this.#sessions.set(peer, session);
    const snapshot = session.snapshot(pending);

    if (snapshot.length <= MAX_INLINE_ATTACHMENT_BYTES) {
      if (session.spilled) {
        this.#clearSpill(session.conn.id);
        session.spilled = false;
      }
      peer.serializeAttachment({ v: ATTACHMENT_FORMAT, i: session.conn.id, s: snapshot });
      return;
    }

    this.#writeSpill(session.conn.id, snapshot);
    session.spilled = true;
    peer.serializeAttachment({ v: ATTACHMENT_FORMAT, i: session.conn.id, s: null });
  }

  #forget(peer: Peer, session: Session): void {
    this.#sessions.delete(peer);
    this.#closed.add(peer);
    peer.serializeAttachment(null);
    this.#release(session.conn.id);
    session.watching = false;
  }

  #release(id: number): void {
    this.#clearSpill(id);
    this.#host.sql.exec(`DELETE FROM ${TABLE_CONN_WATCH} WHERE conn = ?`, id);
    this.#host.sql.exec(`DELETE FROM ${TABLE_CONN_DIRTY} WHERE conn = ?`, id);
    this.#watchersExist = null;
  }

  #readSpill(id: number): Uint8Array | null {
    const rows = this.#host.sql
      .exec(`SELECT state FROM ${TABLE_CONN_SPILL} WHERE conn = ?`, id)
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return new Uint8Array(asBytes(row["state"] as ArrayBuffer));
  }

  #writeSpill(id: number, snapshot: Uint8Array): void {
    this.#host.sql.exec(
      `INSERT INTO ${TABLE_CONN_SPILL} (conn, state) VALUES (?, ?)
       ON CONFLICT(conn) DO UPDATE SET state = excluded.state`,
      id,
      snapshot,
    );
  }

  #clearSpill(id: number): void {
    this.#host.sql.exec(`DELETE FROM ${TABLE_CONN_SPILL} WHERE conn = ?`, id);
  }
}
