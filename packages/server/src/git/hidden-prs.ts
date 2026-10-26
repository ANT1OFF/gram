// Keeps each thread's hidden PRs (`Thread.hiddenPrs`) up to date with the badges as they are
// published, whether or not a window shows the thread. What cleared since a PR was hidden is
// forgotten, so a second failure on the same head, or a change request after one was answered,
// brings its row back.
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
          // Narrowed again on the row the store reads, so a hide landing in between isn't undone.
          return runtimes
            .updateThread(thread.id, (current) => narrowThreadHiddenPrs(current, badges))
            .pipe(Effect.ignore);
        },
        onRound: () => Effect.void,
      },
      // A badge that cleared while the app was shut is first published by the publisher's own
      // start-up sync, before this observer exists.
      { replay: true },
    );
  }),
);
