import { isUntrustedWorktree } from "@gram/git";
import type { DecisionHookShape } from "../embedding/decision-hook.ts";
import { hookedSessionOptions } from "../embedding/hooked-requests.ts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import {
  AWAITS_MACHINE,
  RUNS_ON_SERVER,
  type Runtime,
  locked,
  feedLocked,
  replyOf,
  makeQueueItemId,
} from "./runtime-state.ts";
import {
  type AfterMachineRestart,
  afterMachineRestart,
  MACHINE_RESTART_KEY,
  machineRestartText,
  machineRestartToolText,
  restartMarkerOf,
} from "./machine-restart.ts";
import { endMachineMove } from "./machine-move.ts";
import { commandDuring, machineLostToolText } from "./machine-lost.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import {
  type AgentEvent,
  type AgentKind,
  AgentUnavailable,
  type Thread,
  type TurnId,
  type ThreadId,
  sessionHostOf,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import { UNKNOWN_FAILURE } from "./thread-error.ts";
import { accountOf, machineAccountScope } from "./limit-wait.ts";
import { renderLostSession, renderMovedSession } from "./switch-handoff.ts";
import { recentTurnsOf } from "./recent-turns.ts";

const agentName = (agent: AgentKind): string => (agent === "codex" ? "Codex" : "Claude");
import { dreamSupportFor, sequenceEvents, type AppToolRegistryPort } from "@gram/agents";
import type { ResumeOptions, ResumePlans } from "./history-plans.ts";
import { dreamRolePromptFor } from "../orchestration/dream-prompt.ts";
import { openCostSession } from "./cost-ledger.ts";
import { randomUUID } from "node:crypto";
import type { AgentHosts } from "./agent-hosts.ts";
import type { ClaudeAiSeenShape } from "../connectors/claude-ai-seen.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { folderBringsNothing, projectFolderTrusted } from "../settings/folder-trust.ts";
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
import type { UsageLimitReadingsShape } from "../usage/limit-readings.ts";
import { sharedFolderNote } from "../shared/note.ts";
import { sessionWorktreeActivation, type makeWorktreeActivations } from "./worktree-activations.ts";
import { scopedKeepingFailure } from "./session-scope.ts";

const SETTLED: AgentEvent = { type: "status", status: "idle" };

/** What opening and ending a session read and change beside a thread's `Runtime`. */
export interface SessionLifecycleDeps {
  readonly accountScopeFor: (thread: Thread) => Effect.Effect<string | undefined>;
  readonly limitReadings: Option.Option<UsageLimitReadingsShape>;
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly checkouts: CheckoutServiceShape;
  readonly hosts: AgentHosts["Service"];
  readonly sessions: FiberMap.FiberMap<ThreadId>;
  readonly worktreeActivations: ReturnType<typeof makeWorktreeActivations> | undefined;
  /** The decision hook, where one is configured: a session under it asks about every outward call. */
  readonly decisions: DecisionHookShape | undefined;
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
  readonly opening: SessionPolicies["opening"];
  readonly setPendingRestart: SessionRestarts["setPendingRestart"];
  readonly resumeOptions: ResumePlans["resumeOptions"];
  readonly handleEvent: AgentEvents["handleEvent"];
  readonly setBackground: AgentEvents["setBackground"];
  readonly setLapsedConnectors: AgentEvents["setLapsedConnectors"];
  readonly isShuttingDown: () => boolean;
  readonly markShutdownFailed: () => void;
  readonly currentAppTools: () => AppToolRegistryPort | undefined;
  /** The workspace's shared folder on the thread's machine, for its session; none without one. */
  readonly sharedFolder: (thread: Thread) => Effect.Effect<string | undefined>;
}

