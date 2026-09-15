import type { Socket, TCPSocketListener } from "bun";

const DEFAULT_PORT = 6379;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_UPSTREAM = "ws://localhost:1337/connect";

const AUTH_HEADER = "x-radish-auth";

type UpstreamSocketFactory = new (url: string, options?: { headers: Record<string, string> }) => WebSocket;

const connectUpstream = (upstream: string, authToken: string): WebSocket => {
  const Socket = WebSocket as unknown as UpstreamSocketFactory;
  return authToken.length === 0
    ? new Socket(upstream)
    : new Socket(upstream, { headers: { [AUTH_HEADER]: authToken } });
};
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFAULT_STATS_INTERVAL_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
const SHUTDOWN_POLL_MS = 10;
const MAX_CLOSE_REASON_LENGTH = 120;
const NORMAL_CLOSURE = 1000;

export type LogLevel = "debug" | "info" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean>>;
export type Logger = (level: LogLevel, message: string, fields?: LogFields) => void;

export type UpstreamScheme = "from-url" | "force-tls" | "force-plaintext";

export interface ShimOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly upstream?: string;
  readonly debug?: boolean;
  readonly statsIntervalMs?: number;
  readonly logger?: Logger;
  readonly maxPendingBytes?: number;
  readonly authToken?: string;
}

export interface ShimStats {
  readonly live: number;
  readonly accepted: number;
  readonly bytesToUpstream: number;
  readonly bytesToClient: number;
}

export interface Shim {
  readonly port: number;
  readonly hostname: string;
  readonly upstream: string;
  stats(): ShimStats;
  stop(): Promise<void>;
}

interface Bridge {
  readonly id: number;
  readonly startedAt: number;
  readonly peer: string;
  readonly socket: Socket<Bridge>;
  readonly ws: WebSocket;
  readonly bytesAwaitingHandshake: Uint8Array[];
  bytesAwaitingHandshakeCount: number;
  readonly bytesParkedForClient: Uint8Array[];
  wsOpen: boolean;
  upstreamDone: boolean;
  retired: boolean;
  bytesToUpstream: number;
  bytesToClient: number;
}

const formatFields = (fields: LogFields | undefined): string => {
  if (fields === undefined) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const text = String(value);
    parts.push(/[\s"]/.test(text) ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
};

export const consoleLogger: Logger = (level, message, fields) => {
  const line = `${new Date().toISOString()} ${level} shim: ${message}${formatFields(fields)}`;
  if (level === "error") console.error(line);
  else console.log(line);
};

const humanBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
};

const WEBSOCKET_SCHEME_FOR: Readonly<Record<string, string>> = {
  "http:": "ws:",
  "https:": "wss:",
  "ws:": "ws:",
  "wss:": "wss:",
};

const schemeFor = (override: UpstreamScheme, fromUrl: string): string => {
  if (override === "force-tls") return "wss:";
  if (override === "force-plaintext") return "ws:";
  return fromUrl;
};

export const resolveUpstream = (raw: string, override: UpstreamScheme = "from-url"): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid upstream URL: ${raw}`);
  }

  const websocketScheme = WEBSOCKET_SCHEME_FOR[url.protocol];
  if (websocketScheme === undefined) {
    throw new Error(`upstream must be ws://, wss://, http:// or https:// — got ${url.protocol}//`);
  }

  url.protocol = schemeFor(override, websocketScheme);
  return url.toString();
};

const copyOfReusedBuffer = (chunk: Uint8Array): Uint8Array => new Uint8Array(chunk);

const binaryFrameToBytes = (data: unknown): Uint8Array | null => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
};

const closeWebSocketQuietly = (ws: WebSocket, reason: string): void => {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
  try {
    ws.close(NORMAL_CLOSURE, reason.slice(0, MAX_CLOSE_REASON_LENGTH));
  } catch {
    return;
  }
};

