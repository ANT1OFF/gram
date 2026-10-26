import type { AppTool, AppToolRegistryPort, ToolAudience } from "@gram/agents";
import {
  AppToolError,
  NotFound,
  TaskId,
  type AppToolClass,
  type AppToolDescriptor,
  type TaskChipData,
  type ThreadId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { ThreadWaits } from "../waits/service.ts";
import { defineAppTool, failed, type AppToolDefinition } from "./definition.ts";
import { inputLengthProblem } from "./input.ts";
import { dreamFileTools } from "./dream-tools.ts";
import { sendFileTool } from "./file-tools.ts";
import { setPlanTool } from "./plan-tool.ts";
import { sessionAppTools } from "./session-tools.ts";
import { showMockTool } from "./show-mock.ts";
import { showPanelTool } from "./show-panel.ts";
import { waitAppTools } from "./wait-tools.ts";
import { showWidgetTool } from "./widget-tool.ts";
import { moveToWorktreeTool } from "./worktree-tools.ts";

export { defineAppTool, type AppToolDefinition } from "./definition.ts";

/**
 * Safety classes: *read* and *self* tools run without a card, *crossThread* tools need
 * approval that may be remembered for the session, and *outward* tools need approval every time.
 * *outwardGated* tools raise their own card, so the registry lets them through.
 */
export const allowedWithoutApproval = (toolClass: AppToolClass): boolean =>
  toolClass === "read" || toolClass === "self" || toolClass === "outwardGated";

/**
 * What one call needs: no card, the card its class always raises (`class`), or a card the tool
 * asked for on this one call (`forced`).
 */
export type ApprovalVerdict = "none" | "class" | "forced";

/**
 * The per-call approval rule, for every binding with a gate. A tool's
 * own `needsApproval` answer wins over its class in either direction, and its `true` is that call's
 * card alone, which no mode or earlier answer lifts. The exception is an *outward* call, which
 * keeps its class's card whatever that answer is, because merging, closing and deleting are not
 * delegated by the charter. The only thing that lifts an outward card is the separate, explicit
 * `delegatedAtFullAutonomy`, and it lifts nothing else: on any other class it is not read.
 */
export const approvalFor = (
  toolClass: AppToolClass,
  needsApproval: boolean | undefined,
  delegatedAtFullAutonomy = false,
): ApprovalVerdict => {
  if (toolClass === "outward") return delegatedAtFullAutonomy ? "none" : "class";
  if (needsApproval === undefined) return allowedWithoutApproval(toolClass) ? "none" : "class";
  return needsApproval ? "forced" : "none";
};

/** Whether a definition is bound for `audience`; one without an `audience` is bound for all. */
const boundFor = (definition: AppToolDefinition, audience: ToolAudience): boolean =>
  audience === "dream"
    ? definition.audience?.includes("dream") === true
    : definition.audience === undefined || definition.audience.includes(audience);

/** Raises the approval card; fails closed on rejection or runtime cancellation. */
export interface ApprovalGate {
  approve(
    threadId: ThreadId,
    descriptor: AppToolDescriptor,
    input: unknown,
    /** The card's text; the descriptor's description when absent. */
    description?: string,
    /**
     * The tool asked for this card itself (`approvalFor`'s `forced`): it is about this one call, so
     * neither `bypassPermissions` nor an earlier "allow for session" answers it.
     */
    forced?: boolean,
    claims?: ReviewWriteClaims,
  ): Effect.Effect<void, AppToolError>;
}

/** What a review tool checked about its call (`babysit/review-tools.ts`); never read on a forced card. */
export interface ReviewWriteClaims {
  /**
   * The call writes only to the calling worker's own PR, at an autonomy that leaves PR work to the
   * worker's mode (`workerOwnPrFollowsMode`). Honoured for `OWN_PR_REVIEW_TOOLS` alone.
   */
  readonly workerOwnPr?: boolean | undefined;
  /**
   * The call answers a thread a configured review bot started, on the user's open PR that this
   * thread follows in its checkout's repo, from a plain thread or a worker at `publish` or `full`.
   * Honoured for `REVIEW_BOT_THREAD_TOOLS` alone.
   */
  readonly reviewBotThread?: boolean | undefined;
}

/**
 * The review tools that write only to the calling thread's own pull request
 * (`babysit/review-tools.ts`): the one exception to asking a worker on every call.
 */
export const OWN_PR_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  "pr_reply_to_thread",
  "pr_resolve_thread",
  "pr_request_rereview",
]);

