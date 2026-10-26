// What a thread makes of its agent session's events: the transcript, status and activity they
// change, the turns they open and end, and the limits, tasks and connectors they report.

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
  BACKGROUND_OUTPUT_CHARS,
  type Turn,
} from "./runtime-state.ts";
import {
  type AgentEvent,
  checkoutRoots,
  type UsageSummary,
  type ServerEvent,
  type BackgroundTask,
  type BackgroundOutput,
  type ThreadId,
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
import type { EarlyReleases } from "./limit-wait.ts";
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

/** What an agent's events reach: nearly every other part of `ThreadRuntimes`. */
export interface AgentEventsDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
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
  readonly settleNote: TurnLifecycle["settleNote"];
  readonly recordFailure: TurnLifecycle["recordFailure"];
  readonly keepError: TurnLifecycle["keepError"];
  readonly finishTurn: TurnLifecycle["finishTurn"];
  readonly publishFailure: TurnLifecycle["publishFailure"];
  readonly turnHeld: LimitResume["turnHeld"];
  readonly limitWaitOf: LimitResume["limitWaitOf"];
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

/** The handler every live session's events go through, one at a time under the runtime lock. */
export const makeAgentEvents = ({
  store,
  hub,
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
  settleNote,
  recordFailure,
  keepError,
  finishTurn,
  publishFailure,
  turnHeld,
  limitWaitOf,
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
  /**
   * Called with the runtime lock held. A queue waits only on something running, and an idle
   * session with input queued is a path that forgot to drain it (a card that closed with no turn,
   * once): this says so, without the input, and sends it as `becomeIdle` would.
   */
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
      // `becomeIdle` holds a monitor's notice back from an archived thread on purpose.
      if (rt.noticeKeys.has(rt.queue[0]!.id)) {
        const parked = yield* store.getThread(rt.threadId).pipe(
          Effect.map((thread) => thread.parked),
          Effect.orElseSucceed(() => false),
        );
        if (parked) return;
      }
      yield* Effect.logWarning("queued input waited on an idle thread; sending it").pipe(
        Effect.annotateLogs({ threadId: rt.threadId, queued: rt.queue.length }),
      );
      yield* becomeIdle(rt);
    });

  const handleEvent = (rt: Runtime, event: AgentEvent) =>
    locked(
      rt,
      Effect.gen(function* () {
        const lane = event.type === "chunk" ? rt.open.get(event.messageId) : undefined;
        // Foreground delegation is progress on its parent's outstanding tool; an older or
        // background lane must not hide a silent command in this turn.
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
        // Before the event, so a status change it causes already carries the new line.
        const changed = rt.activity.apply(event, rt.cwd);
        yield* applyEvent(rt, event);
        if (changed) yield* scheduleActivity(rt);
        const tasksDone = tasksRunning && rt.background.length === 0;
        if ((subagentsRunning || tasksDone) && evictable(rt)) yield* startIdleTimer(rt);
        yield* healQueue(rt);
        if (tasksDone && rt.pendingRestart !== undefined) {
          // Looked at again once the agent has had the time to start its report-back turn; if it
          // did, that turn's end is the point of rest.
          rt.tasksEndedAt = yield* Clock.currentTimeMillis;
          yield* FiberMap.run(
            restartChecks,
            rt.threadId,
            Effect.sleep(BACKGROUND_SETTLE).pipe(Effect.andThen(locked(rt, restartIfPending(rt)))),
          );
        }
        // A failed turn's end, with no idle after it, can be the point of rest.
        yield* restartIfPending(rt);
      }),
    );

  /** Called with the runtime lock held. */
  const applyEvent = (rt: Runtime, event: AgentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "identity": {
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          const newId = thread.agentSessionId !== event.agentSessionId;
          const newHome = event.codexHome !== undefined && thread.codexHome !== event.codexHome;
          if (newId || newHome) {
            const next = yield* store
              .updateThread(rt.threadId, (t) => ({
                ...t,
                // A new id has no transcript until its first message.
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
          // Between turns there is no turn end to clear it, and nothing is being retried.
          if (event.status === "retrying" && rt.turn !== undefined) {
            yield* setRetrying(rt, true, event.detail);
          } else if (event.status !== "retrying") {
            yield* setRetrying(rt, false);
          }
          const status = agentStatus(event.status);
          rt.agentRunning = status === "running" && rt.turn === undefined;
          if (status === "idle") {
            // `idle` after `turnEnd` is the previous turn's tail; `turnEnd` already settled it.
            if (rt.turn === undefined && rt.status !== "idle") yield* becomeIdle(rt);
            return;
          }
          // A status from an ended turn must not flip a thread that is between turns.
          if (rt.turn === undefined && status === "running") return;
          const compaction =
            event.status === "compacting"
              ? (event.compaction ?? rt.compaction ?? { startedAt: yield* Clock.currentTimeMillis })
              : event.status === "retrying"
                ? event.compaction
                : undefined;
          const compactionChanged = !sameCompaction(rt.compaction, compaction);
          const compactionStartedAt = compaction?.startedAt ?? rt.compaction?.startedAt;
          // Compacting is the agent at work, however little it streams: its start and end count as
          // progress, so the silent-tool watch measures from them.
          if (compactionChanged) {
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
          const { chunk } = event;
          if (
            rt.turn === undefined &&
            chunk.type === "start" &&
            chunk.messageMetadata?.parentToolUseId === undefined
          ) {
            // A reply outside a turn opens one only when the agent says it started it (e.g. to
            // report back from a background subagent) or while a background subagent still runs.
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
          // A background subagent from an earlier turn streams on its own lane whatever this turn
          // was sent, so only the turn's own reply shows the agent has the input.
          if (
            rt.turn !== undefined &&
            rt.open.get(event.messageId)?.nested === false &&
            rt.open.get(event.messageId)?.turnId === rt.turn.id
          ) {
            if (rt.carrying?.turnId === rt.turn.id) yield* settleDelivery(rt, "accepted");
            yield* settleNote(rt, rt.turn.id, true);
          }
          // Only actual main-turn content proves that this model can answer. Empty starts, error
          // parts and nested/background lanes cannot reset the spawn circuit breaker.
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
          // The adapters report a retry but not its recovery, so the reply's output is the sign. A
          // background subagent streams on whether or not its parent is being rate limited.
          if (
            rt.retrying &&
            showsProgress(chunk) &&
            rt.open.get(event.messageId)?.nested === false &&
            rt.open.get(event.messageId)?.turnId === rt.turn?.id
          ) {
            yield* setRetrying(rt, false);
          }
          // Each tool call is a cheap look at the folder: deleted outside Gram, every tool
          // the agent runs in it would fail.
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
                // First admission owns the path. A later event cannot replace its capability.
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
              const messages = [
                ...(yield* store.listMessages(rt.threadId)),
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
          const now = yield* Clock.currentTimeMillis;
          yield* store.putRequest(rt.threadId, event.request, now);
          yield* hub.publish({
            type: "thread.request",
            threadId: rt.threadId,
            request: event.request,
          });
          yield* setStatus(rt, event.request.kind === "question" ? "needsInput" : "needsApproval");
          return;
        }
        case "requestResolved": {
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
          // Agents repeat a reading between turns, and through a tool call; one that reads the
          // same is no news to clients, or to the orchestrator's context watch.
          const unchanged =
            rt.usage !== undefined && JSON.stringify(rt.usage) === JSON.stringify(usage);
          if (rt.turn !== undefined) rt.turn.usage = usage;
          rt.usage = usage;
          yield* setRetrying(rt, false);
          if (!unchanged)
            yield* hub.publish({ type: "thread.usage", threadId: rt.threadId, usage });
          return;
        }
        case "subagentUsage": {
          // The snapshot rides its own lane's transcript, so a backgrounded subagent reporting back
          // between turns updates its Task card instead of minting a stray message.
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
          const thread = yield* store
            .updateThread(rt.threadId, (t) => ({ ...t, mode: event.mode }))
            .pipe(Effect.orDie);
          yield* publishUpsert(thread);
          return;
        }
        case "model": {
          const current = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
          if (current.model.model === event.model) return;
          // As the picker does on a switch: an effort the new model doesn't take is dropped, or a
          // reopen would hand it to the agent. A model nobody lists has no efforts there either.
          const capabilities = yield* selectableModels(
            store,
            hosts,
            current.model.agent,
            current.model.profileId,
          ).pipe(
            Effect.map((models) => models.find((m) => m.id === event.model)),
            Effect.orElseSucceed(() => undefined),
          );
          const efforts = capabilities?.efforts ?? [];
          const disableFast =
            current.model.speed === "fast" && !capabilities?.speeds.includes("fast");
          // The session already runs this model. Only an unsupported Fast preference needs a
          // control update, so the CLI flag cannot reactivate it or promote a later selection.
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
          // Unless it can't run it as started: then it reopens on the new record once idle.
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
            threadId: rt.threadId,
          });
          return;
        case "rateLimit": {
          const { type: _, ...limit } = event;
          const now = yield* Clock.currentTimeMillis;
          // Every reading feeds the usage meter; only the gated warnings notify.
          if (rt.agent !== undefined) {
            const reading: Extract<ServerEvent, { type: "usageLimit" }> = {
              type: "usageLimit",
              threadId: rt.threadId,
              agent: rt.agent,
              ...(rt.profileId === undefined
                ? {}
                : { gateway: true as const, profileId: rt.profileId }),
              ...limit,
            };
            yield* hub.publish(reading);
            // A rejection's reset is when the account takes turns again, which a thread on it
            // failing in this very turn waits for (`limitedUntil`): recorded now, not when the
            // hub's consumer gets to it, which a second record of the same report leaves as is.
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
          // A provider limit is waited out, not failed on: the thread rests until it resumes.
          const wait =
            event.reason === "error" && event.error !== undefined && event.failure !== undefined
              ? yield* limitWaitOf(rt, event.failure, event.error, turnId)
              : undefined;
          const failed =
            wait === undefined && event.reason === "error" && event.error !== undefined
              ? yield* recordFailure(rt, event.failure ?? UNKNOWN_FAILURE, event.error, turnId)
              : undefined;
          if (event.reason === "completed") {
            yield* keepError(rt, undefined);
            rt.resumedFrom = undefined;
            // A turn the account took after its limit says the limit no longer applies.
            const account = rt.quota;
            if (rt.agent !== undefined && rt.turn !== undefined && Option.isSome(limitReadings)) {
              yield* limitReadings.value.admitted(
                {
                  agent: rt.agent,
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
              // The spacing starts over once nothing on the account waits.
              if (!anyWaiting) earlyReleases.delete(account);
              else {
                const { model } = (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model;
                yield* startRelease(account, model);
              }
            }
          }
          // Before the turn ends, so its observers see the thread waiting rather than failed.
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
            // A reopen waiting on the turn (a restart, a move) goes now: Codex can end a failed turn
            // with no idle after it, so `becomeIdle` would never get to it.
            if (rt.reopenOnIdle && rt.session !== undefined) yield* reopenNow(rt);
            else yield* startIdleTimer(rt);
          } else {
            yield* becomeIdle(rt);
          }
          return;
        }
        case "ended":
          rt.endedReason = event.reason;
          return;
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
          // While a moved session waits to reopen, the agent still reports the folder it's leaving.
          if (rt.cwd === undefined || !samePath(rt.cwd, thread.checkout.path)) return;
          // An orchestrator or a worker stays in the folder it was made for: an orchestrator that
          // `cd`s into a worker's worktree to read it isn't working there, and a worker's other
          // worktrees are its own extras, not a move. A worker carries `spawnedBy`, not a role.
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

  /** Called with the runtime lock held. */
  const setBackground = (rt: Runtime, tasks: ReadonlyArray<BackgroundTask>) =>
    Effect.suspend(() => {
      if (tasks.length === 0 && rt.background.length === 0) return Effect.void;
      rt.background = tasks;
      for (const taskId of rt.backgroundOutput.keys())
        if (!tasks.some((task) => task.taskId === taskId)) rt.backgroundOutput.delete(taskId);
      return hub.publish({ type: "thread.background", threadId: rt.threadId, tasks });
    });

  /**
   * Called with the runtime lock held. Only for a task `background` lists, and at most the last
   * `BACKGROUND_OUTPUT_CHARS` of it, so what is kept stays bounded by the tasks running.
   */
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

  /** Called with the runtime lock held. */
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
