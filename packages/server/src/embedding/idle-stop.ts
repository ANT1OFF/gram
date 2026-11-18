// `POST /embed/v1/idle-stop`: the deployment is about to stop this server because nothing has used
// it for a while. Idle compactions that wait for their time go now, while the threads' prompt
// caches are still warm, so the next wake starts from a summary instead of writing the whole
// conversation into the cache again (docs/AGENTS_AND_FEATURES.md#idle-compaction).
//
//   {}  →  200 { "compacting": 2 }   threads compacting now; ask again before stopping
//          200 { "compacting": 0 }   nothing waits on a stop
//
// It stops nothing and changes no setting: a compaction goes only where the workspace's idle
// compaction would have sent one anyway, through the same holds, and only before its deadline.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Orchestration } from "../orchestration/service.ts";
import { answer, EmbedInbound } from "./inbound.ts";

/** Serves `idle-stop`; provides nothing. */
export const IdleStopInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const orchestration = yield* Orchestration;
    yield* inbound.route("POST", "idle-stop", () =>
      orchestration.compactIdleBeforeStop.pipe(Effect.map((result) => answer(result))),
    );
  }),
);