/** The review tools that never ask outside Ask mode when they answer the review bot's own thread. */
export const REVIEW_BOT_THREAD_TOOLS: ReadonlySet<string> = new Set([
  "pr_reply_to_thread",
  "pr_resolve_thread",
]);

/** Schemas belong to definitions and are reused across thread/session bindings. */
const inputDocuments = new WeakMap<Schema.Top, ReturnType<typeof Schema.toJsonSchemaDocument>>();

/** Registration layers can finish in any order; every transport needs the same prefix. */
const byToolName = (a: AppToolDefinition, b: AppToolDefinition): number => {
  const left = a.descriptor.name;
  const right = b.descriptor.name;
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Binds definitions to a thread; `run` decodes the input once, so any transport can call it, and
 * the card, `describe` and `handle` all see that one decoded value (after the tool's `resolve`,
 * when it has one), so what a card shows is what runs. Input that doesn't decode, or a target that
 * doesn't resolve, fails the call before any card. With a `gate`, the registry enforces the safety
 * classes and the tools' own `needsApproval` itself before a tool runs; without one nothing does,
 * which is for listing the tools and for tests. The bound tool also carries its `needsApproval`,
 * which an *outward* tool never has (its class is the whole answer), and an outward tool's
 * `delegatedAtFullAutonomy` under that name.
 *
 * A tool's own `true` is a card for that call alone, in every mode (the gate's `forced`), and a
 * tool that `alwaysAsks` gets that card on every call whatever it or the delegation would answer;
 * neither is bound for it. Both hold on every binding with a gate, so every agent is asked alike.
 */
