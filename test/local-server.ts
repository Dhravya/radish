import type { ServerWebSocket } from "bun";

import { FakeSqlStorage } from "./sqlite-adapter";
import { applySchema } from "../src/schema";
import { Store } from "../src/store";
import { SessionExecutor, type Peer } from "../src/session";
import { inMemoryColdBucket } from "../src/tier/bucket";
import { registry } from "../src/commands";

const PORT = Number(process.env["PORT"] ?? 8787);

const sql = new FakeSqlStorage();
applySchema(sql);
const store = new Store(sql);

interface SocketData {
  readonly id: number;
}

type Socket = ServerWebSocket<SocketData>;

class LocalPeer implements Peer {
  readonly socket: Socket;
  #attachment: unknown = null;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    this.socket.send(typeof data === "string" ? data : (data as Uint8Array));
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.#attachment;
  }
}

const peers = new Map<Socket, LocalPeer>();

const executor = new SessionExecutor({
  sql,
  store,
  bucket: inMemoryColdBucket(),
  peers: () => peers.values(),
  atomically: (run) => sql.db.transaction(run)(),
});

const peerFor = (socket: Socket): LocalPeer => {
  const live = peers.get(socket);
  if (live !== undefined) return live;
  const fresh = new LocalPeer(socket);
  peers.set(socket, fresh);
  executor.open(fresh);
  return fresh;
};

const server = Bun.serve<SocketData, "/connect" | "/health">({
  port: PORT,
  fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "radish-local" });
    if (url.pathname !== "/connect") return new Response("not found", { status: 404 });
    return srv.upgrade(request, { data: { id: Date.now() } })
      ? undefined
      : new Response("upgrade failed", { status: 426 });
  },
  websocket: {
    open(ws) {
      peerFor(ws);
    },
    async message(ws, message) {
      const bytes =
        typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
      await executor.message(peerFor(ws), bytes, Date.now());
    },
    close(ws) {
      const peer = peers.get(ws);
      if (peer === undefined) return;
      peers.delete(ws);
      executor.close(peer);
    },
  },
});

console.log(`radish-local  ws://localhost:${server.port}/connect  (${registry.size} commands)`);
