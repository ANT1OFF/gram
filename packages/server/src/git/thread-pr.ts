import {
  effectiveCheckout,
  GitError,
  isLocalHost,
  LOCAL_HOST_ID,
  type Thread,
} from "@gram/contracts";
import { Pr, prTargetOf } from "@gram/git";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { folderExists, missingThreadFolder } from "../fs/folders.ts";
import type { WorkerHostsShape } from "../host/worker-host.ts";
import { GitStatePublisher } from "./publisher.ts";

/**
 * Why work that runs git on this machine can't for a thread on another one: its checkout is that
 * machine's, and a folder at the same path here, if any, is another checkout.
 */
export const ON_ANOTHER_MACHINE =
  "This thread runs on another machine, and this runs git on this one. Ask its agent, or use a terminal of the thread, which opens on that machine.";

/**
 * The thread's checkout folder, for git that runs on this machine. A deleted folder fails with a
 * message instead of a platform error, and a thread on another machine is refused before this disk
 * is asked about its path.
 */
export const threadFolder = (thread: Thread) =>
  Effect.gen(function* () {
    const checkout = effectiveCheckout(thread);
    if (!isLocalHost(checkout)) return yield* new GitError({ message: ON_ANOTHER_MACHINE });
    const cwd = checkout.path;
    if (!(yield* folderExists(cwd))) {
      return yield* new GitError({ message: missingThreadFolder(cwd) });
    }
    return cwd;
  });

/**
 * Fails unless `path` is this machine's, for an RPC that names only a path and runs git here: a
 * folder a thread on another machine holds (or one two machines hold) is that machine's, and git
 * here would read or change another repository at the same path, or fail to start.
 */
export const pathHere = (hosts: Pick<WorkerHostsShape, "placeOf">, path: string) =>
  Effect.flatMap(hosts.placeOf(path), (id) =>
    id === LOCAL_HOST_ID
      ? Effect.void
      : Effect.fail(
          new GitError({
            message:
              id === undefined
                ? `${path} is a folder on more than one machine, and this runs git on this one.`
                : `${path} is another machine's folder, and this runs git on this one.`,
          }),
        ),
  );

/**
 * A folder to start `gh` in for a call about the thread's PR that names its repository (`--repo`,
 * or an API path or node id): the thread's folder on this machine, as `threadFolder` checks it. For
 * a thread on another machine, a folder that exists here: `gh` runs on this one, and a folder at
 * its checkout's path here would be another repository.
 */
export const ghFolder = (thread: Thread) =>
  isLocalHost(effectiveCheckout(thread)) ? threadFolder(thread) : Effect.sync(tmpdir);

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

  /**
   * The bound PR, else the branch's badge; `undefined` without one, and for an orchestrator. A
   * thread on another machine has its branch's badge only as published: no branch is looked up
   * from `cwd` here, which isn't its checkout.
   */
  const target = (thread: Thread, cwd: string) =>
    thread.role === "orchestrator"
      ? Effect.succeed(undefined)
      : thread.boundPr !== undefined
        ? Effect.succeed(prTargetOf(thread.boundPr, undefined))
        : Effect.map(
            isLocalHost(effectiveCheckout(thread))
              ? badge(cwd)
              : Effect.map(publisher.stateForThread(thread), (state) => state?.pr),
            (found) => prTargetOf(undefined, found),
          );

  return { badge, target };
});
