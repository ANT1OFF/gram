import {
  AppToolError,
  ReasoningVariant,
  type AgentKind,
  type MessageOrigin,
  type PrStatus,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isBadgeOf } from "../git/extra-prs.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { restoreThreadWorktree } from "../git/restore-worktree.ts";
import { isLiveWorker } from "../orchestration/ledger.ts";
import { sendFingerprint } from "../orchestration/outbox.ts";
import { featureSlug } from "../orchestration/rules.ts";
import { Orchestration, type SentMessage } from "../orchestration/service.ts";
import { attachUserWords, USER_MESSAGES_MAX } from "../orchestration/user-words.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { selectableModels } from "../runtime/model-efforts.ts";
import { limitQueuedNote } from "../runtime/limit-wait.ts";
import { ThreadRuntimes, type JoinQueued, type JoinResult } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";
import { inputAliases } from "./input.ts";
import { checkSend } from "./loop-guard.ts";
import { AppToolRegistry } from "./registry.ts";

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

/** Opens a queued item that carries more than one message. */
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

/** What `send_message` delivers, less its retry id. */
interface SendInput {
  readonly threadId: string;
  readonly text: string;
  readonly mode?: "queue" | "steer";
}

interface ParentRoute {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

type Badge = Pick<PrStatus, "number" | "url" | "state">;

/**
 * Why archiving `thread` now would cut it off from what it waits on, or `undefined`. An archived
 * thread isn't woken by its checks or its review (the publisher leaves parked threads out), so a
 * worker archived with a pull request open, or a monitor on, waits forever. That holds for each PR
 * it follows: its main one (`badge`, the publisher's for the PR it acts on) and every extra
 * (`extraBadges`). A badge counts only for the PR it names, since a rebind can leave the previous
 * binding's for a moment and numbers are local to a repository; a monitored PR whose state isn't
 * known is held, and one known to be merged or closed waits on nothing.
 */
export const archiveHold = (
  thread: Pick<Thread, "boundPr" | "extraPrs" | "babysit">,
  badge: Badge | undefined,
  extraBadges: ReadonlyArray<Badge> = [],
): string | undefined => {
  if (thread.babysit?.phase === "watching") return "it is babysitting its pull request";
  const bound = thread.boundPr;
  const followed = [
    // Without a binding, the badge is its checkout's own PR.
    ...(bound === undefined
      ? badge === undefined
        ? []
        : [{ label: `#${badge.number}`, badge, monitored: false }]
      : [
          {
            label: `${bound.repo}#${bound.number}`,
            badge: badge !== undefined && isBadgeOf(badge, bound) ? badge : undefined,
            monitored: bound.monitor || bound.reviewMonitor === true,
          },
        ]),
    ...(thread.extraPrs ?? []).map((extra) => ({
      label: `${extra.repo}#${extra.number}`,
      badge: extraBadges.find((each) => isBadgeOf(each, extra)),
      monitored: extra.monitor,
    })),
  ];
  for (const pr of followed) {
    if (pr.badge?.state === "OPEN") return `its pull request ${pr.label} is open`;
  }
  for (const pr of followed) {
    if (pr.monitored && pr.badge?.state !== "MERGED" && pr.badge?.state !== "CLOSED") {
      return `it is monitoring pull request ${pr.label}`;
    }
  }
  return undefined;
};

/** How long a queued message has waited, as the sender is told. */
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
    // Absent in runtime-only layers, where there are no watchers to release on park.
    const publisher = Option.getOrUndefined(yield* Effect.serviceOption(GitStatePublisher));
    const releaseWatchers = publisher === undefined ? Effect.void : publisher.sync;
    // Absent in runtime-only layers, where nothing is ever delegated.
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    /** Epoch ms of each sender's recent sends, for the rate limit. */
    const sends = new Map<ThreadId, ReadonlyArray<number>>();

    const isDelegated = (caller: ThreadId, threadId: string) =>
      orchestration === undefined
        ? Effect.succeed(false)
        : orchestration.isDelegated(caller, threadId);
    /**
     * A gate may ask twice for one call, so this only reads. Anything that goes wrong asks the user.
     */
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

    // Exact persisted identity, including dormant threads; no prefix or title-based routing.
    const resolveSendTarget = (threadId: string) =>
      store
        .getThread(threadId as ThreadId)
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
        .summaryOf(threadId as ThreadId)
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
      store.getThread(threadId as ThreadId).pipe(
        Effect.match({
          onFailure: () => `unknown thread ${threadId}`,
          onSuccess: (thread) => `“${thread.title}”`,
        }),
      );

    const modelsFor = (tool: string, agent: AgentKind, profileId: string | undefined) =>
      selectableModels(store, hosts, agent, profileId).pipe(Effect.mapError(toolError(tool)));

    /** A delegated or full-autonomy worker send with a retry id runs once. */
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
          message.threadId as ThreadId,
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

