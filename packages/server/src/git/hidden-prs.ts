import type { GitState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { narrowThreadHiddenPrs } from "./extra-prs.ts";
import { GitStatePublisher } from "./publisher.ts";

const badgesOf = (state: GitState) => [
  ...(state.pr === undefined ? [] : [state.pr]),
  ...(state.extraPrs ?? []),
];

export const HiddenPrsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const publisher = yield* GitStatePublisher;
    const runtimes = yield* ThreadRuntimes;
    yield* publisher.observe(
      {
        onState: (thread, state) => {
          const badges = badgesOf(state);
          if (narrowThreadHiddenPrs(thread, badges) === thread) return Effect.void;
          return runtimes
            .updateThread(thread.id, (current) => narrowThreadHiddenPrs(current, badges))
            .pipe(Effect.ignore);
        },
        onRound: () => Effect.void,
      },
      { replay: true },
    );
  }),
);
