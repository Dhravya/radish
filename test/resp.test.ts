import { test, expect, describe } from "bun:test";

import { ProtocolError, RequestDecoder, encodeReply, type ProtocolVersion } from "../src/resp";
import { unknownCommand } from "../src/errors";
import {
  type Command,
  type Reply,
  array,
  boolean,
  bulk,
  double,
  error,
  integer,
  map,
  set,
  simple,
  NULL,
  NULL_ARRAY,
  EMPTY_ARRAY,
  OK,
} from "../src/types";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const wire = (reply: Reply, version: ProtocolVersion): string => dec(encodeReply(reply, version));

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const request = (...args: readonly (string | Uint8Array)[]): Uint8Array => {
  const parts: Uint8Array[] = [enc(`*${args.length}\r\n`)];
  for (const arg of args) {
    const payload = typeof arg === "string" ? enc(arg) : arg;
    parts.push(enc(`$${payload.length}\r\n`), payload, enc("\r\n"));
  }
  return concat(parts);
};

const asText = (command: Command): string[] => command.map(dec);

const feed = (bytes: Uint8Array, size: number): Command[] => {
  const decoder = new RequestDecoder();
  const commands: Command[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    decoder.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
    commands.push(...decoder.drain());
  }
  return commands;
};

describe("encodeReply: RESP2", () => {
  test("scalars", () => {
    expect(wire(OK, 2)).toBe("+OK\r\n");
    expect(wire(simple(""), 2)).toBe("+\r\n");
    expect(wire(error("WRONGTYPE nope"), 2)).toBe("-WRONGTYPE nope\r\n");
    expect(wire(integer(0), 2)).toBe(":0\r\n");
    expect(wire(integer(-42), 2)).toBe(":-42\r\n");
    expect(wire(integer(9007199254740993n), 2)).toBe(":9007199254740993\r\n");
  });

  test("bulk strings, empty and null are distinct", () => {
    expect(wire(bulk("hello"), 2)).toBe("$5\r\nhello\r\n");
    expect(wire(bulk(""), 2)).toBe("$0\r\n\r\n");
    expect(wire(NULL, 2)).toBe("$-1\r\n");
    expect(wire(NULL_ARRAY, 2)).toBe("*-1\r\n");
  });

  test("aggregates", () => {
    expect(wire(EMPTY_ARRAY, 2)).toBe("*0\r\n");
    expect(wire(array([bulk("a"), integer(1)]), 2)).toBe("*2\r\n$1\r\na\r\n:1\r\n");
    expect(wire(array([array([bulk("x")]), NULL]), 2)).toBe("*2\r\n*1\r\n$1\r\nx\r\n$-1\r\n");
  });

  test("doubles degrade to bulk strings", () => {
    expect(wire(double(3), 2)).toBe("$1\r\n3\r\n");
    expect(wire(double(3.5), 2)).toBe("$3\r\n3.5\r\n");
    expect(wire(double(Infinity), 2)).toBe("$3\r\ninf\r\n");
    expect(wire(double(-Infinity), 2)).toBe("$4\r\n-inf\r\n");
  });

  test("booleans are integers, maps flatten, sets are arrays", () => {
    expect(wire(boolean(true), 2)).toBe(":1\r\n");
    expect(wire(boolean(false), 2)).toBe(":0\r\n");
    expect(wire(map([[bulk("k"), integer(7)]]), 2)).toBe("*2\r\n$1\r\nk\r\n:7\r\n");
    expect(wire(map([]), 2)).toBe("*0\r\n");
    expect(wire(set([bulk("a"), bulk("b")]), 2)).toBe("*2\r\n$1\r\na\r\n$1\r\nb\r\n");
  });
});

