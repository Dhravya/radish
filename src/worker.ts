import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import RedisDO, { COLD_TIER_BINDING } from "./do";

const ORIGIN = "http://radish.invalid";

const AUTH_HEADER = "x-radish-auth";
const AUTH_TOKEN_SETTING = "RADISH_AUTH_TOKEN";
const UNAUTHENTICATED_SETTING = "RADISH_ALLOW_UNAUTHENTICATED";

const INSTANCE_NAME_LIMIT = 128;
const INSTANCE_NAME = /^[A-Za-z0-9._:-]+$/;

export const ColdTier = Cloudflare.R2.Bucket(COLD_TIER_BINDING, {
  forceDestroy: true,
});

const matchesWithoutLeakingTiming = (presented: string, expected: string): boolean => {
  if (expected.length === 0) return false;
  let mismatch = presented.length ^ expected.length;
  for (let at = 0; at < presented.length; at++) {
    mismatch |= presented.charCodeAt(at) ^ expected.charCodeAt(at % expected.length);
  }
  return mismatch === 0;
};

export default Cloudflare.Worker(
  "Radish",
  {
    main: import.meta.url,
    compatibility: { date: "2026-08-31" },
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const redis = yield* RedisDO;
    yield* Cloudflare.R2.ReadWriteBucket(ColdTier);

    const configured = yield* Config.option(Config.redacted(AUTH_TOKEN_SETTING));
    const expected = Option.isSome(configured) ? Redacted.value(configured.value) : "";
    const anonymousAllowed = yield* Config.boolean(UNAUTHENTICATED_SETTING).pipe(
      Config.withDefault(false),
    );

    const authentication =
      expected !== "" ? "required" : anonymousAllowed ? "disabled" : "unconfigured";

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, ORIGIN);

        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({
            ok: true,
            service: "radish",
            router: "live",
            authentication,
          });
        }

        if (url.pathname !== "/connect") {
          return HttpServerResponse.text(
            "radish: open a WebSocket to /connect",
            { status: 404 },
          );
        }

        if (authentication === "unconfigured") {
          return HttpServerResponse.text(
            `radish: refusing to serve without ${AUTH_TOKEN_SETTING}. ` +
              `Set it, or set ${UNAUTHENTICATED_SETTING}=true to serve anyone who can reach this Worker.`,
            { status: 503 },
          );
        }

        if (
          authentication === "required" &&
          !matchesWithoutLeakingTiming(request.headers[AUTH_HEADER] ?? "", expected)
        ) {
          return HttpServerResponse.text(
            `radish: ${AUTH_HEADER} is missing or wrong`,
            { status: 401 },
          );
        }

        const name = url.searchParams.get("db") ?? "default";
        if (name.length > INSTANCE_NAME_LIMIT || !INSTANCE_NAME.test(name)) {
          return HttpServerResponse.text(
            `radish: db must be 1-${INSTANCE_NAME_LIMIT} characters of A-Z a-z 0-9 . _ : -`,
            { status: 400 },
          );
        }

        return yield* redis.getByName(name).fetch(request);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
