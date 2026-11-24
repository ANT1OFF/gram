import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FiberMap from "effect/FiberMap";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import {
  type Runtime,
  locked,
  showsProgress,
  evictable,
  agentStatus,
  sameCompaction,
  idleCompactionMarker,
  runHook,
  feedLocked,
  openLane,
  openReply,
  replyOf,
  noteEnded,
  BACKGROUND_OUTPUT_CHARS,
  type Turn,
} from "./runtime-state.ts";
import { startMachineMove } from "./machine-move.ts";
import {
  type AgentEvent,
  type BackgroundOutput,
  type BackgroundTask,
  checkoutRoots,
  type GramUIMessageChunk,
  listedRow,
  LOCAL_HOST_ID,
  MessageId,
  type PermissionMode,
  type RequestId,
  type ServerEvent,
  sessionHostOf,
  type Thread,
  type ThreadId,
  type UsageSummary,
} from "@gram/contracts";
import { BACKGROUND_SETTLE } from "./session-restarts.ts";
import { touchesRemote } from "./remote-commands.ts";
import { captureToolImageSource } from "../attachments/tool-image-source.ts";
import { attachmentsDir } from "../attachments/attachments.ts";
import { storeToolImage } from "../attachments/tool-images.ts";
import { bookCost } from "./cost-ledger.ts";
import { selectableModels } from "./model-efforts.ts";
import { UNKNOWN_FAILURE } from "./thread-error.ts";
import { samePath } from "@gram/git";
import type { AgentHosts } from "./agent-hosts.ts";
import type { DecisionHookShape } from "../embedding/decision-hook.ts";
import type { EventSinkShape } from "../embedding/event-sink.ts";
import { hookedKey, requestActions, type HookedRequests } from "../embedding/hooked-requests.ts";
import { makeHookedDecisions } from "./hooked-decisions.ts";
import { accountOf, type EarlyReleases } from "./limit-wait.ts";
import { withoutSender } from "./session-chunk.ts";
import type { makeRateLimitGate } from "./rate-limits.ts";
import type { AgentSession } from "@gram/agents";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { ServerConfigShape } from "../config.ts";
import type { TurnHooksShape, CheckoutServiceShape } from "./hooks.ts";
import type { ThreadPlansShape } from "../plans/service.ts";
import type { NotifyObservers } from "./runtime-observer.ts";
import type { UsageLimitReadingsShape } from "../usage/limit-readings.ts";
import type { FeedWriter } from "./feed-writer.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { LimitResume } from "./limit-resume.ts";
import type { MessageQueue } from "./message-queue.ts";

/** What an agent's events reach: nearly every other part of `ThreadRuntimes`. */
export interface AgentEventsDeps {
  readonly rememberAccount: (thread: Thread, login: string, previous: string | undefined) => string;
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  /** The decision hook, where one is configured, and the requests it holds (`decideRequest`). */
  readonly decisions: DecisionHookShape | undefined;
  readonly hooked: HookedRequests;
  /** Whether a card of that id is one the server raised (`requestApproval`), which no session's events touch. */
  readonly serverRaised: (requestId: RequestId) => boolean;
  readonly eventSink: EventSinkShape | undefined;
  /** Runs a decision off the event loop of the session that asked, for as long as the service lives. */
  readonly forkDecision: (decision: Effect.Effect<void>) => Effect.Effect<void>;
  readonly config: ServerConfigShape;
  readonly hooks: TurnHooksShape;
  readonly checkouts: CheckoutServiceShape;
  readonly plans: ThreadPlansShape;
  readonly hosts: AgentHosts["Service"];
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly notifyObservers: NotifyObservers;
  readonly limitReadings: Option.Option<UsageLimitReadingsShape>;
  readonly earlyReleases: Map<string, EarlyReleases>;
  readonly rateLimitShown: ReturnType<typeof makeRateLimitGate>;
  readonly restartChecks: FiberMap.FiberMap<ThreadId>;
  readonly appendChunk: FeedWriter["appendChunk"];
  readonly appendChunkLocked: FeedWriter["appendChunkLocked"];
  readonly appendDataPart: FeedWriter["appendDataPart"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly clearQuiet: TurnLifecycle["clearQuiet"];
  readonly scheduleActivity: TurnLifecycle["scheduleActivity"];
  readonly startIdleTimer: TurnLifecycle["startIdleTimer"];
  readonly openTurn: TurnLifecycle["openTurn"];
  readonly markRunning: TurnLifecycle["markRunning"];
  readonly settleDelivery: TurnLifecycle["settleDelivery"];
  readonly noteDeliveryStart: TurnLifecycle["noteDeliveryStart"];
  readonly settleNote: TurnLifecycle["settleNote"];
  readonly recordFailure: TurnLifecycle["recordFailure"];
  readonly keepError: TurnLifecycle["keepError"];
  readonly finishTurn: TurnLifecycle["finishTurn"];
  readonly publishFailure: TurnLifecycle["publishFailure"];
  readonly turnHeld: LimitResume["turnHeld"];
  readonly limitWaitOf: LimitResume["limitWaitOf"];
  readonly queueHeld: LimitResume["queueHeld"];
  readonly switchHold: MessageQueue["switchHold"];
  readonly hitAt: LimitResume["hitAt"];
  readonly startRelease: LimitResume["startRelease"];
  readonly enterWait: LimitResume["enterWait"];
  readonly scheduleAccount: LimitResume["scheduleAccount"];
  readonly setRetrying: (rt: Runtime, retrying: boolean, detail?: string) => Effect.Effect<void>;
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
  readonly forkStopInMissing: (rt: Runtime) => Effect.Effect<void>;
  readonly restartIfPending: (rt: Runtime) => Effect.Effect<void>;
  readonly reopenWhenIdle: (rt: Runtime) => Effect.Effect<void>;
  readonly reopenNow: (rt: Runtime) => Effect.Effect<void>;
  readonly beginBoundaryStop: (
    rt: Runtime,
    session: AgentSession,
    turn: Turn,
  ) => Effect.Effect<void>;
  readonly setCurrentCheckout: ThreadRuntimesShape["setCurrentCheckout"];
}

/**
 * What the old session of a switch began while stopping, that the switch can't carry to its
 * target: a question or approval, a turn (one the agent opened itself), subagent or background
 * work. `undefined` while it stays at rest.
 */
/**
 * The mode in which Gram's own cards go unasked (`makeApprovalGate`): a thread enters it only at
 * the user's pick, never on a session's report.
 */
export const UNASKED_MODES: ReadonlySet<PermissionMode> = new Set(["bypassPermissions"]);

const LATITUDE: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  dontAsk: 4,
  bypassPermissions: 5,
};

