import {
  COMMAND_HAS_NO_KEYS,
  INVALID_ARGCOUNT_FOR_COMMAND,
  INVALID_COMMAND_SPECIFIED,
  PROTO_MAX_BULK_LEN,
  SYNTAX,
  wrongArity,
} from "../errors";
import { TABLE_META } from "../schema";
import { globToRegExp } from "../store";
import {
  type Command,
  type Reply,
  NULL,
  OK,
  PONG,
  array,
  bulk,
  error,
  integer,
  map,
  simple,
  upper,
  decodeUtf8,
} from "../types";
import {
  type CommandSpec,
  type Ctx,
  NO_KEYS,
  ascii,
  extractKeys,
  hasKeys,
  satisfiesArity,
  spec,
  toI64,
} from "./spec";

const RADISH_VERSION = "0.1.0";
const REDIS_COMPATIBILITY_VERSION = "7.4.11";
const REDIS_COMMAND_TOTAL = 250;
const SERVER_NAME = "radish";
const SERVER_MODE = "standalone";
const SERVER_ROLE = "master";

const MAXMEMORY = "0";
const MAXMEMORY_POLICY = "noeviction";

const ONLY_DATABASE = 0n;
const MS_PER_SECOND = 1000;
const US_PER_MS = 1000;

const NOT_AN_INTEGER = error("ERR value is not an integer or out of range");
const DB_OUT_OF_RANGE = error("ERR DB index is out of range");
const BAD_PROTO_VERSION = error("ERR Protocol version is not an integer or out of range");
const NOPROTO = error("NOPROTO unsupported protocol version");
const BAD_CLIENT_NAME = error(
  "ERR Client names cannot contain spaces, newlines or special characters.",
);

const NO_PASSWORD_SET = error(
  "ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?",
);
const NO_CONFIG_FILE = error("ERR The server is running without a config file");
const NO_RESETTABLE_STATS = error(
  "ERR CONFIG RESETSTAT failed - radish keeps no resettable statistics",
);

const DIAGNOSTIC_BUDGET = 64;
const UNPRINTABLE = /[^\x20-\x7e]/g;

const diagnostic = (bytes: Uint8Array): string =>
  decodeUtf8(bytes)
    .slice(0, DIAGNOSTIC_BUDGET)
    .replace(UNPRINTABLE, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);

const badSubcommand = (container: string, sub: string): Reply =>
  error(
    `ERR Unknown subcommand or wrong number of arguments for '${sub}'. ` +
      `Try ${container.toUpperCase()} HELP.`,
  );

const ping: CommandSpec["handler"] = (_ctx, argv) => {
  if (argv.length > 2) return wrongArity("ping");
  return argv.length === 1 ? PONG : bulk(argv[1] as Uint8Array);
};

const echo: CommandSpec["handler"] = (_ctx, argv) => bulk(argv[1] as Uint8Array);

const select: CommandSpec["handler"] = (ctx, argv) => {
  const index = toI64(argv[1] as Uint8Array);
  if (index === null) return NOT_AN_INTEGER;
  if (index !== ONLY_DATABASE) return DB_OUT_OF_RANGE;
  ctx.conn.db = Number(ONLY_DATABASE);
  return OK;
};

const isPrintableClientName = (name: string): boolean =>
  [...name].every((ch) => ch >= "!" && ch <= "~");

const hello: CommandSpec["handler"] = (ctx, argv) => {
  let protocol: 2 | 3 = ctx.conn.protocol;
  let name: string | null | undefined;
  let next = 1;

  if (argv.length >= 2) {
    const requested = toI64(argv[1] as Uint8Array);
    if (requested === null) return BAD_PROTO_VERSION;
    if (requested < 2n || requested > 3n) return NOPROTO;
    protocol = Number(requested) as 2 | 3;
    next = 2;
  }

  for (; next < argv.length; next++) {
    const opt = upper(argv[next] as Uint8Array);
    const more = argv.length - next - 1;
    if (opt === "AUTH" && more >= 2) {
      return NO_PASSWORD_SET;
    } else if (opt === "SETNAME" && more >= 1) {
      const candidate = decodeUtf8(argv[next + 1] as Uint8Array);
      if (!isPrintableClientName(candidate)) return BAD_CLIENT_NAME;
      name = candidate === "" ? null : candidate;
      next += 1;
    } else {
      return error(`ERR Syntax error in HELLO option '${diagnostic(argv[next] as Uint8Array)}'`);
    }
  }

  ctx.conn.protocol = protocol;
  if (name !== undefined) ctx.conn.name = name;

  return map([
    [bulk("server"), bulk(SERVER_NAME)],
    [bulk("version"), bulk(RADISH_VERSION)],
    [bulk("redis_compatibility_version"), bulk(REDIS_COMPATIBILITY_VERSION)],
    [bulk("proto"), integer(protocol)],
    [bulk("id"), integer(ctx.conn.id)],
    [bulk("mode"), bulk(SERVER_MODE)],
    [bulk("role"), bulk(SERVER_ROLE)],
    [bulk("modules"), array([])],
  ]);
};

