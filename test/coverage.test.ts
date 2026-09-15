import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { registry } from "../src/commands";

const TEST_DIR = import.meta.dir;
const THIS_FILE = "coverage.test.ts";

const readTestCorpus = (): string =>
  readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts") && name !== THIS_FILE)
    .map((name) => readFileSync(join(TEST_DIR, name), "utf8"))
    .join("\n")
    .toLowerCase();

const mentionedAsAToken = (corpus: string, command: string): boolean =>
  new RegExp(`["'\\s(\\[]${command.replace(/[|]/g, "\\|")}["'\\s)\\]]`).test(corpus);

const corpus = readTestCorpus();

const uncovered = [...registry.keys()].filter((command) => !mentionedAsAToken(corpus, command));

describe("every registered command is exercised somewhere", () => {
  test("no command has zero mentions across the test suite", () => {
    expect(uncovered).toEqual([]);
  });

  test("the registry is not empty, so an empty check cannot pass vacuously", () => {
    expect(registry.size).toBeGreaterThan(100);
  });

  test("the corpus was actually read", () => {
    expect(corpus.length).toBeGreaterThan(10_000);
  });
});
