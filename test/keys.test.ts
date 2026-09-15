import { describe, expect, test } from "bun:test";

import { extractKeys, registry } from "../src/commands";
import { ALL_KEYS, ALTERNATING_KEYS, FIRST_TWO_KEYS, NO_KEYS, ONE_KEY, keysAt } from "../src/commands/spec";
import type { CommandSpec, KeySpec } from "../src/commands/spec";
import { encodeUtf8 } from "../src/types";
import { OK } from "../src/types";

const withKeys = (keys: KeySpec): CommandSpec => ({
  name: "probe",
  arity: -1,
  write: false,
  ...keys,
  handler: () => OK,
});

const argv = (...parts: string[]) => parts.map(encodeUtf8);
const names = (keys: Uint8Array[]) => keys.map((k) => new TextDecoder().decode(k));

describe("extractKeys", () => {
  test("a keyless command yields nothing", () => {
    expect(names(extractKeys(withKeys(NO_KEYS), argv("ping")))).toEqual([]);
  });

  test("a keyStep of zero yields nothing even with a firstKey", () => {
    expect(names(extractKeys(withKeys(keysAt(1, 1, 0)), argv("x", "k")))).toEqual([]);
  });

  test("the single-key majority", () => {
    expect(names(extractKeys(withKeys(ONE_KEY), argv("get", "k")))).toEqual(["k"]);
  });

  test("a lastKey of -1 runs to the end of argv", () => {
    expect(names(extractKeys(withKeys(ALL_KEYS), argv("del", "a", "b", "c")))).toEqual(["a", "b", "c"]);
  });

  test("a step of two takes keys and skips values", () => {
    expect(
      names(extractKeys(withKeys(ALTERNATING_KEYS), argv("mset", "a", "1", "b", "2"))),
    ).toEqual(["a", "b"]);
  });

  test("two fixed keys", () => {
    expect(names(extractKeys(withKeys(FIRST_TWO_KEYS), argv("rename", "a", "b")))).toEqual(["a", "b"]);
  });

  test("a numkeys-prefixed command skips the count", () => {
    expect(
      names(extractKeys(withKeys(keysAt(2, -1, 1)), argv("sintercard", "2", "a", "b"))),
    ).toEqual(["a", "b"]);
  });

  test("a truncated argv never reads past the end", () => {
    expect(names(extractKeys(withKeys(FIRST_TWO_KEYS), argv("rename", "a")))).toEqual(["a"]);
    expect(names(extractKeys(withKeys(ALL_KEYS), argv("del")))).toEqual([]);
  });

  test("a lastKey beyond argv clamps instead of yielding undefined", () => {
    expect(names(extractKeys(withKeys(keysAt(1, 9, 1)), argv("x", "a", "b")))).toEqual(["a", "b"]);
  });
});

describe("count-prefixed commands", () => {
  const sintercard = registry.get("sintercard");

  test("COMMAND INFO still reports Redis's 0,0,0 range", () => {
    expect(sintercard?.firstKey).toBe(0);
    expect(sintercard?.lastKey).toBe(0);
    expect(sintercard?.keyStep).toBe(0);
  });

  test("but the real keys are extracted for the fault-in path", () => {
    expect(names(extractKeys(sintercard!, argv("sintercard", "2", "a", "b")))).toEqual(["a", "b"]);
  });

  test("the count is honoured, not the rest of argv", () => {
    expect(
      names(extractKeys(sintercard!, argv("sintercard", "2", "a", "b", "LIMIT", "5"))),
    ).toEqual(["a", "b"]);
  });

  test("a malformed count yields no keys rather than throwing", () => {
    expect(names(extractKeys(sintercard!, argv("sintercard", "abc", "a")))).toEqual([]);
    expect(names(extractKeys(sintercard!, argv("sintercard", "0")))).toEqual([]);
    expect(names(extractKeys(sintercard!, argv("sintercard", "-1", "a")))).toEqual([]);
  });

  test("a count larger than argv clamps", () => {
    expect(names(extractKeys(sintercard!, argv("sintercard", "9", "a", "b")))).toEqual(["a", "b"]);
  });
});