export const bindAppTools = (
  definitions: ReadonlyArray<AppToolDefinition>,
  threadId: ThreadId,
  gate?: ApprovalGate,
): ReadonlyArray<AppTool> =>
  definitions.toSorted(byToolName).map((definition) => {
    const { descriptor } = definition;
    const input = definition.input as unknown as Schema.Codec<unknown, unknown>;
    // A key the schema doesn't name is dropped by default, so `{ pr: 12 }` decoded to `{}` and
    // merged the bound PR instead. A call that acts on the world is refused for it instead.
    const decodeSchema = Schema.decodeUnknownEffect(
      input,
      descriptor.class === "outward" ||
        descriptor.class === "outwardGated" ||
        definition.rejectExcessProperties === true
        ? { onExcessProperty: "error" }
        : undefined,
    );
    const document = inputDocuments.get(input) ?? Schema.toJsonSchemaDocument(input);
    inputDocuments.set(input, document);
    const decode = (raw: unknown): Effect.Effect<unknown, AppToolError> => {
      const problem = inputLengthProblem(document, raw);
      return problem === undefined
        ? decodeSchema(raw).pipe(
            Effect.mapError((e) => new AppToolError({ tool: descriptor.name, message: e.message })),
          )
        : Effect.fail(new AppToolError({ tool: descriptor.name, message: problem }));
    };
    const encode = Schema.encodeUnknownEffect(input);
    const resolveCall = definition.resolve;
    const resolve = (decoded: unknown) =>
      resolveCall === undefined ? Effect.succeed(decoded) : resolveCall(threadId, decoded);
    const describeCall = definition.describe;
    const describe =
      describeCall === undefined
        ? undefined
        : (raw: unknown) =>
            decode(raw).pipe(
              Effect.flatMap(resolve),
              Effect.flatMap((target) => describeCall(threadId, target)),
              Effect.orElseSucceed((): string | undefined => undefined),
            );
    const alwaysAsks = definition.alwaysAsks === true;
    const asksPerCall = alwaysAsks ? undefined : definition.needsApproval;
    const delegatedCall =
      descriptor.class === "outward" && !alwaysAsks
        ? definition.delegatedAtFullAutonomy
        : undefined;
    const cardDetails = definition.cardDetails;
    /** Whether a card was raised and approved for the call; `undefined` with no gate. */
    const approve = (decoded: unknown, target: unknown) =>
      Effect.gen(function* () {
        if (gate === undefined) return undefined;
        const asked =
          asksPerCall === undefined ? undefined : yield* asksPerCall(threadId, decoded, target);
        // A check that dies is a doubt, and a doubt is a card.
        const delegated =
          delegatedCall === undefined
            ? false
            : yield* delegatedCall(threadId, decoded, target).pipe(
                Effect.catchCause(() => Effect.succeed(false)),
              );
        const verdict = alwaysAsks ? "forced" : approvalFor(descriptor.class, asked, delegated);
        if (verdict === "none") return false;
        const description =
          describeCall === undefined ? undefined : yield* describeCall(threadId, target);
        // The card's details are the input as it runs, in the schema's own encoding: a key the
        // schema drops or a value it rewrites isn't shown as though it were sent.
        const shown =
          cardDetails === undefined
            ? yield* encode(decoded).pipe(Effect.orElseSucceed(() => decoded))
            : cardDetails(target);
        yield* gate.approve(threadId, descriptor, shown, description, verdict === "forced");
        return true;
      });
    const needsApproval =
      asksPerCall === undefined || descriptor.class === "outward"
        ? undefined
        : (raw: unknown) =>
            decode(raw).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  definition.approvalRequiresResolvedTarget === true
                    ? Effect.fail(
                        new AppToolError({
                          tool: descriptor.name,
                          message: `Invalid input: ${error.message}`,
                        }),
                      )
                    : Effect.succeed(!allowedWithoutApproval(descriptor.class)),
                onSuccess: (decoded) => {
                  const decision = resolve(decoded).pipe(
                    Effect.flatMap((target) => asksPerCall(threadId, decoded, target)),
                  );
                  // Opt-in tools must refuse unresolved targets even when queried outside `run`.
                  // Other definitions retain their existing conservative class fallback.
                  return definition.approvalRequiresResolvedTarget === true
                    ? decision
                    : decision.pipe(
                        Effect.orElseSucceed(() => !allowedWithoutApproval(descriptor.class)),
                      );
                },
              }),
            );
    const delegatedAtFullAutonomy =
      delegatedCall === undefined
        ? undefined
        : (raw: unknown) =>
            decode(raw).pipe(
              Effect.flatMap((decoded) =>
                resolve(decoded).pipe(
                  Effect.flatMap((target) => delegatedCall(threadId, decoded, target)),
                ),
              ),
              Effect.catchCause(() => Effect.succeed(false)),
            );
    return {
      descriptor,
      input,
      ...(describe === undefined ? {} : { describe }),
      ...(needsApproval === undefined ? {} : { needsApproval }),
      ...(delegatedAtFullAutonomy === undefined ? {} : { delegatedAtFullAutonomy }),
      run: (raw) =>
        Effect.gen(function* () {
          const decoded = yield* decode(raw).pipe(
            Effect.mapError(
              (e) =>
                new AppToolError({ tool: descriptor.name, message: `Invalid input: ${e.message}` }),
            ),
          );
          const target = yield* resolve(decoded);
          const carded = yield* approve(decoded, target);
          return yield* definition.handle(threadId, target, { carded });
        }),
    };
  });

/**
 * A card's text as plain left-to-right text: control characters become spaces, and bidirectional
 * overrides, isolates and invisible spaces are dropped, so agent-authored text in it (a title, a
 * message) can't reorder or hide what the card says.
 */
const plainCardText = (text: string): string =>
  text
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\p{Cc}+/gu, " ");

