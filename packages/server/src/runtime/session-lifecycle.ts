// A thread's agent session: opening it, what its end means for the thread, the watchdog's
// recovery of a stuck turn, and stopping a session whose folder is gone.

import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { type Runtime, locked, feedLocked, replyOf } from "./runtime-state.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import { AgentUnavailable, type Thread, type TurnId, type ThreadId } from "@gram/contracts";
import { UNKNOWN_FAILURE } from "./thread-error.ts";
import { dreamSupportFor, type AppToolRegistryPort } from "@gram/agents";
import type { ResumeOptions, ResumePlans } from "./history-plans.ts";
import { dreamRolePromptFor } from "../orchestration/dream-prompt.ts";
import { openCostSession } from "./cost-ledger.ts";
import { randomUUID } from "node:crypto";
import type { AgentHosts } from "./agent-hosts.ts";
import type { ClaudeAiSeenShape } from "../connectors/claude-ai-seen.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { CheckoutServiceShape } from "./hooks.ts";
import type { McpConnection } from "../app-tools/mcp-tokens.ts";
import type { FeedWriter } from "./feed-writer.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { SessionPolicies } from "./session-policy.ts";
import type { SessionRestarts } from "./session-restarts.ts";
import type { AgentEvents } from "./agent-events.ts";
import type { ServerApprovals } from "./server-approvals.ts";

/** What opening and ending a session read and change beside a thread's `Runtime`. */
export interface SessionLifecycleDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly checkouts: CheckoutServiceShape;
  readonly hosts: AgentHosts["Service"];
  readonly sessions: FiberMap.FiberMap<ThreadId>;
  readonly folderStops: FiberMap.FiberMap<ThreadId>;
  readonly recoveries: FiberMap.FiberMap<ThreadId, void, never>;
  readonly activityTimers: FiberMap.FiberMap<ThreadId>;
  readonly seenConnectors: ClaudeAiSeenShape;
  readonly recordSeen: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly mcpEndpoint: (threadId: ThreadId) => Effect.Effect<Option.Option<McpConnection>>;
  readonly withdrawMessage: FeedWriter["withdrawMessage"];
  readonly appendChunkLocked: FeedWriter["appendChunkLocked"];
  readonly closeOpenMessages: FeedWriter["closeOpenMessages"];
  readonly closeLanes: FeedWriter["closeLanes"];
  readonly flushUnsaved: FeedWriter["flushUnsaved"];
  readonly appendDataPart: FeedWriter["appendDataPart"];
  readonly syncQueue: MessageQueue["syncQueue"];
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly recordFailure: TurnLifecycle["recordFailure"];
  readonly finishTurn: TurnLifecycle["finishTurn"];
  readonly publishFailure: TurnLifecycle["publishFailure"];
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly failUnavailable: TurnLifecycle["failUnavailable"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly setRetrying: (rt: Runtime, retrying: boolean, detail?: string) => Effect.Effect<void>;
  readonly clearPendingRequests: ServerApprovals["clearPendingRequests"];
  readonly policyFor: SessionPolicies["policyFor"];
  readonly setPendingRestart: SessionRestarts["setPendingRestart"];
  readonly resumeOptions: ResumePlans["resumeOptions"];
  readonly handleEvent: AgentEvents["handleEvent"];
  readonly setBackground: AgentEvents["setBackground"];
  readonly setLapsedConnectors: AgentEvents["setLapsedConnectors"];
  readonly isShuttingDown: () => boolean;
  readonly markShutdownFailed: () => void;
  readonly currentAppTools: () => AppToolRegistryPort | undefined;
}

