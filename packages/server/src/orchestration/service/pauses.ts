import { personKey } from "../../embedding/person.ts";
import { readableByOfWorkspace } from "../../embedding/readable-by.ts";
import {
  InvalidState,
  type OrchestrationPause,
  type PauseReason,
  type Thread,
  type ThreadId,
  type WorkspaceState,
  type WorkspaceId,
  inlineText,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import {
  accountOf,
  clockText,
  limitClearedBy,
  pauseResumePlan,
  spanText,
} from "../../runtime/limit-wait.ts";
import { type WorkerFacts } from "../ledger.ts";
import { dueAtPause } from "../worker-questions.ts";
import { readOutbox as readStoredOutbox, type PauseResume } from "../outbox.ts";
import { type PendingReason } from "../rules.ts";
import {
  OUTBOX_UNREADABLE_DETAIL,
  workersOf,
  IN_ERROR_DETAIL,
  inErrorPause,
  CHARTER_MOVED,
  heldByUser,
  type OrchestrationKit,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { Features } from "./features.ts";
import type { HandoffPart } from "./handoff.ts";

/**
 * How long a `deliveryFailed` pause waits before each look at whether its orchestrator's agent can
 * be reached again, and the pause lifted; the last repeats for as long as it can't.
 */
export const RECOVERY_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.minutes(1),
  Duration.minutes(2),
  Duration.minutes(5),
  Duration.minutes(10),
  Duration.minutes(30),
];
/** The `sendNotice` key of what a worker the user's pause stopped is told as it resumes. */
export const PAUSE_RESUME_KEY = "pause-resume";
const pauseResumeText = (entry: PauseResume) =>
  `The user paused this workspace at ${clockText(entry.pausedAt)} and resumed it at ${clockText(entry.resumedAt)}. You were asked to stop while it was paused, and nothing was cut off. Continue where you left off.`;

/** What pauses take from the rest of the service. */
export interface PausesDeps {
  readonly cancelDelivery: (
    workspaceId: WorkspaceId,
    orchestratorId: ThreadId | undefined,
  ) => Effect.Effect<void>;
  readonly wake: (
    workspaceId: WorkspaceId,
    reason: string,
    withoutDiff?: boolean,
    about?: Omit<PendingReason, "reason">,
  ) => Effect.Effect<void>;
  readonly armAlarms: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly noteForNextDigest: Features["noteForNextDigest"];
  readonly armLimitResume: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly abandonHandoff: HandoffPart["abandonHandoff"];
}

/** Pausing, recovery and resuming a workspace. */
export const makePauses = (kit: OrchestrationKit, deps: PausesDeps) => {
  const {
    store,
    findWorkspace,
    outboxLock,
    setAside,
    unreadableSignalled,
    pauseFence,
    workspacesChanged,
    orchestrationChanged,
    recovering,
    hub,
    recoveryTimers,
    signals,
    selfResumed,
    findThread,
    runtimes,
    updateOutbox,
    pauseResumeTimers,
    readOutbox,
    orchestratorState,
    listeningWorkspace,
    releaseSetAside,
    limitReadings,
  } = kit;
  const { cancelDelivery, wake, armAlarms, noteForNextDigest, armLimitResume, abandonHandoff } =
    deps;

  const quarantineOutbox = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const before = readStoredOutbox(yield* store.getOutbox(workspaceId));
      const kept = before._tag === "read" && before.setAside !== undefined;
      if (before._tag !== "unreadable" && !kept) return;
      const state = yield* findWorkspace(workspaceId);
      if (state?.paused?.detail !== OUTBOX_UNREADABLE_DETAIL) {
        yield* pause(workspaceId, "deliveryFailed", OUTBOX_UNREADABLE_DETAIL, "any");
      }
      yield* outboxLock.withLock(
        workspaceId,
        Effect.gen(function* () {
          yield* setAside(workspaceId, yield* store.getOutbox(workspaceId));
        }),
      );
      unreadableSignalled.delete(workspaceId);
    });

  const PAUSE_TITLES: Record<PauseReason, string> = {
    user: "Orchestration paused",
    parked: "Orchestration paused: the orchestrator is parked",
    deliveryFailed: "Orchestration paused: the orchestrator couldn't be reached",
  };

  const pause = (
    workspaceId: WorkspaceId,
    reason: PauseReason,
    detail?: string,
    replaces?: PauseReason | "any",
  ) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      let taken = false;
      const state = yield* pauseFence.withLock(
        workspaceId,
        store
          .updateWorkspace(workspaceId, (current) => {
            if (
              current.paused !== undefined &&
              replaces !== "any" &&
              current.paused.reason !== replaces
            ) {
              return current;
            }
            taken = true;
            return {
              ...current,
              paused: { reason, ...(detail === undefined ? {} : { detail }), at },
            };
          })
          .pipe(Effect.orElseSucceed(() => undefined)),
      );
      if (state === undefined || !taken) return;
      yield* afterPause(workspaceId, state, reason, detail, at);
    });

  const forwardQuestionsInTriageToTheUser = (workspaceId: WorkspaceId, at: number) =>
    Effect.gen(function* () {
      const due = yield* updateOutbox(workspaceId, (outbox) => dueAtPause(outbox, at));
      for (const questionId of due)
        yield* signals.offer({ type: "questionDue", workspaceId, questionId });
    }).pipe(Effect.ignore);

  const afterPause = (
    workspaceId: WorkspaceId,
    state: WorkspaceState,
    reason: PauseReason,
    detail: string | undefined,
    at: number,
  ) =>
    Effect.gen(function* () {
      const holder = state.workspace.orchestratorThreadId;
      yield* cancelDelivery(workspaceId, holder);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "pause",
        data: { reason, ...(detail === undefined ? {} : { detail }) },
      });
      yield* Effect.logInfo("orchestration paused").pipe(
        Effect.annotateLogs({ workspaceId, reason }),
      );
      if (reason === "user") yield* haltWorkspace(workspaceId);
      yield* forwardQuestionsInTriageToTheUser(workspaceId, at);
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      if (reason === "user" || reason === "parked") return;
      const recoverable = reason === "deliveryFailed" && detail === IN_ERROR_DETAIL;
      const told = recoverable && recovering.has(workspaceId);
      if (recoverable) yield* armRecovery(workspaceId);
      else if (recovering.has(workspaceId)) yield* endRecovery(workspaceId);
      if (told) return;
      const title =
        detail === OUTBOX_UNREADABLE_DETAIL
          ? "Orchestration paused: its delivery state can't be read"
          : PAUSE_TITLES[reason];
      const notice = {
        type: "notify" as const,
        kind: "needsInput" as const,
        title: `${title} (${state.workspace.name})`,
        ...(detail === undefined ? {} : { body: detail }),
        ...(holder === undefined ? {} : { threadId: holder }),
      };
      const reader = readableByOfWorkspace(workspaceId, holder);
      yield* reader === undefined ? hub.publish(notice) : hub.publishTo(personKey(reader), notice);
    });

  const armRecovery = (workspaceId: WorkspaceId) =>
    Effect.suspend(() => {
      const looks = recovering.get(workspaceId) ?? 0;
      recovering.set(workspaceId, looks);
      return FiberMap.run(
        recoveryTimers,
        workspaceId,
        Effect.sleep(RECOVERY_DELAYS[looks] ?? RECOVERY_DELAYS.at(-1)!).pipe(
          Effect.andThen(signals.offer({ type: "recoveryDue", workspaceId })),
        ),
      );
    }).pipe(Effect.asVoid);

  const endRecovery = (workspaceId: WorkspaceId) =>
    Effect.suspend(() => {
      recovering.delete(workspaceId);
      selfResumed.delete(workspaceId);
      return FiberMap.remove(recoveryTimers, workspaceId);
    });

  const onRecoveryDue = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const state = yield* findWorkspace(workspaceId);
      if (state?.paused === undefined || !inErrorPause(state.paused))
        return yield* endRecovery(workspaceId);
      const holder = state.workspace.orchestratorThreadId;
      const thread = holder === undefined ? undefined : yield* findThread(holder);
      if (thread === undefined) return yield* endRecovery(workspaceId);
      if (thread.parked) return yield* armRecovery(workspaceId);
      const status = yield* runtimes
        .status(thread.id)
        .pipe(Effect.orElseSucceed((): WorkerFacts["status"] => "cold"));
      if (status === "ended") return yield* endRecovery(workspaceId);
      recovering.set(workspaceId, (recovering.get(workspaceId) ?? 0) + 1);
      let lifted = false;
      yield* store
        .updateWorkspace(workspaceId, (current) => {
          if (current.paused?.reason !== "deliveryFailed") return current;
          lifted = true;
          const { paused: _, ...rest } = current;
          return rest;
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!lifted) return yield* endRecovery(workspaceId);
      selfResumed.add(workspaceId);
      yield* updateOutbox(workspaceId, (outbox) => [{ ...outbox, failures: 0 }, undefined]);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "resume",
        data: { by: "recovery" },
      });
      yield* Effect.logInfo("orchestration resuming by itself").pipe(
        Effect.annotateLogs({ workspaceId, looks: recovering.get(workspaceId) ?? 0 }),
      );
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      yield* wake(workspaceId, "the orchestrator could be reached again", true);
      yield* armAlarms(workspaceId);
    });

  const recoverAtHeadroom = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return;
      const state = yield* findWorkspace(workspaceId);
      if (state?.paused === undefined || !inErrorPause(state.paused)) return;
      const holder = state.workspace.orchestratorThreadId;
      const thread = holder === undefined ? undefined : yield* findThread(holder);
      const error = thread?.lastError;
      if (thread === undefined || error?.kind !== "rateLimit") return;
      if (thread.parked || thread.limitWait?.cancelled === true) return;
      const now = yield* Clock.currentTimeMillis;
      const readings = (yield* limitReadings.value.current).map((record) => ({
        ...record,
        accountScope: undefined,
      }));
      if (!limitClearedBy(readings, accountOf(thread.model), error.at, now)) return;
      yield* Effect.logInfo("the limit that stopped the orchestrator no longer applies").pipe(
        Effect.annotateLogs({ workspaceId }),
      );
      yield* onRecoveryDue(workspaceId);
    });

  const haltWorkspace = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(pauseResumeTimers, workspaceId);
      const stillResuming = yield* updateOutbox(workspaceId, (outbox) => {
        if (outbox.resuming === undefined) return [outbox, []];
        const { resuming, ...rest } = outbox;
        return [rest, resuming.filter((each) => each.stopped).map((each) => each.threadId)];
      });
      const state = yield* findWorkspace(workspaceId);
      if (state === undefined) return;
      const threads = yield* store.listThreads;
      const { workers: memos } = yield* readOutbox(workspaceId);
      const now = yield* Clock.currentTimeMillis;
      const holder = state.workspace.orchestratorThreadId;
      const handingOff = (yield* readOutbox(workspaceId)).handoff !== undefined;
      const targets = [
        ...threads.filter(
          (thread) => thread.id === holder && !handingOff && thread.sessionSwitch === undefined,
        ),
        ...workersOf(threads, state).filter(
          (worker) => !worker.parked && !heldByUser(memos[worker.id], now),
        ),
      ];
      const stopped = [...stillResuming];
      for (const thread of targets) {
        const status = yield* runtimes
          .status(thread.id)
          .pipe(Effect.orElseSucceed(() => "cold" as const));
        if (status === "idle" || status === "cold" || status === "error" || status === "ended") {
          continue;
        }
        const turnOpen = yield* runtimes
          .stopAtToolBoundary(thread.id)
          .pipe(
            Effect.catch((e) =>
              Effect.logWarning("a paused workspace's thread couldn't be stopped").pipe(
                Effect.annotateLogs({ threadId: thread.id, error: e.message }),
                Effect.as(false),
              ),
            ),
          );
        if (turnOpen && !stopped.includes(thread.id)) stopped.push(thread.id);
      }
      if (stopped.length === 0) return;
      yield* store
        .updateWorkspace(workspaceId, (current) =>
          current.paused?.reason === "user"
            ? { ...current, paused: { ...current.paused, stopped } }
            : current,
        )
        .pipe(Effect.ignore);
    });

  const planPauseResume = (workspaceId: WorkspaceId, ended: OrchestrationPause) =>
    Effect.gen(function* () {
      const state = yield* findWorkspace(workspaceId);
      if (state === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      const holder = state.workspace.orchestratorThreadId;
      const workers = workersOf(yield* store.listThreads, state).filter((worker) => !worker.parked);
      const stoppedIds = ended.stopped ?? [];
      const stopped = stoppedIds.flatMap((id) => workers.find((worker) => worker.id === id) ?? []);
      const waiting: Array<Thread> = [];
      const free: Array<Thread> = [];
      for (const worker of workers) {
        if (stoppedIds.includes(worker.id)) continue;
        ((yield* store.listQueue(worker.id)).length > 0 ? waiting : free).push(worker);
      }
      const order = [...stopped, ...waiting];
      const plan = pauseResumePlan(
        order.map((worker) => worker.id),
        now,
      );
      const entries: Array<PauseResume> = order.map((worker) => ({
        threadId: worker.id,
        at: plan.get(worker.id)!,
        ...(stoppedIds.includes(worker.id) ? { stopped: true as const } : {}),
        pausedAt: ended.at,
        resumedAt: now,
      }));
      yield* updateOutbox(workspaceId, (outbox) => {
        const { resuming: _, ...rest } = outbox;
        return [entries.length === 0 ? rest : { ...rest, resuming: entries }, undefined];
      });
      const parts = [
        `The user paused orchestration at ${clockText(ended.at)} and resumed it at ${clockText(now)} (${spanText(now - ended.at)}).`,
      ];
      if (holder !== undefined && stoppedIds.includes(holder)) {
        parts.push(
          "Your own turn was asked to stop when the pause began; continue where you left off.",
        );
      }
      const when = (list: ReadonlyArray<Thread>) =>
        list
          .map((worker) => `${inlineText(worker.title)} at ${clockText(plan.get(worker.id)!)}`)
          .join(", ");
      if (stopped.length > 0) {
        parts.push(
          `The pause stopped ${stopped.length === 1 ? "1 worker" : `${stopped.length} workers`} mid-turn. They resume on their own in batches, each told to continue where it left off: ${when(stopped)}.`,
        );
      }
      if (waiting.length > 0) {
        parts.push(`Input held for other workers goes in the same batches: ${when(waiting)}.`);
      }
      parts.push("Don't message them to resume; it happens by itself.");
      yield* noteForNextDigest(workspaceId, parts.join(" "));
      for (const worker of free) yield* runtimes.releaseQueue(worker.id);
      yield* armPauseResumes(workspaceId);
    });

  const letGoAfterPause = (entry: PauseResume) =>
    Effect.gen(function* () {
      const thread = yield* findThread(entry.threadId);
      if (thread === undefined || thread.parked) return;
      const memo =
        thread.workspaceId === undefined
          ? undefined
          : (yield* readOutbox(thread.workspaceId)).workers[thread.id];
      const theirs = heldByUser(memo, yield* Clock.currentTimeMillis);
      if (entry.stopped === true && thread.limitWait === undefined && !theirs) {
        yield* runtimes
          .sendNotice(thread.id, PAUSE_RESUME_KEY, { text: pauseResumeText(entry) })
          .pipe(
            Effect.catch((e) =>
              Effect.logWarning("a resumed worker wasn't told to continue").pipe(
                Effect.annotateLogs({ threadId: thread.id, error: e.message }),
              ),
            ),
          );
      }
      yield* runtimes.releaseQueue(thread.id);
    });

  const armPauseResumes = (workspaceId: WorkspaceId) =>
    FiberMap.run(
      pauseResumeTimers,
      workspaceId,
      Effect.gen(function* () {
        for (;;) {
          const resuming = (yield* readOutbox(workspaceId)).resuming ?? [];
          if (resuming.length === 0) return;
          const now = yield* Clock.currentTimeMillis;
          const next = Math.min(...resuming.map((each) => each.at));
          if (next > now) {
            yield* Effect.sleep(Duration.millis(next - now));
            continue;
          }
          const due = yield* updateOutbox(workspaceId, (outbox) => {
            const all = outbox.resuming ?? [];
            const taken = all.filter((each) => each.at <= now);
            const left = all.filter((each) => each.at > now);
            const { resuming: _, ...rest } = outbox;
            return [left.length === 0 ? rest : { ...rest, resuming: left }, taken];
          });
          for (const entry of due) yield* letGoAfterPause(entry);
          if (due.length > 0) yield* orchestrationChanged(workspaceId);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("letting go of resumed workers failed").pipe(
            Effect.annotateLogs({ workspaceId, cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);

  const forgetStopped = (thread: Thread) =>
    Effect.gen(function* () {
      const workspaceId = thread.workspaceId;
      if (workspaceId === undefined) return;
      yield* store
        .updateWorkspace(workspaceId, (current) => {
          const stopped = current.paused?.stopped;
          if (stopped === undefined || !stopped.includes(thread.id)) return current;
          const kept = stopped.filter((id) => id !== thread.id);
          const { stopped: _, ...rest } = current.paused!;
          return { ...current, paused: kept.length === 0 ? rest : { ...rest, stopped: kept } };
        })
        .pipe(Effect.ignore);
      if ((yield* findWorkspace(workspaceId)) === undefined) return;
      yield* updateOutbox(workspaceId, (outbox) => {
        const resuming = outbox.resuming;
        if (resuming?.some((each) => each.threadId === thread.id && each.stopped) !== true) {
          return [outbox, undefined];
        }
        return [
          {
            ...outbox,
            resuming: resuming.map((each) => {
              if (each.threadId !== thread.id) return each;
              const { stopped: _, ...rest } = each;
              return rest;
            }),
          },
          undefined,
        ];
      });
    });

  const recordHeldStop = (thread: Thread) =>
    Effect.gen(function* () {
      const own = yield* orchestratorState(thread);
      const state = own ?? (yield* listeningWorkspace(thread));
      if (state?.paused?.reason !== "user") return;
      yield* store
        .updateWorkspace(state.workspace.id, (current) => {
          if (current.paused?.reason !== "user") return current;
          const stopped = current.paused.stopped ?? [];
          if (stopped.includes(thread.id)) return current;
          return { ...current, paused: { ...current.paused, stopped: [...stopped, thread.id] } };
        })
        .pipe(Effect.ignore);
    });

  const setPaused: OrchestrationShape["setPaused"] = (workspaceId, paused) =>
    Effect.gen(function* () {
      if (paused) {
        yield* store.getWorkspace(workspaceId);
        yield* pause(workspaceId, "user");
        return yield* store.getWorkspace(workspaceId);
      }
      let lifted: OrchestrationPause | undefined;
      const state = yield* store.updateWorkspace(workspaceId, (current) => {
        if (current.paused === undefined) return current;
        lifted = current.paused;
        const { paused: _, ...rest } = current;
        return rest;
      });
      if (lifted === undefined) return state;
      return yield* afterResume(workspaceId, state, lifted);
    });

  const afterResume = (
    workspaceId: WorkspaceId,
    state: WorkspaceState,
    lifted: OrchestrationPause,
  ) =>
    Effect.gen(function* () {
      yield* endRecovery(workspaceId);
      const holder = state.workspace.orchestratorThreadId;
      if (holder !== undefined) {
        yield* runtimes
          .updateThread(holder, (thread) => (thread.parked ? { ...thread, parked: false } : thread))
          .pipe(Effect.ignore);
      }
      const letGo = yield* releaseSetAside(workspaceId);
      yield* updateOutbox(workspaceId, (outbox) => [{ ...outbox, failures: 0 }, undefined]);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "resume",
        data: letGo ? { outbox: "startedOver" } : {},
      });
      if (lifted.reason === "user") yield* planPauseResume(workspaceId, lifted);
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      yield* wake(workspaceId, "the user resumed orchestration", true);
      yield* armAlarms(workspaceId);
      yield* armLimitResume(workspaceId);
      return state;
    });

  const launchUnlessPaused: OrchestrationShape["launchUnlessPaused"] = (workspaceId, launch) =>
    pauseFence.withLock(
      workspaceId,
      Effect.gen(function* () {
        const state = yield* findWorkspace(workspaceId);
        if (state === undefined || state.paused !== undefined) return undefined;
        return yield* launch;
      }),
    );

  const changePaused: OrchestrationShape["changePaused"] = (workspaceId, paused, audit) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        let lifted: OrchestrationPause | undefined;
        const done = yield* pauseFence.withLock(
          workspaceId,
          store.updateWorkspaceAudited(
            workspaceId,
            (current) => {
              if ((current.paused !== undefined) === paused) return undefined;
              if (paused) return { ...current, paused: { reason: "user" as const, at } };
              lifted = current.paused;
              const { paused: _, ...rest } = current;
              return rest;
            },
            audit,
          ),
        );
        if (done === undefined) return yield* new InvalidState({ message: CHARTER_MOVED });
        if (paused) yield* afterPause(workspaceId, done.state, "user", undefined, at);
        else if (lifted !== undefined) yield* afterResume(workspaceId, done.state, lifted);
        return done;
      }),
    );

  const followPark = (workspaceId: WorkspaceId, holder: Thread) =>
    Effect.gen(function* () {
      const state = yield* findWorkspace(workspaceId);
      if (state === undefined) return;
      if (holder.parked) {
        if ((yield* readOutbox(workspaceId)).handoff !== undefined) {
          yield* abandonHandoff(workspaceId, holder.id, "The orchestrator was parked.");
        }
        if (state.paused === undefined) yield* pause(workspaceId, "parked");
      }
      if (!holder.parked && state.paused?.reason === "parked") {
        yield* setPaused(workspaceId, false).pipe(Effect.ignore);
      }
    });

  return {
    quarantineOutbox,
    pause,
    armRecovery,
    endRecovery,
    onRecoveryDue,
    recoverAtHeadroom,
    armPauseResumes,
    forgetStopped,
    recordHeldStop,
    setPaused,
    launchUnlessPaused,
    changePaused,
    followPark,
  };
};

/** What `makePauses` makes, for the parts whose `deps` take some of it. */
export type Pauses = ReturnType<typeof makePauses>;