/**
 * Cards raised through `ThreadRuntimes`, for every agent's app tools: this gate is the one that
 * asks about them, Claude's included (`forSession`), and it asks every agent alike. A *crossThread*
 * tool allowed for the session isn't asked again while that agent session lives, and a plain thread
 * in `bypassPermissions` isn't asked for a class's card, since the mode promises no prompts.
 *
 * A `forced` card, one a tool asked for about this call (its own `needsApproval` or `alwaysAsks`),
 * is asked in every mode, Bypass included, and for the one call only: the tool has said this call
 * is not one the mode or an earlier answer covers.
 *
 * An orchestrator or a worker is asked in every mode, and for the one call only. Codex has no Auto,
 * so such a thread *starts* in `bypassPermissions`: skipped there, a spawn over the charter's cap
 * and a message to somebody else's thread would go unasked, and an answer remembered for the
 * session would turn "one worker more" into a standing grant for a thread nobody watches.
 *
 * The one exception is a worker's review write on its own PR (`OWN_PR_REVIEW_TOOLS`) when its
 * workspace's autonomy is `publish` or `full`, which leave pushing and PR work free: none of
 * the above is in a reply on its own PR, so the thread's mode decides, as for a plain thread. It
 * rests on the tool's own check that the PR is the worker's (`workerOwnPr`), not on the role.
 *
 * Answering the review bot (`REVIEW_BOT_THREAD_TOOLS` with `reviewBotThread`) never asks a plain
 * thread or a worker outside `default` (Ask) mode, not for a declined blocker or an unfixed resolve
 * either. Ask mode, which the user picked in order to be asked, keeps the review tools' own rules,
 * babysit's cover included. The tool vouches for
 * the thread, the PR and a worker's autonomy; the gate adds the mode, and never lets an
 * orchestrator or a dream claim it.
 */
export const makeApprovalGate = (
  runtimes: ThreadRuntimesShape,
  store: Pick<ThreadStoreShape, "getThread">,
): ApprovalGate => {
  /**
   * Tool names allowed for the session, by the live agent session they were allowed in: a closed,
   * reopened or fresh session asks again, as Claude's own "session" rules did.
   */
  const allowedForSession = new WeakMap<object, Set<string>>();
  return {
    approve: (threadId, descriptor, input, description, forced = false, claims = {}) =>
      Effect.gen(function* () {
        const { name } = descriptor;
        const thread = yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
        const answersBot =
          !forced &&
          claims.reviewBotThread === true &&
          REVIEW_BOT_THREAD_TOOLS.has(name) &&
          thread !== undefined &&
          thread.role === undefined &&
          thread.mode !== "default";
        if (answersBot) return;
        const ownPr =
          claims.workerOwnPr === true &&
          OWN_PR_REVIEW_TOOLS.has(name) &&
          thread?.role === undefined &&
          thread?.spawnedBy !== undefined;
        const once =
          forced || (!ownPr && (thread?.role !== undefined || thread?.spawnedBy !== undefined));
        if (thread?.mode === "bypassPermissions" && !once) return;
        const remembers = descriptor.class === "crossThread" && !once;
        // No live session, no memory: the call is asked.
        const session = remembers
          ? yield* runtimes.session(threadId).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const allowed = session === undefined ? undefined : allowedForSession.get(session);
        if (allowed?.has(name) === true) return;
        const answer = yield* runtimes
          .requestApproval(threadId, {
            toolName: `mcp__gram__${name}`,
            displayName: name,
            input:
              typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {},
            description: plainCardText(description ?? descriptor.description),
            suggestions: [],
            scopes: descriptor.class === "outward" || once ? ["once"] : ["once", "session"],
          })
          .pipe(
            Effect.catchTag("ThreadNotFound", () =>
              Effect.gen(function* () {
                return yield* new AppToolError({
                  tool: name,
                  message: `Gram did not execute ${name}: approval unavailable for thread ${threadId}.`,
                  approvalRequired: true,
                  approvalResolution: {
                    origin: "runtime",
                    reason: "approval-unavailable",
                    threadId,
                    resolvedAt: yield* Clock.currentTimeMillis,
                  },
                });
              }),
            ),
          );
        if (answer.decision !== "allow") {
          const resolution = answer.resolution ?? {
            origin: "unknown" as const,
            reason: "approval-denied",
            threadId,
            resolvedAt: yield* Clock.currentTimeMillis,
            ...(thread === undefined ? {} : { permissionMode: thread.mode }),
          };
          const userRejected = resolution.origin === "user" && resolution.reason === "rejected";
          return yield* new AppToolError({
            tool: name,
            message: userRejected
              ? `The user declined ${name}.`
              : `Gram did not execute ${name}: approval ${resolution.origin === "runtime" ? "cancelled by the runtime" : "denied without decision provenance"} (${resolution.reason}).${resolution.requestId === undefined ? "" : ` Request ${resolution.requestId}.`} Check the thread's current state before retrying.`,
            approvalRequired: true,
            approvalResolution: resolution,
          });
        }
        if (session !== undefined && answer.scope !== "once") {
          allowedForSession.set(session, (allowed ?? new Set()).add(name));
        }
      }),
  };
};

