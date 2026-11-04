import {
  GitError,
  InvalidState,
  NotFound,
  type ThreadId,
  type TurnId,
  type TurnUndoData,
} from "@gram/contracts";
import { checkpointRef, tryRepoTop, type Checkpoints, type TurnUndo } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { toGitError } from "./mapping.ts";
import { threadFolder } from "./thread-pr.ts";
import { endCheckpointId } from "./turn-hooks.ts";

export const UNDO_RUNNING =
  "Undo not available: the agent is still working. Undo once it has stopped, or view the changes instead.";

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** Up to three paths, then how many more. */
const listed = (paths: ReadonlyArray<string>) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

const UNSUPPORTED = {
  symlink: "a symlink",
  submodule: "a submodule",
  mode: "a file's mode",
} as const;

/** Why an undo changed nothing, in the user's terms; `undefined` when it went through. */
export const undoRefusal = (result: TurnUndo): string | undefined => {
  switch (result.kind) {
    case "undone":
      return undefined;
    case "nothing":
      return "Undo not available: this turn changed no files.";
    case "committed":
      return `Undo not available: a commit made since this turn started changes its files (${listed(result.paths)}). Undo doesn't revert commits.`;
    case "history":
      return "Undo not available: the branch moved off the commit this turn started from (a reset, rebase or another branch), so undo can't tell whether its edits were committed.";
    case "changed":
      return `Undo not available: ${files(result.paths.length)} changed again since this turn (${listed(result.paths)}), by a later turn or by you. View the changes to undo them by hand.`;
    case "obstructed":
      return `Undo not available: a folder this turn's files are in is no longer a plain, writable folder (${listed(result.paths)}).`;
    case "unsupported":
      return `Undo not available: this turn changed ${UNSUPPORTED[result.reason]} (${listed(result.paths)}), which undo doesn't handle.`;
    case "refused":
      return `Undo not available: git couldn't reverse this turn's changes cleanly (${result.message}). Nothing was changed.`;
  }
};

export interface TurnUndoDeps {
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly runtimes: Pick<ThreadRuntimesShape, "whileIdle">;
  readonly checkpoints: Pick<Checkpoints["Service"], "undoTurn" | "resolve">;
  /** Asks for the thread's git state again once files changed. */
  readonly refresh?: (cwd: string) => Effect.Effect<void>;
}

/**
 * Undoes one finished turn's file edits in the thread's working folder: the turn's patch reversed
 * with `git apply -R`, only while the thread is at rest, and only when every path it touches still
 * holds exactly what the turn left and no commit since holds it. The check and the apply run under
 * the thread's lock, so a send made meanwhile waits for them, and the receipt is written before it
 * runs, landing after the turn rather than inside the next. The agent session is left alone.
 */
export const makeTurnUndo =
  ({ store, runtimes, checkpoints, refresh }: TurnUndoDeps) =>
  (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const cwd = yield* threadFolder(thread);
      const top = yield* tryRepoTop(cwd).pipe(Effect.mapError(toGitError));
      if (top === undefined) {
        return yield* new InvalidState({
          message: "Undo not available: this thread's folder isn't a git repository.",
          threadId,
        });
      }
      const resolve = (id: string) =>
        checkpoints
          .resolve(top, threadId, id)
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
      if ((yield* resolve(turnId)) === undefined) {
        return yield* new NotFound({
          entity: "checkpoint",
          id: turnId,
          message:
            "Undo not available: this turn has no checkpoint here. It may have run in another folder or outside git.",
        });
      }
      if ((yield* resolve(endCheckpointId(turnId))) === undefined) {
        return yield* new InvalidState({ message: UNDO_RUNNING, threadId });
      }
      const undo = Effect.gen(function* () {
        const result = yield* checkpoints
          .undoTurn(
            top,
            checkpointRef(threadId, turnId),
            checkpointRef(threadId, endCheckpointId(turnId)),
          )
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
        if (result.kind !== "undone")
          return { refused: undoRefusal(result) ?? "Undo not available." } as const;
        const receipt: TurnUndoData = {
          turnId,
          files: result.paths.length,
          at: yield* Clock.currentTimeMillis,
        };
        return { receipt } as const;
      });
      // The runtime's own refusal: something runs, is queued, or waits on the user.
      const outcome = yield* runtimes
        .whileIdle(threadId, undo, (done) =>
          "receipt" in done
            ? { type: "data-turn-undo", id: randomUUID(), data: done.receipt }
            : undefined,
        )
        .pipe(
          Effect.catchTag("InvalidState", () =>
            Effect.fail(new InvalidState({ message: UNDO_RUNNING, threadId })),
          ),
        );
      if ("refused" in outcome) {
        return yield* new InvalidState({ message: outcome.refused, threadId });
      }
      if (refresh !== undefined) yield* refresh(cwd);
      return outcome.receipt;
    });
