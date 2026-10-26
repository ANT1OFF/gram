import { Checkpoints, Proc, samePath, seedWorktreePermissions } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TurnHooks } from "../runtime/hooks.ts";
import { GitRefresh } from "./platform.ts";
import { resolveWorktreeMove } from "./worktree-move.ts";

/** The checkpoint id written when a turn ends; the start checkpoint is the turn id itself. */
export const endCheckpointId = (turnId: string): string => `${turnId}.end`;

/**
 * Per-turn checkpoints: the working tree at turn start (`refs/gram/checkpoints/<thread>/<turn>`) and
 * at turn end (`<turn>.end`), so a turn's diff includes Bash-made edits. A non-repo cwd simply has no
 * checkpoints. Turn end and file changes request a git-state refresh; a command GitHub reacts to
 * requests one of GitHub too, as it finishes.
 */
export const GitTurnHooksLive = Layer.effect(
  TurnHooks,
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints;
    const refresh = yield* GitRefresh;
    const proc = yield* Proc;
    const snapshot = (cwd: string, threadId: string, id: string) =>
      checkpoints.snapshot(cwd, threadId, id).pipe(
        Effect.catch((error) =>
          Effect.logDebug("no checkpoint for turn").pipe(
            Effect.annotateLogs({ threadId, checkpoint: id, reason: error.message }),
          ),
        ),
        Effect.asVoid,
      );
    return {
      onTurnStart: (threadId, turnId, cwd) => snapshot(cwd, threadId, turnId),
      // GitHub is asked only when the turn did something it would know about. Every turn end used
      // to ask, and most turns only edit files; a push this misses is a sweep away.
      onTurnEnd: (threadId, turnId, cwd, _reason, touchedRemote) =>
        snapshot(cwd, threadId, endCheckpointId(turnId)).pipe(
          Effect.andThen(refresh.request(cwd, touchedRemote)),
        ),
      onRemoteCommand: (_threadId, cwd) => refresh.request(cwd, true, { expectChange: true }),
      onFilesChanged: (_threadId, cwd) => refresh.request(cwd, false),
      // A worktree the agent entered on its own gets the repo root's permission rules, as ones we
      // create do.
      resolveCwd: (thread, cwd, follow) =>
        resolveWorktreeMove(thread, cwd, follow).pipe(
          Effect.tap((next) =>
            next == null || next.repoRoot === undefined || samePath(next.repoRoot, next.path)
              ? Effect.void
              : seedWorktreePermissions(next.repoRoot, next.path),
          ),
          Effect.provideService(Proc, proc),
        ),
    };
  }),
);