/** What `spawn_task` answers an orchestrator that gives no `reason`. */
export const SPAWN_TASK_NEEDS_REASON =
  "You're an orchestrator: hand work to a worker with spawn_worker (it gets a worktree, a PR and " +
  "a place on the board). Use spawn_task only for work that belongs outside this workspace, and " +
  "pass `reason`.";

export interface AppToolRegistryShape extends AppToolRegistryPort {
  readonly definitions: ReadonlyArray<AppToolDefinition>;
  /** Adds another subsystem's tools (git, review bots). A duplicate name is a defect. */
  register(definitions: ReadonlyArray<AppToolDefinition>): Effect.Effect<void>;
  /** The tools for the HTTP MCP server (Codex), with the registry's gate in `run`. */
  forTransport(threadId: ThreadId, audience?: ToolAudience): ReadonlyArray<AppTool>;
  /** Who `threadId` is to the tools, for a transport that has only the thread id to go on. */
  audienceOf(threadId: ThreadId): Effect.Effect<ToolAudience>;
}

export class AppToolRegistry extends Context.Service<AppToolRegistry, AppToolRegistryShape>()(
  "@gram/server/AppToolRegistry",
) {
  /** The core tools; registers itself with `ThreadRuntimes` so sessions get the tools. */
  static readonly layer: Layer.Layer<
    AppToolRegistry,
    never,
    ThreadStore | EventHub | ThreadRuntimes | ThreadPlans | ThreadWaits | CheckoutService
  > = Layer.effect(
    AppToolRegistry,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const plans = yield* ThreadPlans;
      const waits = yield* ThreadWaits;
      const checkouts = yield* CheckoutService;

      const setTitle = defineAppTool({
        descriptor: {
          name: "set_title",
          class: "self",
          description: "Name this thread. Ignored when the user already named it.",
        },
        input: Schema.Struct({ title: Schema.NonEmptyString }),
        handle: (threadId, { title }) =>
          runtimes
            .updateThread(threadId, (t) =>
              t.userNamed ? t : { ...t, title: title.trim(), agentNamed: true },
            )
            .pipe(
              Effect.map((t) => ({ title: t.title, applied: !t.userNamed })),
              Effect.mapError(failed("set_title")),
            ),
      });

      const markChapter = defineAppTool({
        descriptor: {
          name: "mark_chapter",
          class: "self",
          description: "Insert a chapter divider into the transcript.",
        },
        input: Schema.Struct({ title: Schema.NonEmptyString }),
        handle: (threadId, { title }) => {
          const id = randomUUID();
          return runtimes
            .emitChunk(threadId, { type: "data-chapter", id, data: { id, title } })
            .pipe(Effect.as({ chapterId: id }), Effect.mapError(failed("mark_chapter")));
        },
      });

      const spawnTaskInput = Schema.Struct({
        title: Schema.NonEmptyString,
        prompt: Schema.NonEmptyString,
        checkout: Schema.optionalKey(Schema.Literals(["current", "new-worktree"])),
        branch: Schema.optionalKey(Schema.String),
        base: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
      });
      // Who the caller is now, not which description it was bound with: a Claude session keeps its
      // binding through a turn in which orchestration can be switched off and on again.
      const offerTask = (threadId: ThreadId, input: typeof spawnTaskInput.Type) =>
        Effect.gen(function* () {
          const reason = input.reason?.trim();
          if (
            (reason === undefined || reason === "") &&
            (yield* runtimes.audienceOf(threadId)) === "orchestrator"
          ) {
            return yield* new AppToolError({
              tool: "spawn_task",
              message: SPAWN_TASK_NEEDS_REASON,
            });
          }
          const task: TaskChipData = {
            id: Schema.decodeSync(TaskId)(randomUUID()),
            title: input.title,
            prompt: input.prompt,
            ...(input.checkout === undefined ? {} : { checkout: input.checkout }),
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(input.base === undefined ? {} : { base: input.base }),
            ...(reason === undefined || reason === "" ? {} : { reason }),
            status: "offered",
          };
          const messageId = yield* runtimes.emitChunk(threadId, {
            type: "data-task-chip",
            id: task.id,
            data: task,
          });
          yield* store.putTask(threadId, messageId, task);
          return { taskId: task.id };
        }).pipe(Effect.mapError(failed("spawn_task")));
      const whereTaskStarts =
        "It starts in a git worktree of its own, on `branch` (a name is made up when absent), " +
        "branched from `base` or else from this thread's HEAD, so it sees your commits but not " +
        'your uncommitted changes. Pass checkout "current" only for a task that writes nothing ' +
        "and must see your uncommitted files: it shares your working tree, HEAD and index.";

      const spawnTask = defineAppTool({
        descriptor: {
          name: "spawn_task",
          class: "self",
          description:
            "Offer a follow-up task as a chip; the user can start it as a new thread with the prompt. " +
            whereTaskStarts,
        },
        audience: ["plain", "worker"],
        input: spawnTaskInput,
        handle: offerTask,
      });

      // The same tool as an orchestrator sees it: a chip starts a
      // thread outside the workspace, with no ledger entry, PR tracking or digest, which one
      // orchestrator reached for in place of `spawn_worker`. `offerTask` asks it for the reason.
      const orchestratorSpawnTask = defineAppTool({
        descriptor: {
          name: "spawn_task",
          class: "self",
          description:
            "Offer the user a chip that starts an independent thread, outside this workspace: not " +
            "a worker, so it has no place on the board, and you get no reports or digests from it. " +
            "Work for this workspace goes to `spawn_worker` instead. Use this only for work that " +
            "belongs outside it (work the user asked to keep separate, a repo or topic unrelated " +
            "to the workspace, a one-off the user will drive themselves), and say why in `reason`, " +
            "which the chip shows. " +
            whereTaskStarts,
        },
        audience: ["orchestrator"],
        input: spawnTaskInput,
        handle: offerTask,
      });

      const dismissTask = defineAppTool({
        descriptor: {
          name: "dismiss_task",
          class: "self",
          description: "Withdraw a task chip this thread offered.",
        },
        input: Schema.Struct({ taskId: TaskId }),
        handle: (threadId, { taskId }) =>
          Effect.gen(function* () {
            const { messageId, task } = yield* store.getTask(threadId, taskId);
            const dismissed: TaskChipData = { ...task, status: "dismissed" };
            yield* store.putTask(threadId, messageId, dismissed);
            yield* runtimes.updateDataPart(threadId, messageId, {
              type: "data-task-chip",
              id: taskId,
              data: dismissed,
            });
            return { taskId };
          }).pipe(
            Effect.mapError((e) =>
              e instanceof NotFound
                ? new AppToolError({ tool: "dismiss_task", message: `unknown task ${taskId}` })
                : failed("dismiss_task")(e),
            ),
          ),
      });

      const markCompleted = defineAppTool({
        descriptor: {
          name: "mark_completed",
          class: "self",
          description: "Flag the work as done and ready for review.",
        },
        input: Schema.Struct({ summary: Schema.optionalKey(Schema.String) }),
        handle: (threadId, { summary }) =>
          Effect.gen(function* () {
            const thread = yield* runtimes.markCompleted(threadId, "agent");
            yield* hub.publish({
              type: "notify",
              kind: "done",
              title: thread.title,
              ...(summary === undefined ? {} : { body: summary }),
              threadId,
            });
            return { completedAt: thread.completedAt };
          }).pipe(Effect.mapError(failed("mark_completed"))),
      });

      const setUnread = defineAppTool({
        descriptor: {
          name: "set_unread",
          class: "self",
          description: "Mark this thread unread so it stands out in the sidebar.",
        },
        input: Schema.Struct({ unread: Schema.optionalKey(Schema.Boolean) }),
        handle: (threadId, { unread = true }) =>
          runtimes
            .updateThread(threadId, (t) => ({ ...t, unread }))
            .pipe(Effect.as({ unread }), Effect.mapError(failed("set_unread"))),
      });

      const notifyUser = defineAppTool({
        descriptor: {
          name: "notify_user",
          class: "self",
          description: "Raise a notification for the user with a short message.",
        },
        input: Schema.Struct({
          title: Schema.NonEmptyString,
          body: Schema.optionalKey(Schema.String),
          kind: Schema.optionalKey(Schema.Literals(["needsInput", "done", "error", "info"])),
        }),
        handle: (threadId, { title, body, kind = "info" }) =>
          hub
            .publish({
              type: "notify",
              kind,
              title,
              ...(body === undefined ? {} : { body }),
              threadId,
            })
            .pipe(Effect.as({ notified: true })),
      });

      const definitions: Array<AppToolDefinition> = [
        ...dreamFileTools(store),
        setTitle,
        setPlanTool(plans, store),
        markChapter,
        spawnTask,
        orchestratorSpawnTask,
        dismissTask,
        markCompleted,
        setUnread,
        notifyUser,
        showPanelTool(hub),
        sendFileTool(runtimes, store),
        showMockTool(runtimes, store),
        ...sessionAppTools(runtimes, store),
        moveToWorktreeTool(runtimes, store, checkouts),
        showWidgetTool(runtimes),
        ...waitAppTools(waits, runtimes),
      ];
      const gate = makeApprovalGate(runtimes, store);
      const registry = AppToolRegistry.of({
        definitions,
        register: (added) =>
          Effect.suspend(() => {
            const taken = added.find((d) =>
              definitions.some((existing) => existing.descriptor.name === d.descriptor.name),
            );
            if (taken !== undefined) {
              return Effect.die(
                new Error(`app tool ${taken.descriptor.name} is already registered`),
              );
            }
            definitions.push(...added);
            return Effect.void;
          }),
        forThread: (threadId, audience = "plain") =>
          bindAppTools(
            definitions.filter((d) => boundFor(d, audience)),
            threadId,
          ),
        forTransport: (threadId, audience = "plain") =>
          bindAppTools(
            definitions.filter((d) => boundFor(d, audience)),
            threadId,
            gate,
          ),
        // The server's gate is the authority on Claude too: the SDK's permission
        // layer lets a call through unasked in `bypassPermissions`, under an allow rule or an
        // "always" answer, and when Auto's classifier approves it, so an outward merge or a
        // worker's cross-thread call could run with no card.
        forSession: (threadId, audience = "plain") =>
          bindAppTools(
            definitions.filter((d) => boundFor(d, audience)),
            threadId,
            gate,
          ),
        audienceOf: runtimes.audienceOf,
      });
      yield* runtimes.setAppTools(registry);
      return registry;
    }),
  );
}
