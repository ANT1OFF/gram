import { createHash, randomUUID } from "node:crypto";
import {
  aboveHigh,
  type AgentKind,
  AppToolError,
  canonicalModelId,
  type GramUIMessage,
  listedRow,
  type MessageOrigin,
  ProfileId,
  ReasoningVariant,
  ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GitStatePublisher } from "../git/publisher.ts";
import { restoreThreadWorktree } from "../git/restore-worktree.ts";
import { isLiveWorker } from "../orchestration/ledger.ts";
import { isEnded } from "../orchestration/sent-workers.ts";
import { sendFingerprint } from "../orchestration/outbox.ts";
import { featureSlug } from "../orchestration/rules.ts";
import { Orchestration, type SentMessage } from "../orchestration/service.ts";
import { SentWorkPort } from "../embedding/sent-work-port.ts";
import {
  attachUserWords,
  USER_MESSAGES_MAX,
  withUserAnswers,
} from "../orchestration/user-words.ts";
import { findUserMessages, ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { selectableModels } from "../runtime/model-efforts.ts";
import { limitQueuedNote } from "../runtime/limit-wait.ts";
import { ThreadRuntimes, type JoinQueued, type JoinResult } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";
import { inputAliases } from "./input.ts";
import { checkSend } from "./loop-guard.ts";
import { AppToolRegistry } from "./registry.ts";
import { archiveHold, waitsLeftBy } from "./archive-leaves.ts";

const CARD_TEXT_CAP = 400;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const toolError =
  (tool: string) =>
  (e: unknown): AppToolError =>
    e instanceof AppToolError
      ? e
      : new AppToolError({
          tool,
          message:
            typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
              ? e.message
              : `${tool} failed`,
        });

const missingTarget = (threadId: string) =>
  new AppToolError({
    tool: "send_message",
    message: `This thread does not exist: ${threadId}. Use list_threads or list_workers to obtain the full threadId; shortened IDs are not routed.`,
  });

/** Where a user message came from, when another thread sent it. */
export const originOf = (message: GramUIMessage): MessageOrigin | undefined => {
  for (const part of message.parts) {
    if (part.type === "data-thread-origin") return part.data;
  }
  return undefined;
};

const JOINED_PREFACE =
  "These are separate messages, oldest first. A later one may change an earlier one.";

const clockTime = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

const messageDivider = (n: number, at: number | undefined) =>
  `── Message ${n}${at === undefined ? "" : `, sent ${clockTime(at)}`} ──`;

/**
 * A message from the same sender folded into its queued one, each marked as a message of its own
 * and in the order they were sent. The queued item's origin stays, less a `mode` the new message
 * doesn't share: the card would otherwise give the whole row the first one's reason for waiting.
 * How many it holds comes from the runtime, never from the text, which is the agent's and may look
 * like a joined item.
 */
export const joinMessages: JoinQueued = ({ input, queuedAt, messages }, next, now) => {
  const body =
    messages > 1
      ? input.text
      : `${JOINED_PREFACE}\n\n${messageDivider(1, queuedAt)}\n${input.text}`;
  const joined = {
    ...input,
    text: `${body}\n\n${messageDivider(messages + 1, now)}\n${next.text}`,
  };
  if (input.origin?.mode === undefined || input.origin.mode === next.origin?.mode) return joined;
  const { mode: _, ...origin } = input.origin;
  return { ...joined, origin };
};

interface SendInput {
  readonly threadId: string;
  readonly text: string;
  readonly mode?: DeliveryMode;
  readonly clientRequestId?: string;
}

type DeliveryMode = "queue" | "steer" | "interrupt";
const DELIVERY_MODES = ["queue", "steer", "interrupt"] as const;

interface ParentRoute {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

const waited = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "under a minute" : minutes === 1 ? "1 minute" : `${minutes} minutes`;
};

/**
 * Orchestration tools: agent-driven actions on other threads. All *crossThread*, and
 * each call raises a card naming the target, for that call alone and in every mode; `send_message`
 * also passes the loop guard. An orchestrator acting on its own worker needs no card and uses
 * its own guard. send_message alone also needs no card from a current worker to its bound parent or sibling in a
 * full-autonomy workspace; those sends keep the ordinary loop guard and respect pauses/holds.
 */
export const OrchestrationAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const hosts = yield* AgentHosts;
    const checkouts = yield* CheckoutService;
    const publisher = Option.getOrUndefined(yield* Effect.serviceOption(GitStatePublisher));
    const releaseWatchers = publisher === undefined ? Effect.void : publisher.sync;
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const sentWork = Option.getOrUndefined(yield* Effect.serviceOption(SentWorkPort));
    const sends = new Map<ThreadId, ReadonlyArray<number>>();

    const isDelegated = (caller: ThreadId, threadId: string) =>
      orchestration === undefined
        ? Effect.succeed(false)
        : orchestration.isDelegated(caller, threadId);
    const needsApproval = (caller: ThreadId, { threadId }: { readonly threadId: string }) =>
      isDelegated(caller, threadId).pipe(
        Effect.map((delegated) => !delegated),
        Effect.catchCause(() => Effect.succeed(true)),
      );

    const isWorkerSend = (caller: ThreadId, threadId: string) =>
      orchestration === undefined
        ? Effect.succeed(false)
        : orchestration.isWorkerSend(caller, threadId);

    const sendNeedsApproval = (caller: ThreadId, { threadId }: { readonly threadId: string }) =>
      Effect.gen(function* () {
        return !(yield* isDelegated(caller, threadId)) && !(yield* isWorkerSend(caller, threadId));
      }).pipe(Effect.catchCause(() => Effect.succeed(true)));

    const resolveSendTarget = (threadId: string) =>
      store
        .getThread(ThreadId.make(threadId))
        .pipe(Effect.catchTag("ThreadNotFound", () => Effect.fail(missingTarget(threadId))));

    const resolveParent = (caller: ThreadId) =>
      orchestration === undefined
        ? Effect.fail(
            new AppToolError({
              tool: "message_orchestrator",
              message:
                "This worker has no current bound orchestrator. Use list_threads/list_workers to inspect ownership.",
            }),
          )
        : orchestration.resolveWorkerParent(caller);

    const checkParentRoute = (caller: ThreadId, pinned: ParentRoute) =>
      resolveParent(caller).pipe(
        Effect.flatMap((current) =>
          current.threadId === pinned.threadId && current.workspaceId === pinned.workspaceId
            ? Effect.void
            : Effect.fail(
                new AppToolError({
                  tool: "message_orchestrator",
                  message:
                    "The bound orchestrator changed after this message was checked. Nothing was sent; retry to address the current parent.",
                }),
              ),
        ),
      );

    const summaryOf = (tool: string, threadId: string) =>
      runtimes
        .summaryOf(ThreadId.make(threadId))
        .pipe(
          Effect.flatMap((summary) =>
            summary === undefined
              ? Effect.fail(new AppToolError({ tool, message: `unknown thread ${threadId}` }))
              : Effect.succeed(summary),
          ),
        );

    const otherThread = (tool: string, caller: ThreadId, threadId: string, verb: string) =>
      Effect.gen(function* () {
        if (threadId === caller) {
          return yield* new AppToolError({ tool, message: `A thread can't ${verb} itself.` });
        }
        return yield* summaryOf(tool, threadId);
      });

    const titleOf = (threadId: string) =>
      store.getThread(ThreadId.make(threadId)).pipe(
        Effect.match({
          onFailure: () => `unknown thread ${threadId}`,
          onSuccess: (thread) => `“${thread.title}”`,
        }),
      );

    const modelsFor = (tool: string, agent: AgentKind, profileId: string | undefined) =>
      selectableModels(store, hosts, agent, profileId).pipe(Effect.mapError(toolError(tool)));

    const sendOnce = <A extends SentMessage, E>(
      caller: ThreadId,
      message: { readonly threadId: string; readonly text: string; readonly mode?: string },
      clientRequestId: string | undefined,
      send: Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        if (
          clientRequestId === undefined ||
          orchestration === undefined ||
          (!(yield* orchestration.isDelegated(caller, message.threadId)) &&
            !(yield* isWorkerSend(caller, message.threadId)))
        ) {
          return yield* send;
        }
        const result = yield* orchestration.sendOnce(
          caller,
          clientRequestId,
          ThreadId.make(message.threadId),
          sendFingerprint(message.text, message.mode),
          send,
        );
        return "repeated" in result
          ? {
              ...result,
              note: "A call with this clientRequestId already sent it, so nothing was sent again.",
            }
          : result;
      });

    const deliver = (
      caller: ThreadId,
      { threadId, text, mode, clientRequestId }: SendInput,
      ownWorkerOnly = false,
      uncarded = false,
      parentRoute?: ParentRoute,
    ) =>
      Effect.gen(function* () {
        const tool = "send_message";
        if (threadId === caller) {
          return yield* new AppToolError({
            tool,
            message: "A thread can't send a message to itself.",
          });
        }
        yield* resolveSendTarget(threadId);
        const target = yield* summaryOf(tool, threadId);
        const source = yield* summaryOf(tool, caller);
        const delegated =
          orchestration !== undefined && (yield* orchestration.isDelegated(caller, threadId));
        const workerSend = yield* isWorkerSend(caller, threadId);
        if (uncarded && !delegated && !workerSend) {
          return yield* new AppToolError({
            tool,
            message: "no_authority: This message now requires the user's approval. Retry the call.",
          });
        }
        if (ownWorkerOnly && !delegated) {
          return yield* new AppToolError({ tool, message: "It is no longer your worker." });
        }
        const sent = target.thread.sentTo;
        if (sent !== undefined) {
          if (!delegated)
            return yield* new AppToolError({
              tool,
              message: `${target.thread.title} runs on ${sent.server}; only the orchestrator that sent it messages it from here.`,
            });
          yield* orchestration.checkSend(caller, target.thread.id);
          if (sentWork === undefined)
            return yield* new AppToolError({
              tool,
              message: "There is no desktop app to send it through.",
            });
          const answer = yield* sentWork.message(sent.origin, sent.workspaceId, sent.threadId, {
            text,
            clientKey:
              clientRequestId === undefined
                ? randomUUID()
                : createHash("sha256")
                    .update(`${caller}\n${target.thread.id}\n${clientRequestId}\n${text}`)
                    .digest("base64url")
                    .slice(0, 64),
            mode: mode === "queue" ? "queue" : mode === "interrupt" ? "interrupt" : "steer",
          });
          if (!answer.ok)
            return yield* new AppToolError({
              tool,
              message: `${sent.server} didn't take the message: ${answer.why}${
                answer.unknown === true
                  ? " It may have arrived; check with get_thread before sending again."
                  : ""
              }`,
            });
          yield* orchestration.noteMessage(caller, target.thread.id);
          const askedAt = yield* Clock.currentTimeMillis;
          yield* runtimes
            .updateThread(target.thread.id, (current) =>
              current.sentTo === undefined
                ? current
                : {
                    ...current,
                    sentTo: {
                      ...current.sentTo,
                      askedAt,
                      ...(isEnded(current.sentTo.state) ? { state: "running" as const } : {}),
                    },
                  },
            )
            .pipe(Effect.ignore);
          return {
            threadId: target.thread.id,
            title: target.thread.title,
            delivered: answer.queued ? ("queued" as const) : ("sent" as const),
            note: `It runs on ${sent.server}, in ${sent.workspace}: its reply comes as its report.`,
          };
        }
        const callerUser = yield* findUserMessages(store, caller, { from: "newest", count: 1 });
        const callerOrigin = callerUser.length === 0 ? undefined : originOf(callerUser.at(-1)!);
        let depth = 1;
        let counted: ReadonlyArray<number> | undefined;
        if (delegated) {
          yield* orchestration.checkSend(caller, target.thread.id);
        } else {
          const targetUser = yield* findUserMessages(store, target.thread.id, {
            from: "newest",
            count: 1,
          });
          const verdict = checkSend({
            caller,
            target: target.thread.id,
            callerOrigin,
            targetInputs: [
              ...targetUser.map((m) => ({ origin: originOf(m) })),
              ...target.queue.map((q) => ({ origin: q.input.origin })),
            ],
            recentSends: sends.get(caller) ?? [],
            now: yield* Clock.currentTimeMillis,
          });
          if (!verdict.ok) return yield* new AppToolError({ tool, message: verdict.reason });
          depth = verdict.depth;
          counted = verdict.recentSends;
        }
        const asked = mode ?? "steer";
        const role = source.thread.role;
        const feature = source.thread.spawnedBy?.feature;
        const input = {
          text,
          origin: {
            threadId: caller,
            title: source.thread.title,
            depth,
            ...(role === undefined ? {} : { role }),
            ...(feature === undefined ? {} : { feature }),
            mode: asked,
          },
        };
        yield* resolveSendTarget(threadId);
        if (parentRoute !== undefined) yield* checkParentRoute(caller, parentRoute);
        if (workerSend) yield* orchestration!.checkWorkerMessage(caller, target.thread.id);
        const canSteer = target.capabilities?.steer === true && target.status === "running";
        const steer = asked === "steer" || asked === "interrupt";
        const interrupt = asked === "interrupt" && target.capabilities?.steerInterrupt === true;
        const notes: Array<string> = [];
        if (asked === "interrupt" && canSteer && !interrupt) {
          notes.push(
            "That agent can't be interrupted for a message, so it was steered in instead.",
          );
        }
        const steered =
          steer &&
          canSteer &&
          (yield* runtimes
            .steer(target.thread.id, input, interrupt ? { interrupt } : undefined)
            .pipe(
              Effect.as(true),
              Effect.catchTag("InvalidState", () => Effect.succeed(false)),
            ));
        let delivered: "sent" | "queued" | "steered" = "steered";
        let waitedSeconds: number | undefined;
        if (!steered) {
          const result: JoinResult = delegated
            ? yield* runtimes.sendOrJoin(
                target.thread.id,
                input,
                joinMessages,
                (queued) => queued.origin?.threadId === caller,
              )
            : yield* runtimes.send(target.thread.id, input);
          delivered = result.queued ? "queued" : "sent";
          if (result.queued && (mode === "steer" || mode === "interrupt")) {
            notes.push("That thread can't be steered right now, so the message was queued.");
          }
          if (result.joined !== undefined) {
            const { queuedAt } = result.joined;
            const now = yield* Clock.currentTimeMillis;
            if (queuedAt !== undefined) waitedSeconds = Math.round((now - queuedAt) / 1000);
            notes.push(
              `It joined your earlier message, which is still waiting${
                queuedAt === undefined ? "" : ` after ${waited(now - queuedAt)}`
              }; the worker reads them together when its turn ends. Amend rather than add, or steer what can't wait.`,
            );
          }
        }
        if (delivered === "queued") {
          const wait = (yield* store.getThread(target.thread.id).pipe(Effect.option)).pipe(
            Option.flatMap((thread) => Option.fromUndefinedOr(thread.limitWait)),
          );
          if (Option.isSome(wait)) {
            notes.push(limitQueuedNote(wait.value, yield* Clock.currentTimeMillis));
          }
        }
        if (counted !== undefined) sends.set(caller, counted);
        if (delegated) yield* orchestration.noteMessage(caller, target.thread.id);
        return {
          threadId: target.thread.id,
          title: target.thread.title,
          delivered,
          ...(waitedSeconds === undefined ? {} : { joinedWaitingSeconds: waitedSeconds }),
          ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
        };
      });

    const attachUserAnswers = (
      tool: string,
      caller: ThreadId,
      text: string,
      ids: ReadonlyArray<string> | undefined,
    ) =>
      Effect.gen(function* () {
        if (ids === undefined) return text;
        if (orchestration === undefined) {
          return yield* new AppToolError({
            tool,
            message:
              "`userAnswers` attaches the user's answers to an orchestrator's workers' questions; this thread has none. Leave it out.",
          });
        }
        return withUserAnswers(text, yield* orchestration.userAnswers(caller, tool, ids));
      });

    const sendMessage = defineAppTool({
      descriptor: {
        name: "send_message",
        class: "crossThread",
        description:
          'Use `message` for message text (`text` and `content` are aliases). Send it to another Gram thread by the exact full threadId from list_threads or list_workers; shortened IDs are refused. For your parent, use message_orchestrator without an ID. `mode`: "queue" (after the turn; only what wouldn\'t change this turn), "steer" (mid-turn after the tool calls under way; cancels nothing) or "interrupt" (stops the turn now, cutting off tool calls; urgent only). Default steer: leave `mode` out for what would. Your own workers need no approval. A current worker may also message its bound workspace orchestrator or a current sibling worker without approval; these keep the back-to-back, chain and rate limits. Paused workspaces refuse these. Other targets ask approval per call, even in Bypass. `clientRequestId` retries an own-worker or worker send without sending it twice. An orchestrator\'s `userMessages` (1–5) appends the user\'s latest messages word for word, for a paste the worker needs. Link a thread for the user as [title](#threadId).',
      },
      input: inputAliases(
        Schema.Struct({
          threadId: Schema.NonEmptyString,
          text: Schema.NonEmptyString,
          mode: Schema.optionalKey(Schema.Literals(DELIVERY_MODES)),
          clientRequestId: Schema.optionalKey(Schema.String),
          userMessages: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: USER_MESSAGES_MAX })),
          ),
          userAnswers: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
        { text: ["message", "content"] },
      ),
      approvalRequiresResolvedTarget: true,
      resolve: (caller, { userMessages, userAnswers, ...input }) =>
        Effect.gen(function* () {
          const target = yield* resolveSendTarget(input.threadId);
          const text = yield* attachUserWords(
            store,
            "send_message",
            caller,
            yield* attachUserAnswers("send_message", caller, input.text, userAnswers),
            userMessages,
          );
          return { ...input, text, targetTitle: target.title };
        }),
      needsApproval: (caller, _input, target) => sendNeedsApproval(caller, target),
      describe: (_caller, { targetTitle, text, mode }) =>
        Effect.succeed(
          `Send to “${targetTitle}”${mode === undefined || mode === "queue" ? "" : ` (${mode})`}: ${truncate(text, CARD_TEXT_CAP)}`,
        ),
      handle: (caller, { threadId, text, mode, clientRequestId }, { carded }) =>
        deliver(
          caller,
          {
            threadId,
            text,
            ...(mode === undefined ? {} : { mode }),
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
          },
          false,
          carded === false,
        ).pipe(
          (send) =>
            sendOnce(
              caller,
              { threadId, text, ...(mode === undefined ? {} : { mode }) },
              clientRequestId,
              send,
            ),
          Effect.mapError(toolError("send_message")),
        ),
    });

    const messageOrchestrator = defineAppTool({
      descriptor: {
        name: "message_orchestrator",
        class: "crossThread",
        description:
          "Use `message` for message text (`text` and `content` are aliases). Send specific coordination or clarification to your current bound workspace orchestrator, steered into its turn; no thread ID is needed. Prefer `report` for structured progress, completion and interface status. This current owned route needs no approval. Pauses and stale membership refuse it; the user writing to you does not. The usual origin, back-to-back, two-hop and rate guards apply. clientRequestId deduplicates retries per sender.",
      },
      audience: ["worker"],
      rejectExcessProperties: true,
      input: inputAliases(
        Schema.Struct({
          text: Schema.NonEmptyString,
          clientRequestId: Schema.optionalKey(Schema.String),
        }),
        { text: ["message", "content"] },
      ),
      approvalRequiresResolvedTarget: true,
      resolve: (caller, input) =>
        Effect.gen(function* () {
          const parent = yield* resolveParent(caller);
          const target = yield* resolveSendTarget(parent.threadId);
          return { ...input, parent, threadId: parent.threadId, targetTitle: target.title };
        }),
      needsApproval: (caller, _input, target) => sendNeedsApproval(caller, target),
      describe: (_caller, { threadId, targetTitle, text }) =>
        Effect.succeed(
          `Message orchestrator “${targetTitle}” [thread ${threadId}]: ${truncate(text, CARD_TEXT_CAP)}`,
        ),
      handle: (caller, { threadId, parent, text, clientRequestId }, { carded }) =>
        checkParentRoute(caller, parent).pipe(
          Effect.andThen(deliver(caller, { threadId, text }, false, carded === false, parent)),
          (send) => sendOnce(caller, { threadId, text }, clientRequestId, send),
          Effect.mapError(
            (error) => new AppToolError({ tool: "message_orchestrator", message: error.message }),
          ),
        ),
    });

    const broadcastMessage = defineAppTool({
      descriptor: {
        name: "broadcast_message",
        class: "crossThread",
        description:
          "Use `message` for message text (`text` and `content` are aliases). Send one message to each of your live workers, or to those of one `feature`, or to the `threadIds` named: for what they all need to hear, such as main moving or a changed convention. Each gets it as from send_message, steered unless another mode, and through the same per-worker limit. One that refuses is listed under `skipped` with why; the rest are sent.",
      },
      audience: ["orchestrator"],
      input: inputAliases(
        Schema.Struct({
          text: Schema.NonEmptyString,
          feature: Schema.optionalKey(Schema.String),
          threadIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
          mode: Schema.optionalKey(Schema.Literals(DELIVERY_MODES)),
        }),
        { text: ["message", "content"] },
      ),
      needsApproval: () => Effect.succeed(false),
      handle: (caller, { text, feature, threadIds, mode }) =>
        Effect.gen(function* () {
          const tool = "broadcast_message";
          if (orchestration === undefined) {
            return yield* new AppToolError({ tool, message: "Only an orchestrator broadcasts." });
          }
          const ledger = yield* orchestration.listWorkers(caller, {});
          const slug = feature === undefined ? undefined : featureSlug(feature);
          if (feature !== undefined && !ledger.features.some((f) => f.feature === slug)) {
            return yield* new AppToolError({ tool, message: `You have no feature ${feature}.` });
          }
          const targets = ledger.features
            .filter((f) => slug === undefined || f.feature === slug)
            .flatMap((f) => f.workers)
            .filter((worker) =>
              threadIds === undefined ? isLiveWorker(worker) : threadIds.includes(worker.threadId),
            );
          const unknown = (threadIds ?? []).filter(
            (id) => !targets.some((worker) => worker.threadId === id),
          );
          if (targets.length === 0) {
            return yield* new AppToolError({ tool, message: "No worker of yours matches." });
          }
          const sent: Array<{ threadId: string; title: string; delivered: string }> = [];
          const skipped: Array<{ threadId: string; title?: string; reason: string }> = [];
          for (const worker of targets) {
            const result = yield* deliver(
              caller,
              { threadId: worker.threadId, text, ...(mode === undefined ? {} : { mode }) },
              true,
            ).pipe(
              Effect.map((done) => ({ ok: true as const, delivered: done.delivered })),
              Effect.catch((e) =>
                Effect.succeed({ ok: false as const, reason: toolError(tool)(e).message }),
              ),
            );
            if (result.ok) {
              sent.push({
                threadId: worker.threadId,
                title: worker.title,
                delivered: result.delivered,
              });
            } else {
              skipped.push({
                threadId: worker.threadId,
                title: worker.title,
                reason: result.reason,
              });
            }
          }
          for (const id of unknown)
            skipped.push({ threadId: id, reason: "not one of your workers" });
          return { sent, ...(skipped.length === 0 ? {} : { skipped }) };
        }).pipe(Effect.mapError(toolError("broadcast_message"))),
    });

    const stopThread = defineAppTool({
      descriptor: {
        name: "stop_thread",
        class: "crossThread",
        description: "Stop another thread's running turn. The user approves it.",
      },
      input: Schema.Struct({ threadId: Schema.NonEmptyString }),
      needsApproval,
      describe: (_caller, { threadId }) => titleOf(threadId).pipe(Effect.map((t) => `Stop ${t}`)),
      handle: (caller, { threadId }) =>
        Effect.gen(function* () {
          const target = yield* otherThread("stop_thread", caller, threadId, "stop");
          const sent = target.thread.sentTo;
          if (sent !== undefined) {
            if (sentWork === undefined)
              return yield* new AppToolError({
                tool: "stop_thread",
                message: "There is no desktop app to stop it through.",
              });
            const stopped = yield* sentWork.stop(sent.origin, sent.workspaceId, sent.threadId);
            if (!stopped.ok)
              return yield* new AppToolError({
                tool: "stop_thread",
                message: `${sent.server} didn't stop it: ${stopped.why}`,
              });
            if (orchestration !== undefined)
              yield* orchestration.noteStop(caller, target.thread.id);
            return { threadId: target.thread.id, stopped: true };
          }
          const waiting =
            target.thread.limitWait !== undefined && target.thread.limitWait.cancelled !== true;
          if (target.status !== "running" && target.status !== "starting" && !waiting) {
            return { threadId: target.thread.id, stopped: false, status: target.status };
          }
          if (orchestration !== undefined) yield* orchestration.noteStop(caller, target.thread.id);
          yield* runtimes.interrupt(target.thread.id, { endLimitWait: true });
          return { threadId: target.thread.id, stopped: true };
        }).pipe(Effect.mapError(toolError("stop_thread"))),
    });

    const restartSession = defineAppTool({
      descriptor: {
        name: "restart_session",
        class: "crossThread",
        description:
          "Restart an agent session so it rereads its setup (settings, MCP servers and connectors, CLAUDE.md or AGENTS.md, skills, the agent CLI) after a change; the conversation carries on. Without threadId it is your own, restarting once this turn ends, so end your turn. Another thread's restarts at once when at rest, stopping its background tasks; mid-turn it restarts when the turn ends, unless interrupt: true cuts the turn off. On your own worker at full autonomy this needs no approval; on any other thread the user approves it.",
      },
      input: Schema.Struct({
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        interrupt: Schema.optionalKey(Schema.Boolean),
      }),
      needsApproval: (caller, { threadId }) =>
        threadId === undefined || threadId === caller
          ? Effect.succeed(false)
          : orchestration === undefined
            ? Effect.succeed(true)
            : orchestration.coordinationAllows(caller, threadId).pipe(Effect.map((own) => !own)),
      describe: (caller, { threadId, interrupt }) =>
        threadId === undefined || threadId === caller
          ? Effect.succeed("Restart this thread's session once this turn ends")
          : titleOf(threadId).pipe(
              Effect.map(
                (t) =>
                  `Restart the session of ${t}${interrupt === true ? ", interrupting a running turn" : ""}`,
              ),
            ),
      handle: (caller, { threadId, interrupt }) =>
        Effect.gen(function* () {
          const tool = "restart_session";
          const target =
            threadId === undefined || threadId === caller
              ? caller
              : (yield* summaryOf(tool, threadId)).thread.id;
          const own = target === caller;
          const outcome = yield* runtimes.restartSession(
            target,
            !own && interrupt === true ? "interrupt" : "afterTurn",
          );
          return {
            threadId: target,
            outcome,
            ...(own && outcome === "afterTurn"
              ? { note: "It restarts once this turn ends: end your turn now." }
              : {}),
          };
        }).pipe(Effect.mapError(toolError("restart_session"))),
    });

    const setThreadModel = defineAppTool({
      descriptor: {
        name: "set_thread_model",
        class: "crossThread",
        description:
          "Switch another thread to a different model of its agent, optionally through a gateway profile (the thread's current profile when omitted). The user approves it.",
      },
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        model: Schema.NonEmptyString,
        profileId: Schema.optionalKey(ProfileId),
      }),
      needsApproval,
      describe: (_caller, { threadId, model, profileId }) =>
        titleOf(threadId).pipe(
          Effect.map(
            (t) =>
              `Switch ${t} to ${model}${profileId === undefined ? "" : ` (profile ${profileId})`}`,
          ),
        ),
      handle: (caller, { threadId, model, profileId }) =>
        Effect.gen(function* () {
          const tool = "set_thread_model";
          const target = yield* otherThread(tool, caller, threadId, "switch the model of");
          const current = target.thread.model;
          const profile = profileId ?? current.profileId;
          const options = yield* modelsFor(tool, current.agent, profile);
          const chosen = listedRow(options, model);
          const stored = canonicalModelId(options, model) ?? model;
          if (chosen === undefined) {
            return yield* new AppToolError({
              tool,
              message: `${model} isn't available for ${current.agent}. Available: ${options
                .slice(0, 12)
                .map((o) => o.id)
                .join(", ")}`,
            });
          }
          const variant =
            current.variant !== undefined && chosen.efforts.includes(current.variant)
              ? current.variant
              : undefined;
          const next: typeof current = {
            agent: current.agent,
            model: stored,
            ...(profile === undefined ? {} : { profileId: profile }),
            ...(variant === undefined ? {} : { variant }),
            ...(current.speed === undefined
              ? {}
              : {
                  speed:
                    current.speed === "fast" && !chosen.speeds?.includes("fast")
                      ? "standard"
                      : current.speed,
                }),
          };
          if (orchestration !== undefined) {
            yield* orchestration.checkModelChange(target.thread.id, next);
            if (yield* orchestration.isDelegated(caller, threadId)) {
              yield* orchestration.checkWorkerModel(caller, next);
            }
          }
          yield* runtimes.setModel(target.thread.id, next);
          return { threadId: target.thread.id, model: next };
        }).pipe(Effect.mapError(toolError("set_thread_model"))),
    });

    const setThreadEffort = defineAppTool({
      descriptor: {
        name: "set_thread_effort",
        class: "crossThread",
        description:
          "Use `effort` (`variant` is an alias). Set another thread's reasoning effort, when its model has the setting. The user approves it.",
      },
      input: inputAliases(
        Schema.Struct({ threadId: Schema.NonEmptyString, variant: ReasoningVariant }),
        { variant: ["effort"] },
      ),
      needsApproval,
      describe: (_caller, { threadId, variant }) =>
        titleOf(threadId).pipe(Effect.map((t) => `Set ${t} reasoning effort to ${variant}`)),
      handle: (caller, { threadId, variant }) =>
        Effect.gen(function* () {
          const tool = "set_thread_effort";
          const target = yield* otherThread(tool, caller, threadId, "set the effort of");
          const current = target.thread.model;
          const options = yield* modelsFor(tool, current.agent, current.profileId);
          const efforts = listedRow(options, current.model)?.efforts ?? [];
          if (efforts.length === 0) {
            return yield* new AppToolError({
              tool,
              message: `${current.model} has no reasoning effort setting.`,
            });
          }
          if (!efforts.includes(variant)) {
            return yield* new AppToolError({
              tool,
              message: `${current.model} supports ${efforts.join(", ")}.`,
            });
          }
          if (
            orchestration !== undefined &&
            aboveHigh(variant) &&
            (yield* orchestration.isDelegated(caller, threadId))
          ) {
            yield* orchestration.checkWorkerModel(caller, { ...current, variant });
          }
          yield* runtimes.setModel(target.thread.id, { ...current, variant });
          return { threadId: target.thread.id, variant };
        }).pipe(Effect.mapError(toolError("set_thread_effort"))),
    });

    const archiveThread = defineAppTool({
      descriptor: {
        name: "archive_thread",
        class: "crossThread",
        description:
          "Archive another thread: it's parked off the active list; nothing is deleted. An archived thread isn't woken by its pull request's checks or review, so archiving one with an open or monitored pull request is refused unless `force`. The user approves it.",
      },
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        force: Schema.optionalKey(Schema.Boolean),
      }),
      needsApproval,
      describe: (_caller, { threadId }) =>
        titleOf(threadId).pipe(Effect.map((t) => `Archive (park) ${t}`)),
      handle: (caller, { threadId, force }) =>
        Effect.gen(function* () {
          const target = yield* otherThread("archive_thread", caller, threadId, "archive");
          if (target.thread.parked) return { threadId: target.thread.id, archived: true };
          if (force !== true) {
            const badge =
              publisher === undefined ? undefined : yield* publisher.badgeFor(target.thread);
            const extras =
              publisher === undefined ? [] : yield* publisher.extraBadgesFor(target.thread);
            const hold = archiveHold(target.thread, badge, extras);
            if (hold !== undefined) {
              return yield* new AppToolError({
                tool: "archive_thread",
                message: `“${target.thread.title}” wasn't archived: ${hold}, and an archived thread isn't woken by its checks or review. Archive it once that is settled, or pass force: true if it has nothing left to wait for.`,
              });
            }
          }
          yield* runtimes.updateThread(target.thread.id, (t) => ({ ...t, parked: true }));
          yield* releaseWatchers;
          return {
            threadId: target.thread.id,
            archived: true,
            ...(yield* waitsLeftBy(store, target.thread.id)),
          };
        }).pipe(Effect.mapError(toolError("archive_thread"))),
    });

    const restoreWorktree = defineAppTool({
      descriptor: {
        name: "restore_worktree",
        class: "crossThread",
        description:
          "Recreate another thread's worktree deleted outside Gram (its git state reads missing; a worker's ledger row says `worktree missing`) at its recorded path and branch, from the local branch or else origin's, seeded with `.worktreeinclude` and permissions like a new worktree. What was uncommitted in it is gone for good. If the branch is gone everywhere it answers branchGone, naming the PR whose head `fromPr: true` recreates it from. The thread is cold afterwards; message it to carry on. On your own worker this needs no approval; elsewhere the user approves it.",
      },
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        fromPr: Schema.optionalKey(Schema.Boolean),
      }),
      needsApproval,
      describe: (_caller, { threadId, fromPr }) =>
        titleOf(threadId).pipe(
          Effect.map(
            (t) => `Restore the worktree of ${t}${fromPr === true ? " from its PR's head" : ""}`,
          ),
        ),
      handle: (caller, { threadId, fromPr }) =>
        Effect.gen(function* () {
          const target = yield* otherThread("restore_worktree", caller, threadId, "restore");
          return yield* restoreThreadWorktree(target.thread.id, fromPr === true).pipe(
            Effect.provideService(ThreadStore, store),
            Effect.provideService(CheckoutService, checkouts),
            publisher === undefined
              ? (effect) => effect
              : Effect.provideService(GitStatePublisher, publisher),
          );
        }).pipe(Effect.mapError(toolError("restore_worktree"))),
    });

    yield* registry.register([
      sendMessage,
      messageOrchestrator,
      broadcastMessage,
      stopThread,
      restartSession,
      setThreadModel,
      setThreadEffort,
      archiveThread,
      restoreWorktree,
    ]);
  }),
);
