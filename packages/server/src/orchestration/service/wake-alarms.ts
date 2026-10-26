// Scheduled wakes: `schedule_wake` and `cancel_wake`, the timers
// that fire them and the pull requests a wake watches.
import {
  WAKES_PER_THREAD_MAX,
  WAKE_NOTE_MAX,
  type PrStatus,
  DEFAULT_PR_WAKE_EVENTS,
  prRefText,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { randomUUID } from "node:crypto";
import { isBadgeOf } from "../../git/extra-prs.ts";
import { redactText } from "../../logging/redact.ts";
import { prWakeFields, prWakeWatches } from "../../wakes/thread-wakes.ts";
import { withoutWakes, type StoredWake } from "../outbox.ts";
import {
  refusal,
  nextPrWatchSeen,
  prWakeDueAt,
  prWakeEventOf,
  prWakeText,
  type PrWakeFired,
  wakeDueText,
} from "../rules.ts";
import {
  toolError,
  pausedFeatureOf,
  type OrchestrationKit,
  underKeysOf,
  callerKey,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { Digests } from "./digests.ts";

/** What scheduled wakes take from the rest of the service. */
export interface WakeAlarmsDeps {
  readonly wake: Digests["wake"];
}

/** Scheduled wakes and the PR watches behind them. */
export const makeWakeAlarms = (kit: OrchestrationKit, deps: WakeAlarmsDeps) => {
  const {
    authorityOf,
    findThread,
    listeningWorkspace,
    wakeAlarms,
    signals,
    readOutbox,
    publisher,
    updateOutbox,
    store,
    workerWorkspaces,
    findWorkspace,
    orchestrationChanged,
    wakeLock,
    runtimes,
  } = kit;
  const { wake } = deps;

  // ---------------------------------------------------------------------------------------
  // Scheduled wakes
  // ---------------------------------------------------------------------------------------

  /** How long a due wake its worker couldn't take yet waits before it is tried again. */
  const WAKE_RETRY = Duration.minutes(1);
  const NO_WAKE =
    "Only an orchestrator, or a worker its orchestrator still listens to, can set a wake here.";

  /** The workspace whose outbox keeps `callerId`'s wakes: the one it orchestrates or reports into. */
  const wakeWorkspace = (tool: string, callerId: ThreadId) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      if (authority !== undefined) return authority.state;
      const thread = yield* findThread(callerId);
      const state = thread === undefined ? undefined : yield* listeningWorkspace(thread);
      if (state === undefined) return yield* toolError(tool, refusal("no_authority", NO_WAKE));
      return state;
    });

  const keepsWakesOf: OrchestrationShape["keepsWakesOf"] = (callerId) =>
    wakeWorkspace("schedule_wake", callerId).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Fires `alarm` when it falls due, or `after` from now to try a due one again, `fired` when the
   * event of the PR it waits on did.
   */
  const armAlarm = (
    workspaceId: WorkspaceId,
    alarm: StoredWake,
    after?: Duration.Duration,
    fired?: PrWakeFired,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* FiberMap.run(
        wakeAlarms,
        alarm.id,
        Effect.sleep(after ?? Duration.millis(Math.max(0, alarm.at - now))).pipe(
          Effect.andThen(
            signals.offer({
              type: "wakeAlarm",
              workspaceId,
              wakeId: alarm.id,
              ...(fired === undefined ? {} : { fired }),
            }),
          ),
        ),
      );
    });

  /** Hands the PRs the workspace's wakes wait on to the publisher's sweeps. */
  const syncPrWatches = (workspaceId: WorkspaceId) =>
    readOutbox(workspaceId).pipe(
      Effect.flatMap((outbox) =>
        publisher.watchPrs(`orchestration ${workspaceId}`, prWakeWatches(outbox.wakes ?? [])),
      ),
    );

  /** Fires `alarm` now if `badge` shows one of its events since it last looked. */
  const checkPrWake = (workspaceId: WorkspaceId, alarm: StoredWake, badge: PrStatus) =>
    Effect.gen(function* () {
      // One that fired already waits with that event, whatever its PR does since.
      if (alarm.onPr === undefined || alarm.fired !== undefined || !isBadgeOf(badge, alarm.onPr))
        return;
      const fired = prWakeEventOf(alarm.seen, badge, alarm.on ?? DEFAULT_PR_WAKE_EVENTS);
      if (fired !== undefined) {
        // Kept before it is delivered: a pause holds a worker's, and a rerun of checks or a
        // restart meanwhile mustn't take the event back.
        yield* updateOutbox(workspaceId, (outbox) => [
          {
            ...outbox,
            wakes: (outbox.wakes ?? []).map((each) =>
              each.id === alarm.id && each.fired === undefined ? { ...each, fired } : each,
            ),
          },
          undefined,
        ]);
        return yield* armAlarm(workspaceId, alarm, Duration.zero, fired);
      }
      // What it saw is kept in the outbox, so a restart measures the next event from it; not on
      // an event, which a pause holds and the resume must still find.
      const seen = nextPrWatchSeen(alarm.seen, badge);
      if (JSON.stringify(seen) === JSON.stringify(alarm.seen)) return;
      yield* updateOutbox(workspaceId, (outbox) => [
        (outbox.wakes ?? []).some((each) => each.id === alarm.id)
          ? {
              ...outbox,
              wakes: (outbox.wakes ?? []).map((each) =>
                each.id === alarm.id ? { ...each, seen } : each,
              ),
            }
          : outbox,
        undefined,
      ]);
    });

  /**
   * A watched PR's new badge: every workspace's wakes waiting on it are looked at, and so is
   * whether it now drags on for a worker whose PR depends on it.
   */
  const onWatchedPr = (badge: PrStatus) =>
    Effect.gen(function* () {
      for (const state of yield* store.listWorkspaces) {
        for (const alarm of (yield* readOutbox(state.workspace.id)).wakes ?? []) {
          yield* checkPrWake(state.workspace.id, alarm, badge);
        }
      }
      for (const [threadId] of workerWorkspaces) {
        const thread = yield* findThread(threadId);
        if ((thread?.boundPr?.dependsOn ?? []).some((each) => isBadgeOf(badge, each))) {
          yield* signals.offer({ type: "dragCheck", threadId });
        }
      }
    });

  /**
   * Arms every wake the workspace's outbox keeps; one already due fires at once, and one whose PR
   * has moved since it last looked fires on that.
   */
  const armAlarms = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const wakes = (yield* readOutbox(workspaceId)).wakes ?? [];
      for (const alarm of wakes) {
        if (alarm.fired !== undefined) {
          yield* armAlarm(workspaceId, alarm, Duration.zero, alarm.fired);
          continue;
        }
        yield* armAlarm(workspaceId, alarm);
        const badge =
          alarm.onPr === undefined ? undefined : yield* publisher.watchedBadge(alarm.onPr);
        if (badge !== undefined) yield* checkPrWake(workspaceId, alarm, badge);
      }
      yield* syncPrWatches(workspaceId);
    });

  /** The workspace keeping `callerId`'s wakes: its role's, else the one it last belonged to. */
  const ownWakesWorkspace = (callerId: ThreadId) =>
    wakeWorkspace("cancel_wake", callerId).pipe(
      Effect.catch(() =>
        findThread(callerId).pipe(Effect.flatMap((thread) => findWorkspace(thread?.workspaceId))),
      ),
    );

  const pendingWakesOf: OrchestrationShape["pendingWakesOf"] = (callerId) =>
    Effect.gen(function* () {
      const state = yield* ownWakesWorkspace(callerId);
      if (state === undefined) return 0;
      const wakes = (yield* readOutbox(state.workspace.id)).wakes ?? [];
      return wakes.filter((each) => each.threadId === callerId).length;
    });

  const scheduleWake: OrchestrationShape["scheduleWake"] = (callerId, input, elsewhere = 0) =>
    Effect.gen(function* () {
      const tool = "schedule_wake";
      const state = yield* wakeWorkspace(tool, callerId);
      const workspaceId = state.workspace.id;
      const now = yield* Clock.currentTimeMillis;
      const due = prWakeDueAt(input, now);
      if (!due.ok) return yield* toolError(tool, due.reason);
      const alarm: StoredWake = {
        id: randomUUID(),
        threadId: callerId,
        at: due.at,
        // Redaction can lengthen it past what the ledger carries.
        note: redactText(input.note).slice(0, WAKE_NOTE_MAX),
        setAt: now,
        ...prWakeFields(input),
      };
      const taken = yield* updateOutbox(workspaceId, (outbox) => {
        const wakes = outbox.wakes ?? [];
        const pending = wakes.filter((each) => each.threadId === callerId).length + elsewhere;
        if (pending >= WAKES_PER_THREAD_MAX) {
          return [outbox, false];
        }
        return [{ ...outbox, wakes: [...wakes, alarm] }, true];
      });
      if (!taken) {
        return yield* toolError(
          tool,
          `You have ${WAKES_PER_THREAD_MAX} wakes pending already; cancel one with cancel_wake first.`,
        );
      }
      yield* armAlarm(workspaceId, alarm);
      yield* syncPrWatches(workspaceId);
      yield* orchestrationChanged(workspaceId);
      // Another watch of the PR may have seen it move since the tool looked it up.
      const badge =
        alarm.onPr === undefined ? undefined : yield* publisher.watchedBadge(alarm.onPr);
      if (badge !== undefined) yield* checkPrWake(workspaceId, alarm, badge);
      return { id: alarm.id, at: new Date(alarm.at).toISOString() };
    });

  const cancelWake: OrchestrationShape["cancelWake"] = (callerId, id) =>
    underKeysOf(
      wakeLock,
      ownWakesWorkspace(callerId).pipe(
        Effect.map((state) => [state?.workspace.id ?? callerKey(callerId)]),
      ),
      Effect.gen(function* () {
        // Dropping its own wake needs no authority: one set while its orchestrator listened, or
        // before it lost the slot, stays the caller's to cancel from its workspace.
        const state = yield* ownWakesWorkspace(callerId);
        if (state === undefined) {
          if (id === undefined) return { cancelled: 0 };
          return yield* toolError("cancel_wake", `No pending wake of yours has the id ${id}.`);
        }
        const workspaceId = state.workspace.id;
        const dropped = yield* updateOutbox(workspaceId, (outbox) => {
          const wakes = outbox.wakes ?? [];
          const gone = wakes.filter(
            (each) => each.threadId === callerId && (id === undefined || each.id === id),
          );
          return [withoutWakes(outbox, gone), gone];
        });
        if (id !== undefined && dropped.length === 0) {
          return yield* toolError("cancel_wake", `No pending wake of yours has the id ${id}.`);
        }
        for (const alarm of dropped) {
          yield* FiberMap.remove(wakeAlarms, alarm.id);
        }
        if (dropped.length > 0) {
          yield* syncPrWatches(workspaceId);
          yield* orchestrationChanged(workspaceId);
        }
        return { cancelled: dropped.length };
      }),
    );

  /**
   * A wake fell due. The orchestrator's goes into its next digest as a note, which a pause holds
   * back with the rest; a worker's is sent to it, and waits in the outbox while the workspace is
   * paused, to be armed again on the resume. An archived worker's, or one of a thread that is no
   * longer the workspace's, is dropped.
   */
  const onWakeAlarm = (workspaceId: WorkspaceId, wakeId: string, firedNow?: PrWakeFired) =>
    // Under the lock `cancel_wake` takes, so a wake cancelled once this has read it can't come
    // back, and one this is delivering is cancelled after, as delivered.
    wakeLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const alarm = (yield* readOutbox(workspaceId)).wakes?.find((each) => each.id === wakeId);
        if (alarm === undefined) return;
        // The event kept on the wake is the first one; a later one a concurrent look armed with
        // gives way to it.
        const fired = alarm.fired ?? firedNow;
        const now = yield* Clock.currentTimeMillis;
        if (fired === undefined && now < alarm.at) return yield* armAlarm(workspaceId, alarm);
        const state = yield* findWorkspace(workspaceId);
        const thread = yield* findThread(alarm.threadId);
        if (state !== undefined && state.workspace.orchestratorThreadId === alarm.threadId) {
          yield* updateOutbox(workspaceId, (outbox) =>
            (outbox.wakes ?? []).some((each) => each.id === alarm.id)
              ? [
                  {
                    ...withoutWakes(outbox, [alarm]),
                    dueWakes: [
                      ...(outbox.dueWakes ?? []),
                      { ...alarm, ...(fired === undefined ? {} : { fired }) },
                    ],
                  },
                  undefined,
                ]
              : [outbox, undefined],
          );
          yield* syncPrWatches(workspaceId);
          yield* orchestrationChanged(workspaceId);
          return yield* wake(
            workspaceId,
            alarm.onPr === undefined
              ? "a wake you scheduled is due"
              : fired === undefined
                ? `the wake you set on ${prRefText(alarm.onPr)} timed out`
                : `a wake you set on ${prRefText(alarm.onPr)} fired (${fired.event})`,
            true,
          );
        }
        const listening = thread === undefined ? undefined : yield* listeningWorkspace(thread);
        if (thread !== undefined && listening?.workspace.id === workspaceId && !thread.parked) {
          // Held, not dropped: a pause stops what wakes workers too, and the resume arms it again,
          // the user's pause of the worker's feature as well as of the workspace.
          if (listening.paused !== undefined || pausedFeatureOf(listening, thread)) return;
          const text =
            alarm.onPr === undefined
              ? wakeDueText(alarm)
              : prWakeText({ ...alarm, onPr: alarm.onPr }, fired);
          const delivered = yield* runtimes
            .sendNotice(thread.id, `wake:${alarm.id}`, { text })
            .pipe(
              Effect.as(true),
              Effect.catch((e) =>
                Effect.logWarning("scheduled wake not delivered").pipe(
                  Effect.annotateLogs({ threadId: thread.id, error: e.message }),
                  // An agent that won't start leaves the notice queued; a thread that's gone
                  // takes nothing. Anything else (a close or worktree cleanup holding it, say)
                  // passes, and the wake waits in the outbox to be tried again.
                  Effect.as(e._tag !== "InvalidState"),
                ),
              ),
            );
          if (!delivered) return yield* armAlarm(workspaceId, alarm, WAKE_RETRY, fired);
        }
        yield* updateOutbox(workspaceId, (outbox) => [withoutWakes(outbox, [alarm]), undefined]);
        yield* syncPrWatches(workspaceId);
        yield* orchestrationChanged(workspaceId);
      }),
    );

  return {
    keepsWakesOf,
    armAlarm,
    syncPrWatches,
    onWatchedPr,
    armAlarms,
    pendingWakesOf,
    scheduleWake,
    cancelWake,
    onWakeAlarm,
  };
};

/** What `makeWakeAlarms` makes, for the parts whose `deps` take some of it. */
export type WakeAlarms = ReturnType<typeof makeWakeAlarms>;