describe("encodeReply: RESP3", () => {
  test("nulls collapse onto the null type", () => {
    expect(wire(NULL, 3)).toBe("_\r\n");
    expect(wire(NULL_ARRAY, 3)).toBe("_\r\n");
  });

  test("doubles get their own type", () => {
    expect(wire(double(3), 3)).toBe(",3\r\n");
    expect(wire(double(3.5), 3)).toBe(",3.5\r\n");
    expect(wire(double(-0.25), 3)).toBe(",-0.25\r\n");
    expect(wire(double(Infinity), 3)).toBe(",inf\r\n");
    expect(wire(double(-Infinity), 3)).toBe(",-inf\r\n");
  });

  test("NaN uses the C spelling, signed or not", () => {
    expect(wire(double(NaN), 3)).toMatch(/^,-?nan\r\n$/);
  });

  test("booleans, maps and sets", () => {
    expect(wire(boolean(true), 3)).toBe("#t\r\n");
    expect(wire(boolean(false), 3)).toBe("#f\r\n");
    expect(wire(map([[bulk("k"), integer(7)]]), 3)).toBe("%1\r\n$1\r\nk\r\n:7\r\n");
    expect(wire(map([]), 3)).toBe("%0\r\n");
    expect(wire(set([bulk("a"), bulk("b")]), 3)).toBe("~2\r\n$1\r\na\r\n$1\r\nb\r\n");
  });

  test("version only changes the version-dependent kinds", () => {
    expect(wire(simple("PONG"), 3)).toBe(wire(simple("PONG"), 2));
    expect(wire(integer(12), 3)).toBe(wire(integer(12), 2));
    expect(wire(bulk("abc"), 3)).toBe(wire(bulk("abc"), 2));
    expect(wire(error("ERR x"), 3)).toBe(wire(error("ERR x"), 2));
  });

  test("nested map inside array keeps per-version spelling", () => {
    const reply = array([map([[bulk("a"), boolean(true)]]), NULL]);
    expect(wire(reply, 3)).toBe("*2\r\n%1\r\n$1\r\na\r\n#t\r\n_\r\n");
    expect(wire(reply, 2)).toBe("*2\r\n*2\r\n$1\r\na\r\n:1\r\n$-1\r\n");
  });
});

describe("encodeReply: binary and unicode safety", () => {
  test("payloads with CR, LF, NUL and invalid UTF-8 survive byte for byte", () => {
    const payload = new Uint8Array([0x00, 0x0d, 0x0a, 0xff, 0xfe, 0x24, 0x2a]);
    const frame = encodeReply(bulk(payload), 2);
    expect(frame.length).toBe(4 + payload.length + 2);
    expect(frame.subarray(0, 4)).toEqual(enc("$7\r\n"));
    expect(frame.subarray(4, 4 + payload.length)).toEqual(payload);
    expect(frame.subarray(4 + payload.length)).toEqual(enc("\r\n"));
  });

  test("multi-byte text is sized in bytes, not code units", () => {
    expect(encodeReply(simple("é😀"), 2)).toEqual(enc("+é😀\r\n"));
    expect(encodeReply(bulk("é😀"), 3)).toEqual(enc("$6\r\né😀\r\n"));
  });

  test("a lone surrogate becomes the replacement character", () => {
    expect(encodeReply(simple("a\ud800b"), 2)).toEqual(enc("+a�b\r\n"));
  });
});

describe("RequestDecoder: multibulk requests", () => {
  test("decodes a whole command", () => {
    const decoder = new RequestDecoder();
    decoder.push(request("SET", "key", "value"));
    expect(asText(decoder.next()!)).toEqual(["SET", "key", "value"]);
    expect(decoder.next()).toBeNull();
  });

  test("empty bulk argument is preserved", () => {
    const decoder = new RequestDecoder();
    decoder.push(request("SET", "k", ""));
    const command = decoder.next()!;
    expect(command.length).toBe(3);
    expect(command[2]).toEqual(new Uint8Array(0));
  });

  test("binary-safe arguments", () => {
    const payload = new Uint8Array([0x00, 0x0d, 0x0a, 0xff, 0x80, 0x24]);
    const decoder = new RequestDecoder();
    decoder.push(request("SET", "k", payload));
    expect(decoder.next()![2]).toEqual(payload);
  });

  test("drain returns a pipeline in order and leaves nothing behind", () => {
    const decoder = new RequestDecoder();
    decoder.push(concat([request("PING"), request("ECHO", "hi"), request("GET", "k")]));
    const commands = decoder.drain();
    expect(commands.map(asText)).toEqual([["PING"], ["ECHO", "hi"], ["GET", "k"]]);
    expect(decoder.drain()).toEqual([]);
  });

  test("empty and negative multibulk headers are skipped, not commands", () => {
    const decoder = new RequestDecoder();
    decoder.push(concat([enc("*0\r\n"), enc("*-1\r\n"), request("PING")]));
    expect(decoder.drain().map(asText)).toEqual([["PING"]]);
  });

  test("a trailing partial command is held until it completes", () => {
    const decoder = new RequestDecoder();
    const full = request("GET", "key");
    decoder.push(full.subarray(0, full.length - 3));
    expect(decoder.next()).toBeNull();
    decoder.push(full.subarray(full.length - 3));
    expect(asText(decoder.next()!)).toEqual(["GET", "key"]);
  });
});

