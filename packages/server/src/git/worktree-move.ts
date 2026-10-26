import { existsSync } from "node:fs";
import type { Checkout, Thread } from "@gram/contracts";
import { git, samePath, tryRepoRoots, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";

const roots = (path: string) => tryRepoRoots(path).pipe(Effect.orElseSucceed(() => undefined));

/**
 * What a reported agent cwd means for a thread: the checkout to follow, `null` to return to its launch
 * checkout, or `undefined` for no change. Moving the checkout:
 * - only another worktree of the launch repo is followed; cross-repo moves are ignored;
 * - with following off, a thread still pinned to a worktree returns to its checkout;
 * - a followed worktree removed out of band also returns it.
 */
export const resolveWorktreeMove = (
  thread: Pick<Thread, "checkout" | "currentCheckout">,
  cwd: string,
  follow: boolean,
): Effect.Effect<Checkout | null | undefined, never, Proc> =>
  Effect.gen(function* () {
    const current = thread.currentCheckout;
    if (!follow) return current === undefined ? undefined : null;
    if (current !== undefined && !existsSync(current.path)) return null;
    if (samePath(cwd, current?.path ?? thread.checkout.path)) return undefined;

    const [reported, launch] = yield* Effect.all([roots(cwd), roots(thread.checkout.path)]);
    if (reported === undefined || launch === undefined || reported.common !== launch.common) {
      return undefined;
    }
    if (samePath(reported.top, launch.top)) return current === undefined ? undefined : null;
    if (current !== undefined && samePath(current.path, reported.top)) return undefined;

    const branch = yield* git(reported.top, ["branch", "--show-current"]).pipe(
      Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );
    return {
      kind: "worktree",
      path: reported.top,
      ...(branch === "" ? {} : { branch }),
      repoRoot: thread.checkout.repoRoot ?? launch.top,
    };
  });
