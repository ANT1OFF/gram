import { AppToolError } from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { refuseOutOfReach } from "../git/repo-reach.ts";
import { parseRunRef, RunMonitor } from "../git/run-monitor.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { defineAppTool, OWN_PR_AUDIENCE } from "./definition.ts";

/** The `run_monitor` tool, over the server's run monitor where it has one. */
export const makeRunMonitorTool = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const runMonitor = Option.getOrUndefined(yield* Effect.serviceOption(RunMonitor));
  return defineAppTool({
    descriptor: {
      name: "run_monitor",
      class: "self",
      description:
        "Watch a GitHub Actions run, such as a release build or a deploy, and end your turn: when it completes, Gram sends one message here with its conclusion, failed jobs and link. Name it by `run` (id or page URL) or by `workflow` (file name or name; `branch` narrows it) for its latest run; `repo` defaults to the thread's PR's, else origin's. A completed run is answered at once. It survives a restart. enabled: false stops watching `run`, or every run. Use it instead of `gh run watch`, which holds your turn and dies with it; for a PR's own checks, use pr_review_monitor.",
    },
    input: Schema.Struct({
      run: Schema.optionalKey(Schema.String),
      workflow: Schema.optionalKey(Schema.String),
      branch: Schema.optionalKey(Schema.String),
      repo: Schema.optionalKey(Schema.String),
      enabled: Schema.optionalKey(Schema.Boolean),
    }),
    audience: OWN_PR_AUDIENCE,
    handle: (threadId, { enabled = true, ...input }) =>
      Effect.gen(function* () {
        if (enabled) {
          const named = input.run === undefined ? undefined : parseRunRef(input.run)?.repo;
          yield* refuseOutOfReach("run_monitor", store, threadId, {
            repos: [input.repo, named],
          }).pipe(Effect.provideService(Proc, proc));
        }
        if (runMonitor === undefined) {
          return yield* new AppToolError({
            tool: "run_monitor",
            message: "Run monitoring isn't available here.",
          });
        }
        if (!enabled) {
          const ref = input.run === undefined ? undefined : parseRunRef(input.run);
          if (input.run !== undefined && ref === undefined) {
            return yield* new AppToolError({
              tool: "run_monitor",
              message: `"${input.run}" is neither a run id nor a run's URL.`,
            });
          }
          return { stopped: yield* runMonitor.unwatch(threadId, ref?.runId) };
        }
        const result = yield* runMonitor.watch(threadId, input);
        return result.watch === undefined
          ? { watching: false, completed: result.completed }
          : { watching: true, run: result.watch };
      }),
  });
});
