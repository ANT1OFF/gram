import { GitError, NotFound, type Diff, type ThreadId, type TurnId } from "@gram/contracts";
import {
  Checkpoints,
  git,
  MAX_DIFF_READ_BYTES,
  parseGitDiffCapped,
  tryRepoTop,
  withoutWhitespaceChanges,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { toDiffFile, toGitError } from "./mapping.ts";
import { endCheckpointId } from "./turn-hooks.ts";

/**
 * A finished turn's changes without whitespace-only ones: `git diff -w` between its two checkpoint
 * commits, which `Checkpoints.resolve` has already read and pinned as full commit ids.
 */
const checkpointsDiffIgnoringWhitespace = (top: string, start: string, end: string) =>
  Effect.gen(function* () {
    const out = yield* git(
      top,
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--no-color",
        "-w",
        start,
        end,
      ],
      { maxOutputBytes: MAX_DIFF_READ_BYTES },
    ).pipe(Effect.mapError(toGitError));
    if (out.status !== 0) {
      return yield* new GitError({
        message: out.stderr.trim() || "git diff failed",
        command: "git diff",
      });
    }
    return parseGitDiffCapped(out.stdout, out.truncated);
  });

/** A turn's changes: its start checkpoint against its end checkpoint, or the live tree while it runs. */
export const turnDiff = (
  threadId: ThreadId,
  cwd: string,
  turnId: TurnId,
  options: { readonly ignoreWhitespace?: boolean | undefined } = {},
) =>
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
    const result =
      options.ignoreWhitespace === true && end !== undefined
        ? yield* checkpointsDiffIgnoringWhitespace(top, start, end)
        : yield* checkpoints.diffBetween(top, start, end ?? "worktree").pipe(
            Effect.mapError(
              (e) => new GitError({ message: `no checkpoint for turn ${turnId}: ${e.message}` }),
            ),
            // A running turn's end is the live tree, which only the checkpoints can snapshot.
            Effect.map((diff) =>
              options.ignoreWhitespace === true
                ? { ...diff, files: withoutWhitespaceChanges(diff.files) }
                : diff,
            ),
          );
    return {
      repo: true,
      worktree: top,
      files: result.files.map((f) => toDiffFile(f, new Set())),
      ...(result.note === undefined ? {} : { note: result.note }),
    } satisfies Diff;
  });
