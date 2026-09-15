import { beforeEach, describe, expect, test } from "bun:test";

import { dispatch, registry } from "../src/commands";
import type { Ctx } from "../src/commands/spec";
import { applySchema, type SqlStorage } from "../src/schema";
import { Store } from "../src/store";
import { type Reply, decodeUtf8, encodeUtf8 } from "../src/types";
import { FakeSqlStorage } from "./sqlite-adapter";

const BINARY128_1E300 =
  "1000000000000000000000000000000000041552152361405111863956068954728002352563744" +
  "3067475100676887236804983605207528754077894488238335133468181274878254428524077" +
  "3598041445031004430533712707176444532326347302641015962717804542760572194001541" +
  "8302077278887782971657143239834636920678627670495998467767271424";

const X87_80_BIT_1E300 =
  "1000000000000000000008997324079559193870523944273290747938260082321265646596180" +
  "9357558491520837504971903503725086142748359035925561846729839130962605207486462" +
  "8732713564184365329408425510760601678972665293237003055138294762099454029477278" +
  "1889620606179267611627097410650567187386105690089424915104006144";

let sql: SqlStorage;
let ctx: Ctx;

const run = (...parts: string[]): Reply => dispatch(ctx, parts.map(encodeUtf8));
const text = (...parts: string[]): string => {
  const reply = run(...parts);
  if (reply.kind === "bulk") return decodeUtf8(reply.value);
  if (reply.kind === "error" || reply.kind === "simple") return reply.value;
  return `<${reply.kind}>`;
};

beforeEach(() => {
  sql = new FakeSqlStorage();
  applySchema(sql);
  ctx = {
    store: new Store(sql),
    sql,
    now: Date.now(),
    conn: { protocol: 2, id: 1, name: null, db: 0, closeAfterReply: false },
    commands: registry,
  };
});

describe("INCRBYFLOAT matches a binary128 long-double Redis build, not every Redis build", () => {
  test("1e300 prints the binary128 expansion, which an x87 80-bit build would not print", () => {
    expect(text("INCRBYFLOAT", "big", "1e300")).toBe(BINARY128_1E300);
    expect(text("GET", "big")).not.toBe(X87_80_BIT_1E300);
    expect(BINARY128_1E300).not.toBe(X87_80_BIT_1E300);
  });

  test("a 23-digit integer survives a zero increment, which a double cannot do", () => {
    run("SET", "k", "12345678901234567890123");
    expect(text("INCRBYFLOAT", "k", "0")).toBe("12345678901234567890123");
  });

  test("decimal increments accumulate without double artefacts", () => {
    expect(text("INCRBYFLOAT", "k", "0.1")).toBe("0.1");
    expect(text("INCRBYFLOAT", "k", "0.2")).toBe("0.3");

    for (const expected of ["0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "1"]) {
      expect(text("INCRBYFLOAT", "k", "0.1")).toBe(expected);
    }
  });

  test("the reply is ld2string LD_STR_HUMAN: 17 fraction digits, trailing zeroes stripped", () => {
    run("SET", "wide", "1.234567890123456789012345678901234");
    expect(text("INCRBYFLOAT", "wide", "0")).toBe("1.23456789012345679");

    expect(text("INCRBYFLOAT", "under", "0.000000000000000001")).toBe("0");
    expect(text("INCRBYFLOAT", "exp", "5.0e3")).toBe("5000");
    expect(text("INCRBYFLOAT", "trailing", "2.000")).toBe("2");
    expect(text("INCRBYFLOAT", "zero", "0e1")).toBe("0");
    expect(text("INCRBYFLOAT", "negzero", "-0.0")).toBe("0");
  });

  test("the rejections stay where Redis puts them", () => {
    run("SET", "text", "abc");
    expect(text("INCRBYFLOAT", "text", "1.0")).toBe("ERR value is not a valid float");
    expect(text("INCRBYFLOAT", "k", "nan")).toBe("ERR value is not a valid float");
    expect(text("INCRBYFLOAT", "k", "1e5000")).toBe("ERR value is not a valid float");
    expect(text("INCRBYFLOAT", "k", "1e-5000")).toBe("ERR value is not a valid float");

    expect(text("INCRBYFLOAT", "k", "inf")).toBe("ERR increment would produce NaN or Infinity");
    run("SET", "stored", "inf");
    expect(text("INCRBYFLOAT", "stored", "1")).toBe(
      "ERR increment would produce NaN or Infinity",
    );
    expect(text("GET", "stored")).toBe("inf");
  });

  test("a refused increment leaves the stored value untouched", () => {
    run("SET", "k", "10.5");
    expect(text("INCRBYFLOAT", "k", "nope")).toBe("ERR value is not a valid float");
    expect(text("GET", "k")).toBe("10.5");
  });
});
