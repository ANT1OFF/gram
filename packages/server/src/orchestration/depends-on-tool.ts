import { AppToolError, MAX_PR_DEPENDENCIES, type ThreadId } from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { parsePrRef } from "../git/merge-when-ready.ts";
import { refuseOutOfReach } from "../git/repo-reach.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { PrDependencies } from "../wakes/pr-dependencies.ts";

/** The `depends_on` tool, over the server's PR dependencies. */
export const makeDependsOn = Effect.gen(function* () {
  const dependencies = yield* PrDependencies;
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  return defineAppTool({
    descriptor: {
      name: "depends_on",
      class: "self",
      description: `Declare that a pull request depends on another one (\`pr\`, owner/repo#N or its URL): it can't merge, or can't be finished, until that one has. For your own bound PR, or with \`threadId\` your worker's. The thread is then woken whenever the dependency merges, closes or gets a new push, with no wake to set; merge_when_ready waits for it to merge first unless \`mergeAfter: false\`; and the ledger shows the chain, flagging a dependency that drags on so the dependent PR can be stacked on its branch instead. \`remove: true\` drops it. Needs a bound PR (pr_bind); at most ${MAX_PR_DEPENDENCIES} per PR; a PR already merged or closed is refused. What an orchestrator declares, its worker can't drop.`,
    },
    audience: ["orchestrator", "worker"],
    input: Schema.Struct({
      pr: Schema.NonEmptyString,
      threadId: Schema.optionalKey(Schema.NonEmptyString),
      remove: Schema.optionalKey(Schema.Boolean),
      mergeAfter: Schema.optionalKey(Schema.Boolean),
    }),
    handle: (caller, { pr, threadId, ...rest }) =>
      Effect.gen(function* () {
        const ref = parsePrRef(pr);
        if (ref === undefined) {
          return yield* new AppToolError({
            tool: "depends_on",
            message: `"${pr}" isn't a pull request; write owner/repo#N or its URL.`,
          });
        }
        yield* refuseOutOfReach("depends_on", store, caller, { prRepo: ref.repo }).pipe(
          Effect.provideService(Proc, proc),
        );
        return yield* dependencies.declare(caller, {
          ...rest,
          pr: ref,
          ...(threadId === undefined ? {} : { threadId: threadId as ThreadId }),
        });
      }),
  });
});
