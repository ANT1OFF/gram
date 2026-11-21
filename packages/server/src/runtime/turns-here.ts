import { effectiveCheckout, isLocalHost, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { TurnHooksShape } from "./hooks.ts";

/**
 * The turn hooks, with a thread on another machine's turns taking no checkpoints here: this
 * machine's git can't reach its checkout, and a folder of the same name here isn't it. Its turn
 * end still asks for a git-state refresh, with no checkpoint, which reads the machine's checkout
 * there.
 */
export const turnsHere = (
  hooks: TurnHooksShape,
  store: Pick<ThreadStore["Service"], "getThread">,
): TurnHooksShape => {
  const here = (threadId: ThreadId) =>
    store.getThread(threadId).pipe(
      Effect.map((thread) => isLocalHost(effectiveCheckout(thread))),
      Effect.orElseSucceed(() => true),
    );
  return {
    ...hooks,
    onTurnStart: (threadId, turnId, cwd) =>
      Effect.flatMap(here(threadId), (local) =>
        local ? hooks.onTurnStart(threadId, turnId, cwd) : Effect.void,
      ),
    onTurnEnd: (threadId, turnId, cwd, reason, touchedRemote) =>
      Effect.flatMap(here(threadId), (local) =>
        local
          ? hooks.onTurnEnd(threadId, turnId, cwd, reason, touchedRemote)
          : touchedRemote
            ? hooks.onRemoteCommand(threadId, cwd)
            : hooks.onFilesChanged(threadId, cwd),
      ),
  };
};
