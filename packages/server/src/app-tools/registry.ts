import type { AppTool, AppToolRegistryPort, ToolAudience } from "@gram/agents";
import {
  AppToolError,
  effectiveCheckout,
  NotFound,
  TaskId,
  type AppToolClass,
  type TaskChipData,
  type ThreadId,
  agentTitle,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadWaits } from "../waits/service.ts";
import {
  byToolName,
  defineAppTool,
  failed,
  type AppToolCall,
  type AppToolDefinition,
  type AskedDespiteAutonomy,
} from "./definition.ts";
import { inputLengthProblem } from "./input.ts";
import { DecisionHook, REFUSAL_FOR_AGENT } from "../embedding/decision-hook.ts";
import { RoutedFor, threadOwner } from "../host/ownership.ts";
import {
  anyPrivate,
  currentReader,
  mayReadThread,
  pathsMentioned,
  ReadingAs,
  readableByOf,
  readableByOfWorkspace,
  readerMay,
  threadsMentioned,
  touchesUnreadable,
  workspacesMentioned,
} from "../embedding/readable-by.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { makeActionGuard, type ActionGuard } from "../embedding/guard.ts";
import { dreamFileTools } from "./dream-tools.ts";
import { sendFileTool } from "./file-tools.ts";
import { sentFromMachinesHere } from "./sent-from-machines.ts";
import { setPlanTool } from "./plan-tool.ts";
import { sessionAppTools } from "./session-tools.ts";
import { showMockTool } from "./show-mock.ts";
import { showPanelTool } from "./show-panel.ts";
import { waitAppTools } from "./wait-tools.ts";
import { showWidgetTool } from "./widget-tool.ts";
import { moveToWorktreeTool } from "./worktree-tools.ts";
import { forThread } from "../embedding/gh-thread.ts";
import { type PendingCard, pendingCardsOf } from "./pending-cards.ts";
import { type ApprovalGate, makeApprovalGate, plainCardText } from "./approval-gate.ts";

export { defineAppTool, type AppToolDefinition } from "./definition.ts";
export {
  makeApprovalGate,
  OWN_PR_REVIEW_TOOLS,
  REVIEW_BOT_THREAD_TOOLS,
  type ApprovalGate,
  type ReviewWriteClaims,
} from "./approval-gate.ts";

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

const boundFor = (definition: AppToolDefinition, audience: ToolAudience): boolean =>
  audience === "dream"
    ? definition.audience?.includes("dream") === true
    : definition.audience === undefined || definition.audience.includes(audience);

/**
 * How long a tool's `whyAsked` may take before its card goes up without it: long enough for the
 * ownership check's git and gh reads, short enough that the user isn't kept from the card.
 */
export const WHY_ASKED_TIMEOUT = Duration.seconds(5);

type Approved =
  | {
      readonly kind: "acted";
      readonly result: unknown;
      readonly why: AskedDespiteAutonomy | undefined;
    }
  | { readonly kind: "joined"; readonly askedIn: ThreadId };

/** What a call gets that joined its caller's own waiting card (`sharedCard`): it did nothing. */
export const askedElsewhere = (tool: string, askedIn: ThreadId) => ({
  askedElsewhere: askedIn,
  done: false,
  note: `The user is already being asked this same ${tool} call from this thread. That card is the one decision; this call did nothing, raised no card and needn't be repeated.`,
});

/** What a thread readable by one person is told that writes into a thread of another reader. */
export const WRITES_STAY_PRIVATE =
  "This thread is readable by one person, so it sends nothing into a thread readable by others.";

const inputDocuments = new WeakMap<Schema.Top, ReturnType<typeof Schema.toJsonSchemaDocument>>();