const client: CommandSpec["handler"] = (ctx, argv) => {
  const sub = upper(argv[1] as Uint8Array);

  if (sub === "ID" && argv.length === 2) return integer(ctx.conn.id);

  if (sub === "GETNAME" && argv.length === 2) {
    const name = ctx.conn.name;
    return name === null ? NULL : bulk(name);
  }

  if (sub === "SETNAME" && argv.length === 3) {
    const name = decodeUtf8(argv[2] as Uint8Array);
    if (!isPrintableClientName(name)) return BAD_CLIENT_NAME;
    ctx.conn.name = name === "" ? null : name;
    return OK;
  }

  return badSubcommand("client", diagnostic(argv[1] as Uint8Array));
};

const reset: CommandSpec["handler"] = (ctx) => {
  ctx.conn.protocol = 2;
  ctx.conn.name = null;
  ctx.conn.db = Number(ONLY_DATABASE);
  return simple("RESET");
};

const quit: CommandSpec["handler"] = (ctx) => {
  ctx.conn.closeAfterReply = true;
  return OK;
};

const NO_DETAIL = array([]);

const commandFlags = (entry: CommandSpec): Reply => {
  if (entry.write) return array([simple("write")]);
  return hasKeys(entry) ? array([simple("readonly")]) : array([]);
};

const commandInfoEntry = (entry: CommandSpec): Reply =>
  array([
    bulk(entry.name),
    integer(entry.arity),
    commandFlags(entry),
    integer(entry.firstKey),
    integer(entry.lastKey),
    integer(entry.keyStep),
    NO_DETAIL,
    NO_DETAIL,
    NO_DETAIL,
    NO_DETAIL,
  ]);

const getkeys = (
  table: ReadonlyMap<string, CommandSpec>,
  inner: Command,
): Reply => {
  const head = inner[0];
  if (head === undefined) return wrongArity("command|getkeys");

  const entry = table.get(decodeUtf8(head).toLowerCase());
  if (entry === undefined) return INVALID_COMMAND_SPECIFIED;
  if (!hasKeys(entry)) return COMMAND_HAS_NO_KEYS;
  if (!satisfiesArity(entry.arity, inner.length)) return INVALID_ARGCOUNT_FOR_COMMAND;

  const keys = extractKeys(entry, inner);
  return keys.length === 0 ? COMMAND_HAS_NO_KEYS : array(keys.map(bulk));
};

const command: CommandSpec["handler"] = (ctx, argv) => {
  const table = ctx.commands;
  if (argv.length === 1) return array([...table.values()].map(commandInfoEntry));

  const sub = upper(argv[1] as Uint8Array);
  const named = argv.slice(2).map((name) => decodeUtf8(name).toLowerCase());
  const wanted = named.length > 0 ? named : [...table.keys()];

  if (sub === "COUNT" && argv.length === 2) return integer(table.size);

  if (sub === "INFO") {
    return array(
      wanted.map((name) => {
        const entry = table.get(name);
        return entry === undefined ? NULL : commandInfoEntry(entry);
      }),
    );
  }

  if (sub === "GETKEYS") {
    return getkeys(table, argv.slice(2));
  }

  if (sub === "DOCS") return map([]);

  return badSubcommand("command", diagnostic(argv[1] as Uint8Array));
};

const ALL_SECTION_ALIASES = new Set(["all", "default", "everything"]);

interface ExpiryStats {
  readonly n: number;
  readonly mean: number | null;
}

const keyspaceSection = (ctx: Ctx): readonly string[] => {
  const keys = ctx.store.dbsize();
  if (keys === 0) return [];

  const expiring = ctx.sql
    .exec<ExpiryStats>(
      `SELECT COUNT(*) AS n, AVG(expire_at) AS mean FROM ${TABLE_META} WHERE expire_at > ?`,
      ctx.now,
    )
    .one();
  const avgTtl = expiring.mean === null ? 0 : Math.max(0, Math.round(expiring.mean - ctx.now));

  return [`db0:keys=${keys},expires=${expiring.n},avg_ttl=${avgTtl}`];
};

const infoSections = (ctx: Ctx): ReadonlyMap<string, readonly string[]> =>
  new Map([
    [
      "server",
      [`server_name:${SERVER_NAME}`, `radish_version:${RADISH_VERSION}`, `redis_mode:${SERVER_MODE}`],
    ],
    [
      "compatibility",
      [
        `redis_compatibility_version:${REDIS_COMPATIBILITY_VERSION}`,
        `commands_in_registry:${ctx.commands.size}`,
        `redis_commands_total:${REDIS_COMMAND_TOTAL}`,
      ],
    ],
    ["memory", [`maxmemory:${MAXMEMORY}`, `maxmemory_policy:${MAXMEMORY_POLICY}`]],
    ["persistence", ["loading:0", "rdb_bgsave_in_progress:0", "aof_enabled:0"]],
    ["replication", [`role:${SERVER_ROLE}`, "connected_slaves:0"]],
    ["keyspace", keyspaceSection(ctx)],
  ]);

