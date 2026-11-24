import {
  type Dream,
  type DreamId,
  type MemoryUpdateMode,
  memoryUpdateModeOf,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { AutomaticDreamDeferred } from "./automatic-dream.ts";
import { dreamWaitsForReview } from "./dream-recent.ts";

const HOUR_MS = 3_600_000;

const recentDraft = (dream: Dream) =>
  dreamWaitsForReview(dream) && dream.inputs.recent !== undefined;

/**
 * When memory updates run on their own, and what switching to Auto does. `scheduledPass` starts
 * those due: `memoryUpdateEveryHours` after the last began, when nothing holds it; in Review a
 * draft waiting for review holds it, so drafts don't pile up. `onModeChanges` discards the drafts
 * of these updates waiting for review when a workspace switches to Auto; drafts of picked threads
 * and imports stay.
 */
export const makeMemoryUpdateSchedule = (deps: {
  readonly store: ThreadStoreShape;
  readonly discard: (dreamId: DreamId) => Effect.Effect<void, unknown>;
  readonly gate: (state: WorkspaceState) => Effect.Effect<string | undefined>;
  readonly start: (
    state: WorkspaceState,
  ) => Effect.Effect<unknown, { readonly message?: string; readonly _tag: string }>;
}) => {
  const { store } = deps;
  const modes = new Map<WorkspaceId, MemoryUpdateMode>();
  const seeModes = Effect.gen(function* () {
    for (const state of yield* store.listWorkspaces) {
      modes.set(state.workspace.id, memoryUpdateModeOf(state.charter));
    }
  });
  const onModeChanges = Effect.gen(function* () {
    for (const state of yield* store.listWorkspaces) {
      const id = state.workspace.id;
      const mode = memoryUpdateModeOf(state.charter);
      const was = modes.get(id);
      modes.set(id, mode);
      if (was === undefined || was === mode || mode !== "auto") continue;
      for (const dream of (yield* store.listDreams(id)).filter(recentDraft)) {
        yield* deps
          .discard(dream.id)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("draft not discarded on switching to auto").pipe(
                Effect.annotateLogs({ dreamId: dream.id, cause: Cause.pretty(cause) }),
              ),
            ),
          );
      }
    }
  });
  const tried = new Map<WorkspaceId, number>();
  const scheduledPass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const state of yield* store.listWorkspaces) {
      const id = state.workspace.id;
      const hours = state.charter.memoryUpdateEveryHours;
      if (hours === undefined) continue;
      const dreams = yield* store.listDreams(id);
      if (dreams.some((dream) => dream.status === "running" || dream.status === "pending"))
        continue;
      if (memoryUpdateModeOf(state.charter) === "review" && dreams.some(recentDraft)) continue;
      const last = Math.max(
        tried.get(id) ?? 0,
        ...dreams.filter((dream) => dream.kind === "dream").map((dream) => dream.createdAt),
      );
      if (now - last < hours * HOUR_MS) continue;
      if ((yield* deps.gate(state)) !== undefined) continue;
      yield* deps.start(state).pipe(
        Effect.tap(() => Effect.sync(() => tried.set(id, now))),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!(error instanceof AutomaticDreamDeferred)) tried.set(id, now);
            yield* Effect.logDebug("scheduled memory update not started").pipe(
              Effect.annotateLogs({ workspaceId: id, why: error.message ?? error._tag }),
            );
          }),
        ),
      );
    }
  });
  return { onModeChanges, scheduledPass, seeModes };
};
