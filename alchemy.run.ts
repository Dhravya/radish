import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Radish from "./src/worker";

export default Alchemy.Stack(
  "Radish",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Radish;
    return { url: worker.url.as<string>() };
  }),
);