/** The sessions `ThreadRuntimes` runs, one per thread, each in `sessions`. */
export const makeSessionLifecycle = ({
  store,
  hub,
  checkouts,
  hosts,
  sessions,
  folderStops,
  recoveries,
  activityTimers,
  seenConnectors,
  recordSeen,
  mcpEndpoint,
  withdrawMessage,
  appendChunkLocked,
  closeOpenMessages,
  closeLanes,
  flushUnsaved,
  appendDataPart,
  syncQueue,
  stopSession,
  recordFailure,
  finishTurn,
  publishFailure,
  setStatus,
  failUnavailable,
  publishUpsert,
  setRetrying,
  clearPendingRequests,
  policyFor,
  setPendingRestart,
  resumeOptions,
  handleEvent,
  setBackground,
  setLapsedConnectors,
  isShuttingDown,
  markShutdownFailed,
  currentAppTools,
}: SessionLifecycleDeps) => {
  /** `stopInMissingFolder` for a runtime. Takes the lock, so never run it while holding it. */
  const stopInMissing = (rt: Runtime) =>
    Effect.gen(function* () {
      // The live session's own folder, read under the lock: `moveCheckout` records the new
      // checkout at once while the session runs on in the old one until its turn ends.
      const gone = yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing || rt.stopping !== undefined || rt.cwd === undefined) return undefined;
          if (rt.session === undefined && !FiberMap.hasUnsafe(sessions, rt.threadId)) {
            return undefined;
          }
          if (yield* checkouts.present(rt.cwd)) return undefined;
          return { path: rt.cwd, midTurn: rt.turn !== undefined };
        }),
      );
      if (gone === undefined) return;
      const { path, midTurn } = gone;
      // No path: it can name the user's folders.
      yield* Effect.logInfo("thread folder gone; session stopped").pipe(
        Effect.annotateLogs({ threadId: rt.threadId, midTurn }),
      );
      yield* stopSession(rt, "folderGone");
      if (midTurn) {
        yield* hub.publish({
          type: "notify",
          kind: "error",
          title: `The agent was stopped. ${missingThreadFolder(path)}`,
          threadId: rt.threadId,
        });
      }
    });

  /** Forks `stopInMissing`, so a session's own event or a send under the lock can ask for it. */
  const forkStopInMissing = (rt: Runtime) =>
    FiberMap.run(folderStops, rt.threadId, stopInMissing(rt), { onlyIfMissing: true }).pipe(
      Effect.asVoid,
    );

  const handleSessionExit = (rt: Runtime, exit: Exit.Exit<void, AgentUnavailable>) =>
    locked(
      rt,
      Effect.gen(function* () {
        if (rt.switchOpening !== undefined)
          yield* Deferred.fail(
            rt.switchOpening.ack,
            new AgentUnavailable({
              agent: rt.agent ?? "claude",
              message: "The selected orchestrator failed to start. No fallback was started.",
            }),
          );
        const stopping = rt.stopping;
        rt.stopping = undefined;
        rt.session = undefined;
        rt.agentRunning = false;
        if (stopping !== "recover") {
          rt.restartMarker = undefined;
          // A cold thread reads the config afresh when it next opens.
          yield* setPendingRestart(rt, undefined);
        }
        // The session the launch waited on is gone, so it waits in the queue as what it now is:
        // unsent, and out of the feed, where a fork would take it for a message its source has.
        // A recovery opens the next session at once, which takes the launch as this one would have.
        if (rt.launch !== undefined && stopping !== "recover") {
          const { id, input } = rt.launch;
          yield* withdrawMessage(rt, id);
          rt.queue.unshift({ id, input });
          rt.launch = undefined;
          yield* syncQueue(rt);
        }
        // Nor did one cut off on its way to the agent: it waits at the queue's head, as it was,
        // for this session's successor too, which nothing else would hand it to.
        if (rt.inFlight !== undefined) {
          const { id, input } = rt.inFlight;
          yield* withdrawMessage(rt, id);
          rt.queue.unshift({ id, input });
          rt.inFlight = undefined;
          yield* syncQueue(rt);
        }
        // The session's end takes its background tasks with it, and its connectors.
        yield* setBackground(rt, []);
        // Scope termination withdraws live process visibility, without claiming the process
        // exited or releasing Codex provider ownership. Leave no indefinitely running card.
        yield* feedLocked(
          rt,
          Effect.gen(function* () {
            for (const inFlight of rt.open.values()) {
              const preliminary = inFlight.accumulator.preliminaryTools();
              for (const toolCallId of preliminary) {
                yield* appendChunkLocked(rt, inFlight.messageId, {
                  type: "tool-output-error",
                  toolCallId,
                  errorText: "Session ended before the process exited",
                });
              }
              if (preliminary.length > 0)
                yield* appendChunkLocked(rt, inFlight.messageId, { type: "finish" });
            }
          }),
        );
        yield* setLapsedConnectors(rt, []);
        yield* setRetrying(rt, false);
        // Mid-turn, the session's end is that turn's failure. Between turns (Codex ends a turn it
        // flushes before its session does) the turn's own classified error stays.
        const turnId = rt.turn?.id;
        const endedMidTurn = stopping === undefined && turnId !== undefined;
        const kept = (yield* store.getThread(rt.threadId).pipe(Effect.option)).pipe(
          Option.flatMap((thread) => Option.fromUndefinedOr(thread.lastError)),
        );
        const exitDetail = Exit.isFailure(exit)
          ? // A defect's cause is a stack, not something to keep on the thread.
            "the agent session failed"
          : `agent session ended: ${rt.endedReason ?? "unknown reason"}`;
        const replyId = replyOf(rt, turnId);
        // An agent that couldn't start is `failUnavailable`'s to record, in its own words.
        const unavailable = Exit.isFailure(exit)
          ? Cause.findErrorOption(exit.cause)
          : Option.none();
        // An interrupt is the server shutting down under the session, which says nothing of the turn.
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
        const exitError =
          stopping === undefined &&
          !interrupted &&
          !isShuttingDown() &&
          Option.isNone(unavailable) &&
          (endedMidTurn || Option.isNone(kept))
            ? yield* recordFailure(rt, UNKNOWN_FAILURE, exitDetail, turnId)
            : undefined;
        // A shutdown keeps what streamed, a background subagent's transcript under an idle parent
        // too, but leaves the turn itself open (`shutdown`).
        if (isShuttingDown()) {
          yield* closeOpenMessages(rt);
        } else {
          if (rt.turn !== undefined) {
            yield* finishTurn(rt, stopping === undefined ? "error" : "interrupted", "sessionExit");
          }
          yield* closeLanes(rt);
          // Its subagents went with it, so none keeps the activity line up.
          rt.activity.reset();
          yield* FiberMap.remove(activityTimers, rt.threadId);
        }
        yield* flushUnsaved(rt);
        if (exitError !== undefined && turnId !== undefined) {
          yield* publishFailure(rt, exitError, turnId, replyId);
        }
        yield* clearPendingRequests(rt, isShuttingDown() ? "runtime-shutdown" : "session-ended");
        switch (stopping) {
          case "evict":
          case "folderGone":
            return yield* setStatus(rt, "cold");
          case "close":
            return yield* setStatus(rt, "ended");
          case "recover":
          case "rewind":
            return;
          case undefined: {
            const detail = Exit.isFailure(exit)
              ? Cause.pretty(exit.cause)
              : `agent session ended: ${rt.endedReason ?? "unknown reason"}`;
            rt.endedReason = undefined;
            return yield* Option.isSome(unavailable)
              ? failUnavailable(rt, unavailable.value, detail)
              : setStatus(rt, "error", detail);
          }
        }
      }),
    );

  /** Called with the runtime lock held. */
  const openSession = (rt: Runtime, thread: Thread, resumeAt?: string, switchAttempt?: string) =>
    Effect.gen(function* () {
      if (isShuttingDown()) return;
      if (
        thread.sessionSwitch !== undefined &&
        thread.sessionSwitch.phase !== "checkpoint" &&
        switchAttempt !== thread.sessionSwitch.id
      )
        return yield* new AgentUnavailable({
          agent: thread.model.agent,
          message:
            "An orchestrator switch is holding this session. Review its status before starting another session.",
        });
      const host = yield* hosts.get(thread.model.agent);
      const resume = yield* resumeOptions(thread, resumeAt);
      const policy = yield* policyFor(thread);
      rt.capabilities = host.capabilities;
      rt.cwd = thread.checkout.path;
      rt.quota = `${thread.model.agent}/${thread.model.profileId ?? ""}`;
      rt.profileId = thread.model.profileId;
      rt.agent = thread.model.agent;
      yield* setStatus(rt, "starting");
      const lifetime = Effect.gen(function* () {
        // The bounded Dream bridge survives policy failure. The shared mode separately
        // chooses strict native-tool denial or prompt-guided normal native permissions.
        const dreamSupport =
          thread.role === "dream"
            ? dreamSupportFor(thread.model.agent, { kind: "implementation" })
            : undefined;
        if (dreamSupport?.mode === "unsupported" || dreamSupport?.mode === "unknown")
          return yield* new AgentUnavailable({
            agent: thread.model.agent,
            reason: "startup-failed",
            message: dreamSupport.reason,
          });
        const dreamMode = dreamSupport?.mode;
        const sessionAppTools = currentAppTools();
        const mcp = sessionAppTools === undefined ? Option.none() : yield* mcpEndpoint(rt.threadId);
        const open = (options: ResumeOptions) =>
          host.open({
            threadId: rt.threadId,
            ...(switchAttempt === undefined ? {} : { switchStartup: switchAttempt }),
            cwd: thread.checkout.path,
            model: thread.model,
            permissionMode: thread.mode,
            ...options,
            // Only Codex owns the shared app-server wait protocol. Other providers
            // finish their scoped child teardown before this open.
            ...(rt.restartMarker === undefined || thread.model.agent !== "codex"
              ? {}
              : {
                  waitForPreviousSession: {
                    onWait: locked(
                      rt,
                      setStatus(
                        rt,
                        "starting",
                        "Waiting for the previous Codex server to exit. Other sessions can keep working.",
                      ),
                    ),
                  },
                }),
            ...(thread.additionalDirectories === undefined
              ? {}
              : { additionalDirectories: thread.additionalDirectories }),
            ...(sessionAppTools === undefined ? {} : { appTools: sessionAppTools }),
            ...(Option.isSome(mcp) ? { mcp: mcp.value } : {}),
            audience: thread.role === "dream" ? "dream" : policy.audience,
            ...(thread.role === "dream"
              ? {
                  dreamFilesOnly: dreamMode === "confined",
                  dreamGuided: dreamMode === "guided",
                  confineWrites: true,
                  instructions: dreamRolePromptFor(thread.model.agent),
                }
              : {}),
            ...(thread.role === "dream" || policy.instructions === undefined
              ? {}
              : { instructions: policy.instructions }),
            ...(dreamMode === "guided" || policy.outwardGate === undefined
              ? {}
              : { outwardGate: policy.outwardGate }),
            ...(policy.confineWrites === true ? { confineWrites: true } : {}),
            ...(policy.pinCwd === true ? { pinCwd: true } : {}),
            ...(policy.mcpAllowlist === undefined ? {} : { mcpAllowlist: policy.mcpAllowlist }),
            ...(policy.mcpDenylist === undefined ? {} : { mcpDenylist: policy.mcpDenylist }),
            ...(policy.mcpNoneWithoutToolSearch === true ? { mcpNoneWithoutToolSearch: true } : {}),
            ...(policy.noBlockingAsk === true ? { noBlockingAsk: true } : {}),
            ...(policy.peerMessaging === true ? { peerMessaging: true } : {}),
            onConnectorsSeen: (seen) => {
              recordSeen(seenConnectors.record(seen));
            },
          });
        const session = yield* open(resume).pipe(
          Effect.catchTag("AgentUnavailable", (error) => {
            const ownResume =
              resume.resumeId !== undefined &&
              resume.fork !== true &&
              resume.resumeId === thread.agentSessionId;
            if (error.reason !== "session-not-found" || !ownResume) return Effect.fail(error);
            // A session opened and evicted before `agentSessionUnused` existed has an id but no
            // transcript: mark it and open once more, fresh under the same id.
            return Effect.gen(function* () {
              const marked = yield* store
                .updateThread(rt.threadId, (t) => ({ ...t, agentSessionUnused: true }))
                .pipe(Effect.orDie);
              yield* publishUpsert(marked);
              const fresh = yield* open(yield* resumeOptions(marked, resumeAt));
              // A thread with a conversation (e.g. a transcript Claude Code cleaned up) continues
              // without the agent's memory of it, so say so.
              if ((yield* store.listMessages(rt.threadId)).length > 0) {
                yield* hub.publish({
                  type: "notify",
                  kind: "info",
                  title:
                    "The previous Claude conversation couldn't be found, so this thread continues in a fresh session.",
                  threadId: rt.threadId,
                });
              }
              return fresh;
            });
          }),
        );
        yield* locked(
          rt,
          Effect.gen(function* () {
            rt.session = session;
            rt.reopening = false;
            // An MCP edit can arrive while a restart waits for its former child to exit. The
            // adapter acquires its held child after that wait, so it may already have read this
            // newer config. Do not close it again onto its own writer fence. Changed workspace
            // policy still needs a reopen, even when that child is current for the disk config.
            if (
              rt.pendingRestart === "mcpConfig" &&
              session.configCurrent !== undefined &&
              (yield* session.configCurrent) &&
              JSON.stringify(policy) ===
                JSON.stringify(
                  yield* policyFor(yield* store.getThread(rt.threadId).pipe(Effect.orDie)),
                )
            ) {
              yield* setPendingRestart(rt, undefined);
            }
            openCostSession(rt.cost);
            if (rt.restartMarker !== undefined) {
              const reason = rt.restartMarker;
              rt.restartMarker = undefined;
              const at = yield* Clock.currentTimeMillis;
              yield* appendDataPart(rt, {
                type: "data-session-restart",
                id: randomUUID(),
                data: reason === "asked" ? { at } : { at, reason },
              });
            }
            // A switch made while the session was opening was only recorded. Apply it before the
            // first idle drains the queue: live, or by reopening when the session can't run it.
            const latest = (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model;
            if (
              latest.model !== thread.model.model ||
              latest.variant !== thread.model.variant ||
              latest.speed !== thread.model.speed
            ) {
              if (session.needsReopenFor?.(latest.model) === true) rt.reopenOnIdle = true;
              else yield* session.setModel(latest);
            }
          }),
        );
        yield* Stream.runForEach(session.events, (event) => handleEvent(rt, event));
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) => {
          if (isShuttingDown() && Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
            markShutdownFailed();
          return handleSessionExit(rt, exit).pipe(
            Effect.onExit((handled) =>
              Effect.sync(() => {
                if (isShuttingDown() && Exit.isFailure(handled)) markShutdownFailed();
              }),
            ),
          );
        }),
      );
      yield* FiberMap.run(sessions, rt.threadId, lifetime);
    });

  const recover = (rt: Runtime, turnId: TurnId) =>
    Effect.gen(function* () {
      const stillRunning = yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing || rt.turn?.id !== turnId) return false;
          yield* finishTurn(rt, "interrupted", "recovered");
          // As in `reopenWhenIdle`: sends queue while `starting`, and go out once the session is idle.
          yield* setStatus(rt, "starting");
          return true;
        }),
      );
      if (!stillRunning) return;
      yield* Effect.logWarning("interrupt watchdog fired; closing and resuming the session").pipe(
        Effect.annotateLogs({ threadId: rt.threadId }),
      );
      yield* stopSession(rt, "recover");
      yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing) return;
          // This open reads the thread as it is now, which is all a reopen waiting on idle wants.
          rt.reopenOnIdle = false;
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          yield* openSession(rt, thread).pipe(
            Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
          );
        }),
      );
    });

  /** Runs `recover` in `recoveries`, or waits for the one already running for the thread. */
  const recoverOwned = (rt: Runtime, turnId: TurnId) =>
    Effect.gen(function* () {
      yield* FiberMap.run(recoveries, rt.threadId, recover(rt, turnId), { onlyIfMissing: true });
      const running = FiberMap.getUnsafe(recoveries, rt.threadId);
      if (Option.isNone(running)) return;
      const exit = yield* Fiber.await(running.value);
      // Closing the thread cancels its recovery, which is no failure of the interrupt.
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause);
      }
    });

  return { stopInMissing, forkStopInMissing, openSession, recoverOwned };
};