describe("RequestDecoder: chunk boundaries", () => {
  const stream = concat([
    request("PING"),
    enc("PING\r\n"),
    request("SET", "key", "value"),
    request("SET", "bin", new Uint8Array([0x0d, 0x0a, 0x00, 0xff, 0x24, 0x2a])),
    enc("  ECHO   spaced  \r\n"),
    request("MSET", "a", "", "b", "x".repeat(300)),
    enc('SET q "a b"\r\n'),
    request("GET", "key"),
  ]);

  const expected = feed(stream, stream.length).map(asText);

  test("the whole-buffer baseline is what we think it is", () => {
    expect(expected).toEqual([
      ["PING"],
      ["PING"],
      ["SET", "key", "value"],
      ["SET", "bin", "\r\n �$*"],
      ["ECHO", "spaced"],
      ["MSET", "a", "", "b", "x".repeat(300)],
      ["SET", "q", "a b"],
      ["GET", "key"],
    ]);
  });

  for (const size of [1, 2, 3, 7, 13, 64, 997]) {
    test(`identical command sequence at ${size}-byte chunks`, () => {
      expect(feed(stream, size).map(asText)).toEqual(expected);
    });
  }

  test("byte-at-a-time yields nothing early and everything by the end", () => {
    const decoder = new RequestDecoder();
    const framed = request("SET", "k", "v");
    for (let i = 0; i < framed.length - 1; i += 1) {
      decoder.push(framed.subarray(i, i + 1));
      expect(decoder.next()).toBeNull();
    }
    decoder.push(framed.subarray(framed.length - 1));
    expect(asText(decoder.next()!)).toEqual(["SET", "k", "v"]);
  });

  test("a split between CR and LF reassembles", () => {
    const framed = request("PING");
    const cut = framed.length - 1;
    const decoder = new RequestDecoder();
    decoder.push(framed.subarray(0, cut));
    expect(decoder.next()).toBeNull();
    decoder.push(framed.subarray(cut));
    expect(asText(decoder.next()!)).toEqual(["PING"]);
  });

  test("a bulk payload split mid-body reassembles", () => {
    const payload = new Uint8Array(4096).map((_, i) => i & 0xff);
    const framed = request("SET", "k", payload);
    const decoder = new RequestDecoder();
    decoder.push(framed.subarray(0, 1000));
    expect(decoder.next()).toBeNull();
    decoder.push(framed.subarray(1000, 4000));
    expect(decoder.next()).toBeNull();
    decoder.push(framed.subarray(4000));
    expect(decoder.next()![2]).toEqual(payload);
  });

  test("a sustained stream whose tail is always partial", () => {
    const decoder = new RequestDecoder();
    const rounds = 200;
    const perRound = 50;
    let decoded = 0;
    let carry = new Uint8Array(0);

    for (let round = 0; round < rounds; round += 1) {
      const parts: Uint8Array[] = [carry];
      for (let i = 0; i < perRound; i += 1) {
        parts.push(request("SET", `k:${round}:${i}`, "v".repeat(60)));
      }
      const blob = concat(parts);
      const cut = blob.length - 17;
      decoder.push(blob.subarray(0, cut));
      carry = blob.slice(cut);
      decoded += decoder.drain().length;
    }
    decoder.push(carry);
    decoded += decoder.drain().length;

    expect(decoded).toBe(rounds * perRound);
  });

  test("a long pipeline stays linear", () => {
    const count = 20_000;
    const framed: Uint8Array[] = [];
    for (let i = 0; i < count; i += 1) framed.push(request("SET", `key:${i}`, `value:${i}`));
    const decoder = new RequestDecoder();
    const started = performance.now();
    decoder.push(concat(framed));
    const commands = decoder.drain();
    const elapsed = performance.now() - started;
    expect(commands.length).toBe(count);
    expect(asText(commands[count - 1]!)).toEqual(["SET", `key:${count - 1}`, `value:${count - 1}`]);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("RequestDecoder: remaining", () => {
  const handoff = (bytes: Uint8Array, cut: number): RequestDecoder => {
    const before = new RequestDecoder();
    before.push(bytes.subarray(0, cut));
    before.drain();
    const after = new RequestDecoder();
    after.push(before.remaining());
    return after;
  };

  test("empty when nothing is buffered", () => {
    const decoder = new RequestDecoder();
    expect(decoder.remaining()).toEqual(new Uint8Array(0));
    decoder.push(request("PING"));
    decoder.drain();
    expect(decoder.remaining()).toEqual(new Uint8Array(0));
  });

  test("a partial command survives a decoder handoff", () => {
    const framed = request("SET", "key", "value");
    const cut = 12;
    const before = new RequestDecoder();
    before.push(framed.subarray(0, cut));
    expect(before.next()).toBeNull();

    const after = new RequestDecoder();
    after.push(before.remaining());
    after.push(framed.subarray(cut));
    expect(asText(after.next()!)).toEqual(["SET", "key", "value"]);
  });

  test("the handoff reproduces the unconsumed bytes exactly", () => {
    const framed = request("SET", "key", "value");
    for (let cut = 1; cut < framed.length; cut += 1) {
      const before = new RequestDecoder();
      before.push(framed.subarray(0, cut));
      before.drain();
      expect(before.remaining()).toEqual(framed.slice(0, cut));
    }
  });

  test("every cut point round-trips through push(remaining())", () => {
    const framed = concat([
      request("SET", "key", new Uint8Array([0x0d, 0x0a, 0x00, 0xff])),
      request("MSET", "a", "", "b", "x".repeat(200)),
    ]);
    const whole = feed(framed, framed.length).map(asText);

    for (let cut = 0; cut <= framed.length; cut += 1) {
      const before = new RequestDecoder();
      before.push(framed.subarray(0, cut));
      const early = before.drain().map(asText);

      const after = new RequestDecoder();
      after.push(before.remaining());
      after.push(framed.subarray(cut));
      expect([...early, ...after.drain().map(asText)]).toEqual(whole);
    }
  });

  test("bytes of an already-decoded command are not handed over again", () => {
    const framed = concat([request("PING"), request("GET", "k")]);
    const before = new RequestDecoder();
    before.push(framed);
    expect(asText(before.next()!)).toEqual(["PING"]);
    expect(before.remaining()).toEqual(request("GET", "k"));
  });

  test("an unterminated inline line is handed over verbatim", () => {
    const decoder = new RequestDecoder();
    decoder.push(enc("PI"));
    expect(decoder.next()).toBeNull();
    expect(decoder.remaining()).toEqual(enc("PI"));

    const resumed = handoff(enc("PI"), 2);
    resumed.push(enc("NG\r\n"));
    expect(asText(resumed.next()!)).toEqual(["PING"]);
  });

  test("remaining does not consume: it can be called twice", () => {
    const framed = request("SET", "k", "v");
    const decoder = new RequestDecoder();
    decoder.push(framed.subarray(0, 10));
    decoder.drain();
    expect(decoder.remaining()).toEqual(decoder.remaining());
    decoder.push(framed.subarray(10));
    expect(asText(decoder.next()!)).toEqual(["SET", "k", "v"]);
  });
});

describe("RequestDecoder: inline commands", () => {
  const inline = (line: string): Command[] => {
    const decoder = new RequestDecoder();
    decoder.push(enc(line));
    return decoder.drain();
  };

  test("bare newline and CRLF both terminate a line", () => {
    expect(inline("PING\r\n").map(asText)).toEqual([["PING"]]);
    expect(inline("PING\n").map(asText)).toEqual([["PING"]]);
  });

  test("runs of whitespace collapse", () => {
    expect(inline("\tSET \t a   b \r\n").map(asText)).toEqual([["SET", "a", "b"]]);
  });

  test("blank lines are ignored", () => {
    expect(inline("\r\n\n\nPING\r\n").map(asText)).toEqual([["PING"]]);
  });

  test("quoting", () => {
    expect(inline('SET k "a b"\r\n').map(asText)).toEqual([["SET", "k", "a b"]]);
    expect(inline("SET k 'a b'\r\n").map(asText)).toEqual([["SET", "k", "a b"]]);
    expect(inline('SET k ""\r\n')[0]![2]).toEqual(new Uint8Array(0));
    expect(inline(String.raw`SET k "it\'s"` + "\r\n").map(asText)).toEqual([["SET", "k", "it's"]]);
    expect(inline(String.raw`SET k 'it\'s'` + "\r\n").map(asText)).toEqual([["SET", "k", "it's"]]);
  });

  test("escapes produce raw bytes, not text", () => {
    expect(inline(String.raw`SET k "a\x41b"` + "\r\n").map(asText)).toEqual([["SET", "k", "aAb"]]);
    expect(inline(String.raw`SET k "\x00\xff"` + "\r\n")[0]![2]).toEqual(
      new Uint8Array([0x00, 0xff]),
    );
    expect(inline(String.raw`SET k "a\nb\tc"` + "\r\n")[0]![2]).toEqual(enc("a\nb\tc"));
  });

  test("a line is held until its newline arrives", () => {
    const decoder = new RequestDecoder();
    decoder.push(enc("PI"));
    expect(decoder.next()).toBeNull();
    decoder.push(enc("NG"));
    expect(decoder.next()).toBeNull();
    decoder.push(enc("\r\n"));
    expect(asText(decoder.next()!)).toEqual(["PING"]);
  });

  test("inline and multibulk interleave on one connection", () => {
    const decoder = new RequestDecoder();
    decoder.push(concat([enc("PING\r\n"), request("GET", "k"), enc("QUIT\n")]));
    expect(decoder.drain().map(asText)).toEqual([["PING"], ["GET", "k"], ["QUIT"]]);
  });
});

describe("RequestDecoder: protocol errors", () => {
  const push = (text: string): (() => void) => {
    const decoder = new RequestDecoder();
    decoder.push(enc(text));
    return () => decoder.drain();
  };

  test("non-numeric and oversized multibulk lengths", () => {
    expect(push("*abc\r\n")).toThrow("ERR Protocol error: invalid multibulk length");
    expect(push("*\r\n")).toThrow("ERR Protocol error: invalid multibulk length");
    expect(push("*1048577\r\n")).toThrow("ERR Protocol error: invalid multibulk length");
    expect(push("*3.5\r\n")).toThrow("ERR Protocol error: invalid multibulk length");
  });

  test("bad bulk lengths", () => {
    expect(push("*1\r\n$-1\r\n")).toThrow("ERR Protocol error: invalid bulk length");
    expect(push("*1\r\n$abc\r\n")).toThrow("ERR Protocol error: invalid bulk length");
    expect(push("*1\r\n$536870913\r\n")).toThrow("ERR Protocol error: invalid bulk length");
  });

  test("an element that is not a bulk string names the offending byte", () => {
    expect(push("*1\r\n+PING\r\n")).toThrow("ERR Protocol error: expected '$', got '+'");
    expect(push("*2\r\n$1\r\na\r\n:9\r\n")).toThrow("ERR Protocol error: expected '$', got ':'");
  });

  test("unbalanced quotes", () => {
    expect(push('SET k "unterminated\r\n')).toThrow(
      "ERR Protocol error: unbalanced quotes in request",
    );
    expect(push("SET k 'unterminated\r\n")).toThrow(
      "ERR Protocol error: unbalanced quotes in request",
    );
    expect(push('SET k "ab"cd\r\n')).toThrow("ERR Protocol error: unbalanced quotes in request");
  });

  test("an inline line that never ends", () => {
    expect(push("a".repeat(70_000))).toThrow("ERR Protocol error: too big inline request");
  });

  test("throws ProtocolError carrying a ready-to-send reply", () => {
    let caught: unknown;
    try {
      push("*1\r\n+PING\r\n")();
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    const failure = caught as ProtocolError;
    expect(failure.reply).toEqual(error("ERR Protocol error: expected '$', got '+'"));
    expect(encodeReply(failure.reply, 2)).toEqual(
      enc("-ERR Protocol error: expected '$', got '+'\r\n"),
    );
  });
});

describe("round trip", () => {
  test("an encoded bulk reply parses back as a request argument", () => {
    const payload = new Uint8Array([0xc3, 0x28, 0x00, 0x0d, 0x0a, 0xff]);
    const encoded = encodeReply(bulk(payload), 2);
    const decoder = new RequestDecoder();
    decoder.push(concat([enc("*1\r\n"), encoded]));
    expect(decoder.next()![0]).toEqual(payload);
  });
});

describe("line replies cannot be framed out of", () => {
  const INJECTION = "\r\n+PWN";

  const framedLines = (reply: Reply): string[] => {
    const text = dec(encodeReply(reply, 2));
    expect(text.endsWith("\r\n")).toBe(true);
    return text.slice(0, -2).split("\r\n");
  };

  test("a simple error carrying CRLF stays one line", () => {
    expect(framedLines(error(`ERR boom${INJECTION}`))).toEqual(["-ERR boom  +PWN"]);
  });

  test("a simple string carrying CRLF stays one line", () => {
    expect(framedLines(simple(`OK${INJECTION}`))).toEqual(["+OK  +PWN"]);
  });

  test("an unknown command name cannot open a second reply line", () => {
    const reply = unknownCommand(`bad${INJECTION}`, [`arg${INJECTION}`]);
    const lines = framedLines(reply);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ERR unknown command 'bad\\x0d\\x0a+PWN'");
    expect(lines[0]).toContain("'arg\\x0d\\x0a+PWN'");
  });

  test("unknown command diagnostics render binary bytes and stay bounded", () => {
    const name = new Uint8Array([0x67, 0x65, 0x74, 0xff, 0x00]);
    expect(framedLines(unknownCommand(name, []))[0]).toContain("'get\\xff\\x00'");

    const huge = "x".repeat(100_000);
    const flood = unknownCommand(huge, Array.from({ length: 64 }, () => huge));
    expect(encodeReply(flood, 2).length).toBeLessThan(1024);
  });

  test("a pipelined client reads one reply per request after an injection attempt", () => {
    const stream = concat([
      encodeReply(unknownCommand(`bad${INJECTION}`, []), 2),
      encodeReply(OK, 2),
    ]);
    expect(dec(stream).split("\r\n").filter((line) => line !== "")).toHaveLength(2);
  });

  test("a bulk reply keeps raw CRLF unescaped and round trips", () => {
    const payload = enc(`line${INJECTION}`);
    const frame = encodeReply(bulk(payload), 2);
    expect(dec(frame)).toBe(`$${payload.length}\r\nline\r\n+PWN\r\n`);

    const decoder = new RequestDecoder();
    decoder.push(concat([enc("*1\r\n"), frame]));
    expect(decoder.next()![0]).toEqual(payload);
  });
});

describe("doubles are spelled the way redis-server spells them", () => {
  const MEASURED: readonly (readonly [number, string])[] = [
    [0.0000813385, "8.13385e-5"],
    [154288503.89524817, "1.5428850389524817e+8"],
    [-678346351760656.8, "-678346351760656.7"],
    [1e-6, "0.000001"],
    [1e-7, "1e-7"],
    [0.0012345, "0.0012345"],
    [0.00012345, "1.2345e-4"],
    [0.12345678901234566, "0.12345678901234566"],
    [1.5, "1.5"],
    [3, "3"],
    [1e18, "1000000000000000000"],
    [1e19, "1e+19"],
    [2 ** 63, "9223372036854776000"],
    [1e20, "1e+20"],
    [1e100, "1e+100"],
    [1e-100, "1e-100"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [0, "0"],
  ];

  test("RESP3 doubles carry the measured spelling", () => {
    for (const [value, spelling] of MEASURED) {
      expect(wire(double(value), 3)).toBe(`,${spelling}\r\n`);
    }
  });

  test("RESP2 doubles carry the same spelling as a bulk string", () => {
    for (const [value, spelling] of MEASURED) {
      expect(wire(double(value), 2)).toBe(`$${spelling.length}\r\n${spelling}\r\n`);
    }
  });

  test("grisu2 is reproduced even where it is not the shortest round trip", () => {
    expect(wire(double(-678346351760656.8), 3)).toBe(",-678346351760656.7\r\n");
    expect(Number("-678346351760656.7")).toBe(-678346351760656.8);
    expect(String(-678346351760656.8)).toBe("-678346351760656.8");
  });

  test("exponent form is signed and unpadded", () => {
    expect(wire(double(8.13385e-5), 3)).toBe(",8.13385e-5\r\n");
    expect(wire(double(1.5428850389524817e8), 3)).toBe(",1.5428850389524817e+8\r\n");
    expect(wire(double(1e-100), 3)).toBe(",1e-100\r\n");
  });

  test("infinities and nan take their explicit forms, nan unsigned", () => {
    expect(wire(double(Infinity), 3)).toBe(",inf\r\n");
    expect(wire(double(-Infinity), 3)).toBe(",-inf\r\n");
    expect(wire(double(NaN), 3)).toBe(",nan\r\n");
    expect(wire(double(-NaN), 3)).toBe(",nan\r\n");
    expect(wire(double(Infinity), 2)).toBe("$3\r\ninf\r\n");
  });

  test("negative zero keeps the d2string spelling redis reserves for it", () => {
    expect(wire(double(-0), 3)).toBe(",-0\r\n");
    expect(wire(double(0), 3)).toBe(",0\r\n");
  });
});