const asLineage = <A, E, R>(
  lineage: ((threadId: ThreadId) => Effect.Effect<string | undefined>) | undefined,
  threadId: ThreadId,
  call: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(lineage === undefined ? Effect.succeed(undefined) : lineage(threadId), (person) =>
    call.pipe(
      Effect.provideService(RoutedFor, { person }),
      Effect.provideService(ReadingAs, {
        subject: readableByOf(threadId),
        fromThread: true,
        thread: threadId,
      }),
    ),
  );

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
  guard?: ActionGuard,
  lineage?: (threadId: ThreadId) => Effect.Effect<string | undefined>,
  foldersOf?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string>>,
): ReadonlyArray<AppTool> =>
  definitions.toSorted(byToolName).map((definition) => {
    const { descriptor } = definition;
    const { input } = definition;
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
    const whyAsked = delegatedCall === undefined ? undefined : definition.whyAsked;
    const refuseInstead =
      delegatedCall === undefined ? undefined : definition.refuseInsteadOfAsking;
    const sharedCardOf = definition.sharedCard;
    const hostDecides = definition.hostDecides === true;
    const approve = (
      decoded: unknown,
      target: unknown,
      act: (call: AppToolCall) => Effect.Effect<unknown, AppToolError>,
      decidedByHost: boolean,
    ): Effect.Effect<Approved, AppToolError> => {
      const acted = (carded: boolean | undefined, why: AskedDespiteAutonomy | undefined) =>
        act({ carded }).pipe(Effect.map((result): Approved => ({ kind: "acted", result, why })));
      return Effect.gen(function* () {
        if (gate === undefined) return yield* acted(undefined, undefined);
        if (hostDecides && decidedByHost) return yield* acted(false, undefined);
        const asked =
          asksPerCall === undefined ? undefined : yield* asksPerCall(threadId, decoded, target);
        const delegated =
          delegatedCall === undefined
            ? false
            : yield* delegatedCall(threadId, decoded, target).pipe(
                Effect.catchCause(() => Effect.succeed(false)),
              );
        const verdict = alwaysAsks ? "forced" : approvalFor(descriptor.class, asked, delegated);
        if (verdict === "none") return yield* acted(false, undefined);
        const refusal =
          refuseInstead === undefined || verdict !== "class"
            ? undefined
            : yield* Effect.suspend(() => refuseInstead(threadId, target)).pipe(
                Effect.timeoutOption(WHY_ASKED_TIMEOUT),
                Effect.map(Option.getOrUndefined),
                Effect.catchCause(() => Effect.succeed(undefined)),
              );
        if (typeof refusal === "string" && refusal !== "")
          return yield* new AppToolError({ tool: descriptor.name, message: refusal });
        const shared =
          sharedCardOf === undefined
            ? undefined
            : yield* Effect.suspend(() => sharedCardOf(threadId, target)).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              );
        const description =
          describeCall === undefined ? undefined : yield* describeCall(threadId, target);
        const title =
          definition.title === undefined
            ? undefined
            : yield* definition
                .title(threadId, target)
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
        const shown =
          cardDetails === undefined
            ? yield* encode(decoded).pipe(Effect.orElseSucceed(() => decoded))
            : cardDetails(target);
        const why =
          whyAsked === undefined || verdict !== "class"
            ? undefined
            : yield* Effect.suspend(() => whyAsked(threadId, target)).pipe(
                Effect.timeoutOption(WHY_ASKED_TIMEOUT),
                Effect.map(Option.getOrUndefined),
                Effect.map((said) =>
                  typeof said?.user === "string" &&
                  typeof said.agent === "string" &&
                  typeof said.tag === "string"
                    ? said
                    : undefined,
                ),
                Effect.catchCause(() => Effect.succeed(undefined)),
              );
        const asking = gate.approve(
          threadId,
          descriptor,
          shown,
          description,
          verdict === "forced",
          {},
          why,
          title,
          definition.approvalReach ?? "anyone",
        );
        const moot = shared?.moot;
        const settled =
          moot === undefined
            ? asking
            : Effect.raceFirst(
                asking,
                moot.pipe(
                  Effect.flatMap((message) =>
                    Effect.fail(new AppToolError({ tool: descriptor.name, message })),
                  ),
                ),
              );
        if (shared === undefined) {
          yield* settled;
          return yield* acted(true, why);
        }
        const cards = pendingCardsOf(gate);
        const key = `${descriptor.name}\u0000${shared.key}`;
        const mine: PendingCard = { threadId };
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const pending = cards.get(key);
            if (pending === undefined) cards.set(key, mine);
            return pending;
          }),
          (holder): Effect.Effect<Approved, AppToolError> =>
            holder !== undefined
              ? Effect.succeed({ kind: "joined", askedIn: holder.threadId })
              : settled.pipe(Effect.andThen(acted(true, why))),
          () =>
            Effect.sync(() => {
              if (cards.get(key) === mine) cards.delete(key);
            }),
        );
      });
    };
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
              forThread(threadId),
            );
    return {
      descriptor,
      input,
      ...(describe === undefined ? {} : { describe }),
      ...(needsApproval === undefined ? {} : { needsApproval }),
      ...(delegatedAtFullAutonomy === undefined ? {} : { delegatedAtFullAutonomy }),
      run: (raw) =>
        asLineage(
          lineage,
          threadId,
          Effect.gen(function* () {
            const decoded = yield* decode(raw).pipe(
              Effect.mapError(
                (e) =>
                  new AppToolError({
                    tool: descriptor.name,
                    message: `Invalid input: ${e.message}`,
                  }),
              ),
            );
            if (anyPrivate()) {
              for (const named of threadsMentioned(decoded))
                if (!(yield* mayReadThread(named)))
                  return yield* new AppToolError({
                    tool: descriptor.name,
                    message: `unknown thread ${named}`,
                  });
              const caller = yield* currentReader;
              if (caller?.subject !== undefined && descriptor.class === "crossThread") {
                const foreign =
                  threadsMentioned(decoded).some(
                    (named) => readableByOf(named) !== caller.subject,
                  ) ||
                  workspacesMentioned(decoded).some(
                    (workspaceId) => readableByOfWorkspace(workspaceId) !== caller.subject,
                  );
                if (foreign)
                  return yield* new AppToolError({
                    tool: descriptor.name,
                    message: WRITES_STAY_PRIVATE,
                  });
              }
              for (const workspaceId of workspacesMentioned(decoded))
                if (!readerMay(yield* currentReader, readableByOfWorkspace(workspaceId)))
                  return yield* new AppToolError({
                    tool: descriptor.name,
                    message: `unknown workspace ${workspaceId}`,
                  });
              if (
                touchesUnreadable(
                  yield* currentReader,
                  pathsMentioned(
                    decoded,
                    foldersOf === undefined ? [] : yield* foldersOf(threadId),
                  ),
                )
              )
                return yield* new AppToolError({
                  tool: descriptor.name,
                  message: "unknown path",
                });
            }
            const target = yield* resolve(decoded);
            const decision =
              guard === undefined ? undefined : definition.decision?.(threadId, target);
            let decidedByHost = false;
            if (guard !== undefined && decision !== undefined) {
              decidedByHost = yield* guard(
                threadId,
                { ...decision, initiator: "agent" },
                (describeCall === undefined
                  ? Effect.succeed(descriptor.description)
                  : describeCall(threadId, target).pipe(
                      Effect.catchCause(() => Effect.succeed(descriptor.description)),
                    )
                ).pipe(
                  Effect.map((description) => ({
                    toolName: `mcp__gram__${descriptor.name}`,
                    displayName: descriptor.name,
                    description: plainCardText(description),
                    input: decision.detail,
                  })),
                ),
              ).pipe(
                Effect.mapError(
                  (refused) =>
                    new AppToolError({
                      tool: descriptor.name,
                      message: `${refused.message} ${REFUSAL_FOR_AGENT}`,
                    }),
                ),
              );
            }
            const approved = yield* approve(
              decoded,
              target,
              (call) => definition.handle(threadId, target, call).pipe(forThread(threadId)),
              decidedByHost,
            );
            if (approved.kind === "joined")
              return askedElsewhere(descriptor.name, approved.askedIn);
            const { result, why } = approved;
            return why === undefined ||
              typeof result !== "object" ||
              result === null ||
              Array.isArray(result)
              ? result
              : { ...result, approvalNeededBecause: why.agent };
          }).pipe(forThread(threadId)),
        ),
    };
  });

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
      const sentFromMachines = yield* sentFromMachinesHere;
      const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
      const lineage = (threadId: ThreadId) =>
        store.getThread(threadId).pipe(
          Effect.map((thread) => threadOwner(hosts?.ownerOf ?? (() => undefined), thread)),
          Effect.orElseSucceed(() => undefined),
        );
      const foldersOf = (threadId: ThreadId) =>
        store.getThread(threadId).pipe(
          Effect.map((thread) => [
            effectiveCheckout(thread).path,
            ...(thread.extraCheckouts ?? []).map((extra) => extra.path),
          ]),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );

      const setTitle = defineAppTool({
        descriptor: {
          name: "set_title",
          class: "self",
          description: "Name this thread. Ignored when the user already named it.",
        },
        input: Schema.Struct({ title: Schema.NonEmptyString }),
        handle: (threadId, { title }) => {
          const named = agentTitle(title);
          return runtimes
            .updateThread(threadId, (t) =>
              t.userNamed || named === "" ? t : { ...t, title: named, agentNamed: true },
            )
            .pipe(
              Effect.map((t) => ({ title: t.title, applied: !t.userNamed && named !== "" })),
              Effect.mapError(failed("set_title")),
            );
        },
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
          description:
            "Mark this thread's work as done: the thread shows as completed and the user gets a `done` notification, with `summary` as its body. It tells the user only; a worker tells its orchestrator with `report` (`done`).",
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
          description:
            "Raise a desktop notification for the user from this thread: `title` is the line they see, `body` an optional detail, and `kind` how it is marked (`needsInput`, `done`, `error`, default `info`). It returns at once and carries no answer back; a question goes to your question tool.",
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
        sendFileTool(runtimes, store, sentFromMachines),
        showMockTool(runtimes, store),
        ...sessionAppTools(runtimes, store),
        moveToWorktreeTool(runtimes, store, checkouts),
        showWidgetTool(runtimes),
        ...waitAppTools(waits, runtimes, store),
      ];
      const gate = makeApprovalGate(runtimes, store);
      const guard = makeActionGuard({
        hook: Option.getOrUndefined(yield* Effect.serviceOption(DecisionHook)),
        store,
        runtimes,
      });
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
            undefined,
            undefined,
            lineage,
            foldersOf,
          ),
        forTransport: (threadId, audience = "plain") =>
          bindAppTools(
            definitions.filter((d) => boundFor(d, audience)),
            threadId,
            gate,
            guard,
            lineage,
            foldersOf,
          ),
        forSession: (threadId, audience = "plain") =>
          bindAppTools(
            definitions.filter((d) => boundFor(d, audience)),
            threadId,
            gate,
            guard,
            lineage,
            foldersOf,
          ),
        audienceOf: runtimes.audienceOf,
      });
      yield* runtimes.setAppTools(registry);
      return registry;
    }),
  );
}
