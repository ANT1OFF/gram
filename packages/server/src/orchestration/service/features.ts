// Features: a workspace's features with their stages and groups,
// set by the orchestrator (`set_stage`, `set_group`) or the user, and the user's archive, pause and
// rename of one.

import {
  InvalidState,
  cardShown,
  type FeatureCard,
  type WorkspaceState,
  type NotFound,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { redactText } from "../../logging/redact.ts";
import {
  encodeOutbox,
  outboxWithFeatureRenamed,
  readOutbox as readStoredOutbox,
  withNotes,
  type OutboxState,
} from "../outbox.ts";
import {
  featureSlug,
  refusal,
  regroup,
  stageUpdate,
  type PendingReason,
  type RefusalCode,
} from "../rules.ts";
import { workersOf, toolError, type OrchestrationKit } from "./kit.ts";
import {
  type StageInput,
  type GroupInput,
  type OrchestrationShape,
  type WorkspaceStage,
} from "./shape.ts";

/** Why a stage or a group wasn't set, for a tool's refusal or an RPC's `InvalidState`. */
type Refused = { readonly code: RefusalCode; readonly reason: string };

const unknownFeature = (slug: string): Refused => ({
  code: "unknown_feature",
  reason: `No feature is called ${slug} here: it has no worker, no stage and no group. Spawn a worker for it first.`,
});

/** The workspace with `from` called `to` wherever it keys: its stage, its groups, its pause. */
const workspaceWithFeatureRenamed = (
  state: WorkspaceState,
  from: string,
  to: string,
): WorkspaceState => {
  const { [from]: stage, ...stages } = state.stages ?? {};
  return {
    ...state,
    ...(state.stages === undefined
      ? {}
      : { stages: stage === undefined ? stages : { ...stages, [to]: stage } }),
    ...(state.groups === undefined
      ? {}
      : {
          groups: Object.fromEntries(
            Object.entries(state.groups).map(([name, group]) => [
              name,
              {
                ...group,
                features: group.features.map((feature) => (feature === from ? to : feature)),
              },
            ]),
          ),
        }),
    ...(state.pausedFeatures === undefined
      ? {}
      : {
          pausedFeatures: state.pausedFeatures.map((feature) => (feature === from ? to : feature)),
        }),
  };
};

/** What features take from the rest of the service. */
export interface FeaturesDeps {
  readonly wake: (
    workspaceId: WorkspaceId,
    reason: string,
    withoutDiff?: boolean,
    about?: Omit<PendingReason, "reason">,
  ) => Effect.Effect<void>;
  readonly armAlarms: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly armLimitResume: (workspaceId: WorkspaceId) => Effect.Effect<void>;
}

/** Stages, groups, and archiving, pausing and renaming features. */
export const makeFeatures = (kit: OrchestrationKit, deps: FeaturesDeps) => {
  const {
    store,
    workspacesChanged,
    orchestrationChanged,
    updateOutbox,
    runtimes,
    publisher,
    readOutbox,
    heldLock,
    spawnLock,
    cardsLock,
    outboxLock,
    requireAuthority,
  } = kit;
  const { wake, armAlarms, armLimitResume } = deps;

  // ---------------------------------------------------------------------------------------
  // Stages and groups
  // ---------------------------------------------------------------------------------------

  /** Whether the workspace knows the feature: it has a worker, a stage, or a place in a group. */
  const knownFeature = (state: WorkspaceState, slug: string) =>
    Effect.gen(function* () {
      if (state.stages?.[slug] !== undefined) return true;
      if (Object.values(state.groups ?? {}).some((group) => group.features.includes(slug))) {
        return true;
      }
      return workersOf(yield* store.listThreads, state).some(
        (worker) => worker.spawnedBy?.feature === slug,
      );
    });

  /**
   * Sets a stage, or says why not. The check that needs the threads runs first; the stage itself
   * is decided inside `updateWorkspace`, against the plan that is there at that moment.
   */
  const applyStage = (
    workspaceId: WorkspaceId,
    input: StageInput,
    setBy: WorkspaceStage["setBy"],
  ): Effect.Effect<
    | { readonly state: WorkspaceState; readonly target: string; readonly stage: WorkspaceStage }
    | Refused,
    NotFound
  > =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      if ((input.feature === undefined) === (input.group === undefined)) {
        return {
          code: "invalid_stage",
          reason: "Name a feature or a group to set the stage of, one and not both.",
        };
      }
      const onGroup = input.feature === undefined;
      const slug = featureSlug(input.feature ?? input.group ?? "");
      if (slug === undefined) {
        return onGroup
          ? { code: "invalid_group", reason: `"${input.group}" isn't a usable group name.` }
          : {
              code: "invalid_feature",
              reason: `"${input.feature}" isn't a usable feature name.`,
            };
      }
      if (onGroup && state.groups?.[slug] === undefined) {
        return {
          code: "invalid_group",
          reason: `No group is called ${slug}. Make one by putting a feature in it: spawn_worker's group, or set_group.`,
        };
      }
      if (!onGroup && !(yield* knownFeature(state, slug))) return unknownFeature(slug);
      const now = yield* Clock.currentTimeMillis;
      let refused: Refused | undefined;
      let stored: WorkspaceStage | undefined;
      const next = yield* store.updateWorkspace(workspaceId, (current) => {
        const group = current.groups?.[slug];
        // The group went while this call was checking it: nothing to put a stage on.
        if (onGroup && group === undefined) return current;
        const verdict = stageUpdate({
          current: onGroup ? group?.stage : current.stages?.[slug],
          stage: input.stage,
          plan: input.plan,
          ...(input.note === undefined ? {} : { note: redactText(input.note) }),
          setBy,
          now,
        });
        if (!verdict.ok) {
          refused = { code: verdict.code, reason: verdict.reason };
          return current;
        }
        stored = verdict.stage;
        return onGroup && group !== undefined
          ? { ...current, groups: { ...current.groups, [slug]: { ...group, stage: stored } } }
          : { ...current, stages: { ...current.stages, [slug]: stored } };
      });
      if (refused !== undefined) return refused;
      if (stored === undefined) {
        return { code: "invalid_group", reason: `No group is called ${slug} any more.` };
      }
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: now,
        kind: "stage",
        data: { [onGroup ? "group" : "feature"]: slug, stage: stored.stage, setBy },
      });
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      return { state: next, target: slug, stage: stored };
    });

  const applyGroup = (
    workspaceId: WorkspaceId,
    input: GroupInput,
  ): Effect.Effect<
    | {
        readonly state: WorkspaceState;
        readonly feature: string;
        readonly group?: string;
        /** Whether anything changed: putting a feature where it already is doesn't. */
        readonly moved: boolean;
      }
    | Refused,
    NotFound
  > =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const feature = featureSlug(input.feature);
      if (feature === undefined) {
        return {
          code: "invalid_feature",
          reason: `"${input.feature}" isn't a usable feature name.`,
        };
      }
      const group = input.group === undefined ? undefined : featureSlug(input.group);
      if (input.group !== undefined && group === undefined) {
        return {
          code: "invalid_group",
          reason: `"${input.group}" isn't a usable group name. Use a short slug such as release-0-4.`,
        };
      }
      if (!(yield* knownFeature(state, feature))) return unknownFeature(feature);
      let moved = false;
      const next = yield* store.updateWorkspace(workspaceId, (current) => {
        const before = current.groups ?? {};
        const groups = regroup(before, feature, group);
        if (groups === before) return current;
        moved = true;
        return { ...current, groups };
      });
      if (moved) {
        yield* store.appendOrchestrationEvent(workspaceId, {
          at: yield* Clock.currentTimeMillis,
          kind: "group",
          data: { feature, ...(group === undefined ? {} : { group }) },
        });
        yield* workspacesChanged;
        yield* orchestrationChanged(workspaceId);
      }
      return { state: next, feature, moved, ...(group === undefined ? {} : { group }) };
    });

  /** One line for the next digest, without sending one: what the user did is news, not an alarm. */
  const noteForNextDigest = (workspaceId: WorkspaceId, note: string) =>
    updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);

  const setStage: OrchestrationShape["setStage"] = (workspaceId, input) =>
    Effect.gen(function* () {
      const done = yield* applyStage(workspaceId, input, "user");
      if ("code" in done) return yield* new InvalidState({ message: done.reason });
      yield* noteForNextDigest(
        workspaceId,
        `The user moved ${input.feature === undefined ? "group" : "feature"} ${done.target} to stage "${done.stage.stage}"${
          done.stage.note === undefined ? "" : ` (${done.stage.note})`
        }. Their word stands; work from there.`,
      );
      return done.state;
    });

  const setGroup: OrchestrationShape["setGroup"] = (workspaceId, input) =>
    Effect.gen(function* () {
      const done = yield* applyGroup(workspaceId, input);
      if ("code" in done) return yield* new InvalidState({ message: done.reason });
      if (done.moved) {
        yield* noteForNextDigest(
          workspaceId,
          done.group === undefined
            ? `The user took feature ${done.feature} out of its group.`
            : `The user put feature ${done.feature} in group ${done.group}.`,
        );
      }
      return done.state;
    });

  const archiveFeature: OrchestrationShape["archiveFeature"] = (workspaceId, raw) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const feature = featureSlug(raw);
      if (feature === undefined) {
        return yield* new InvalidState({ message: `"${raw}" isn't a usable feature name.` });
      }
      const workers = workersOf(yield* store.listThreads, state).filter(
        (worker) => worker.spawnedBy?.feature === feature && !worker.parked,
      );
      if (workers.length === 0) {
        return yield* new InvalidState({
          message: `No feature called ${feature} has a worker left to archive.`,
        });
      }
      const busy: Array<string> = [];
      for (const worker of workers) {
        const status = yield* runtimes
          .status(worker.id)
          .pipe(Effect.orElseSucceed(() => "cold" as const));
        const asking = (yield* store.listRequests(worker.id)).length > 0;
        if (asking || status === "running" || status === "starting") busy.push(worker.title);
      }
      if (busy.length > 0) {
        return yield* new InvalidState({
          message: `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} still running or waiting on you. Stop ${busy.length === 1 ? "it" : "them"} first.`,
        });
      }
      for (const worker of workers) {
        yield* runtimes
          .updateThread(worker.id, (thread) => ({ ...thread, parked: true }))
          .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
      }
      // Parked threads leave the git watchers, as the thread menu's Park does.
      yield* publisher.sync;
      // A pause on it goes with it: nothing would be left to show Resume on.
      yield* store.updateWorkspace(workspaceId, (current) => {
        if (current.pausedFeatures?.includes(feature) !== true) return current;
        const kept = current.pausedFeatures.filter((each) => each !== feature);
        const { pausedFeatures: _, ...rest } = current;
        return kept.length === 0 ? rest : { ...rest, pausedFeatures: kept };
      });
      yield* noteForNextDigest(
        workspaceId,
        `The user archived feature ${feature}: its ${workers.length === 1 ? "worker is" : `${workers.length} workers are`} parked. Leave it unless they bring it back.`,
      );
      yield* orchestrationChanged(workspaceId);
      return workers.map((worker) => worker.id);
    });

  const setFeaturePaused: OrchestrationShape["setFeaturePaused"] = (workspaceId, raw, paused) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const feature = featureSlug(raw);
      if (feature === undefined) {
        return yield* new InvalidState({ message: `"${raw}" isn't a usable feature name.` });
      }
      const held = (yield* readOutbox(workspaceId)).heldBriefs ?? [];
      if (
        paused &&
        !(yield* knownFeature(state, feature)) &&
        !held.some((brief) => brief.input.feature === feature)
      ) {
        return yield* new InvalidState({ message: `No feature is called ${feature} here.` });
      }
      let changed = false;
      const next = yield* store.updateWorkspace(workspaceId, (current) => {
        const list = current.pausedFeatures ?? [];
        if (list.includes(feature) === paused) return current;
        changed = true;
        const after = paused ? [...list, feature] : list.filter((each) => each !== feature);
        const { pausedFeatures: _, ...rest } = current;
        return after.length === 0 ? rest : { ...rest, pausedFeatures: after };
      });
      if (!changed) return next;
      let stopped = 0;
      if (paused) {
        const workers = workersOf(yield* store.listThreads, next).filter(
          (worker) => worker.spawnedBy?.feature === feature && !worker.parked,
        );
        for (const worker of workers) {
          const status = yield* runtimes
            .status(worker.id)
            .pipe(Effect.orElseSucceed(() => "cold" as const));
          if (status !== "running" && status !== "starting") continue;
          yield* runtimes
            .interrupt(worker.id)
            .pipe(
              Effect.catch((e) =>
                Effect.logWarning("a paused feature's worker couldn't be stopped").pipe(
                  Effect.annotateLogs({ threadId: worker.id, error: e.message }),
                ),
              ),
            );
          stopped++;
        }
      }
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: paused ? "featurePaused" : "featureResumed",
        data: { feature },
      });
      yield* noteForNextDigest(
        workspaceId,
        paused
          ? `The user paused feature ${feature}${
              stopped === 0
                ? ""
                : `, stopping ${stopped === 1 ? "its running worker" : `its ${stopped} running workers`}`
            }. Until they resume it, don't message its workers or spawn for it; its news waits for your next digest.`
          : `The user resumed feature ${feature}. Pick it up where it stands: its workers wait until you write to them.`,
      );
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      if (!paused) {
        // What its workers' queues held while it was paused goes now.
        const workers = workersOf(yield* store.listThreads, next).filter(
          (worker) => worker.spawnedBy?.feature === feature && !worker.parked,
        );
        for (const worker of workers) yield* runtimes.releaseQueue(worker.id);
        yield* wake(workspaceId, `the user resumed feature ${feature}`, true);
        // A worker's wake that fell due during the pause, and a held brief whose limit reset
        // meanwhile, waited for this.
        yield* armAlarms(workspaceId);
        yield* armLimitResume(workspaceId);
      }
      return next;
    });

  const renameFeature: OrchestrationShape["renameFeature"] = (workspaceId, raw, rawTo) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const from = featureSlug(raw);
      if (from === undefined) {
        return yield* new InvalidState({ message: `"${raw}" isn't a usable feature name.` });
      }
      const to = featureSlug(rawTo);
      if (to === undefined) {
        return yield* new InvalidState({
          message: `"${rawTo.trim()}" isn't a usable feature name. Use a short slug such as mail-trigger.`,
        });
      }
      if (to === from) {
        return yield* new InvalidState({ message: `The feature is called ${from} already.` });
      }
      const inUse = (slug: string, outbox: OutboxState, cards: ReadonlyArray<FeatureCard>) =>
        Effect.gen(function* () {
          if (yield* knownFeature(state, slug)) return true;
          if ((outbox.heldBriefs ?? []).some((brief) => brief.input.feature === slug)) {
            return true;
          }
          return cards.some((card) => card.feature === slug && cardShown(card));
        });
      // One rename at a time beside the card reconcile and every outbox write, so neither puts
      // the old name back over the new one.
      // Behind a release run and a spawn under way (in their order: held, spawn, cards, outbox),
      // so neither lands a worker under the old name after the rename.
      const renamed = yield* heldLock.withLock(
        workspaceId,
        spawnLock.withLock(
          workspaceId,
          cardsLock.withLock(
            workspaceId,
            outboxLock.withLock(
              workspaceId,
              Effect.gen(function* () {
                const stored = readStoredOutbox(yield* store.getOutbox(workspaceId));
                if (
                  stored._tag === "unreadable" ||
                  (stored._tag === "read" && stored.setAside !== undefined)
                ) {
                  return yield* new InvalidState({
                    message:
                      "The orchestrator's delivery state can't be read, so the feature isn't renamed. Resume orchestration first.",
                  });
                }
                const cards = yield* store.listFeatureCards(workspaceId);
                if (!(yield* inUse(from, stored.state, cards))) {
                  return yield* new InvalidState({
                    message: `No feature is called ${from} here.`,
                  });
                }
                if (yield* inUse(to, stored.state, cards)) {
                  return yield* new InvalidState({
                    message: `A feature called ${to} exists already. Pick another name.`,
                  });
                }
                const now = yield* Clock.currentTimeMillis;
                // The card goes under its new name, its sentence with it; the old name's card stays
                // with no worker at a newer version, so a client holding it lets it go.
                const card = cards.find((each) => each.feature === from);
                const taken = cards.find((each) => each.feature === to);
                const moved: Array<FeatureCard> = [];
                if (card !== undefined) {
                  const version =
                    taken === undefined ? card.version : Math.max(card.version, taken.version) + 1;
                  const { summary, held, ...rest } = card;
                  moved.push({
                    ...rest,
                    ...(held === undefined ? {} : { held }),
                    feature: to,
                    version,
                    ...(summary !== undefined && version === card.version ? { summary } : {}),
                    updatedAt: now,
                  });
                  moved.push({ ...rest, workers: [], version: card.version + 1, updatedAt: now });
                }
                const outbox = withNotes(outboxWithFeatureRenamed(stored.state, from, to), [
                  `The user renamed feature ${from} to ${to}. Call it ${to} from now on, in tools and in memory; its branches keep their names.`,
                ]);
                return yield* store.renameFeature({
                  workspaceId,
                  holder: state.workspace.orchestratorThreadId,
                  from,
                  to,
                  workspace: (current) => workspaceWithFeatureRenamed(current, from, to),
                  cards: moved,
                  outbox: encodeOutbox(outbox),
                });
              }),
            ),
          ),
        ),
      );
      // Every view of the workers hears of their new feature as of any other edit.
      for (const thread of renamed) {
        yield* runtimes
          .updateThread(thread.id, (current) => current)
          .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
      }
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "featureRenamed",
        data: { from, to, workers: renamed.length },
      });
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      return to;
    });

  const setStageAs: OrchestrationShape["setStageAs"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "set_stage";
      const { state } = yield* requireAuthority(tool, callerId);
      const done = yield* applyStage(state.workspace.id, input, "orchestrator").pipe(
        Effect.mapError((e) => toolError(tool, e.message)),
      );
      if ("code" in done) return yield* toolError(tool, refusal(done.code, done.reason));
      return {
        ...(input.feature === undefined ? { group: done.target } : { feature: done.target }),
        stage: done.stage,
      };
    });

  const setGroupAs: OrchestrationShape["setGroupAs"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "set_group";
      const { state } = yield* requireAuthority(tool, callerId);
      const done = yield* applyGroup(state.workspace.id, input).pipe(
        Effect.mapError((e) => toolError(tool, e.message)),
      );
      if ("code" in done) return yield* toolError(tool, refusal(done.code, done.reason));
      return {
        feature: done.feature,
        ...(done.group === undefined ? {} : { group: done.group }),
      };
    });

  return {
    noteForNextDigest,
    setStage,
    setGroup,
    archiveFeature,
    setFeaturePaused,
    renameFeature,
    setStageAs,
    setGroupAs,
  };
};

/** What `makeFeatures` makes, for the parts whose `deps` take some of it. */
export type Features = ReturnType<typeof makeFeatures>;
