import { type Command, type Reply, decodeUtf8, error } from "../types";
import { RedisError, unknownCommand, wrongArity } from "../errors";
import type { CommandSpec, Ctx } from "./spec";
import { extractKeys, satisfiesArity } from "./spec";

import { stringCommands } from "./string";
import { keyspaceCommands } from "./keyspace";
import { serverCommands } from "./server";
import { hashCommands } from "./hash";
import { listCommands } from "./list";
import { setCommands } from "./set";
import { zsetCommands } from "./zset";

const ALL: readonly CommandSpec[] = [
  ...stringCommands,
  ...keyspaceCommands,
  ...serverCommands,
  ...hashCommands,
  ...listCommands,
  ...setCommands,
  ...zsetCommands,
];

export const registry: ReadonlyMap<string, CommandSpec> = new Map(ALL.map((c) => [c.name, c]));

export const commandCount = registry.size;

export const lookup = (name: string): CommandSpec | undefined => registry.get(name.toLowerCase());

export const isWrite = (name: string): boolean => lookup(name)?.write ?? false;

export { extractKeys, satisfiesArity };

export const keysOf = (argv: Command): Uint8Array[] => {
  const head = argv[0];
  if (head === undefined) return [];
  const command = registry.get(decodeUtf8(head).toLowerCase());
  return command === undefined ? [] : extractKeys(command, argv);
};

export const INTERNAL_ERROR = error("ERR internal error");

export class StorageFailure extends Error {
  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(`command ${command} failed against storage`, { cause });
    this.name = "StorageFailure";
  }
}

export function dispatch(ctx: Ctx, argv: Command): Reply {
  const head = argv[0];
  if (head === undefined) return error("ERR empty command");

  const spelling = decodeUtf8(head);
  const name = spelling.toLowerCase();
  const spec = registry.get(name);
  if (spec === undefined) return unknownCommand(spelling, argv.slice(1).map(decodeUtf8));
  if (!satisfiesArity(spec.arity, argv.length)) return wrongArity(name);

  try {
    return spec.handler(ctx, argv);
  } catch (cause) {
    if (cause instanceof RedisError) return cause.reply;
    throw new StorageFailure(name, cause);
  }
}

export const internalErrorFor = (cause: unknown): Reply => {
  console.error(cause instanceof StorageFailure ? cause.message : "command failed", cause);
  return INTERNAL_ERROR;
};

export function dispatchOutsideTransaction(ctx: Ctx, argv: Command): Reply {
  try {
    return dispatch(ctx, argv);
  } catch (cause) {
    return internalErrorFor(cause);
  }
}
