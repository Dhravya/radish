import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Radish from "./src/worker";

const Site = Cloudflare.Website.StaticSite("RadishSite", {
  cwd: "web",
  command: "bun run build",
  outdir: "dist",
  domain: "radish.dhr.wtf",
  dev: { command: "bun run dev", cwd: "web" },
});

export default Alchemy.Stack(
  "Radish",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Radish;
    const site = yield* Site;
    return {
      server: worker.url.as<string>(),
      site: site.url.as<string>(),
    };
  }),
);
