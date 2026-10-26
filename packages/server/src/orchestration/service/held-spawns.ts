// Held spawns: the gates a spawn passes near a usage limit (asking
// the user, holding a low-priority brief, offering another route), the held briefs themselves, and
// releasing them when the limit resets or a slot frees, or when the user or orchestrator says so.

import type { makeSpawnBreaker } from "../spawn-breaker.ts";
import {
  InvalidState,
  LIMIT_PAUSE_TOOL,
  LIMIT_SAME_WINDOW_MS,
  limitExpiresAt,
  type LimitPauseInput,
  type LimitRecord,
  PlanStepId,
  seedOrchestratorPlan,
  type ModelRef,
  type Thread,
  type ThreadId,
  type UserInput,
  type WorkspaceState,
  type WorkspaceId,
  type AppToolError,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { onScreen } from "../../git/activity.ts";
import type { UsageLimitReadings } from "../../usage/limit-readings.ts";
import { LIMIT_FRESH_MS, releaseBatchAt } from "../../runtime/limit-wait.ts";
import {
  activeHolds,
  atThreshold,
  heldWords,
  HELD_RETRIES_MAX,
  HELD_RETRY_MS,
  refusalPasses,
  slotWaitNote,
  holdAtPct,
  holdingLimit,
  holdOf,
  limitAgentName,
  limitName,
  agentStopped,
  limitReached,
  reachedWords,
  releaseFailedNote,
  routeChoiceWords,
  type RouteAlternative,
  type RouteOffer,
  releasedNote,
  resumeNote,
  subscriptionLimits,
  usedPct,
} from "../limit-pause.ts";
import {
  heldDueAt,
  withNotes,
  workerThreadId,
  type LimitHold,
  type StoredHeldBrief,
} from "../outbox.ts";
import {
  admittedForRole,
  budgetVerdict,
  featureSlug,
  refusal,
  workerModelLabel,
} from "../rules.ts";
import { workerModel, toolError, type OrchestrationKit, underKeysOf } from "./kit.ts";
import {
  type SpawnWorkerInput,
  type HeldSpawn,
  type SpawnedWorker,
  type OrchestrationShape,
} from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Digests } from "./digests.ts";
import type { Projects } from "./projects.ts";

const heldSpawnOf = (stored: StoredHeldBrief): HeldSpawn => ({
  held: true,
  id: stored.id,
  feature: stored.input.feature,
  title: stored.input.title,
  project: stored.projectName,
  until: stored.until,
  note: heldWords(stored),
});

/** How long a spawn waits for a fresh limit reading while no window shows; see `spawnLimits`. */
const SPAWN_LIMIT_READ = "10 seconds";
/** The log line of a route offer (`routeAtLimit`). */
const logOffer = (workspaceId: WorkspaceId, input: SpawnWorkerInput, stop: string) =>
  Effect.logInfo("a spawn stopped at a limit is offered other worker models").pipe(
    Effect.annotateLogs({ workspaceId, feature: input.feature, stop }),
  );

/** What held spawns take from the rest of the service. */
export interface HeldSpawnsDeps {
  readonly wake: Digests["wake"];
  readonly lookupProject: Projects["lookupProject"];
  readonly spawnFor: (
    callerId: ThreadId,
    input: SpawnWorkerInput,
    byUser?: { readonly id: ThreadId; readonly input: UserInput; readonly model?: ModelRef },
  ) => Effect.Effect<SpawnedWorker, AppToolError>;
  readonly survey: LedgerWatch["survey"];
  readonly spawnBreaker: Effect.Success<ReturnType<typeof makeSpawnBreaker>>;
}

