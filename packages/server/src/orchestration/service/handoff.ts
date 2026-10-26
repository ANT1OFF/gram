// Handoff: moving a workspace to a fresh orchestrator session,
// asked for by the orchestrator or the user or forced by a model switch. It covers the checkpoint
// the old session writes, the fresh session's boot, and the retries, give-up and cancel around
// them, plus resuming a handoff a restart interrupted.

import {
  autonomyOf,
  InvalidState,
  serializeDigest,
  type Handoff,
  type ModelRef,
  type OrchestrationDigest,
  type Thread,
  type ThreadId,
  type UserInput,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";
import { selectableModels } from "../../runtime/model-efforts.ts";
import {
  type ObservedTurnEnd,
  type SystemDelivery,
  type SystemDeliveryFailure,
} from "../../runtime/thread-runtimes.ts";
import { visibleFeatures, type WorkerFacts } from "../ledger.ts";
import { outboxAfterHandoff, type HandoffMarker } from "../outbox.ts";
import {
  admittedForRole,
  digestGroups,
  gateNeedsReason,
  gateOfAutonomy,
  kindName,
} from "../rules.ts";
import { OUTBOX_UNREADABLE_DETAIL, DIGEST_KEY, type OrchestrationKit, underKeysOf } from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";

/**
 * The key of a handoff's checkpoint prompt. Its own, so a digest asked for meanwhile can't replace
 * it, and cancelling one leaves the other.
 */
export const HANDOFF_KEY = "handoff";
/**
 * How often a fresh session that was refused is tried again, beside every turn end of the
 * orchestrator: a thread waiting on a card or in the middle of a reload ends no turn.
 */
export const HANDOFF_RETRY = Duration.seconds(15);
/** A handoff that still hasn't happened this long after it was asked for is given up. */
export const HANDOFF_GIVE_UP_MS = 3_600_000;
const HANDOFF_WHY: Record<Handoff["reason"], string> = {
  user: "The user asked for a handoff",
  context: "Your context is nearly full",
  compactions: "Your conversation has been compacted more than once",
};

/** What the checkpoint prompt, a handoff's first step, asks of the session about to be replaced. */
const checkpointNote = (reason: Handoff["reason"]): string =>
  `${HANDOFF_WHY[reason]}, so when this turn ends your session is replaced by a fresh one. It starts from your role, MEMORY.md, the ledger and the charter, and remembers nothing else of this conversation. Write down now, with \`memory_write\`, whatever isn't in memory yet and can't be derived: goals and priorities, decisions and why, open questions for the user, what you were in the middle of. Only flush; tidying is for later. Don't spawn or message workers in this turn. When you are done, reply \`ready\` and end your turn.`;

/** The wake reason of the `boot` digest that opens the fresh session. */
const HANDOFF_BOOT_REASON = "a fresh session after a handoff";

/** What handoff takes from the rest of the service. */
export interface HandoffDeps {
  readonly armWake: (workspaceId: WorkspaceId, delay: Duration.Duration) => Effect.Effect<void>;
  readonly survey: LedgerWatch["survey"];
  readonly endRecovery: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly armAlarms: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly deliveryFor: (workspaceId: WorkspaceId) => SystemDelivery;
  readonly cancelDelivery: (
    workspaceId: WorkspaceId,
    orchestratorId: ThreadId | undefined,
  ) => Effect.Effect<void>;
}

/** Handoff and the model switch that goes through it. */
export const makeHandoff = (kit: OrchestrationKit, deps: HandoffDeps) => {
  const {
    handoffTimers,
    updateOutbox,
    findThread,
    runtimes,
    store,
    orchestrationChanged,
    hub,
    reasons,
    debounce,
    findWorkspace,
    app,
    signals,
    releaseSetAside,
    bootWhilePaused,
    workspacesChanged,
    handoffLock,
    switchJobs,
    taskStartupLock,
    workspaceStartupKeys,
    readOutbox,
    hosts,
    needsUnderGate,
  } = kit;
  const { armWake, survey, endRecovery, armAlarms, deliveryFor, cancelDelivery } = deps;

  // ---------------------------------------------------------------------------------------
  // Handoff
  //
  // By reopening, not by replacing the thread. P0 left open whether a session can be opened
  // without a resume id outside a rewind; read against `ThreadRuntimes` it can, and
  // `freshSession` is that path without the truncation. `resumeOptions` resumes nothing for a
  // thread with no `agentSessionId` and no `forkedFrom` (an orchestrator is never a fork), the
  // adapter's `identity` records the new id with `agentSessionUnused` until the boot digest is
  // sent, and checkpoints are keyed by thread and turn, never by agent session. The one thing a
  // rewind got for free is that no message outlives its session: here they all do, carrying
  // `agentMessageIds` of the session left behind, so `rewindTarget` and `forkTarget` refuse a
  // message from before the handoff part (`beforeHandoff`). That keeps the thread id, the slot,
  // every worker's `spawnedBy` and the transcript where they are, which the demoting
  // replacement would each have had to move atomically.
  //
  // The marker in the outbox is the whole state machine: `checkpoint` until the checkpoint turn
  // has ended by the adapter's own word, then `fresh` until the new session is open, the part is
  // in the transcript and the boot digest is asked for. Every way out clears it, and a restart
  // picks it up (`resumeHandoff`).
  // ---------------------------------------------------------------------------------------

  const clearHandoff = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(handoffTimers, workspaceId);
      return yield* updateOutbox(workspaceId, (outbox) => {
        if (outbox.handoff === undefined) return [outbox, undefined];
        const { handoff: marker, ...rest } = outbox;
        return [rest, marker];
      });
    });

  /** Gives a handoff up, leaving the orchestrator in the session it had, and says so once. */
  const abandonHandoff = (workspaceId: WorkspaceId, threadId: ThreadId, why: string) =>
    Effect.gen(function* () {
      const switching = (yield* findThread(threadId))?.sessionSwitch;
      if (switching !== undefined) {
        if (switching.phase !== "checkpoint") return;
        const cancelled = yield* runtimes.cancelSessionSwitch(threadId, switching.id).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!cancelled) return;
      }
      const marker = yield* clearHandoff(workspaceId);
      if (marker === undefined) return;
      yield* runtimes.cancelSystemDelivery(threadId, HANDOFF_KEY);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "handoffAbandoned",
        data: { reason: marker.reason, why },
      });
      yield* Effect.logWarning("orchestration handoff abandoned").pipe(
        Effect.annotateLogs({ workspaceId, why }),
      );
      yield* orchestrationChanged(workspaceId);
      yield* hub.publish({
        type: "notify",
        kind: "info",
        title:
          marker.target === undefined
            ? "The orchestrator's handoff didn't happen"
            : "The orchestrator switch didn't start",
        body:
          marker.target === undefined
            ? `${why} It carries on in the session it had; ask again when it is idle.`
            : `${why} The selection is unchanged. Review or recover the current session before trying again.`,
        threadId,
      });
      // Digests were held back while it ran.
      if ((reasons.get(workspaceId)?.size ?? 0) > 0) yield* armWake(workspaceId, debounce);
    });

  /**
   * The checkpoint prompt, the handoff's first step. It acknowledges nothing: the outbox's delivery
   * state is a digest's alone.
   */
  const checkpointFor = (workspaceId: WorkspaceId): SystemDelivery => ({
    build: (turnId) =>
      Effect.gen(function* () {
        const state = yield* findWorkspace(workspaceId);
        if (state === undefined) return undefined;
        const marker = yield* updateOutbox(workspaceId, (outbox) =>
          outbox.handoff?.phase === "checkpoint"
            ? [
                { ...outbox, handoff: { ...outbox.handoff, checkpointTurnId: turnId } },
                outbox.handoff,
              ]
            : [outbox, undefined],
        );
        if (marker === undefined) return undefined;
        const holder = state.workspace.orchestratorThreadId;
        if (marker.target !== undefined && holder !== undefined) {
          yield* store
            .updateThread(holder, (t) =>
              t.sessionSwitch?.phase === "checkpoint"
                ? { ...t, sessionSwitch: { ...t.sessionSwitch, checkpointTurnId: turnId } }
                : t,
            )
            .pipe(Effect.orDie);
        }
        const found = yield* survey(state, false);
        const features = visibleFeatures(found.features, () => 0, { includeArchived: false });
        const digest: OrchestrationDigest = {
          kind: "orchestration",
          variant: "checkpoint",
          // The digest it may have waited behind counts, even before its acceptance is booked.
          generation: found.outbox.inFlight?.generation ?? found.outbox.generation,
          workspaceId,
          workspaceName: state.workspace.name,
          ...(app === undefined ? {} : { app }),
          reasons: ["a handoff to a fresh session"],
          changes: [],
          reports: [],
          features,
          ...(found.groups.length === 0
            ? {}
            : { groups: digestGroups(found.groups, found.features, features) }),
          ...(found.groups.some((group) => group.state === "archived")
            ? {
                archivedGroupCount: found.groups.filter((group) => group.state === "archived")
                  .length,
              }
            : {}),
          budget: found.budget,
          notes: [checkpointNote(marker.reason)],
          ...(state.paused === undefined ? {} : { paused: state.paused }),
        };
        const input: UserInput = { text: serializeDigest(digest), notice: digest };
        return input;
      }),
    // The turn's end is what the handoff waits for, and the observer brings it.
    accepted: () => Effect.void,
    failed: (_turnId, reason) =>
      signals.offer({ type: "handoffFailed", workspaceId, reason }).pipe(Effect.asVoid),
  });

  /**
   * The handoff's third and fourth steps, once the fresh session is open: the transcript's mark,
   * then the boot digest.
   */
  const finishHandoff = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    marker: HandoffMarker,
    previous: string | undefined,
  ) =>
    Effect.gen(function* () {
      const marked = (yield* store.listMessages(threadId)).some((message) =>
        message.parts.some((part) => part.type === "data-handoff" && part.data.at === marker.at),
      );
      if (!marked) {
        const data: Handoff = {
          ...(previous === undefined ? {} : { previousAgentSessionId: previous }),
          reason: marker.reason,
          at: marker.at,
        };
        yield* runtimes
          .emitChunk(threadId, { type: "data-handoff", id: randomUUID(), data })
          .pipe(Effect.ignore);
      }
      yield* FiberMap.remove(handoffTimers, workspaceId);
      yield* updateOutbox(workspaceId, (outbox) => [outboxAfterHandoff(outbox), undefined]);
      // As `open` does: a pause for an orchestrator that couldn't be reached was about the
      // session this one replaces. The user's own pause stays, and the boot goes out through it.
      let endedSetAside = false;
      const state = yield* store
        .updateWorkspace(workspaceId, (current) => {
          if (current.paused?.reason !== "deliveryFailed") return current;
          endedSetAside = current.paused.detail === OUTBOX_UNREADABLE_DETAIL;
          const { paused: _, ...rest } = current;
          return rest;
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* endRecovery(workspaceId);
      // The fresh session the user asked for ends the set-aside pause as Resume would.
      if (endedSetAside) yield* releaseSetAside(workspaceId);
      // A worker's wake that fell due during a pause this lifted waited for it.
      if (state?.paused === undefined) yield* armAlarms(workspaceId);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "handoff",
        data: {
          reason: marker.reason,
          ...(previous === undefined ? {} : { previousAgentSessionId: previous }),
        },
      });
      yield* Effect.logInfo("orchestration handoff").pipe(
        Effect.annotateLogs({ workspaceId, reason: marker.reason }),
      );
      reasons.set(workspaceId, (reasons.get(workspaceId) ?? new Set()).add(HANDOFF_BOOT_REASON));
      if (state?.paused !== undefined && state.paused.reason !== "parked") {
        bootWhilePaused.add(workspaceId);
      }
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      yield* runtimes
        .requestSystemDelivery(threadId, DIGEST_KEY, deliveryFor(workspaceId))
        .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
    });

  /**
   * The handoff's second step. A thread that can't take a fresh session yet (the user's queued
   * message started a turn the moment the checkpoint ended, a card is up, a reload is running)
   * keeps its marker, and this runs again at its next turn end and on a slow timer.
   */
  const performFresh = (workspaceId: WorkspaceId, threadId: ThreadId) =>
    handoffLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const thread = yield* findThread(threadId);
        const now = yield* Clock.currentTimeMillis;
        const marker = yield* updateOutbox(workspaceId, (outbox) => {
          if (outbox.handoff === undefined || thread === undefined) return [outbox, undefined];
          if (outbox.handoff.phase === "fresh") return [outbox, outbox.handoff];
          const next: HandoffMarker = {
            reason: outbox.handoff.reason,
            ...(outbox.handoff.target === undefined ? {} : { target: outbox.handoff.target }),
            at: outbox.handoff.at,
            phase: "fresh",
            ...(thread.agentSessionId === undefined
              ? {}
              : { previousAgentSessionId: thread.agentSessionId }),
          };
          return [{ ...outbox, handoff: next }, next];
        });
        if (thread === undefined) return void (yield* clearHandoff(workspaceId));
        if (marker === undefined) return;
        if (marker.target === undefined && now - marker.at > HANDOFF_GIVE_UP_MS) {
          return yield* abandonHandoff(
            workspaceId,
            threadId,
            "The orchestrator never became free for a fresh session.",
          );
        }
        if (marker.target !== undefined) {
          if (FiberMap.hasUnsafe(switchJobs, workspaceId)) return;
          const change = thread.sessionSwitch;
          if (change === undefined || (change.phase !== "checkpoint" && change.phase !== "retry"))
            return;
          return yield* FiberMap.run(
            switchJobs,
            workspaceId,
            Effect.gen(function* () {
              const current = yield* store.getWorkspace(workspaceId);
              if (current.workspace.orchestratorThreadId !== threadId)
                return yield* new InvalidState({
                  message: "The previous orchestrator no longer holds this workspace.",
                });
              const mode = yield* validateSwitch(current, thread, marker.target!);
              if (change.mode !== mode)
                yield* runtimes.updateThread(threadId, (t) =>
                  t.sessionSwitch?.id === change.id
                    ? { ...t, sessionSwitch: { ...t.sessionSwitch, mode } }
                    : t,
                );

              const previous = yield* runtimes.switchSession(threadId, change.id);
              const installed = yield* store.getThread(threadId);
              if (
                installed.sessionSwitch?.id !== change.id ||
                installed.sessionSwitch.phase !== "ready"
              )
                return yield* new InvalidState({
                  message: "The selected startup no longer owns this switch attempt.",
                });
              yield* underKeysOf(
                taskStartupLock,
                workspaceStartupKeys(workspaceId),
                store.updateWorkspace(workspaceId, (value) =>
                  value.workspace.orchestratorThreadId === threadId
                    ? {
                        ...value,
                        charter: { ...value.charter, orchestratorModel: marker.target! },
                      }
                    : value,
                ),
              );
              yield* finishHandoff(workspaceId, threadId, marker, previous);
              yield* runtimes.releaseSwitch(threadId, change.id);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const current = yield* findThread(threadId);
                  if (current?.sessionSwitch?.phase === "retry") {
                    yield* runtimes
                      .updateThread(threadId, (t) => ({
                        ...t,
                        sessionSwitch: {
                          ...current.sessionSwitch!,
                          phase: "failed",
                          detail:
                            "This previous session's owner cannot be verified in the current runtime. No retry or fallback was started. Your history and queued input remain held.",
                        },
                      }))
                      .pipe(Effect.ignore);
                  }
                  const failure = Cause.findErrorOption(cause);
                  if (current?.sessionSwitch?.phase === "checkpoint")
                    return yield* abandonHandoff(
                      workspaceId,
                      threadId,
                      Option.isSome(failure)
                        ? failure.value.message
                        : "The selected harness could not be safely started; review the selected model and try again.",
                    );
                  yield* orchestrationChanged(workspaceId);
                  yield* hub.publish({
                    type: "notify",
                    kind: "info",
                    title: "The orchestrator switch needs attention",
                    body: "No fallback or automatic retry was started. Open the switch action to review its status. Queued input is retained.",
                    threadId,
                  });
                  yield* Effect.logWarning("orchestrator switch did not complete").pipe(
                    Effect.annotateLogs({ workspaceId, cause: Cause.pretty(cause) }),
                  );
                }),
              ),
            ),
          ).pipe(Effect.asVoid);
        }
        const replaced = yield* runtimes.freshSession(threadId).pipe(
          Effect.map((previous) => ({ previous })),
          Effect.catchTag("InvalidState", (e) =>
            Effect.logDebug("orchestration handoff waits for the thread to be free").pipe(
              Effect.annotateLogs({ workspaceId, why: e.message }),
              Effect.as(undefined),
            ),
          ),
          Effect.catchTag("ThreadNotFound", () => Effect.succeed(undefined)),
        );
        if (replaced === undefined) {
          return yield* FiberMap.run(
            handoffTimers,
            workspaceId,
            Effect.sleep(HANDOFF_RETRY).pipe(
              Effect.andThen(signals.offer({ type: "handoffRetry", workspaceId })),
            ),
          ).pipe(Effect.asVoid);
        }
        yield* finishHandoff(workspaceId, threadId, marker, replaced.previous);
      }),
    );

  const handoffAfterTurn = (workspaceId: WorkspaceId, thread: Thread, end: ObservedTurnEnd) =>
    Effect.gen(function* () {
      const marker = (yield* readOutbox(workspaceId)).handoff;
      if (marker === undefined) return;
      if (marker.phase === "checkpoint") {
        // Some other turn: a digest that was in flight, or the user's own message. Keep waiting.
        if (marker.checkpointTurnId !== end.turnId) return;
        // Only the adapter's own `completed` says the orchestrator had its chance to write.
        if (end.synthesized || end.reason !== "completed") {
          return yield* abandonHandoff(
            workspaceId,
            thread.id,
            `The checkpoint turn ended early (${end.synthesized ? "the session stopped" : end.reason}), so nothing says the memory is up to date.`,
          );
        }
      }
      yield* performFresh(workspaceId, thread.id);
    });

  const onHandoffFailed = (workspaceId: WorkspaceId, reason: SystemDeliveryFailure) =>
    Effect.gen(function* () {
      const state = yield* findWorkspace(workspaceId);
      const holder = state?.workspace.orchestratorThreadId;
      const marker = (yield* readOutbox(workspaceId)).handoff;
      if (holder === undefined || marker?.phase !== "checkpoint") return;
      // A thread that went into `error` while the prompt waited can't be asked anything, and a
      // fresh session is what gets it out.
      if (reason === "error" && marker.target === undefined)
        return yield* performFresh(workspaceId, holder);
      yield* abandonHandoff(
        workspaceId,
        holder,
        `The orchestrator didn't take the checkpoint prompt (${reason}).`,
      );
    });

  const validateSwitch = (state: WorkspaceState, thread: Thread, target: ModelRef) =>
    Effect.gen(function* () {
      if (
        thread.forkedFrom !== undefined ||
        thread.role !== "orchestrator" ||
        thread.workspaceId !== state.workspace.id ||
        state.workspace.orchestratorThreadId !== thread.id
      )
        return yield* new InvalidState({
          message:
            "This thread cannot transfer the workspace's orchestrator session. Review the current holder; forked or detached threads cannot be switched here.",
        });
      if (!admittedForRole(target.agent, "orchestrator"))
        return yield* new InvalidState({
          message: "Choose Codex or Claude Code for the orchestrator.",
        });
      const sourceHost = yield* hosts
        .get(thread.model.agent)
        .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
      const targetHost = yield* hosts
        .get(target.agent)
        .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
      if (!sourceHost.supportsWorkspaceSwitch || !targetHost.supportsWorkspaceSwitch)
        return yield* new InvalidState({
          message:
            "Switching an existing orchestrator is unavailable on this platform or harness build. Windows cannot currently guarantee a graceful stop. Your current session and workspace preferences have not changed.",
        });
      if (target.profileId !== undefined)
        return yield* new InvalidState({
          message:
            "Choose the installed CLI's subscription login for this switch. Switching does not migrate gateway credentials or accounts.",
        });
      const mode = thread.mode;
      if (mode === "plan" && !targetHost.capabilities.planMode)
        return yield* new InvalidState({
          message:
            "The selected harness cannot preserve this session's Plan mode. Finish the plan in the current session before switching.",
        });
      const needs = yield* needsUnderGate(target, gateOfAutonomy(autonomyOf(state.charter)), mode);
      if (needs !== undefined)
        return yield* new InvalidState({
          message: `The selected ${kindName(target.agent)} session cannot preserve this workspace's approval policy in ${mode} mode. ${gateNeedsReason(needs, target.agent, mode)} No switch was started.`,
        });
      const models = yield* selectableModels(store, hosts, target.agent, undefined).pipe(
        Effect.mapError((e) => new InvalidState({ message: e.message })),
      );
      const selected = models.find(
        (model) => model.id === target.model || model.resolvedId === target.model,
      );
      if (selected === undefined)
        return yield* new InvalidState({
          message: `The installed ${kindName(target.agent)} CLI does not list ${target.model}. Select a listed model, or add that exact custom ID in Settings → Agents first. No model was substituted.`,
        });
      if (target.variant !== undefined && !selected.efforts.includes(target.variant))
        return yield* new InvalidState({
          message:
            "The selected model does not support that effort. Choose one offered by its model picker.",
        });
      if (target.speed === "fast" && !selected.speeds.includes("fast"))
        return yield* new InvalidState({
          message:
            "The selected model does not support that speed. Choose one offered by its model picker.",
        });
      if (targetHost.checkWorkspaceSwitch === undefined)
        return yield* new InvalidState({
          message:
            "This harness build cannot re-check sign-in before stopping the current session. Update or recover the current session before trying the switch.",
        });
      yield* targetHost.checkWorkspaceSwitch.pipe(
        Effect.mapError((e) => new InvalidState({ message: e.message })),
      );
      return mode;
    });

  const handoff: OrchestrationShape["handoff"] = (workspaceId, reason, target) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const holder = state.workspace.orchestratorThreadId;
      const thread = holder === undefined ? undefined : yield* findThread(holder);
      if (thread === undefined) {
        return yield* new InvalidState({
          message: "This workspace has no orchestrator to hand off. Open one first.",
        });
      }
      if (thread.sessionSwitch !== undefined)
        return yield* new InvalidState({
          message:
            "This orchestrator already has a switch to review. No second attempt was started.",
        });
      const switchMode =
        target === undefined ? undefined : yield* validateSwitch(state, thread, target);
      if (target !== undefined) {
        const latest = yield* store.getWorkspace(workspaceId);
        const current = yield* findThread(thread.id);
        if (
          latest.workspace.orchestratorThreadId !== thread.id ||
          current === undefined ||
          current.sessionSwitch !== undefined ||
          JSON.stringify(latest.charter) !== JSON.stringify(state.charter) ||
          JSON.stringify(current.model) !== JSON.stringify(thread.model)
        )
          return yield* new InvalidState({
            message:
              "The workspace changed while the selected harness was checked. Review the current orchestrator and try again.",
          });
      }
      const status = yield* runtimes
        .status(thread.id)
        .pipe(Effect.orElseSucceed((): WorkerFacts["status"] => "cold"));
      if (status === "ended") {
        // `ended` is a thread on its way out (`close`), and a session opened under it would
        // outlive the row.
        return yield* new InvalidState({
          message: "The orchestrator thread has ended. Close it and open a new orchestrator.",
          threadId: thread.id,
          status,
        });
      }
      if (thread.parked) {
        return yield* new InvalidState({
          message: "The orchestrator is parked. Unpark it to start a fresh session.",
          threadId: thread.id,
        });
      }
      // A session in `error` can't be asked to write anything down first.
      if (target !== undefined && (status === "error" || thread.lastError !== undefined))
        return yield* new InvalidState({
          message:
            "The current orchestrator cannot checkpoint its work. Recover its existing session with Restart session or Start fresh session, then request the switch again. No checkpoint or model change was made.",
        });
      const broken = status === "error";
      const at = yield* Clock.currentTimeMillis;
      const marker: HandoffMarker = {
        reason,
        ...(target === undefined ? {} : { target }),
        at,
        phase: broken ? "fresh" : "checkpoint",
        ...(broken && thread.agentSessionId !== undefined
          ? { previousAgentSessionId: thread.agentSessionId }
          : {}),
      };
      const claim = Effect.gen(function* () {
        if (target !== undefined) {
          const latest = yield* store.getWorkspace(workspaceId);
          const current = yield* findThread(thread.id);
          if (
            latest.workspace.orchestratorThreadId !== thread.id ||
            current === undefined ||
            current.parked ||
            current.sessionSwitch !== undefined ||
            JSON.stringify(latest.charter) !== JSON.stringify(state.charter) ||
            JSON.stringify(current.model) !== JSON.stringify(thread.model)
          )
            return yield* new InvalidState({
              message:
                "The workspace changed during switch preflight. Review the current selection and try again.",
            });
        }
        const taken = yield* updateOutbox(workspaceId, (outbox) =>
          outbox.handoff === undefined ? [{ ...outbox, handoff: marker }, true] : [outbox, false],
        );
        if (!taken)
          return yield* new InvalidState({
            message: "A handoff is already under way for this orchestrator.",
            threadId: thread.id,
          });
        if (target !== undefined) {
          const id = randomUUID();
          yield* runtimes
            .claimSessionSwitch(thread.id, {
              id,
              target,
              previous: thread.model,
              mode: switchMode!,
              phase: "checkpoint",
              oldExited: false,
            })
            .pipe(
              Effect.mapError((e) => new InvalidState({ message: e.message })),
              Effect.onError(() => clearHandoff(workspaceId)),
            );
        }
      });
      yield* target === undefined
        ? claim
        : underKeysOf(taskStartupLock, workspaceStartupKeys(workspaceId), claim);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "handoffRequested",
        data: { reason, checkpoint: !broken },
      });
      // A digest that hasn't gone out would reach the session that is about to go. One a turn
      // already carries finishes first, acknowledged as usual: the checkpoint waits behind it.
      yield* cancelDelivery(workspaceId, thread.id);
      yield* orchestrationChanged(workspaceId);
      if (broken) {
        yield* performFresh(workspaceId, thread.id);
      } else {
        yield* runtimes
          .requestSystemDelivery(thread.id, HANDOFF_KEY, checkpointFor(workspaceId))
          .pipe(Effect.catchTag("ThreadNotFound", () => clearHandoff(workspaceId)));
      }
      return yield* store
        .getThread(thread.id)
        .pipe(Effect.catchTag("ThreadNotFound", () => Effect.succeed(thread)));
    });

  /**
   * A handoff the last run of the app didn't finish. One still at its checkpoint asks again: the
   * turn that carried the prompt died with the process, and the old session is there to resume.
   * One that had begun replacing the session finishes, by whether the thread still names the
   * session it had; it never stays half done.
   */
  const resumeHandoff = (workspaceId: WorkspaceId, thread: Thread) =>
    Effect.gen(function* () {
      const marker = (yield* readOutbox(workspaceId)).handoff;
      if (marker === undefined) return;
      if (
        marker.target !== undefined &&
        thread.sessionSwitch !== undefined &&
        thread.sessionSwitch.phase !== "checkpoint"
      ) {
        if (thread.sessionSwitch.phase !== "failed") {
          yield* runtimes
            .updateThread(thread.id, (t) => ({
              ...t,
              sessionSwitch: {
                ...thread.sessionSwitch!,
                phase: "failed",
                detail:
                  "The app restarted during this switch. The previous attempt's process ownership cannot be verified, so no session was started automatically. Your history, workers and queued input are retained. Resolve or close the previous session before opening another orchestrator.",
              },
            }))
            .pipe(Effect.ignore);
        }
        return;
      }
      if (marker.target !== undefined && thread.sessionSwitch?.phase === "checkpoint") {
        yield* runtimes
          .updateThread(thread.id, (t) => {
            const { checkpointTurnId: _turn, ...change } = thread.sessionSwitch!;
            return { ...t, sessionSwitch: change };
          })
          .pipe(Effect.ignore);
        yield* updateOutbox(workspaceId, (outbox) => [
          { ...outbox, handoff: { ...marker, phase: "checkpoint" } },
          undefined,
        ]);
        return yield* runtimes
          .requestSystemDelivery(thread.id, HANDOFF_KEY, checkpointFor(workspaceId))
          .pipe(
            Effect.catchTag("ThreadNotFound", () => clearHandoff(workspaceId)),
            Effect.asVoid,
          );
      }
      if (marker.target !== undefined && thread.sessionSwitch === undefined) {
        return yield* abandonHandoff(
          workspaceId,
          thread.id,
          "The switch request was interrupted before it claimed a session. Please select the target again.",
        );
      }
      if (marker.phase === "checkpoint") {
        return yield* runtimes
          .requestSystemDelivery(thread.id, HANDOFF_KEY, checkpointFor(workspaceId))
          .pipe(Effect.catchTag("ThreadNotFound", () => clearHandoff(workspaceId)));
      }
      const replaced =
        marker.previousAgentSessionId !== undefined &&
        thread.agentSessionId !== marker.previousAgentSessionId;
      if (!replaced) return yield* performFresh(workspaceId, thread.id);
      yield* finishHandoff(workspaceId, thread.id, marker, marker.previousAgentSessionId);
    });

  const retrySwitch: OrchestrationShape["retrySwitch"] = (workspaceId) =>
    handoffLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const state = yield* store.getWorkspace(workspaceId);
        const holder = state.workspace.orchestratorThreadId;
        const thread = holder === undefined ? undefined : yield* findThread(holder);
        const change = thread?.sessionSwitch;
        if (thread === undefined || change?.phase !== "failed" || thread.parked)
          return yield* new InvalidState({
            message: "There is no failed, unparked switch ready to retry in this workspace.",
          });
        const mode = yield* validateSwitch(state, thread, change.target);
        let release = change.targetRelease;
        if (change.oldExited && release === undefined) {
          const host = yield* hosts
            .get(change.target.agent)
            .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
          release =
            host.switchAttemptReceipt === undefined
              ? undefined
              : yield* host.switchAttemptReceipt(change.id);
        }
        if (change.oldExited && release === undefined)
          return yield* new InvalidState({
            message:
              "The failed attempt has not proved that no target child remains. It may still be stopping, or its owner cannot be verified after an app restart. No retry was started; queued input remains held.",
          });
        const marker = (yield* readOutbox(workspaceId)).handoff;
        if (marker?.target === undefined)
          return yield* new InvalidState({
            message: "The saved handoff is unavailable. No replacement was started.",
          });
        const id = randomUUID();
        const next = yield* runtimes
          .updateThread(thread.id, (t) => ({
            ...t,
            sessionSwitch: {
              id,
              previous: change.previous,
              target: change.target,
              mode,
              phase: "retry",
              oldExited: change.oldExited,
              ...(change.oldExited && release !== undefined
                ? { retryFrom: { id: change.id, release } }
                : {}),
            },
          }))
          .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
        // performFresh takes handoffLock too; its job is scheduled after this request releases it.
        yield* FiberMap.run(
          handoffTimers,
          workspaceId,
          signals.offer({ type: "handoffRetry", workspaceId }),
        );
        return next;
      }),
    );

  const cancelSwitch: OrchestrationShape["cancelSwitch"] = (workspaceId) =>
    handoffLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const state = yield* store.getWorkspace(workspaceId);
        const thread =
          state.workspace.orchestratorThreadId === undefined
            ? undefined
            : yield* findThread(state.workspace.orchestratorThreadId);
        if (thread?.sessionSwitch?.phase !== "checkpoint")
          return yield* new InvalidState({
            message:
              "This switch has already begun stopping the previous session. It cannot be cancelled or restored as though that session were still active.",
          });
        yield* runtimes
          .cancelSessionSwitch(thread.id, thread.sessionSwitch.id)
          .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
        yield* abandonHandoff(
          workspaceId,
          thread.id,
          "You cancelled the switch before the previous session stopped.",
        );
      }),
    );

  return {
    clearHandoff,
    abandonHandoff,
    performFresh,
    handoffAfterTurn,
    onHandoffFailed,
    handoff,
    resumeHandoff,
    retrySwitch,
    cancelSwitch,
  };
};

/** What `makeHandoff` makes, for the parts whose `deps` take some of it. */
export type HandoffPart = ReturnType<typeof makeHandoff>;