const renderSection = (name: string, lines: readonly string[]): string => {
  const heading = `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
  return `# ${heading}\r\n${lines.map((line) => `${line}\r\n`).join("")}\r\n`;
};

const info: CommandSpec["handler"] = (ctx, argv) => {
  const sections = infoSections(ctx);
  const requested =
    argv.length > 1
      ? argv.slice(1).map((s) => decodeUtf8(s).toLowerCase())
      : [...sections.keys()];

  let out = "";
  for (const name of requested) {
    if (ALL_SECTION_ALIASES.has(name)) {
      for (const [section, lines] of sections) out += renderSection(section, lines);
      continue;
    }
    const lines = sections.get(name);
    if (lines !== undefined) out += renderSection(name, lines);
  }
  return bulk(ascii(out));
};

const dbsize: CommandSpec["handler"] = (ctx) => integer(ctx.store.dbsize());

const flush: CommandSpec["handler"] = (ctx, argv) => {
  if (argv.length > 2) return SYNTAX;
  if (argv.length === 2) {
    const mode = upper(argv[1] as Uint8Array);
    if (mode !== "SYNC" && mode !== "ASYNC") return SYNTAX;
  }
  ctx.store.flush();
  return OK;
};

const time: CommandSpec["handler"] = (ctx) =>
  array([
    bulk(ascii(String(Math.floor(ctx.now / MS_PER_SECOND)))),
    bulk(ascii(String((ctx.now % MS_PER_SECOND) * US_PER_MS))),
  ]);

const CONFIG: ReadonlyMap<string, string> = new Map([
  ["maxmemory", MAXMEMORY],
  ["maxmemory-policy", MAXMEMORY_POLICY],
  ["appendonly", "no"],
  ["save", ""],
  ["timeout", "0"],
  ["databases", "1"],
  ["proto-max-bulk-len", String(PROTO_MAX_BULK_LEN)],
]);

const unsettableParam = (param: string): Reply =>
  error(`ERR Unknown option or number of arguments for CONFIG SET - '${param}'`);

const duplicateParam = (param: string): Reply =>
  error(`ERR CONFIG SET failed - duplicate parameter '${param}'`);

const fixedParam = (param: string, current: string): Reply =>
  error(
    `ERR CONFIG SET failed - radish runs with '${param}' fixed at '${current}' ` +
      "and cannot change it",
  );

const configSet = (argv: Command): Reply => {
  const seen = new Set<string>();
  for (let at = 2; at + 1 < argv.length; at += 2) {
    const name = argv[at] as Uint8Array;
    const param = decodeUtf8(name).toLowerCase();
    const current = CONFIG.get(param);
    if (current === undefined) return unsettableParam(diagnostic(name));
    if (seen.has(param)) return duplicateParam(param);
    seen.add(param);

    const requested = decodeUtf8(argv[at + 1] as Uint8Array);
    if (requested.toLowerCase() !== current.toLowerCase()) return fixedParam(param, current);
  }
  return OK;
};

const config: CommandSpec["handler"] = (_ctx, argv) => {
  const sub = upper(argv[1] as Uint8Array);

  if (sub === "GET" && argv.length >= 3) {
    const pairs: (readonly [Reply, Reply])[] = [];
    const seen = new Set<string>();
    for (let j = 2; j < argv.length; j++) {
      const pattern = globToRegExp(decodeUtf8(argv[j] as Uint8Array).toLowerCase());
      for (const [name, value] of CONFIG) {
        if (seen.has(name) || !pattern.test(name)) continue;
        seen.add(name);
        pairs.push([bulk(name), bulk(value)]);
      }
    }
    return map(pairs);
  }

  if (sub === "SET" && argv.length >= 4 && argv.length % 2 === 0) return configSet(argv);
  if (sub === "RESETSTAT" && argv.length === 2) return NO_RESETTABLE_STATS;
  if (sub === "REWRITE" && argv.length === 2) return NO_CONFIG_FILE;

  return badSubcommand("config", diagnostic(argv[1] as Uint8Array));
};

export const serverCommands: readonly CommandSpec[] = [
  spec("ping", -1, false, NO_KEYS, ping),
  spec("echo", 2, false, NO_KEYS, echo),
  spec("select", 2, false, NO_KEYS, select),
  spec("hello", -1, false, NO_KEYS, hello),
  spec("command", -1, false, NO_KEYS, command),
  spec("info", -1, false, NO_KEYS, info),
  spec("dbsize", 1, false, NO_KEYS, dbsize),
  spec("flushdb", -1, true, NO_KEYS, flush),
  spec("flushall", -1, true, NO_KEYS, flush),
  spec("time", 1, false, NO_KEYS, time),
  spec("config", -2, false, NO_KEYS, config),
  spec("client", -2, false, NO_KEYS, client),
  spec("quit", -1, false, NO_KEYS, quit),
  spec("reset", 1, false, NO_KEYS, reset),
];