/** The limit gates, and holding and releasing briefs. */
export const makeHeldSpawns = (kit: OrchestrationKit, deps: HeldSpawnsDeps) => {
  const {
    readOutbox,
    findWorkspace,
    limitAlarms,
    signals,
    heldPending,
    heldReleases,
    alarmLock,
    updateOutbox,
    orchestrationChanged,
    limitAsks,
    runtimes,
    store,
    limitPoller,
    appActivity,
    limitReadings,
    authorityOf,
    rosterHere,
    plans,
    findThread,
    heldLock,
    authorityKeys,
  } = kit;
  const { wake, lookupProject, spawnFor, survey, spawnBreaker } = deps;

  // ---------------------------------------------------------------------------------------
  // Pausing new workers near a subscription limit
  // ---------------------------------------------------------------------------------------

  /**
   * Wakes the workspace's consumer at its soonest paused window's reset, or its soonest held
   * brief's (or its retry's); nothing with neither. Held briefs already due start now, in the
   * background, unless orchestration is paused: resuming arms this again. Called from inside a
   * release run too, where a brief that fell due meanwhile gets a run of its own after it.
   * One at a time (`alarmLock`), reading the outbox inside it, and the alarm is set before a
   * release run is forked: a run that finishes at once (one refused straight away) sets its own
   * alarm after this one, never under it.
   */
  const armLimitResume = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const outbox = yield* readOutbox(workspaceId);
      const now = yield* Clock.currentTimeMillis;
      const paused = (outbox.limitHolds ?? []).filter((hold) => hold.decision === "paused");
      // Not a brief of a feature the user paused: resuming it arms this again.
      const pausedFeatures = (yield* findWorkspace(workspaceId))?.pausedFeatures ?? [];
      const held = (outbox.heldBriefs ?? []).filter(
        (brief) => !pausedFeatures.includes(brief.input.feature),
      );
      const times = [
        ...paused.map((hold) => hold.until),
        ...held.flatMap((brief) => (heldDueAt(brief) > now ? [heldDueAt(brief)] : [])),
      ];
      if (times.length === 0) yield* FiberMap.remove(limitAlarms, workspaceId);
      else {
        const at = Math.min(...times);
        yield* FiberMap.run(
          limitAlarms,
          workspaceId,
          Effect.sleep(Duration.millis(Math.max(0, at - now))).pipe(
            Effect.andThen(signals.offer({ type: "limitReset", workspaceId })),
          ),
        );
      }
      if (!held.some((brief) => heldDueAt(brief) <= now) || heldPending.has(workspaceId)) return;
      const state = yield* findWorkspace(workspaceId);
      if (state === undefined || state.paused !== undefined) return;
      heldPending.add(workspaceId);
      yield* FiberSet.run(heldReleases, releaseDue(workspaceId));
    }).pipe((effect) => alarmLock.withLock(workspaceId, effect));

  /**
   * Drops the holds whose windows have reset. One that paused new workers is owed the
   * orchestrator a word: a note and a digest, which a pause of the whole workspace holds back
   * with the rest.
   */
  const onLimitReset = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const resumed = yield* updateOutbox(workspaceId, (outbox) => {
        const holds = outbox.limitHolds ?? [];
        const kept = activeHolds(holds, now);
        if (kept.length === holds.length) return [outbox, []];
        const { limitHolds: _, ...rest } = outbox;
        const ended = holds.filter((hold) => hold.until <= now && hold.decision === "paused");
        return [
          withNotes(
            kept.length === 0 ? rest : { ...rest, limitHolds: kept },
            ended.map(resumeNote),
          ),
          ended,
        ];
      });
      yield* armLimitResume(workspaceId);
      if (resumed.length === 0) return;
      yield* Effect.logInfo("new workers resume after a limit reset").pipe(
        Effect.annotateLogs({ workspaceId, limits: resumed.map(limitName).join(", ") }),
      );
      yield* orchestrationChanged(workspaceId);
      yield* wake(workspaceId, "a usage limit reset", true);
    });

  /**
   * Fresh readings may show that a limit holding the workspace's new workers back no longer
   * applies: the CLI was signed in to another login, or the window reset early. Nothing is
   * resumed on stale or unknown data. A reading counts only when it was taken since the hold,
   * within `LIMIT_FRESH_MS`, and is of the hold's own agent and window.
   * - A held brief whose agent no longer holds briefs (`holdingLimit` finds none) falls due now,
   *   oldest first, in the batches a limit's resume takes (`releaseBatchAt`). Its release
   *   (`releaseDue`) checks again, and so does every pause.
   * - A "pause new workers until it resets" whose window reads as another window (its reset
   *   moved more than `LIMIT_SAME_WINDOW_MS`) below the threshold ends as if that window had
   *   reset (`onLimitReset`), with its note.
   * A user pause of the workspace or a feature still holds what it holds: releases stop there.
   */
  const onLimitHeadroom = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return;
      const state = yield* findWorkspace(workspaceId);
      if (state === undefined) return;
      const readings = yield* limitReadings.value.current;
      const now = yield* Clock.currentTimeMillis;
      const freshOf = (agent: string, window: string, since: number) =>
        readings.find(
          (record) =>
            record.profileId === undefined &&
            record.agent === agent &&
            record.window === window &&
            record.at > since &&
            now - record.at <= LIMIT_FRESH_MS,
        );
      const pct = holdAtPct(state.charter);
      const outbox = yield* readOutbox(workspaceId);
      const early = (outbox.heldBriefs ?? [])
        .filter(
          (brief) =>
            brief.breaker === undefined &&
            brief.releasedEarly !== true &&
            brief.until > now &&
            freshOf(brief.agent, brief.window, brief.heldAt) !== undefined &&
            holdingLimit(subscriptionLimits(readings, new Set([brief.agent]), now), pct) ===
              undefined,
        )
        .toSorted((a, b) => a.heldAt - b.heldAt);
      for (const [index, brief] of early.entries()) {
        const at = releaseBatchAt(index, now);
        yield* updateHeld(workspaceId, brief.id, (current) =>
          current.until > at ? { ...current, until: at, releasedEarly: true } : current,
        );
      }
      const lifted = activeHolds(outbox.limitHolds, now).filter((hold) => {
        if (hold.decision !== "paused") return false;
        const reading = freshOf(hold.agent, hold.window, hold.at);
        return (
          reading !== undefined &&
          Math.abs(limitExpiresAt(reading) - hold.until) > LIMIT_SAME_WINDOW_MS &&
          !atThreshold(reading, pct ?? hold.usedPct)
        );
      });
      if (lifted.length > 0) {
        yield* updateOutbox(workspaceId, (current) => [
          {
            ...current,
            limitHolds: (current.limitHolds ?? []).map((hold) =>
              lifted.some((each) => each.agent === hold.agent && each.window === hold.window)
                ? { ...hold, until: Math.min(hold.until, now) }
                : hold,
            ),
          },
          undefined,
        ]);
      }
      if (early.length === 0 && lifted.length === 0) return;
      yield* Effect.logInfo("a limit holding new workers no longer applies").pipe(
        Effect.annotateLogs({ workspaceId, briefs: early.length, pauses: lifted.length }),
      );
      // Drops the pauses with their note, re-arms the alarm, and starts what fell due.
      yield* onLimitReset(workspaceId);
      if (lifted.length === 0) yield* orchestrationChanged(workspaceId);
    });

  /**
   * Asks the user, on the orchestrator's thread, whether to pause new workers until `limit`'s
   * window resets, and keeps the answer for that window. A spawn made meanwhile waits on the same
   * ask rather than raising its own. `undefined` when no answer came from the user: the card was
   * withdrawn, so nothing is kept and the next spawn asks again.
   */
  const askLimit = (
    callerId: ThreadId,
    workspaceId: WorkspaceId,
    limit: LimitRecord,
    pauseAtPct: number,
  ) =>
    Effect.gen(function* () {
      const key = `${workspaceId}/${limit.agent}/${limit.window}`;
      const asking = limitAsks.get(key);
      if (asking !== undefined) return yield* Deferred.await(asking);
      const answered = yield* Deferred.make<LimitHold["decision"] | undefined>();
      limitAsks.set(key, answered);
      const until = limitExpiresAt(limit);
      const pct = usedPct(limit.utilization);
      const input: LimitPauseInput = {
        agent: limit.agent,
        window: limit.window,
        usedPct: pct,
        pauseAtPct,
        ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
      };
      const decision = yield* runtimes
        .requestApproval(callerId, {
          toolName: LIMIT_PAUSE_TOOL,
          displayName: "new workers",
          input,
          description: `${limitName(limit)} is at ${pct}%. Pause new workers until it resets${limit.resetsAt === undefined ? "" : ` at ${new Date(limit.resetsAt).toISOString().slice(11, 16)} UTC`}? Running ones finish.`,
          suggestions: [],
          scopes: ["once"],
        })
        .pipe(
          Effect.map((answer): LimitHold["decision"] | undefined =>
            answer.decision === "allow"
              ? "keepGoing"
              : answer.resolution?.origin === "user"
                ? "paused"
                : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
          Effect.onExit((exit) =>
            Effect.sync(() => limitAsks.delete(key)).pipe(
              Effect.andThen(
                Deferred.succeed(answered, exit._tag === "Success" ? exit.value : undefined),
              ),
            ),
          ),
        );
      if (decision === undefined) return undefined;
      const at = yield* Clock.currentTimeMillis;
      const hold: LimitHold = {
        agent: limit.agent,
        window: limit.window,
        decision,
        until,
        usedPct: pct,
        at,
      };
      yield* updateOutbox(workspaceId, (outbox) => [
        {
          ...outbox,
          limitHolds: [
            ...activeHolds(outbox.limitHolds, at).filter(
              (each) => each.agent !== hold.agent || each.window !== hold.window,
            ),
            hold,
          ],
        },
        undefined,
      ]);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "limitHold",
        data: { agent: hold.agent, window: hold.window, decision, until, usedPct: pct },
      });
      if (decision === "paused") yield* armLimitResume(workspaceId);
      yield* orchestrationChanged(workspaceId);
      return decision;
    });

  /**
   * The readings a spawn decides on. While no window shows the limit poll rests, and a session
   * reports only its own agent's limits, so a spawn reads them afresh first (at most one read per
   * `LIMIT_REFRESH_QUIET_MS`, however many spawns ask). A read that hangs holds a spawn for at most
   * `SPAWN_LIMIT_READ`, after which the last readings stand.
   */
  const spawnLimits = (readings: UsageLimitReadings["Service"]) =>
    Effect.gen(function* () {
      if (
        Option.isSome(limitPoller) &&
        Option.isSome(appActivity) &&
        !onScreen(yield* appActivity.value.level)
      ) {
        yield* limitPoller.value.refresh.pipe(Effect.timeout(SPAWN_LIMIT_READ), Effect.ignore);
      }
      return yield* readings.current;
    });

  /**
   * `spawn_worker`'s limit check, before the spawn itself: when a subscription limit the new
   * worker would run against stands at the workspace's threshold (`pauseAtLimitPct`), the user is
   * asked once per window, and while they have paused new workers the spawn is refused. Running
   * workers are never touched. A gateway model, a retried call that made its worker already, and a
   * workspace without a threshold pass; so does anything the spawn itself refuses, which it says.
   */
  const limitGate = (callerId: ThreadId, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      const tool = "spawn_worker";
      if (Option.isNone(limitReadings)) return;
      const authority = yield* authorityOf(callerId);
      if (authority === undefined) return;
      const { thread: caller, state } = authority;
      const pauseAtPct = state.charter.pauseAtLimitPct;
      if (pauseAtPct === undefined || state.paused !== undefined) return;
      const workspaceId = state.workspace.id;
      if (
        input.clientRequestId !== undefined &&
        (yield* readOutbox(workspaceId)).requests[input.clientRequestId] !== undefined
      ) {
        return;
      }
      const picked = yield* workerModel(
        tool,
        caller,
        state.charter,
        input.model,
        state.charter.workerModels === undefined
          ? undefined
          : yield* rosterHere(state.charter.workerModels, state.charter),
      ).pipe(Effect.option);
      if (Option.isNone(picked) || picked.value.model.profileId !== undefined) return;
      const agent = picked.value.model.agent;
      const now = yield* Clock.currentTimeMillis;
      const reached = subscriptionLimits(
        yield* spawnLimits(limitReadings.value),
        new Set([agent]),
        now,
      ).filter((limit) => atThreshold(limit, pauseAtPct));
      for (const limit of reached) {
        const decision =
          holdOf((yield* readOutbox(workspaceId)).limitHolds, limit, now)?.decision ??
          (yield* askLimit(callerId, workspaceId, limit, pauseAtPct));
        if (decision === "keepGoing") continue;
        const until =
          limit.resetsAt === undefined
            ? "the next reading shows it below the threshold"
            : `${new Date(limit.resetsAt).toISOString().slice(0, 16)}Z`;
        return yield* toolError(
          tool,
          decision === "paused"
            ? refusal(
                "limit_paused",
                `${limitName(limit)} is at ${usedPct(limit.utilization)}%, and the user paused new ${limitAgentName(agent)} workers until it resets (${until}). Running workers carry on. Don't retry; a digest follows the reset.`,
              )
            : refusal(
                "limit_unanswered",
                `${limitName(limit)} is at ${usedPct(limit.utilization)}%, and the user wasn't able to answer whether to pause new workers, so none is spawned. End your turn.`,
              ),
        );
      }
    });

  // ---------------------------------------------------------------------------------------
  // Holding low-priority briefs until a limit resets
  // ---------------------------------------------------------------------------------------

  /**
   * The subscription limit a brief would wait on, with the project's name: one of the agent its
   * worker would run on at the workspace's hold share (`holdAtPct`) or rejected. None for a
   * gateway model, a repo Gram doesn't know yet, or anything the spawn itself would refuse.
   */
  const heldLimit = (caller: Thread, state: WorkspaceState, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return undefined;
      const tool = "spawn_worker";
      const found = yield* lookupProject(tool, input.project, state).pipe(Effect.option);
      if (Option.isNone(found) || !("known" in found.value)) return undefined;
      const picked = yield* workerModel(
        tool,
        caller,
        state.charter,
        input.model,
        state.charter.workerModels === undefined
          ? undefined
          : yield* rosterHere(state.charter.workerModels, state.charter),
      ).pipe(Effect.option);
      if (Option.isNone(picked) || picked.value.model.profileId !== undefined) return undefined;
      const now = yield* Clock.currentTimeMillis;
      const limit = holdingLimit(
        subscriptionLimits(
          yield* spawnLimits(limitReadings.value),
          new Set([picked.value.model.agent]),
          now,
        ),
        holdAtPct(state.charter),
      );
      return limit === undefined ? undefined : { limit, project: found.value.known };
    });

  /**
   * `spawn_worker`'s hold, before the limit check and the spawn: a `low` priority brief whose
   * worker would run against a subscription limit at the workspace's hold share is kept in the
   * outbox instead of spawned, and starts on its own at the reset (`releaseDue`). A retried call
   * with the same `clientRequestId` finds the brief it held (one without it holds a second copy,
   * as a retried spawn without it makes a second worker); one whose worker exists already
   * passes, as do normal briefs. A feature that won't slug isn't held: the spawn refuses it.
   */
  const holdGate = (callerId: ThreadId, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      if (input.priority !== "low") return undefined;
      // A name that makes no feature is the spawn's to refuse, which says why.
      if (featureSlug(input.feature) === undefined) return undefined;
      const authority = yield* authorityOf(callerId);
      if (authority === undefined || authority.state.paused !== undefined) return undefined;
      // A paused feature's brief is the spawn's to refuse, not to hold.
      if (authority.state.pausedFeatures?.includes(featureSlug(input.feature)!) === true) {
        return undefined;
      }
      const { thread: caller, state } = authority;
      const workspaceId = state.workspace.id;
      const outbox = yield* readOutbox(workspaceId);
      if (input.clientRequestId !== undefined) {
        if (outbox.requests[input.clientRequestId] !== undefined) return undefined;
        const again = (outbox.heldBriefs ?? []).find(
          (brief) => brief.input.clientRequestId === input.clientRequestId,
        );
        if (again !== undefined) return heldSpawnOf(again);
      }
      const found = yield* heldLimit(caller, state, input);
      if (found === undefined) return undefined;
      const { limit, project } = found;
      const now = yield* Clock.currentTimeMillis;
      const { priority: _priority, atLimit: _atLimit, ...rest } = input;
      const stored: StoredHeldBrief = {
        id: `held-${randomUUID().slice(0, 8)}`,
        callerId: caller.id,
        input: Object.fromEntries(
          Object.entries(rest).filter(([, value]) => value !== undefined),
        ) as StoredHeldBrief["input"],
        projectName: project.name,
        agent: limit.agent,
        window: limit.window,
        usedPct: usedPct(limit.utilization),
        until: limitExpiresAt(limit),
        heldAt: now,
      };
      // A parallel retry may have held it meanwhile; the first one stands.
      const raced = yield* updateOutbox(workspaceId, (current) => {
        const first =
          input.clientRequestId === undefined
            ? undefined
            : (current.heldBriefs ?? []).find(
                (brief) => brief.input.clientRequestId === input.clientRequestId,
              );
        return first !== undefined
          ? [current, first]
          : [{ ...current, heldBriefs: [...(current.heldBriefs ?? []), stored] }, undefined];
      });
      if (raced !== undefined) return heldSpawnOf(raced);
      yield* Effect.logInfo("a low-priority brief is held until a limit resets").pipe(
        Effect.annotateLogs({ workspaceId, feature: input.feature, limit: limitName(limit) }),
      );
      yield* orchestrationChanged(workspaceId);
      yield* armLimitResume(workspaceId);
      return heldSpawnOf(stored);
    });

  // ---------------------------------------------------------------------------------------
  // Offering another worker model at a limit
  // ---------------------------------------------------------------------------------------

  /**
   * What a route offer needs, when one may be made for this spawn: the workspace's `routeAtLimit`
   * is on and it has a roster, the call didn't say `atLimit: "stay"`, isn't a retry of a call
   * that made or held its brief, and its model runs on a subscription login. `alternatives` are
   * the roster's other models clear of every limit that stops a spawn now (`agentStopped`): a
   * gateway model always is. No share of a meter is read; only what the CLI says is reached and
   * the user's pauses.
   */
  const routeContext = (callerId: ThreadId, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      if (input.atLimit === "stay" || Option.isNone(limitReadings)) return undefined;
      const authority = yield* authorityOf(callerId);
      if (authority === undefined || authority.state.paused !== undefined) return undefined;
      const { thread: caller, state } = authority;
      const { charter } = state;
      if (charter.routeAtLimit !== true || charter.workerModels === undefined) return undefined;
      const outbox = yield* readOutbox(state.workspace.id);
      if (
        input.clientRequestId !== undefined &&
        outbox.requests[input.clientRequestId] !== undefined
      ) {
        return undefined;
      }
      const here = yield* rosterHere(charter.workerModels, charter);
      const picked = yield* workerModel("spawn_worker", caller, charter, input.model, here).pipe(
        Effect.option,
      );
      if (Option.isNone(picked) || picked.value.model.profileId !== undefined) return undefined;
      const chosen = picked.value.model;
      const now = yield* Clock.currentTimeMillis;
      const readings = yield* spawnLimits(limitReadings.value);
      const limitsOf = (agent: string) => subscriptionLimits(readings, new Set([agent]), now);
      const alternatives = here.roster.flatMap((entry, index): Array<RouteAlternative> => {
        if (here.unavailable.has(index)) return [];
        if (!admittedForRole(entry.agent, "worker")) return [];
        if (
          entry.agent === chosen.agent &&
          entry.model === chosen.model &&
          entry.profileId === chosen.profileId
        ) {
          return [];
        }
        const gateway = entry.profileId !== undefined;
        // Limits are an account's: another model on the same login shares the one that stopped it.
        if (!gateway && entry.agent === chosen.agent) return [];
        if (!gateway && agentStopped(limitsOf(entry.agent), outbox.limitHolds, entry.agent, now)) {
          return [];
        }
        return [
          {
            model: workerModelLabel(entry),
            ...(entry.useFor === undefined || entry.useFor.trim() === ""
              ? {}
              : { useFor: entry.useFor.trim() }),
            ...(gateway ? { gateway: true as const } : {}),
          },
        ];
      });
      if (alternatives.length === 0) return undefined;
      return {
        workspaceId: state.workspace.id,
        model: workerModelLabel(chosen),
        reached: limitReached(limitsOf(chosen.agent)),
        alternatives,
      };
    });

  /**
   * `spawn_worker`'s route offer before the hold and the pause gates: a spawn whose account its
   * CLI says is at its limit would only wait in its worker's queue, so nothing is spawned and the
   * orchestrator is offered the models clear of it. Nothing is swapped for it.
   */
  const routeGate = (callerId: ThreadId, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      if (featureSlug(input.feature) === undefined) return undefined;
      const route = yield* routeContext(callerId, input);
      if (route?.reached === undefined) return undefined;
      yield* logOffer(route.workspaceId, input, "queued");
      const offer: RouteOffer = {
        routeOffer: true,
        feature: input.feature,
        title: input.title,
        model: route.model,
        wouldBe: "queued",
        alternatives: route.alternatives,
        note: `Not spawned. ${reachedWords(route.reached, route.model)} ${routeChoiceWords({ stop: "queued", model: route.model })}`,
      };
      return offer;
    });

  /** A brief the hold gate held, with the models it could be retargeted to when routing is on. */
  const routeHeld = (callerId: ThreadId, input: SpawnWorkerInput, held: HeldSpawn) =>
    Effect.gen(function* () {
      // The held brief's id is the retry's answer now, so a retry finds it already held.
      const route = yield* routeContext(callerId, { ...input, clientRequestId: undefined });
      if (route === undefined) return held;
      yield* logOffer(route.workspaceId, input, "held");
      return {
        ...held,
        alternatives: route.alternatives,
        note: `${held.note} ${routeChoiceWords({ stop: "held", model: route.model, heldId: held.id })}`,
      };
    });

  /**
   * The pause gate's refusal, as a route offer when routing is on and another model is clear:
   * still nothing is spawned, and the orchestrator chooses. Any other refusal stands.
   */
  const routePaused = (callerId: ThreadId, input: SpawnWorkerInput, refused: AppToolError) =>
    Effect.gen(function* () {
      const why = /^limit_(?:paused|unanswered): (.*)$/s.exec(refused.message)?.[1];
      if (why === undefined) return yield* refused;
      const route = yield* routeContext(callerId, input);
      if (route === undefined) return yield* refused;
      yield* logOffer(route.workspaceId, input, "paused");
      const offer: RouteOffer = {
        routeOffer: true,
        feature: input.feature,
        title: input.title,
        model: route.model,
        wouldBe: "paused",
        alternatives: route.alternatives,
        note: `Not spawned: ${why.replace(/ (?:Don't retry|End your turn)[^]*$/, "")} ${routeChoiceWords({ stop: "paused", model: route.model })}`,
      };
      return offer;
    });

  /** Takes the held brief `id` out of the outbox, so only one release ever spawns it. */
  const claimHeld = (workspaceId: WorkspaceId, id: string) =>
    updateOutbox(workspaceId, (outbox) => {
      const held = outbox.heldBriefs ?? [];
      const claimed = held.find((brief) => brief.id === id);
      if (claimed === undefined) return [outbox, undefined];
      const kept = held.filter((brief) => brief.id !== id);
      const { heldBriefs: _, ...rest } = outbox;
      return [kept.length === 0 ? rest : { ...rest, heldBriefs: kept }, claimed];
    });

  /** Spawns a claimed held brief for the workspace's orchestrator, seeding its plan if it had one. */
  const spawnHeld = (workspaceId: WorkspaceId, stored: StoredHeldBrief) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const callerId = state.workspace.orchestratorThreadId ?? stored.callerId;
      const spawned = yield* spawnFor(callerId, stored.input);
      const plan = stored.input.plan;
      if (plan !== undefined && Option.isSome(plans)) {
        const now = yield* Clock.currentTimeMillis;
        yield* plans.value
          .update(spawned.threadId, (current) =>
            seedOrchestratorPlan(current, plan, {
              now,
              newId: () => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8)),
            }),
          )
          .pipe(Effect.ignore);
      }
      return spawned;
    });

  /** Rewrites the held brief `id` in place; nothing when it was released meanwhile. */
  const updateHeld = (
    workspaceId: WorkspaceId,
    id: string,
    change: (brief: StoredHeldBrief) => StoredHeldBrief,
  ) =>
    updateOutbox(workspaceId, (outbox) => [
      {
        ...outbox,
        heldBriefs: (outbox.heldBriefs ?? []).map((brief) =>
          brief.id === id ? change(brief) : brief,
        ),
      },
      undefined,
    ]);

  /** Puts a claimed brief back, as `change` makes it, when its spawn didn't happen. */
  const putBackHeld = (workspaceId: WorkspaceId, brief: StoredHeldBrief) =>
    updateOutbox(workspaceId, (outbox) => [
      { ...outbox, heldBriefs: [...(outbox.heldBriefs ?? []), brief] },
      undefined,
    ]);

  /** Live workers against the charter's cap, as `spawn_worker`'s approval check counts them. */
  const slotFree = (state: WorkspaceState) =>
    survey(state, false).pipe(
      Effect.map(({ budget }) => ({
        ok: budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok,
        live: budget.liveWorkers,
        cap: budget.maxConcurrentWorkers,
      })),
    );

  /**
   * Spawns, one at a time, the held briefs that are due: their limit has reset, or their retry
   * came. Each is checked as `spawn_worker` would be:
   * - its worker would now run against another limit at the hold share (the weekly one, say): held
   *   again until that one resets;
   * - every worker slot is taken (`maxConcurrentWorkers`): kept, and tried again every
   *   `HELD_RETRY_MS` until a worker finishes; the orchestrator is told once;
   * - the spawn refuses it for now (`refusalPasses`: rate limited, paused, a failing git): put back
   *   and tried again, dropped with a note after `HELD_RETRIES_MAX`;
   * - the spawn refuses it for good: dropped with a note.
   * The board hears of every change; the orchestrator is woken when there is a note to read.
   * Stops, leaving the rest held, while orchestration is paused. One run at a time (`heldLock`).
   */
  const releaseDue = (workspaceId: WorkspaceId): Effect.Effect<void> =>
    Effect.gen(function* () {
      heldPending.delete(workspaceId);
      const notes: Array<string> = [];
      let changed = false;
      const tried = new Set<string>();
      while (true) {
        const state = yield* findWorkspace(workspaceId);
        if (state === undefined || state.paused !== undefined) break;
        const now = yield* Clock.currentTimeMillis;
        // A brief of a feature the user paused stays held until they resume it.
        const due = ((yield* readOutbox(workspaceId)).heldBriefs ?? []).find(
          (brief) =>
            heldDueAt(brief) <= now &&
            !tried.has(brief.id) &&
            state.pausedFeatures?.includes(brief.input.feature) !== true,
        );
        if (due === undefined) break;
        tried.add(due.id);
        const caller =
          state.workspace.orchestratorThreadId === undefined
            ? undefined
            : yield* findThread(state.workspace.orchestratorThreadId);
        const still = caller === undefined ? undefined : yield* heldLimit(caller, state, due.input);
        if (still !== undefined && limitExpiresAt(still.limit) > now) {
          const { limit } = still;
          yield* updateHeld(workspaceId, due.id, (brief) => {
            const { retryAt: _r, waitsForSlot: _w, releasedEarly: _e, ...rest } = brief;
            return {
              ...rest,
              agent: limit.agent,
              window: limit.window,
              usedPct: usedPct(limit.utilization),
              until: limitExpiresAt(limit),
            };
          });
          changed = true;
          continue;
        }
        const slot = yield* slotFree(state);
        if (!slot.ok) {
          if (due.waitsForSlot !== true) notes.push(slotWaitNote(due, slot.live, slot.cap));
          yield* updateHeld(workspaceId, due.id, (brief) => ({
            ...brief,
            waitsForSlot: true,
            retryAt: now + HELD_RETRY_MS,
          }));
          changed = true;
          continue;
        }
        if (yield* spawnBreaker.defer(workspaceId, due)) {
          changed = true;
          continue;
        }
        const claimed = yield* claimHeld(workspaceId, due.id);
        if (claimed === undefined) continue;
        changed = true;
        const spawned = yield* spawnHeld(workspaceId, claimed).pipe(
          Effect.map((worker) => ({ worker })),
          Effect.catch((error) => Effect.succeed({ error: error.message })),
        );
        if ("worker" in spawned) {
          notes.push(releasedNote(claimed, spawned.worker.threadId, false));
          continue;
        }
        yield* spawnBreaker.abandoned(claimed);
        // Its feature was paused meanwhile: held as it was, without counting a try, until the
        // resume arms it again.
        if (spawned.error.startsWith("feature_paused: ")) {
          yield* putBackHeld(workspaceId, claimed);
          continue;
        }
        const attempts = (claimed.attempts ?? 0) + 1;
        if (refusalPasses(spawned.error) && attempts < HELD_RETRIES_MAX) {
          const { waitsForSlot: _w, ...rest } = claimed;
          yield* putBackHeld(workspaceId, { ...rest, attempts, retryAt: now + HELD_RETRY_MS });
          continue;
        }
        notes.push(releaseFailedNote(claimed, spawned.error.replace(/^[a-z_]+: /, "")));
      }
      yield* armLimitResume(workspaceId);
      if (changed) yield* orchestrationChanged(workspaceId);
      if (notes.length === 0) return;
      yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, notes), undefined]);
      yield* wake(workspaceId, "held briefs were released at a usage limit reset", true);
    }).pipe(
      (effect) => heldLock.withLock(workspaceId, effect),
      Effect.catchCause((cause) =>
        Effect.logWarning("releasing held briefs failed").pipe(
          Effect.annotateLogs({ workspaceId, cause: Cause.pretty(cause) }),
        ),
      ),
    );

  const manageHeldSpawn: OrchestrationShape["manageHeldSpawn"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "manage_held_spawn";
      const authority = yield* authorityOf(callerId);
      if (authority === undefined)
        return yield* toolError(
          tool,
          "Only the current owning orchestrator can manage held spawns.",
        );
      const { thread: caller, state } = authority;
      if (state.paused !== undefined)
        return yield* toolError(tool, "Orchestration is paused; held spawns remain unchanged.");
      const workspaceId = state.workspace.id;
      const held = (yield* readOutbox(workspaceId)).heldBriefs?.find(
        (brief) => brief.id === input.id,
      );
      if (held === undefined) {
        return yield* toolError(
          tool,
          "No held spawn with that id belongs to you; it may have started already.",
        );
      }
      if (input.action === "cancel") {
        if (input.model !== undefined)
          return yield* toolError(tool, "model is only used with action retarget.");
        yield* claimHeld(workspaceId, input.id);
        yield* armLimitResume(workspaceId);
        yield* orchestrationChanged(workspaceId);
        return { id: input.id, cancelled: true, held: false };
      }
      if (input.model === undefined)
        return yield* toolError(tool, "model is required for action retarget.");
      // The same configured/admitted roster as spawn_worker; no arbitrary provider/profile switch.
      const picked = yield* workerModel(
        tool,
        caller,
        state.charter,
        input.model,
        state.charter.workerModels === undefined
          ? undefined
          : yield* rosterHere(state.charter.workerModels, state.charter),
      );
      const model = workerModelLabel(picked.model);
      const now = yield* Clock.currentTimeMillis;
      const nextInput = { ...held.input, model };
      const limit = yield* heldLimit(caller, state, nextInput);
      yield* updateHeld(workspaceId, input.id, (brief) => {
        const { retryAt: _r, waitsForSlot: _w, breaker: _b, releasedEarly: _e, ...rest } = brief;
        return {
          ...rest,
          input: nextInput,
          agent: picked.model.agent,
          until: limit === undefined ? now : limitExpiresAt(limit.limit),
          ...(limit === undefined
            ? { usedPct: 0 }
            : {
                window: limit.limit.window,
                usedPct: usedPct(limit.limit.utilization),
              }),
        };
      });
      // Ordinary release rechecks model admission, limits, worker slots and feature/workspace
      // pauses. It also preserves clientRequestId, the plan, and puts refused spawns back.
      yield* armLimitResume(workspaceId);
      yield* orchestrationChanged(workspaceId);
      return {
        id: input.id,
        retargeted: true,
        model,
        held: true,
        note: "Retargeted; starts when limits, slots and pauses allow.",
      };
    }).pipe((effect) => underKeysOf(heldLock, authorityKeys(callerId), effect));

  const releaseHeldBrief: OrchestrationShape["releaseHeldBrief"] = (workspaceId, id) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const held = (yield* readOutbox(workspaceId)).heldBriefs?.find((brief) => brief.id === id);
      if (held === undefined) {
        return yield* new InvalidState({
          message: "That brief isn't held any more: it may have started already.",
        });
      }
      if (state.pausedFeatures?.includes(held.input.feature) === true) {
        return yield* new InvalidState({
          message: `You paused ${held.input.feature}, so “${held.input.title}” waits. Resume the feature to start it.`,
        });
      }
      // The user's click is no "Allow one more": past the cap it waits for a slot, as at the reset.
      const slot = yield* slotFree(state);
      if (!slot.ok) {
        return yield* new InvalidState({
          message: `${slot.live} workers are live and the workspace allows ${slot.cap} at once, so “${held.input.title}” can't start yet. It starts on its own once its limit has reset and a worker finishes.`,
        });
      }
      const claimed = yield* claimHeld(workspaceId, id);
      if (claimed === undefined) {
        return yield* new InvalidState({
          message: "That brief isn't held any more: it may have started already.",
        });
      }
      const spawned = yield* spawnHeld(workspaceId, claimed).pipe(
        Effect.catch((error) =>
          // Put back as it was, so a refusal loses nothing: it still starts at the reset, and
          // one whose reset has passed is looked at again now.
          putBackHeld(workspaceId, claimed).pipe(
            Effect.andThen(armLimitResume(workspaceId)),
            Effect.andThen(orchestrationChanged(workspaceId)),
            Effect.andThen(
              Effect.fail(new InvalidState({ message: error.message.replace(/^[a-z_]+: /, "") })),
            ),
          ),
        ),
      );
      yield* updateOutbox(workspaceId, (outbox) => [
        withNotes(outbox, [releasedNote(claimed, spawned.threadId, true)]),
        undefined,
      ]);
      yield* armLimitResume(workspaceId);
      yield* orchestrationChanged(workspaceId);
      return yield* store
        .getThread(spawned.threadId)
        .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
      // One release at a time with the release runs, so a rename never falls between a brief's
      // claim and its spawn.
    }).pipe((effect) => heldLock.withLock(workspaceId, effect));

  /**
   * `spawn_worker`'s refusal for a feature the user paused, before the hold and the limit check:
   * a paused feature's brief is neither held nor asked about, only refused. A retry whose
   * `clientRequestId` already made its worker passes, after the same lookup `spawnFor` makes, so
   * it gets that worker back rather than the refusal.
   */
  const pausedSpawnGate = (callerId: ThreadId, input: SpawnWorkerInput) =>
    Effect.gen(function* () {
      const slug = featureSlug(input.feature);
      const authority = yield* authorityOf(callerId);
      if (slug === undefined || authority?.state.pausedFeatures?.includes(slug) !== true) return;
      if (input.clientRequestId !== undefined) {
        const workspaceId = authority.state.workspace.id;
        const requestedId =
          (yield* readOutbox(workspaceId)).requests[input.clientRequestId] ??
          workerThreadId(workspaceId, input.clientRequestId);
        if ((yield* findThread(requestedId)) !== undefined) return;
      }
      return yield* toolError(
        "spawn_worker",
        refusal(
          "feature_paused",
          `The user paused feature ${slug}, so no worker is spawned for it. Only the user can resume it; a digest says when they do.`,
        ),
      );
    });

  return {
    armLimitResume,
    onLimitReset,
    onLimitHeadroom,
    limitGate,
    holdGate,
    routeGate,
    routeHeld,
    routePaused,
    updateHeld,
    manageHeldSpawn,
    releaseHeldBrief,
    pausedSpawnGate,
  };
};

/** What `makeHeldSpawns` makes, for the parts whose `deps` take some of it. */
export type HeldSpawns = ReturnType<typeof makeHeldSpawns>;