/** The sessions `ThreadRuntimes` runs, one per thread, each in `sessions`. */
export const makeSessionLifecycle = ({
  accountScopeFor,
  limitReadings,
  decisions,
  store,
  hub,
  checkouts,
  hosts,
  sessions,
  worktreeActivations,
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
  opening,
  setPendingRestart,
  resumeOptions,
  handleEvent,
  setBackground,
  setLapsedConnectors,
  isShuttingDown,
  markShutdownFailed,
  currentAppTools,
  sharedFolder,
}: SessionLifecycleDeps) => {
  const lostSessionContext = (rt: Runtime, agent: AgentKind, movedFrom?: string) =>
    recentTurnsOf(store, rt).pipe(
      Effect.map((turns) =>
        turns === undefined
          ? undefined
          : movedFrom === undefined
            ? renderLostSession(agent, turns)
            : renderMovedSession(agent, turns, movedFrom),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't read a thread's recent turns for its new session").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, cause: Cause.pretty(cause) }),
          Effect.as(undefined),
        ),
      ),
    );

  const machineContinuations = new Map<ThreadId, ReadonlyArray<number>>();

  const machineRestartPlan = (
    rt: Runtime,
    stopping: Runtime["stopping"],
    exit: Exit.Exit<void, AgentUnavailable>,
    turnCut: boolean,
  ): Effect.Effect<AfterMachineRestart | undefined> =>
    Effect.gen(function* () {
      const machine = rt.restartedMachine;
      const moved = rt.machineMoved === true;
      rt.restartedMachine = undefined;
      rt.machineMoved = undefined;
      if (
        machine === undefined ||
        stopping !== undefined ||
        Exit.isFailure(exit) ||
        isShuttingDown() ||
        rt.closing
      )
        return undefined;
      const turn = rt.turn;
      const waitingOnUser =
        rt.status === "needsApproval" ||
        rt.status === "needsInput" ||
        (yield* store.listRequests(rt.threadId)).length > 0;
      const { next, recent } = afterMachineRestart({
        machine,
        moved,
        turnCut,
        turnOpen: turn !== undefined,
        stopAsked:
          turn !== undefined && (rt.stopAsked === turn.id || rt.stopAtBoundary === turn.id),
        queued: rt.queue.length > 0 || rt.deliveries.size > 0,
        waitingOnUser,
        recent: machineContinuations.get(rt.threadId) ?? [],
        now: yield* Clock.currentTimeMillis,
      });
      machineContinuations.set(rt.threadId, recent);
      yield* Effect.logInfo("a joined machine restarted under a session").pipe(
        Effect.annotateLogs({ threadId: rt.threadId, outcome: next.kind, moved }),
      );
      return next;
    });

  const resumeAfterRestart = (
    rt: Runtime,
    ended: Option.Option<Fiber.Fiber<unknown, unknown>>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (Option.isSome(ended)) yield* Fiber.await(ended.value);
      yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing || rt.session !== undefined || rt.status !== "starting") return;
          rt.reopenOnIdle = false;
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          yield* openSession(rt, thread).pipe(
            Effect.catchTag("AgentUnavailable", (e) =>
              Effect.andThen(
                Effect.sync(() => {
                  rt.machineRestart = undefined;
                }),
                failUnavailable(rt, e),
              ),
            ),
          );
        }),
      );
    });

  const stopInMissing = (rt: Runtime) =>
    Effect.gen(function* () {
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
        const onItsOwn = Exit.isSuccess(exit) && rt.stopping === "recover";
        if (Exit.isSuccess(exit)) rt.endedOnItsOwn = rt.session;
        const stopping = onItsOwn ? undefined : rt.stopping;
        rt.stopping = undefined;
        rt.session = undefined;
        rt.sessionBrowser = false;
        rt.agentRunning = false;
        if (stopping !== "recover") {
          rt.restartMarker = undefined;
          yield* setPendingRestart(rt, undefined);
        }
        if (rt.launch !== undefined && stopping !== "recover") {
          const { id, input } = rt.launch;
          yield* withdrawMessage(rt, id);
          rt.queue.unshift({ id, input });
          rt.launch = undefined;
          yield* syncQueue(rt);
        }
        const turnCut =
          rt.turn !== undefined && (rt.inFlight === undefined || rt.inFlight.turnId !== rt.turn.id);
        if (rt.inFlight !== undefined) {
          const { id, input } = rt.inFlight;
          yield* withdrawMessage(rt, id);
          rt.queue.unshift({ id, input });
          rt.inFlight = undefined;
          yield* syncQueue(rt);
        }
        const restart = yield* machineRestartPlan(rt, stopping, exit, turnCut);
        if (restart?.kind === "fail") rt.endedReason = restart.reason;
        const carriesOn = restart?.kind === "continue" || restart?.kind === "rest";
        const lostMachine =
          restart === undefined && stopping === undefined ? rt.lostMachine : undefined;
        rt.lostMachine = undefined;
        const lostDuring =
          lostMachine === undefined
            ? undefined
            : commandDuring(
                [...rt.open.values()].flatMap((inFlight) =>
                  inFlight.accumulator
                    .unfinishedTools()
                    .map((id) => inFlight.accumulator.toolPart(id)?.["input"]),
                ),
              );
        yield* setBackground(rt, []);
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
              const cut =
                restart === undefined && lostMachine === undefined
                  ? []
                  : inFlight.accumulator.unfinishedTools();
              const errorText =
                restart !== undefined
                  ? machineRestartToolText(restart.machine, restart.moved)
                  : lostMachine !== undefined
                    ? machineLostToolText(lostMachine)
                    : "";
              for (const toolCallId of cut) {
                yield* appendChunkLocked(rt, inFlight.messageId, {
                  type: "tool-output-error",
                  toolCallId,
                  errorText,
                });
              }
              if (preliminary.length > 0 || cut.length > 0)
                yield* appendChunkLocked(rt, inFlight.messageId, { type: "finish" });
            }
          }),
        );
        yield* setLapsedConnectors(rt, []);
        yield* endMachineMove(store, publishUpsert, rt.threadId);
        yield* setRetrying(rt, false);
        const turnId = rt.turn?.id;
        const endedMidTurn = stopping === undefined && turnId !== undefined;
        const kept = (yield* store.getThread(rt.threadId).pipe(Effect.option)).pipe(
          Option.flatMap((thread) => Option.fromUndefinedOr(thread.lastError)),
        );
        const exitDetail = Exit.isFailure(exit)
          ? "the agent session failed"
          : `agent session ended: ${rt.endedReason ?? "unknown reason"}`;
        const replyId = replyOf(rt, turnId);
        const unavailable = Exit.isFailure(exit)
          ? Cause.findErrorOption(exit.cause)
          : Option.none();
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
        const exitError =
          stopping === undefined &&
          !carriesOn &&
          !interrupted &&
          !isShuttingDown() &&
          Option.isNone(unavailable) &&
          (endedMidTurn || Option.isNone(kept) || lostMachine !== undefined)
            ? yield* recordFailure(
                rt,
                UNKNOWN_FAILURE,
                exitDetail,
                turnId,
                lostMachine === undefined
                  ? undefined
                  : {
                      machine: lostMachine,
                      ...(lostDuring === undefined ? {} : { during: lostDuring }),
                    },
              )
            : undefined;
        if (isShuttingDown()) {
          yield* closeOpenMessages(rt);
        } else {
          if (rt.turn !== undefined) {
            yield* finishTurn(
              rt,
              stopping === undefined && !carriesOn ? "error" : "interrupted",
              "sessionExit",
            );
          }
          yield* closeLanes(rt);
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
            if (restart?.kind === "rest") {
              rt.endedReason = undefined;
              return yield* setStatus(rt, "cold");
            }
            if (restart?.kind === "continue") {
              rt.endedReason = undefined;
              if (restart.continued === "turn") {
                const id = makeQueueItemId();
                rt.queue.unshift({
                  id,
                  input: {
                    text: machineRestartText(restart.machine, restart.moved),
                    author: "server",
                  },
                });
                rt.noticeKeys.set(id, MACHINE_RESTART_KEY);
                rt.actors.set(id, "server");
                yield* syncQueue(rt);
              }
              rt.machineRestart = restartMarkerOf(restart);
              yield* setStatus(rt, "starting");
              const ended = FiberMap.getUnsafe(sessions, rt.threadId);
              yield* FiberMap.run(recoveries, rt.threadId, resumeAfterRestart(rt, ended));
              return;
            }
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

  const openSession = (rt: Runtime, thread: Thread, resumeAt?: string, switchAttempt?: string) =>
    Effect.gen(function* () {
      if (isShuttingDown()) return;
      if (thread.awaitingMachine !== undefined)
        return yield* new AgentUnavailable({
          agent: thread.model.agent,
          reason: "startup-failed",
          message: AWAITS_MACHINE,
        });
      if (thread.sentTo !== undefined)
        return yield* new AgentUnavailable({
          agent: thread.model.agent,
          reason: "startup-failed",
          message: RUNS_ON_SERVER,
        });
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
      const project = (yield* store.listProjects).find((p) => p.id === thread.projectId);
      const folderTrusted =
        project === undefined ||
        projectFolderTrusted(
          project,
          sessionHostOf(thread) === LOCAL_HOST_ID
            ? folderBringsNothing(thread.checkout.path)
            : () => false,
        );
      const resume = yield* resumeOptions(thread, resumeAt);
      const policy = yield* policyFor(thread);
      yield* opening(thread);
      const hooked =
        decisions !== undefined && thread.role !== "dream" && (yield* decisions.enabled);
      rt.capabilities = host.capabilities;
      rt.cwd = thread.checkout.path;
      rt.accountScope = yield* accountScopeFor(thread);
      rt.quota = accountOf({ ...thread.model, accountScope: rt.accountScope });
      if (
        sessionHostOf(thread) === LOCAL_HOST_ID &&
        thread.model.profileId === undefined &&
        Option.isSome(limitReadings)
      ) {
        const machine = sessionHostOf(thread);
        const meterScope =
          rt.accountScope === machineAccountScope(machine, `thread:${thread.id}`)
            ? (limitReadings.value.scopeFor?.(machine, "unknown") ??
              machineAccountScope(machine, "unknown"))
            : rt.accountScope;
        yield* limitReadings.value.selectAccount?.(thread.model.agent, meterScope) ?? Effect.void;
      }
      rt.profileId = thread.model.profileId;
      rt.agent = thread.model.agent;
      const hooks = sessionWorktreeActivation(worktreeActivations, rt, thread);
      yield* setStatus(rt, "starting");
      const lifetime = Effect.gen(function* () {
        yield* hooks.beforeOpen;
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
        const shared = thread.role === "dream" ? undefined : yield* sharedFolder(thread);
        const directories =
          shared === undefined
            ? thread.additionalDirectories
            : [...(thread.additionalDirectories ?? []), shared];
        const instructions =
          shared === undefined
            ? policy.instructions
            : [policy.instructions, sharedFolderNote(shared)]
                .filter((part) => part !== undefined && part !== "")
                .join("\n\n");
        const open = (options: ResumeOptions) =>
          host.open({
            threadId: rt.threadId,
            ...(switchAttempt === undefined ? {} : { switchStartup: switchAttempt }),
            cwd: thread.checkout.path,
            model: thread.model,
            permissionMode: thread.mode,
            ...options,
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
            ...(directories === undefined ? {} : { additionalDirectories: directories }),
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
            ...(thread.role === "dream" || instructions === undefined ? {} : { instructions }),
            ...(dreamMode === "guided" || policy.outwardGate === undefined
              ? {}
              : { outwardGate: policy.outwardGate }),
            ...(hooked ? hookedSessionOptions : {}),
            ...(policy.confineWrites === true ? { confineWrites: true } : {}),
            ...(thread.checkout.untrusted === true ||
            isUntrustedWorktree(thread.checkout.path) ||
            !folderTrusted
              ? { untrustedTree: true }
              : {}),
            ...(policy.pinCwd === true ? { pinCwd: true } : {}),
            ...(policy.mcpAllowlist === undefined ? {} : { mcpAllowlist: policy.mcpAllowlist }),
            ...(policy.mcpDenylist === undefined ? {} : { mcpDenylist: policy.mcpDenylist }),
            ...(policy.mcpServer === undefined ? {} : { mcpServer: policy.mcpServer }),
            ...(policy.mcpNoneWithoutToolSearch === true ? { mcpNoneWithoutToolSearch: true } : {}),
            ...(policy.noBlockingAsk === true ? { noBlockingAsk: true } : {}),
            ...(policy.peerMessaging === true ? { peerMessaging: true } : {}),
            browser: policy.browser === true && thread.role !== "dream",
            ...(policy.browserSurfaces === undefined
              ? {}
              : { browserSurfaces: policy.browserSurfaces }),
            ...(policy.browserScope === undefined ? {} : { browserScope: policy.browserScope }),
            ...(policy.browserAsk === true ? { browserAsk: true } : {}),
            onConnectorsSeen: (seen) => {
              recordSeen(seenConnectors.record(seen));
            },
          });
        let lost: string | undefined;
        const session = yield* open(resume).pipe(
          Effect.catchTag("AgentUnavailable", (error) => {
            const ownResume =
              resume.resumeId !== undefined &&
              resume.fork !== true &&
              resume.resumeId === thread.agentSessionId;
            if (error.reason !== "session-not-found" || !ownResume) return Effect.fail(error);
            return Effect.gen(function* () {
              const marked = yield* store
                .updateThread(rt.threadId, (t) => ({ ...t, agentSessionUnused: true }))
                .pipe(Effect.orDie);
              yield* publishUpsert(marked);
              const fresh = yield* open(yield* resumeOptions(marked, resumeAt));
              if (yield* store.hasMessages(rt.threadId)) {
                lost = yield* lostSessionContext(rt, thread.model.agent);
                yield* Effect.logWarning("an agent's conversation couldn't be resumed").pipe(
                  Effect.annotateLogs({ threadId: rt.threadId, seeded: lost !== undefined }),
                );
                yield* hub.publish({
                  type: "notify",
                  kind: "info",
                  title:
                    lost === undefined
                      ? `The previous ${agentName(thread.model.agent)} conversation couldn't be found, so this thread continues in a fresh session.`
                      : `The previous ${agentName(thread.model.agent)} conversation couldn't be found, so this thread continues in a new session given its recent turns.`,
                  threadId: rt.threadId,
                });
              }
              return fresh;
            });
          }),
        );
        yield* hooks.beforeAdmission(session.reattached === true);
        const moved = thread.transferredFrom;
        if (moved !== undefined && moved.seeded !== true && lost === undefined) {
          lost = yield* lostSessionContext(rt, thread.model.agent, moved.name);
          const marked = yield* store
            .updateThread(rt.threadId, (t) =>
              t.transferredFrom === undefined
                ? t
                : { ...t, transferredFrom: { ...t.transferredFrom, seeded: true } },
            )
            .pipe(Effect.orDie);
          yield* publishUpsert(marked);
        }
        yield* locked(
          rt,
          Effect.gen(function* () {
            hooks.admitted(session.reattached === true);
            rt.session = session;
            if (lost !== undefined) rt.lostSession = lost;
            rt.sessionBrowser = policy.browser === true && thread.role !== "dream";
            rt.reopening = false;
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
            if (rt.machineRestart !== undefined) {
              const machineRestart = rt.machineRestart;
              rt.machineRestart = undefined;
              yield* appendDataPart(rt, {
                type: "data-session-restart",
                id: randomUUID(),
                data: { at: yield* Clock.currentTimeMillis, machineRestart },
              });
            }
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
        const settle = session.reattached === true && rt.turn === undefined;
        const log = yield* sequenceEvents(
          settle
            ? Stream.concat(Stream.succeed<AgentEvent>(SETTLED), session.events)
            : session.events,
        );
        const added = settle ? 1 : 0;
        yield* Stream.runForEach(log.subscribe(), ({ seq, event }) =>
          handleEvent(rt, event).pipe(
            Effect.andThen(log.ack(seq)),
            Effect.andThen(
              Effect.sync(() => {
                if (seq > added) session.handled?.(seq - added);
              }),
            ),
          ),
        );
      }).pipe(
        scopedKeepingFailure,
        Effect.onExit((exit) => {
          hooks.ended();
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
          rt.reopenOnIdle = false;
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          yield* openSession(rt, thread).pipe(
            Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
          );
        }),
      );
    });

  const recoverOwned = (rt: Runtime, turnId: TurnId) =>
    Effect.gen(function* () {
      yield* FiberMap.run(recoveries, rt.threadId, recover(rt, turnId), { onlyIfMissing: true });
      const running = FiberMap.getUnsafe(recoveries, rt.threadId);
      if (Option.isNone(running)) return;
      const exit = yield* Fiber.await(running.value);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause);
      }
    });

  return { stopInMissing, forkStopInMissing, openSession, recoverOwned };
};
