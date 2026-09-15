import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Store } from "./store";
import { SessionExecutor, type Peer } from "./session";
import { r2ColdBucket } from "./tier/bucket";
import type { ColdBucket } from "./tier/bucket";
import { encodeUtf8 } from "./types";

export const COLD_TIER_BINDING = "ColdTier";

export default class RedisDO extends Cloudflare.DurableObject<RedisDO>()(
  "RedisDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;

    return Effect.gen(function* () {
      const sql = state.storage.sql.raw;
      const store = new Store(sql);

      const binding = env[COLD_TIER_BINDING];
      const bucket: ColdBucket | null =
        binding === undefined || binding === null ? null : r2ColdBucket(binding);

      const executor = new SessionExecutor({
        sql,
        store,
        bucket,
        peers: () => state.raw.getWebSockets() as unknown as Iterable<Peer>,
        atomically: (run) => state.raw.storage.transactionSync(run),
      });

      const rearm = Effect.suspend(() => {
        const next = store.nextExpiry();
        return next === null
          ? Effect.void
          : Effect.promise(() => state.raw.storage.setAlarm(next));
      });

      const relieve = Effect.promise(() => executor.relieve());

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
            return HttpServerResponse.text("radish: connect with a WebSocket", {
              status: 426,
            });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          executor.open(socket.ws as unknown as Peer);
          return response;
        }),

        webSocketMessage: (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) =>
          Effect.promise(() =>
            executor.message(
              socket.ws as unknown as Peer,
              typeof message === "string"
                ? encodeUtf8(message)
                : new Uint8Array(message),
              Date.now(),
            ),
          ).pipe(Effect.andThen(rearm)),

        webSocketClose: (socket: Cloudflare.WebSocket) =>
          Effect.sync(() => {
            executor.close(socket.ws as unknown as Peer);
          }),

        alarm: () =>
          Effect.sync(() => {
            store.sweep();
            executor.reap();
          })
            .pipe(Effect.andThen(relieve))
            .pipe(Effect.andThen(rearm)),
      };
    });
  }),
) {}