/**
 * Whether a session on another machine may move its thread from `current` to `reported`. That
 * machine's word never loosens the thread: every mode the server asks for it sets on the thread
 * first (`setMode`, a session's open), so a looser report there is none of the server's. It may
 * leave plan mode for the modes a plan's approval goes on in, and move to anything stricter.
 */
export const remoteMayReport = (current: PermissionMode, reported: PermissionMode): boolean =>
  LATITUDE[reported] <= LATITUDE[current] ||
  (current === "plan" && (reported === "default" || reported === "acceptEdits"));

const startedDuringStop = (rt: Runtime, event: AgentEvent): string | undefined =>
  event.type === "request"
    ? event.request.kind === "question"
      ? "asked a question"
      : "asked for an approval"
    : rt.turn !== undefined
      ? "started a turn"
      : rt.activity.subagentsRunning
        ? "started a subagent"
        : rt.background.length > 0
          ? "started background work"
          : undefined;

/** The handler every live session's events go through, one at a time under the runtime lock. */
export const makeAgentEvents = ({
  rememberAccount,
  store,
  hub,
  decisions,
  hooked,
  serverRaised,
  eventSink,
  forkDecision,
  config,
  hooks,
  checkouts,
  plans,
  hosts,
  runtimes,
  notifyObservers,
  limitReadings,
  earlyReleases,
  rateLimitShown,
  restartChecks,
  appendChunk,
  appendChunkLocked,
  appendDataPart,
  publishUpsert,
  setStatus,
  clearQuiet,
  scheduleActivity,
  startIdleTimer,
  openTurn,
  markRunning,
  settleDelivery,
  noteDeliveryStart,
  settleNote,
  recordFailure,
  keepError,
  finishTurn,
  publishFailure,
  turnHeld,
  limitWaitOf,
  queueHeld,
  switchHold,
  hitAt,
  startRelease,
  enterWait,
  scheduleAccount,
  setRetrying,
  becomeIdle,
  forkStopInMissing,
  restartIfPending,
  reopenWhenIdle,
  reopenNow,
  beginBoundaryStop,
  setCurrentCheckout,
}: AgentEventsDeps) => {
  const healQueue = (rt: Runtime) =>
    Effect.gen(function* () {
      if (
        rt.queue.length === 0 ||
        rt.status !== "idle" ||
        rt.turn !== undefined ||
        rt.session === undefined ||
        rt.closing ||
        rt.reserved ||
        rt.reopening ||
        rt.reopenOnIdle
      ) {
        return;
      }
      if (rt.noticeKeys.has(rt.queue[0]!.id)) {
        const parked = yield* store.getThread(rt.threadId).pipe(
          Effect.map((thread) => thread.parked),
          Effect.orElseSucceed(() => false),
        );
        if (parked) return;
      }
      const held =
        (yield* switchHold(rt).pipe(Effect.orElseSucceed(() => undefined))) !== undefined ||
        rt.limitWait !== undefined ||
        (yield* queueHeld(rt));
      if (!held) {
        yield* Effect.logWarning("queued input waited on an idle thread; sending it").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, queued: rt.queue.length }),
        );
      }
      yield* becomeIdle(rt);
    });

  const { raiseCard, decideRequest, replaceAsked, replayed } = makeHookedDecisions({
    store,
    hub,
    hooked,
    eventSink,
    setStatus,
  });

  const splitAfterSteer = (rt: Runtime, sent: AgentEvent) =>
    Effect.gen(function* () {
      const original = "messageId" in sent ? sent.messageId : undefined;
      const aliased = original === undefined ? undefined : rt.replyAliases.get(original);
      const event: AgentEvent =
        aliased === undefined || !("messageId" in sent) ? sent : { ...sent, messageId: aliased };
      if (event.type !== "chunk" || original === undefined) return event;
      const { chunk } = event;
      if (aliased !== undefined && (chunk.type === "finish" || chunk.type === "abort")) {
        rt.replyAliases.delete(original);
      }
      const split = rt.steerSplit;
      if (split === undefined) return event;
      const reply = rt.open.get(split.reply);
      if (split.turnId !== rt.turn?.id || reply === undefined || reply.finished) {
        rt.steerSplit = undefined;
        return event;
      }
      if (event.messageId !== split.reply) return event;
      const startsPart =
        chunk.type === "start-step" ||
        chunk.type === "text-start" ||
        chunk.type === "reasoning-start" ||
        ((chunk.type === "tool-input-start" || chunk.type === "tool-input-available") &&
          reply.accumulator.toolPart(chunk.toolCallId) === undefined);
      if (!startsPart || !reply.accumulator.settled()) return event;
      rt.steerSplit = undefined;
      const said = reply.accumulator.snapshot().metadata;
      if (chunk.type !== "start-step")
        yield* appendChunk(rt, reply.messageId, { type: "finish-step" });
      yield* appendChunk(rt, reply.messageId, { type: "finish" });
      rt.toolTimes.delete(reply.messageId);
      const next = MessageId.make(`reply-${randomUUID()}`);
      rt.replyAliases.set(original, next);
      yield* appendChunk(rt, next, {
        type: "start",
        messageMetadata: {
          ...(said?.agent === undefined ? {} : { agent: said.agent }),
          ...(said?.agentSessionId === undefined ? {} : { agentSessionId: said.agentSessionId }),
          ...(said?.agentMessageIds === undefined ? {} : { agentMessageIds: said.agentMessageIds }),
        },
      });
      if (chunk.type !== "start-step") yield* appendChunk(rt, next, { type: "start-step" });
      return { ...event, messageId: next };
    });

  const handleEvent = (rt: Runtime, sent: AgentEvent) =>
    locked(
      rt,
      Effect.gen(function* () {
        const event = yield* splitAfterSteer(rt, sent);
        const lane = event.type === "chunk" ? rt.open.get(event.messageId) : undefined;
        yield* noteDeliveryStart(
          rt,
          event,
          event.type === "chunk" &&
            (lane === undefined
              ? event.chunk.type === "start" &&
                event.chunk.messageMetadata?.parentToolUseId === undefined
              : lane.nested !== true && lane.turnId === rt.turn?.id),
        );
        const foregroundProgress =
          lane?.parentToolUseId !== undefined &&
          lane.turnId === rt.turn?.id &&
          rt.runningTools.has(lane.parentToolUseId) &&
          !rt.background.some((task) => task.toolCallId === lane.parentToolUseId);
        if (
          event.type === "chunk" &&
          showsProgress(event.chunk) &&
          ((lane?.nested !== true && (lane === undefined || lane.turnId === rt.turn?.id)) ||
            foregroundProgress)
        ) {
          rt.lastProgressAt = yield* Clock.currentTimeMillis;
          yield* clearQuiet(rt);
          if (
            lane?.nested !== true &&
            (event.chunk.type === "tool-input-start" || event.chunk.type === "tool-input-available")
          ) {
            rt.lastTool = event.chunk.toolName;
            rt.runningTools.add(event.chunk.toolCallId);
          } else if (
            lane?.nested !== true &&
            (event.chunk.type === "tool-output-available" ||
              event.chunk.type === "tool-output-error") &&
            !(event.chunk.type === "tool-output-available" && event.chunk.preliminary === true)
          ) {
            rt.runningTools.delete(event.chunk.toolCallId);
            if (rt.turn !== undefined) rt.turn.lastInputAt = rt.lastProgressAt;
          }
        }
        if (
          event.type === "chunk" &&
          (event.chunk.type === "finish" || event.chunk.type === "abort") &&
          rt.open.get(event.messageId)?.nested !== true &&
          rt.open.get(event.messageId)?.turnId === rt.turn?.id
        ) {
          rt.runningTools.clear();
        }
        const subagentsRunning = rt.activity.subagentsRunning;
        const tasksRunning = rt.background.length > 0;
        const changed = rt.activity.apply(event, rt.cwd);
        yield* applyEvent(rt, event);
        if (rt.switchFence !== undefined) rt.switchFence.arrived ??= startedDuringStop(rt, event);
        if (changed) yield* scheduleActivity(rt);
        const tasksDone = tasksRunning && rt.background.length === 0;
        if ((subagentsRunning || tasksDone) && evictable(rt)) yield* startIdleTimer(rt);
        yield* healQueue(rt);
        if (tasksDone && rt.pendingRestart !== undefined) {
          rt.tasksEndedAt = yield* Clock.currentTimeMillis;
          yield* FiberMap.run(
            restartChecks,
            rt.threadId,
            Effect.sleep(BACKGROUND_SETTLE).pipe(Effect.andThen(locked(rt, restartIfPending(rt)))),
          );
        }
        yield* restartIfPending(rt);
      }),
    );

  const stampToolTime = (rt: Runtime, messageId: MessageId, chunk: GramUIMessageChunk) =>
    Effect.gen(function* () {
      if (chunk.type === "finish" || chunk.type === "abort") {
        rt.toolTimes.delete(messageId);
        return;
      }
      const started = chunk.type === "tool-input-start" || chunk.type === "tool-input-available";
      const ended =
        (chunk.type === "tool-output-available" && chunk.preliminary !== true) ||
        chunk.type === "tool-output-error" ||
        chunk.type === "tool-output-denied" ||
        chunk.type === "tool-input-error";
      if (!started && !ended) return;
      const lane = rt.open.get(messageId);
      if (lane === undefined || lane.finished) return;
      const { toolCallId } = chunk;
      const times = rt.toolTimes.get(messageId) ?? {};
      const was = times[toolCallId];
      if (started && was !== undefined) return;
      if (ended && (was === undefined || was.endedAt !== undefined)) return;
      const now = yield* Clock.currentTimeMillis;
      const next = {
        ...times,
        [toolCallId]: started ? { startedAt: now } : { startedAt: was!.startedAt, endedAt: now },
      };
      rt.toolTimes.set(messageId, next);
      yield* appendChunk(rt, messageId, {
        type: "message-metadata",
        messageMetadata: { toolTimes: next },
      });
    });

  const applyEvent = (rt: Runtime, event: AgentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "identity": {
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          if (event.accountScope !== undefined && thread.model.profileId === undefined) {
            rt.accountScope = rememberAccount(thread, event.accountScope, rt.accountScope);
            rt.quota = accountOf({ ...thread.model, accountScope: rt.accountScope });
          }
          const newId = thread.agentSessionId !== event.agentSessionId;
          const newHome = event.codexHome !== undefined && thread.codexHome !== event.codexHome;
          if (newId || newHome) {
            const next = yield* store
              .updateThread(rt.threadId, (t) => ({
                ...t,
                ...(newId
                  ? { agentSessionId: event.agentSessionId, agentSessionUnused: true }
                  : {}),
                ...(event.codexHome === undefined ? {} : { codexHome: event.codexHome }),
              }))
              .pipe(Effect.orDie);
            yield* publishUpsert(next);
          }
          rt.identity = { model: event.model, commands: event.commands };
          yield* hub.publish({
            type: "thread.identity",
            threadId: rt.threadId,
            identity: rt.identity,
            ...(rt.capabilities === undefined ? {} : { capabilities: rt.capabilities }),
          });
          if (rt.switchOpening !== undefined && rt.session !== undefined) {
            const switching = (yield* store.getThread(rt.threadId).pipe(Effect.orDie))
              .sessionSwitch;
            if (switching?.id === rt.switchOpening.id && switching.phase === "starting")
              yield* Deferred.succeed(rt.switchOpening.ack, rt.session);
          }
          if (rt.status === "starting") yield* becomeIdle(rt);
          return;
        }
        case "status": {
          if (event.status === "retrying" && rt.turn !== undefined) {
            yield* setRetrying(rt, true, event.detail);
          } else if (event.status !== "retrying") {
            yield* setRetrying(rt, false);
          }
          const status = agentStatus(event.status);
          rt.agentRunning = status === "running" && rt.turn === undefined;
          const errorAtRest = rt.errorAtRest;
          rt.errorAtRest = undefined;
          if (status === "idle") {
            if (errorAtRest?.session === rt.session && rt.status === "error") return;
            if (rt.turn === undefined && rt.status !== "idle") yield* becomeIdle(rt);
            return;
          }
          if (rt.turn === undefined && status === "running") return;
          const compaction =
            event.status === "compacting"
              ? (event.compaction ?? rt.compaction ?? { startedAt: yield* Clock.currentTimeMillis })
              : event.status === "retrying"
                ? event.compaction
                : undefined;
          const compactionChanged = !sameCompaction(rt.compaction, compaction);
          const compactionStartedAt = compaction?.startedAt ?? rt.compaction?.startedAt;
          if (compactionChanged || (event.status === "running" && rt.status === "running")) {
            rt.lastProgressAt = yield* Clock.currentTimeMillis;
            yield* clearQuiet(rt);
          }
          rt.compaction = compaction;
          yield* setStatus(rt, status, event.detail, compactionChanged);
          if (compactionChanged) {
            yield* Effect.logInfo("thread compaction status").pipe(
              Effect.annotateLogs({
                threadId: rt.threadId,
                phase: compaction === undefined ? "cleared" : "published",
                at: yield* Clock.currentTimeMillis,
                startedAt: compactionStartedAt,
                ...(compaction === undefined ? {} : compaction),
                queueLength: rt.queue.length,
              }),
            );
          }
          return;
        }
        case "chunk": {
          const chunk = withoutSender(event.chunk);
          if (
            rt.turn === undefined &&
            chunk.type === "start" &&
            chunk.messageMetadata?.parentToolUseId === undefined
          ) {
            const subagentOpen = [...rt.open.values()].some((m) => m.nested && !m.finished);
            if (chunk.messageMetadata?.initiator === "agent" || subagentOpen) {
              const { turn } = yield* openTurn(rt);
              yield* markRunning(rt, turn);
              if (rt.session !== undefined && (yield* turnHeld(rt.threadId))) {
                yield* beginBoundaryStop(rt, rt.session, turn);
                const held = yield* store.getThread(rt.threadId).pipe(Effect.option);
                if (Option.isSome(held)) {
                  yield* notifyObservers(rt.threadId, "onTurnHeld", (observer) =>
                    observer.onTurnHeld?.(held.value, turn.id),
                  );
                }
              }
            } else {
              yield* Effect.logWarning("an agent reply started outside a turn").pipe(
                Effect.annotateLogs({ threadId: rt.threadId, messageId: event.messageId }),
              );
            }
          }
          yield* appendChunk(rt, event.messageId, idleCompactionMarker(rt, chunk));
          yield* stampToolTime(rt, event.messageId, chunk);
          if (
            rt.turn !== undefined &&
            rt.open.get(event.messageId)?.nested === false &&
            rt.open.get(event.messageId)?.turnId === rt.turn.id
          ) {
            if (rt.carrying?.turnId === rt.turn.id && rt.carrying.steered === undefined) {
              yield* settleDelivery(rt, "accepted");
            }
            yield* settleNote(rt, rt.turn.id, true);
          }
          if (
            rt.turn !== undefined &&
            (((chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
              chunk.delta.length > 0) ||
              chunk.type === "tool-input-available" ||
              (chunk.type === "tool-input-delta" && chunk.inputTextDelta.length > 0)) &&
            rt.open.get(event.messageId)?.nested === false &&
            rt.open.get(event.messageId)?.turnId === rt.turn.id
          ) {
            rt.turn.producedOutput = true;
            const { id: turnId, model } = rt.turn;
            yield* notifyObservers(rt.threadId, "onTurnProgress", (observer) =>
              observer.onTurnProgress?.(rt.threadId, model, turnId),
            );
          }
          if (
            rt.retrying &&
            showsProgress(chunk) &&
            rt.open.get(event.messageId)?.nested === false &&
            rt.open.get(event.messageId)?.turnId === rt.turn?.id
          ) {
            yield* setRetrying(rt, false);
          }
          if (
            chunk.type === "tool-input-available" &&
            rt.cwd !== undefined &&
            !(yield* checkouts.present(rt.cwd))
          ) {
            yield* forkStopInMissing(rt);
          }
          if (chunk.type === "tool-input-available" && touchesRemote(chunk.toolName, chunk.input)) {
            rt.remoteCalls.add(chunk.toolCallId);
            rt.touchedRemote = true;
          } else if (
            (chunk.type === "tool-output-available" || chunk.type === "tool-output-error") &&
            rt.remoteCalls.delete(chunk.toolCallId) &&
            rt.cwd !== undefined
          ) {
            yield* runHook(rt, "onRemoteCommand", hooks.onRemoteCommand(rt.threadId, rt.cwd));
          }
          return;
        }
        case "toolImageRead":
        case "toolImageSource": {
          yield* feedLocked(
            rt,
            Effect.gen(function* () {
              const lane = rt.open.get(event.messageId);
              const turn = rt.turn;
              if (
                event.origin !== "codex-image-view" ||
                turn === undefined ||
                lane === undefined ||
                lane.finished ||
                lane.nested ||
                lane.turnId !== turn.id ||
                lane.imageSources.has(event.toolCallId)
              )
                return;
              const message = lane.accumulator.snapshot();
              const call = message.parts.find(
                (part) => part.type === "dynamic-tool" && part.toolCallId === event.toolCallId,
              );
              if (
                message.metadata?.agent !== "codex" ||
                call?.type !== "dynamic-tool" ||
                call.toolName !== "Read" ||
                call.state !== "input-available" ||
                call.providerExecuted !== true ||
                typeof call.input !== "object" ||
                call.input === null ||
                !("file_path" in call.input) ||
                call.input.file_path !== event.path
              )
                return;
              if (event.type === "toolImageRead") {
                if (!lane.imageReads.has(event.toolCallId))
                  lane.imageReads.set(event.toolCallId, event.path);
                return;
              }
              if (lane.imageReads.get(event.toolCallId) !== event.path) return;
              lane.imageReads.delete(event.toolCallId);
              lane.imageSources.add(event.toolCallId);
              const isCurrent = () =>
                rt.turn === turn && rt.open.get(event.messageId) === lane && !lane.finished;
              const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
              if (sessionHostOf(thread) !== LOCAL_HOST_ID) return;
              const messages = [
                ...(yield* store.messagesWithParts(rt.threadId, ["file", "data-tool-image"])),
                ...[...rt.open.values()].map((reply) => reply.accumulator.snapshot()),
              ];
              const stored = yield* captureToolImageSource(
                attachmentsDir(config.dataDir),
                rt.threadId,
                event,
                checkoutRoots(thread),
                messages,
                {},
                { origin: event.origin, path: event.path, isCurrent },
              );
              if (
                stored !== undefined &&
                rt.turn === turn &&
                rt.open.get(event.messageId) === lane &&
                !lane.finished
              ) {
                yield* appendChunkLocked(rt, event.messageId, {
                  type: "data-tool-image",
                  id: stored.id,
                  data: stored.data,
                });
              }
            }),
          );
          return;
        }
        case "toolImage": {
          const stored = yield* storeToolImage(attachmentsDir(config.dataDir), rt.threadId, event);
          yield* appendChunk(rt, event.messageId, {
            type: "data-tool-image",
            id: stored.id,
            data: stored.data,
          });
          return;
        }
        case "request": {
          const { request } = event;
          if (serverRaised(request.id)) {
            yield* Effect.logWarning("an agent's request reused a server-raised card's id").pipe(
              Effect.annotateLogs({ threadId: rt.threadId, requestId: request.id }),
            );
            return;
          }
          if (yield* replayed(rt, request)) return;
          const key = yield* replaceAsked(rt, request.id);
          if (
            request.kind === "approval" &&
            decisions !== undefined &&
            (yield* decisions.enabled)
          ) {
            const actions = requestActions(request);
            if (actions.length > 0) {
              const deciding = { threadId: rt.threadId, request };
              hooked.deciding.set(key, deciding);
              yield* forkDecision(decideRequest(rt, rt.session, decisions, deciding, actions));
              return;
            }
          }
          yield* raiseCard(rt, request);
          return;
        }
        case "requestResolved": {
          if (serverRaised(event.requestId)) return;
          hooked.deciding.delete(hookedKey(rt.threadId, event.requestId));
          hooked.asked.delete(hookedKey(rt.threadId, event.requestId));
          if (yield* store.removeRequest(rt.threadId, event.requestId)) {
            yield* hub.publish({
              type: "thread.requestResolved",
              threadId: rt.threadId,
              requestId: event.requestId,
            });
          }
          return;
        }
        case "usage": {
          const usage: UsageSummary = {
            tokens: event.tokens,
            ...(event.partial === undefined ? {} : { partial: event.partial }),
            ...(event.telemetryVersion === undefined
              ? {}
              : { telemetryVersion: event.telemetryVersion }),
            ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
            ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
            ...bookCost(rt.cost, event),
            ...(event.cacheWrites === undefined ? {} : { cacheWrites: event.cacheWrites }),
          };
          const unchanged =
            rt.usage !== undefined && JSON.stringify(rt.usage) === JSON.stringify(usage);
          if (rt.turn !== undefined) rt.turn.usage = usage;
          rt.usage = usage;
          yield* setRetrying(rt, false);
          if (!unchanged)
            yield* hub.publish({
              type: "thread.usage",
              threadId: rt.threadId,
              usage,
              ...(rt.turn === undefined ? {} : { turnId: rt.turn.id }),
            });
          return;
        }
        case "subagentUsage": {
          const target = openLane(rt, event.usage.toolCallId) ?? openReply(rt);
          if (target === undefined) return;
          yield* appendChunk(rt, target.messageId, {
            type: "data-subagent-usage",
            id: event.usage.toolCallId,
            data: event.usage,
          });
          return;
        }
        case "plan":
          yield* plans.setTurnPlan(rt.threadId, event.items);
          yield* appendDataPart(rt, {
            type: "data-plan",
            id: "plan",
            data: { items: event.items },
          });
          return;
        case "goal":
          yield* plans.setAgentGoal(rt.threadId, event.objective);
          return;
        case "files":
          if (rt.cwd !== undefined) {
            yield* runHook(rt, "onFilesChanged", hooks.onFilesChanged(rt.threadId, rt.cwd));
          }
          return;
        case "mode": {
          const current = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          if (current.mode === event.mode) return;
          if (
            UNASKED_MODES.has(event.mode) ||
            (sessionHostOf(current) !== LOCAL_HOST_ID && !remoteMayReport(current.mode, event.mode))
          ) {
            yield* Effect.logWarning("a session reported a mode the user didn't pick").pipe(
              Effect.annotateLogs({ threadId: rt.threadId, mode: event.mode }),
            );
            return;
          }
          const thread = yield* store
            .updateThread(rt.threadId, (t) => ({ ...t, mode: event.mode }))
            .pipe(Effect.orDie);
          yield* publishUpsert(thread);
          return;
        }
        case "model": {
          const current = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          if (current.model.model === event.model) return;
          const capabilities = yield* selectableModels(
            store,
            hosts,
            current.model.agent,
            current.model.profileId,
          ).pipe(
            Effect.map((models) => listedRow(models, event.model)),
            Effect.orElseSucceed(() => undefined),
          );
          const efforts = capabilities?.efforts ?? [];
          const disableFast =
            current.model.speed === "fast" && !capabilities?.speeds.includes("fast");
          const thread = yield* store
            .updateThread(rt.threadId, (t) => {
              const { variant, ...rest } = t.model;
              return {
                ...t,
                model: {
                  ...rest,
                  model: event.model,
                  ...(disableFast ? { speed: "standard" as const } : {}),
                  ...(variant !== undefined && efforts.includes(variant) ? { variant } : {}),
                },
              };
            })
            .pipe(Effect.orDie);
          if (rt.turn !== undefined) rt.turn.model = thread.model;
          yield* publishUpsert(thread);
          if (rt.session?.needsReopenFor?.(event.model) === true) yield* reopenWhenIdle(rt);
          else if (disableFast && rt.session !== undefined)
            yield* rt.session.setModel(thread.model);
          return;
        }
        case "speed": {
          const next = yield* store
            .updateThread(rt.threadId, (t) => ({ ...t, speedState: event.state }))
            .pipe(Effect.orDie);
          yield* publishUpsert(next);
          return;
        }
        case "notice":
          yield* hub.publish({
            type: "notify",
            kind: event.level === "error" ? "error" : "info",
            title: event.message,
            ...(event.level === "warning" && event.startupDiagnostic !== undefined
              ? { startupDiagnostic: event.startupDiagnostic }
              : {}),
            ...(event.action === undefined ? {} : { action: event.action }),
            threadId: rt.threadId,
          });
          return;
        case "rateLimit": {
          const { type: _, ...limit } = event;
          const now = yield* Clock.currentTimeMillis;
          if (rt.agent !== undefined) {
            const reading: Extract<ServerEvent, { type: "usageLimit" }> = {
              type: "usageLimit",
              threadId: rt.threadId,
              agent: rt.agent,
              ...(rt.accountScope === undefined ? {} : { accountScope: rt.accountScope }),
              ...(rt.profileId === undefined
                ? {}
                : { gateway: true as const, profileId: rt.profileId }),
              ...limit,
            };
            yield* hub.publish(reading);
            if (limit.status === "rejected" && Option.isSome(limitReadings)) {
              yield* limitReadings.value.record(reading);
            }
          }
          if (limit.status === "allowed" || !rateLimitShown(rt.quota ?? "", limit, now)) return;
          yield* hub.publish({ type: "rateLimit", threadId: rt.threadId, ...limit });
          return;
        }
        case "turnEnd": {
          const turnId = rt.turn?.id;
          const replyId = replyOf(rt, turnId);
          const stopped = turnId !== undefined && rt.stopAsked === turnId;
          const wait =
            event.reason === "error" &&
            event.error !== undefined &&
            event.failure !== undefined &&
            !stopped
              ? yield* limitWaitOf(rt, event.failure, event.error, turnId)
              : undefined;
          const failed =
            wait === undefined && event.reason === "error" && event.error !== undefined
              ? yield* recordFailure(rt, event.failure ?? UNKNOWN_FAILURE, event.error, turnId)
              : undefined;
          if (event.reason === "completed") {
            yield* keepError(rt, undefined);
            rt.resumedFrom = undefined;
            const account = rt.quota;
            if (rt.agent !== undefined && rt.turn !== undefined && Option.isSome(limitReadings)) {
              yield* limitReadings.value.admitted(
                {
                  agent: rt.agent,
                  ...(rt.accountScope === undefined ? {} : { accountScope: rt.accountScope }),
                  ...(rt.profileId === undefined ? {} : { profileId: rt.profileId }),
                },
                rt.turn.startedAt,
              );
            }
            if (
              account !== undefined &&
              rt.turn !== undefined &&
              rt.turn.startedAt > hitAt(account)
            ) {
              const anyWaiting = [...runtimes.values()].some(
                (each) => each.limitWait?.account === account && each.limitWait.kind === "limit",
              );
              if (!anyWaiting) earlyReleases.delete(account);
              else {
                const { model } = (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model;
                yield* startRelease(account, model);
              }
            }
          }
          if (wait !== undefined) yield* enterWait(rt, wait, true);
          yield* finishTurn(rt, event.reason, "adapter", wait !== undefined);
          if (wait !== undefined) {
            yield* setStatus(rt, "idle");
            if (rt.reopenOnIdle && rt.session !== undefined) yield* reopenNow(rt);
            else yield* startIdleTimer(rt);
            yield* scheduleAccount(wait.account, wait.kind === "backoff" ? rt.threadId : undefined);
          } else if (failed !== undefined) {
            if (turnId !== undefined) yield* publishFailure(rt, failed, turnId, replyId);
            yield* setStatus(rt, "error", failed.text);
            if (rt.reopenOnIdle && rt.session !== undefined) yield* reopenNow(rt);
            else yield* startIdleTimer(rt);
          } else {
            yield* becomeIdle(rt);
          }
          return;
        }
        case "ended":
          return noteEnded(rt, event);
        case "machineMoving":
          return yield* startMachineMove(store, publishUpsert, rt.threadId, event);
        case "backgroundTasks":
          yield* setBackground(rt, event.tasks);
          return;
        case "backgroundOutput":
          yield* setBackgroundOutput(rt, event);
          return;
        case "connectorsLapsed":
          yield* setLapsedConnectors(rt, event.names);
          return;
        case "cwd": {
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          if (rt.cwd === undefined || !samePath(rt.cwd, thread.checkout.path)) return;
          const follow =
            (yield* store.getSettings).agents.followWorktreeMoves &&
            thread.role === undefined &&
            thread.spawnedBy === undefined;
          const next = yield* hooks
            .resolveCwd(thread, event.cwd, follow)
            .pipe(Effect.catchDefect(() => Effect.succeed(undefined)));
          if (next !== undefined) {
            yield* setCurrentCheckout(rt.threadId, next ?? undefined).pipe(Effect.orDie);
          }
          return;
        }
      }
    });

  const setBackground = (rt: Runtime, tasks: ReadonlyArray<BackgroundTask>) =>
    Effect.suspend(() => {
      if (tasks.length === 0 && rt.background.length === 0) return Effect.void;
      rt.background = tasks;
      for (const taskId of rt.backgroundOutput.keys())
        if (!tasks.some((task) => task.taskId === taskId)) rt.backgroundOutput.delete(taskId);
      return hub.publish({ type: "thread.background", threadId: rt.threadId, tasks });
    });

  const setBackgroundOutput = (
    rt: Runtime,
    event: Extract<AgentEvent, { type: "backgroundOutput" }>,
  ) =>
    Effect.suspend(() => {
      if (!rt.background.some((task) => task.taskId === event.taskId)) return Effect.void;
      const output: BackgroundOutput = {
        taskId: event.taskId,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        output: event.output.slice(-BACKGROUND_OUTPUT_CHARS),
      };
      if (rt.backgroundOutput.get(event.taskId)?.output === output.output) return Effect.void;
      rt.backgroundOutput.set(event.taskId, output);
      return hub.publish({ type: "thread.backgroundOutput", threadId: rt.threadId, ...output });
    });

  const setLapsedConnectors = (rt: Runtime, names: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      if (names.length === 0 && rt.lapsedConnectors.length === 0) return Effect.void;
      rt.lapsedConnectors = names;
      return hub.publish({ type: "thread.lapsedConnectors", threadId: rt.threadId, names });
    });

  return { handleEvent, setBackground, setLapsedConnectors };
};

/** What `makeAgentEvents` gives the rest of `ThreadRuntimes`. */
export type AgentEvents = ReturnType<typeof makeAgentEvents>;
