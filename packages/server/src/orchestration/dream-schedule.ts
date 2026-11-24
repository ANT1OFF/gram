import {
  type AutomaticDreamStatus,
  type Dream,
  type DreamId,
  type MemoryUpdateMode,
  memoryUpdateModeOf,
  memoryUpdateRuleOf,
  type NotFound,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { AutomaticDreamDeferred } from "./automatic-dream.ts";
import { type MemoryActivity, countActivity } from "./dream-recent-items.ts";
import { dreamWaitsForReview } from "./dream-recent.ts";

const HOUR_MS = 3_600_000;

const recentDraft = (dream: Dream) =>
  dreamWaitsForReview(dream) && dream.inputs.recent !== undefined;

const holdOf = (state: WorkspaceState, dreams: ReadonlyArray<Dream>) => {
  if (dreams.some((dream) => dream.status === "running" || dream.status === "pending"))
    return "Waiting for the running memory update to end.";
  if (memoryUpdateModeOf(state.charter) === "review" && dreams.some(recentDraft))
    return "Waiting for you to review the last draft.";
  return undefined;
};

/**
 * When memory updates run on their own, and what switching to Auto does. One rule
 * (`memoryUpdateRuleOf`): an update is due once `everyHours` have passed since the last began AND
 * `minItems` new items have happened since the last update's cursor, so a workspace where little
 * happens spends no model time on it. `scheduledPass` checks the time first, then counts from the
 * store, and calls no model to decide. A running update, or in Review a draft waiting for review,
 * holds it so drafts don't pile up. `onModeChanges` discards the drafts of these updates waiting
 * for review when a workspace switches to Auto; drafts of picked threads and imports stay.
 */
export const makeMemoryUpdateSchedule = (deps: {
  readonly store: ThreadStoreShape;
  readonly discard: (dreamId: DreamId) => Effect.Effect<void, unknown>;
  readonly gate: (state: WorkspaceState) => Effect.Effect<string | undefined>;
  readonly start: (
    state: WorkspaceState,
  ) => Effect.Effect<unknown, { readonly message?: string; readonly _tag: string }>;
  /** How much has happened since the last update's cursor; the store's own count by default. */
  readonly activity?: (state: WorkspaceState) => Effect.Effect<MemoryActivity>;
}) => {
  const { store } = deps;
  const activity = deps.activity ?? ((state: WorkspaceState) => countActivity(store, state));
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
  const refusedWhy = new Map<WorkspaceId, string>();
  const lastBegan = (id: WorkspaceId, dreams: ReadonlyArray<Dream>) =>
    Math.max(
      tried.get(id) ?? 0,
      ...dreams.filter((dream) => dream.kind === "dream").map((dream) => dream.createdAt),
    );
  const scheduledPass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const state of yield* store.listWorkspaces) {
      const id = state.workspace.id;
      const rule = memoryUpdateRuleOf(state.charter);
      if (rule === undefined) continue;
      const dreams = yield* store.listDreams(id);
      if (holdOf(state, dreams) !== undefined) continue;
      if (now - lastBegan(id, dreams) < rule.everyHours * HOUR_MS) continue;
      if ((yield* activity(state)).total < rule.minItems) continue;
      if ((yield* deps.gate(state)) !== undefined) continue;
      yield* deps.start(state).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            tried.set(id, now);
            refusedWhy.delete(id);
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!(error instanceof AutomaticDreamDeferred)) tried.set(id, now);
            refusedWhy.set(id, error.message ?? error._tag);
            yield* Effect.logDebug("scheduled memory update not started").pipe(
              Effect.annotateLogs({ workspaceId: id, why: error.message ?? error._tag }),
            );
          }),
        ),
      );
    }
  });
  const status = (workspaceId: WorkspaceId): Effect.Effect<AutomaticDreamStatus, NotFound> =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const rule = memoryUpdateRuleOf(state.charter);
      if (rule === undefined)
        return { completed: 0, detail: "Automatic memory updates are off: they run when you ask." };
      const dreams = yield* store.listDreams(workspaceId);
      const last = lastBegan(workspaceId, dreams);
      const counted = yield* activity(state);
      return {
        threshold: rule.minItems,
        completed: counted.total,
        everyHours: rule.everyHours,
        ...(last === 0 ? {} : { dueAt: last + rule.everyHours * HOUR_MS }),
        detail:
          holdOf(state, dreams) ??
          (yield* deps.gate(state)) ??
          refusedWhy.get(workspaceId) ??
          (memoryUpdateModeOf(state.charter) === "auto"
            ? "Each update applies itself."
            : "Each update waits for your review."),
      };
    });
  return { onModeChanges, scheduledPass, seeModes, status };
};
