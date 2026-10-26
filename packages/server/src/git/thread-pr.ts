import { effectiveCheckout, GitError, type Thread } from "@gram/contracts";
import { Pr, prTargetOf } from "@gram/git";
import * as Effect from "effect/Effect";
import { folderExists, missingThreadFolder } from "../fs/folders.ts";
import { GitStatePublisher } from "./publisher.ts";

/** The thread's checkout folder; a deleted folder fails with a message instead of a platform error. */
export const threadFolder = (thread: Thread) =>
  Effect.gen(function* () {
    const cwd = effectiveCheckout(thread).path;
    if (!(yield* folderExists(cwd))) {
      return yield* new GitError({ message: missingThreadFolder(cwd) });
    }
    return cwd;
  });

/** Finds the PR a thread acts on, for handlers and app tools that yield it once at construction. */
export const ThreadPrLookup = Effect.gen(function* () {
  const publisher = yield* GitStatePublisher;
  const pr = yield* Pr;

  /** The branch's badge: the publisher's cached state, else a fresh lookup; `undefined` without a PR. */
  const badge = (cwd: string) =>
    Effect.gen(function* () {
      const cached = (yield* publisher.stateFor(cwd))?.pr;
      if (cached !== undefined) return cached;
      return yield* pr.status(cwd).pipe(Effect.orElseSucceed(() => undefined));
    });

  /** The bound PR, else the branch's badge; `undefined` without one, and for an orchestrator. */
  const target = (thread: Thread, cwd: string) =>
    thread.role === "orchestrator"
      ? Effect.succeed(undefined)
      : thread.boundPr !== undefined
        ? Effect.succeed(prTargetOf(thread.boundPr, undefined))
        : Effect.map(badge(cwd), (found) => prTargetOf(undefined, found));

  return { badge, target };
});