const endSocketQuietly = (socket: Socket<Bridge>): void => {
  try {
    socket.end();
  } catch {
    return;
  }
};

const hasParkedOutput = (bridge: Bridge): boolean => bridge.bytesParkedForClient.length > 0;

export function startShim(options: ShimOptions = {}): Shim {
  const log = options.logger ?? consoleLogger;
  const debug = options.debug ?? false;
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  const statsIntervalMs = options.statsIntervalMs ?? 0;
  const upstream = resolveUpstream(options.upstream ?? DEFAULT_UPSTREAM);
  const authToken = options.authToken ?? "";

  const live = new Set<Bridge>();
  let nextId = 1;
  let accepted = 0;
  let bytesToUpstream = 0;
  let bytesToClient = 0;
  let stopping = false;

  const countBytesToClient = (bridge: Bridge, written: number): void => {
    bytesToClient += written;
    bridge.bytesToClient += written;
  };

  const countBytesToUpstream = (bridge: Bridge, sent: number): void => {
    bytesToUpstream += sent;
    bridge.bytesToUpstream += sent;
  };

  const writeToClient = (bridge: Bridge, chunk: Uint8Array): void => {
    if (bridge.retired || chunk.byteLength === 0) return;
    if (hasParkedOutput(bridge)) {
      bridge.bytesParkedForClient.push(chunk);
      return;
    }
    const written = bridge.socket.write(chunk);
    if (written < 0) return;
    countBytesToClient(bridge, written);
    if (written < chunk.byteLength) bridge.bytesParkedForClient.push(chunk.subarray(written));
  };

  const drainToClient = (bridge: Bridge): void => {
    while (hasParkedOutput(bridge)) {
      const head = bridge.bytesParkedForClient[0];
      if (head === undefined) break;
      const written = bridge.socket.write(head);
      if (written < 0) {
        bridge.bytesParkedForClient.length = 0;
        return;
      }
      countBytesToClient(bridge, written);
      if (written < head.byteLength) {
        bridge.bytesParkedForClient[0] = head.subarray(written);
        return;
      }
      bridge.bytesParkedForClient.shift();
    }
    if (bridge.upstreamDone) endSocketQuietly(bridge.socket);
  };

  const writeToUpstream = (bridge: Bridge, chunk: Uint8Array): void => {
    if (bridge.retired || chunk.byteLength === 0) return;

    if (bridge.wsOpen) {
      bridge.ws.send(chunk);
      countBytesToUpstream(bridge, chunk.byteLength);
      return;
    }

    if (bridge.bytesAwaitingHandshakeCount + chunk.byteLength > maxPendingBytes) {
      retire(bridge, `pre-handshake buffer exceeded ${maxPendingBytes} bytes`, true);
      return;
    }
    bridge.bytesAwaitingHandshake.push(copyOfReusedBuffer(chunk));
    bridge.bytesAwaitingHandshakeCount += chunk.byteLength;
  };

  const flushHandshakeBuffer = (bridge: Bridge): void => {
    for (const chunk of bridge.bytesAwaitingHandshake) {
      bridge.ws.send(chunk);
      countBytesToUpstream(bridge, chunk.byteLength);
    }
    if (debug && bridge.bytesAwaitingHandshake.length > 0) {
      log("debug", "flushed pre-handshake buffer", {
        conn: bridge.id,
        chunks: bridge.bytesAwaitingHandshake.length,
        bytes: bridge.bytesAwaitingHandshakeCount,
      });
    }
    bridge.bytesAwaitingHandshake.length = 0;
    bridge.bytesAwaitingHandshakeCount = 0;
  };

  const retire = (bridge: Bridge, reason: string, asError = false): void => {
    if (bridge.retired) return;
    bridge.retired = true;
    live.delete(bridge);

    bridge.bytesAwaitingHandshake.length = 0;
    bridge.bytesAwaitingHandshakeCount = 0;
    bridge.bytesParkedForClient.length = 0;

    closeWebSocketQuietly(bridge.ws, reason);
    endSocketQuietly(bridge.socket);

    log(asError ? "error" : "info", "connection close", {
      conn: bridge.id,
      peer: bridge.peer,
      ms: Math.round(performance.now() - bridge.startedAt),
      up: humanBytes(bridge.bytesToUpstream),
      down: humanBytes(bridge.bytesToClient),
      reason,
    });
  };

  const openUpstream = (bridge: Bridge): void => {
    const { ws } = bridge;
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      if (bridge.retired) {
        closeWebSocketQuietly(ws, "client gone");
        return;
      }
      bridge.wsOpen = true;
      if (debug) log("debug", "upstream open", { conn: bridge.id });
      flushHandshakeBuffer(bridge);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (bridge.retired) return;
      const bytes = binaryFrameToBytes(event.data);
      if (bytes === null) {
        retire(bridge, "upstream sent a non-binary frame", true);
        return;
      }
      if (debug) log("debug", "upstream -> client", { conn: bridge.id, bytes: bytes.byteLength });
      writeToClient(bridge, bytes);
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (bridge.retired) return;
      bridge.wsOpen = false;
      bridge.upstreamDone = true;
      if (hasParkedOutput(bridge)) return;
      retire(bridge, `upstream closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    });

    ws.addEventListener("error", () => {
      if (bridge.retired) return;
      retire(bridge, bridge.wsOpen ? "upstream error" : "upstream unreachable", true);
    });
  };

  const listener: TCPSocketListener<Bridge> = Bun.listen<Bridge>({
    hostname: options.hostname ?? DEFAULT_HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    socket: {
      open(socket) {
        if (stopping) {
          socket.end();
          return;
        }
        const id = nextId++;
        accepted += 1;
        const bridge: Bridge = {
          id,
          startedAt: performance.now(),
          peer: `${socket.remoteAddress}:${socket.remotePort}`,
          socket,
          ws: connectUpstream(upstream, authToken),
          bytesAwaitingHandshake: [],
          bytesAwaitingHandshakeCount: 0,
          bytesParkedForClient: [],
          wsOpen: false,
          upstreamDone: false,
          retired: false,
          bytesToUpstream: 0,
          bytesToClient: 0,
        };
        socket.data = bridge;
        live.add(bridge);
        log("info", "connection open", { conn: id, peer: bridge.peer, live: live.size });
        openUpstream(bridge);
      },

      data(socket, chunk) {
        const bridge = socket.data;
        if (bridge === undefined) return;
        if (debug) log("debug", "client -> upstream", { conn: bridge.id, bytes: chunk.byteLength });
        writeToUpstream(bridge, chunk);
      },

      drain(socket) {
        const bridge = socket.data;
        if (bridge === undefined || bridge.retired) return;
        drainToClient(bridge);
      },

      close(socket) {
        const bridge = socket.data;
        if (bridge === undefined) return;
        retire(bridge, bridge.upstreamDone ? "upstream closed" : "client closed");
      },

      error(socket, error) {
        const bridge = socket.data;
        if (bridge === undefined) return;
        retire(bridge, `client socket error: ${error.message}`, true);
      },
    },
  });

  const statsTimer =
    statsIntervalMs > 0
      ? setInterval(() => {
          log("info", "stats", {
            live: live.size,
            accepted,
            up: humanBytes(bytesToUpstream),
            down: humanBytes(bytesToClient),
          });
        }, statsIntervalMs)
      : null;
  statsTimer?.unref();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (statsTimer !== null) clearInterval(statsTimer);

    listener.stop(false);
    for (const bridge of [...live]) retire(bridge, "shutdown");

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (live.size > 0 && Date.now() < deadline) await Bun.sleep(SHUTDOWN_POLL_MS);

    listener.stop(true);
    log("info", "stopped", {
      accepted,
      up: humanBytes(bytesToUpstream),
      down: humanBytes(bytesToClient),
    });
  };

  return {
    port: listener.port,
    hostname: listener.hostname,
    upstream,
    stats: () => ({ live: live.size, accepted, bytesToUpstream, bytesToClient }),
    stop,
  };
}

const USAGE = `radish tcp-shim — bridge raw Redis TCP to a Durable Object over WebSocket

  bun shim/tcp-shim.ts [options]

Options
  --port <n>        TCP port to listen on            (env PORT, default ${DEFAULT_PORT})
  --host <addr>     interface to bind                (env HOST, default ${DEFAULT_HOSTNAME})
  --upstream <url>  WebSocket URL of the Worker      (env UPSTREAM, default ${DEFAULT_UPSTREAM})
  ${AUTH_HEADER} is sent when RADISH_AUTH_TOKEN is set in the environment.
  --tls / --no-tls  force wss:// or ws://            (env TLS=1|0, default: from the URL)
  --stats [ms]      periodic live-connection line    (default ${DEFAULT_STATS_INTERVAL_MS}ms)
  --debug           log every frame                  (env DEBUG=1)
  -h, --help        this text
`;

const isTruthyEnv = (value: string): boolean => value === "1" || value === "true";

const schemeOverrideFromEnv = (value: string | undefined): UpstreamScheme => {
  if (value === undefined) return "from-url";
  return isTruthyEnv(value) ? "force-tls" : "force-plaintext";
};

const parseArgs = (argv: readonly string[]): ShimOptions => {
  const nonNegativeInteger = (label: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer, got ${raw}`);
    }
    return value;
  };

  const env = Bun.env;
  let port = env.PORT === undefined ? DEFAULT_PORT : nonNegativeInteger("PORT", env.PORT);
  let hostname = env.HOST ?? DEFAULT_HOSTNAME;
  let rawUpstream = env.UPSTREAM ?? DEFAULT_UPSTREAM;
  let schemeOverride = schemeOverrideFromEnv(env.TLS);
  let debug = env.DEBUG !== undefined && isTruthyEnv(env.DEBUG);
  let statsIntervalMs = debug ? DEFAULT_STATS_INTERVAL_MS : 0;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--port":
        port = nonNegativeInteger("--port", next());
        break;
      case "--host":
        hostname = next();
        break;
      case "--upstream":
        rawUpstream = next();
        break;
      case "--tls":
        schemeOverride = "force-tls";
        break;
      case "--no-tls":
        schemeOverride = "force-plaintext";
        break;
      case "--debug":
        debug = true;
        if (statsIntervalMs === 0) statsIntervalMs = DEFAULT_STATS_INTERVAL_MS;
        break;
      case "--stats": {
        const peek = argv[i + 1];
        if (peek !== undefined && !peek.startsWith("-")) {
          statsIntervalMs = nonNegativeInteger("--stats", peek);
          i++;
        } else {
          statsIntervalMs = DEFAULT_STATS_INTERVAL_MS;
        }
        break;
      }
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }

  return {
    port,
    hostname,
    upstream: resolveUpstream(rawUpstream, schemeOverride),
    authToken: env.RADISH_AUTH_TOKEN ?? "",
    debug,
    statsIntervalMs,
  };
};

if (import.meta.main) {
  let shim: Shim;
  try {
    shim = startShim(parseArgs(Bun.argv.slice(2)));
  } catch (cause) {
    console.error(`shim: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error(USAGE);
    process.exit(2);
  }

  console.log(
    [
      "",
      "  radish tcp-shim",
      `  listening   ${shim.hostname}:${shim.port}`,
      `  upstream    ${shim.upstream}`,
      `  try         redis-cli -p ${shim.port} ping`,
      "",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.error(`shim: second ${signal}, exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    console.error(`shim: ${signal}, draining`);
    void shim.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
