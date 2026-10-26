import { GitError, NotFound, type Diff, type ThreadId, type TurnId } from "@gram/contracts";
import { Checkpoints, tryRepoTop } from "@gram/git";
import * as Effect from "effect/Effect";
import { toDiffFile, toGitError } from "./mapping.ts";
import { endCheckpointId } from "./turn-hooks.ts";

/** A turn's changes: its start checkpoint against its end checkpoint, or the live tree while it runs. */
export const turnDiff = (threadId: ThreadId, cwd: string, turnId: TurnId) =>
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints;
    const top = yield* tryRepoTop(cwd).pipe(Effect.mapError(toGitError));
    if (top === undefined) return { repo: false } satisfies Diff;
    // Either name: a turn checkpointed before 1.0 may not have moved to the new one yet.
    const resolve = (turn: string) =>
      checkpoints.resolve(top, threadId, turn).pipe(Effect.mapError(toGitError));
    const start = yield* resolve(turnId);
    if (start === undefined) {
      return yield* new NotFound({
        entity: "checkpoint",
        id: turnId,
        message:
          "This turn has no checkpoint, so its changes can't be shown. It may have run outside git or in another folder.",
      });
    }
    const end = yield* resolve(endCheckpointId(turnId));
    const result = yield* checkpoints
      .diffBetween(top, start, end ?? "worktree")
      .pipe(
        Effect.mapError(
          (e) => new GitError({ message: `no checkpoint for turn ${turnId}: ${e.message}` }),
        ),
      );
    return {
      repo: true,
      worktree: top,
      files: result.files.map((f) => toDiffFile(f, new Set())),
      ...(result.note === undefined ? {} : { note: result.note }),
    } satisfies Diff;
  });