    /**
     * One message to another thread, through whichever loop guard applies to the pair. With
     * `ownWorkerOnly` it is refused unless the target is still the caller's own worker, which a
     * send nobody approves needs: the user may detach one while a broadcast runs.
     */
    const deliver = (
      caller: ThreadId,
      { threadId, text, mode }: SendInput,
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
        // An orchestrator writing to its own worker: the back-to-back rule would refuse every
        // follow-up to a brief, so its guard leaves that rule out, and the hop count stays at 1.
        const delegated =
          orchestration !== undefined && (yield* orchestration.isDelegated(caller, threadId));
        const workerSend = yield* isWorkerSend(caller, threadId);
        // Recheck after the gate: a changed workspace/owner must not inherit the earlier exemption.
        if (uncarded && !delegated && !workerSend) {
          return yield* new AppToolError({
            tool,
            message: "no_authority: This message now requires the user's approval. Retry the call.",
          });
        }
        if (ownWorkerOnly && !delegated) {
          return yield* new AppToolError({ tool, message: "It is no longer your worker." });
        }
        const callerUser = (yield* store.listMessages(caller)).filter((m) => m.role === "user");
        const callerOrigin = callerUser.length === 0 ? undefined : originOf(callerUser.at(-1)!);
        let depth = 1;
        let counted: ReadonlyArray<number> | undefined;
        if (delegated) {
          yield* orchestration.checkSend(caller, target.thread.id);
        } else {
          const targetUser = (yield* store.listMessages(target.thread.id)).filter(
            (m) => m.role === "user",
          );
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
        // An orchestrator's word to its own worker is usually a correction, which a turn spent
        // waiting behind it makes stale.
        const asked = mode ?? (delegated ? "steer" : undefined);
        const role = source.thread.role;
        // A worker's feature marks its message a worker's, which the receiving agent reads fenced.
        const feature = source.thread.spawnedBy?.feature;
        const input = {
          text,
          origin: {
            threadId: caller,
            title: source.thread.title,
            depth,
            ...(role === undefined ? {} : { role }),
            ...(feature === undefined ? {} : { feature }),
            ...(asked === undefined ? {} : { mode: asked }),
          },
        };
        yield* resolveSendTarget(threadId);
        if (parentRoute !== undefined) yield* checkParentRoute(caller, parentRoute);
        if (workerSend) yield* orchestration!.checkWorkerMessage(caller, target.thread.id);
        const canSteer = target.capabilities?.steer === true && target.status === "running";
        const steer = asked === "steer";
        const steered =
          steer &&
          canSteer &&
          (yield* runtimes.steer(target.thread.id, input).pipe(
            Effect.as(true),
            // The turn can end between the snapshot and the steer; to a worker that is a queued
            // message, not a failed send.
            Effect.catchTag("InvalidState", (e) =>
              delegated ? Effect.succeed(false) : Effect.fail(e),
            ),
          ));
        let delivered: "sent" | "queued" | "steered" = "steered";
        const notes: Array<string> = [];
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
          if (mode === "steer") {
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

    const sendMessage = defineAppTool({
      descriptor: {
        name: "send_message",
        class: "crossThread",
        description:
          'Use `message` for message text (`text` and `content` are aliases). Send a message to another Gram thread using the exact full threadId from list_threads or list_workers; shortened IDs are refused. For parent coordination, use message_orchestrator without an ID. Messages are queued until it\'s idle, or with mode "steer" delivered mid-turn, once the tool call running now finishes, when that agent supports it. To your own running worker a message is steered unless you pass mode "queue": steer what changes what it should do now, queue context it can read after its current step. A queued message to your own worker joins your earlier one while that is still waiting, and the result says how long it has waited. Your own workers need no approval. In Full Auto, a current worker may also coordinate with its bound workspace orchestrator or a current sibling worker without approval; these messages queue by default and keep the back-to-back, chain and rate limits. Prefer `report` for progress, decisions, blockers and completed work to your orchestrator. Paused workspaces and workers held by the user refuse these messages. Other targets and worker sends outside Full Auto require approval for each call, even in Bypass. `clientRequestId` retries an own-worker or Full Auto worker send without sending it again. An orchestrator\'s `userMessages` (1–5) attaches the user\'s latest messages in its conversation after `message`, word for word: for a paste the worker needs exactly, instead of retyping it. To mention a thread to the user, link it as [title](#threadId).',
      },
      input: inputAliases(
        Schema.Struct({
          threadId: Schema.NonEmptyString,
          text: Schema.NonEmptyString,
          mode: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
          clientRequestId: Schema.optionalKey(Schema.String),
          userMessages: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: USER_MESSAGES_MAX })),
          ),
        }),
        { text: ["message", "content"] },
      ),
      approvalRequiresResolvedTarget: true,
      resolve: (caller, { userMessages, ...input }) =>
        Effect.gen(function* () {
          const target = yield* resolveSendTarget(input.threadId);
          const text = yield* attachUserWords(
            store,
            "send_message",
            caller,
            input.text,
            userMessages,
          );
          return { ...input, text, targetTitle: target.title };
        }),
      needsApproval: (caller, _input, target) => sendNeedsApproval(caller, target),
      describe: (_caller, { targetTitle, text, mode }) =>
        Effect.succeed(
          `Send to “${targetTitle}”${mode === "steer" ? " (steer)" : ""}: ${truncate(text, CARD_TEXT_CAP)}`,
        ),
      handle: (caller, { threadId, text, mode, clientRequestId }, { carded }) =>
        deliver(
          caller,
          { threadId, text, ...(mode === undefined ? {} : { mode }) },
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
          "Use `message` for message text (`text` and `content` are aliases). Send specific coordination or clarification to your current bound workspace orchestrator, queued by default. No thread ID is needed. Prefer report for structured progress, completion and interface status. Full Auto needs no approval for this current owned route; lower autonomy requires per-call approval even in Bypass. Pauses, user holds and stale membership refuse. The usual origin, back-to-back, two-hop and rate guards apply. clientRequestId deduplicates Full Auto retries per sender.",
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
          'Use `message` for message text (`text` and `content` are aliases). Send one message to each of your live workers, or to those of one `feature`, or to the `threadIds` named: for what they all need to hear, such as main moving or a changed convention. Each gets it as from send_message, steered unless mode "queue", and through the same per-worker limit. A worker the user holds, or one that refuses, is listed under `skipped` with why; the rest are sent.',
      },
      audience: ["orchestrator"],
      input: inputAliases(
        Schema.Struct({
          text: Schema.NonEmptyString,
          feature: Schema.optionalKey(Schema.String),
          threadIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
          mode: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
        }),
        { text: ["message", "content"] },
      ),
      // Only the caller's own workers are ever sent to, which is delegated like one send to each.
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
          if (target.status !== "running" && target.status !== "starting") {
            return { threadId: target.thread.id, stopped: false, status: target.status };
          }
          yield* runtimes.interrupt(target.thread.id);
          return { threadId: target.thread.id, stopped: true };
        }).pipe(Effect.mapError(toolError("stop_thread"))),
    });

    const restartSession = defineAppTool({
      descriptor: {
        name: "restart_session",
        class: "crossThread",
        description:
          "Restart an agent session so it reads its setup from disk again (settings, MCP servers and connectors, CLAUDE.md or AGENTS.md, skills, the agent CLI) after one of them changed; the conversation carries on where it was. Without threadId it is your own session, which restarts once this turn ends, so end your turn after calling it. Another thread's session restarts at once when it is at rest, stopping its background tasks; while it runs a turn it restarts when the turn ends, unless interrupt: true cuts the turn off. On your own worker at full autonomy this needs no approval; on any other thread the user approves it.",
      },
      input: Schema.Struct({
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        interrupt: Schema.optionalKey(Schema.Boolean),
      }),
      // Its own session goes no further than a restart once the turn it asks in has ended.
      needsApproval: (caller, { threadId }) =>
        threadId === undefined || threadId === caller
          ? Effect.succeed(false)
          : orchestration === undefined
            ? Effect.succeed(true)
            : orchestration.fullAutonomyAllows(caller, threadId).pipe(Effect.map((full) => !full)),
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
        profileId: Schema.optionalKey(Schema.String),
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
          const chosen = options.find((o) => o.id === model);
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
          const next = {
            agent: current.agent,
            model,
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
          } as typeof current;
          if (orchestration !== undefined) {
            // Admission holds on every path a model changes by, and a delegated switch also stays
            // inside the charter's worker models.
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
          const efforts = options.find((o) => o.id === current.model)?.efforts ?? [];
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
          yield* runtimes.setModel(target.thread.id, { ...current, variant });
          return { threadId: target.thread.id, variant };
        }).pipe(Effect.mapError(toolError("set_thread_effort"))),
    });

    const archiveThread = defineAppTool({
      descriptor: {
        name: "archive_thread",
        class: "crossThread",
        description:
          "Archive another thread: it's parked, leaving the active list; nothing is deleted. An archived thread isn't woken by its pull request's checks or review, so archiving one whose pull request is open, or that monitors one, is refused unless `force`. The user approves it.",
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
          return { threadId: target.thread.id, archived: true };
        }).pipe(Effect.mapError(toolError("archive_thread"))),
    });

    const restoreWorktree = defineAppTool({
      descriptor: {
        name: "restore_worktree",
        class: "crossThread",
        description:
          "Recreate another thread's worktree that was deleted outside Gram (its git state reads missing, a worker's ledger row says `worktree missing`): at its recorded path, on its branch, from the local branch or else origin's, with `.worktreeinclude` and permissions seeded as for a new worktree. What was uncommitted in it is gone and can't come back. When the branch is gone everywhere it answers branchGone, naming the PR whose head `fromPr: true` recreates it from. The thread is cold afterwards; send it a message to carry on. On your own worker this needs no approval; elsewhere the user approves it.",
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
