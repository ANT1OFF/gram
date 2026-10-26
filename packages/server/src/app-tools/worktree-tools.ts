import { AppToolError } from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { heldCheckoutPaths } from "../runtime/create-in-checkout.ts";
import type { CheckoutServiceShape } from "../runtime/hooks.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";

/** `move_to_worktree`: the native version of "the sidebar follows Claude into a worktree". */
export const moveToWorktreeTool = (
  runtimes: ThreadRuntimesShape,
  store: ThreadStoreShape,
  checkouts: CheckoutServiceShape,
) =>
  defineAppTool({
    descriptor: {
      name: "move_to_worktree",
      class: "crossThread",
      description:
        "Move this thread into a git worktree for `branch`, created from `base` or reused if it exists. The session continues there once the current turn ends; until then use absolute paths into the new folder.",
    },
    input: Schema.Struct({
      branch: Schema.NonEmptyString,
      base: Schema.optionalKey(Schema.String),
    }),
    describe: (_threadId, { branch, base }) =>
      Effect.succeed(
        `Move this thread into a worktree on ${branch}${base === undefined ? "" : `, from ${base}`}`,
      ),
    handle: (threadId, { branch, base }) =>
      Effect.gen(function* () {
        const tool = "move_to_worktree";
        const thread = yield* store.getThread(threadId);
        const project = (yield* store.listProjects).find((p) => p.id === thread.projectId);
        if (project === undefined) {
          return yield* new AppToolError({ tool, message: "This thread's project is gone." });
        }
        const others = heldCheckoutPaths(
          (yield* store.listThreads).filter((t) => t.id !== threadId),
        );
        const checkout = yield* checkouts
          .prepare(
            { kind: "newWorktree", branch, ...(base === undefined ? {} : { base }) },
            others,
            thread.checkout.repoRoot ?? project.root,
          )
          .pipe(
            Effect.catchTag("WorktreeDirty", (e) =>
              Effect.fail(new AppToolError({ tool, message: `${e.path} has uncommitted changes` })),
            ),
          );
        if (samePath(checkout.path, thread.checkout.path)) {
          return { moved: false, path: checkout.path };
        }
        yield* runtimes.moveCheckout(threadId, checkout);
        return {
          moved: true,
          path: checkout.path,
          ...(checkout.branch === undefined ? {} : { branch: checkout.branch }),
        };
      }).pipe(
        Effect.mapError((e) =>
          e instanceof AppToolError
            ? e
            : new AppToolError({
                tool: "move_to_worktree",
                message: "message" in e && typeof e.message === "string" ? e.message : String(e),
              }),
        ),
      ),
  });
