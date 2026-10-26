import {
  ANSWER_SOURCE_MAX,
  AppToolError,
  askQuestion,
  BriefPriority,
  closeQuestion,
  FEATURE_PLAN_MAX_STAGES,
  FEATURE_STAGE_NOTE_MAX,
  FEATURE_STAGE_MAX,
  MAX_PLAN_STEPS,
  PlanStepId,
  QUESTIONS_FILE,
  QuestionChoice,
  QUESTION_TEXT_MAX,
  QUESTION_CONTEXT_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_DESCRIPTION_MAX,
  QUESTION_OPTIONS_MAX,
  FORWARD_CONTEXT_MAX,
  WORKER_RECOMMENDATION_MAX,
  questionDate,
  QuestionHow,
  type QuestionEdit,
  ReasoningVariant,
  WORKER_ANSWER_MAX,
  WORKER_REPORT_INTERFACE_MAX,
  WORKER_REPORT_SUMMARY_MAX,
  DEFAULT_PR_WAKE_EVENTS,
  MAX_PR_DEPENDENCIES,
  prRefText,
  PrWakeEvent,
  WAKE_MAX_MINUTES,
  WAKE_NOTE_MAX,
  WAKES_PER_THREAD_MAX,
  WorkerReportState,
  WorkerReportEvidence,
  WorkerState,
  checkoutRoots,
  type MemoryWrite,
  seedOrchestratorPlan,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { defineAppTool, failed } from "../app-tools/definition.ts";
import { inputAliases } from "../app-tools/input.ts";
import { EventHub } from "../events/event-hub.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { parsePrRef } from "../git/merge-when-ready.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { confineQuestionVisuals } from "../preview/mocks.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { PrDependencies } from "../wakes/pr-dependencies.ts";
import { ThreadWakes, type WakeInput } from "../wakes/thread-wakes.ts";
import { compactWorkerRow } from "./ledger.ts";
import { appendEntry, editPassage, OrchestrationMemory } from "./memory.ts";
import { prWakeEventOf, prWatchSeenOf, refusal } from "./rules.ts";
import { MAX_WORKER_REPOS, Orchestration } from "./service.ts";
import { attachUserWords, USER_MESSAGES_MAX, withBriefFooter } from "./user-words.ts";

/** An edit of `questions.md` as `modify` takes it, or the tool's refusal in the edit's words. */
const questionEdit = (tool: string, edit: QuestionEdit) =>
  edit.ok
    ? Effect.succeed({ content: edit.content, result: edit })
    : Effect.fail(new AppToolError({ tool, message: edit.problem }));

/** What a question's options show, as `ask_user` and `ask_question` describe it to the agent. */
const VISUALS_HELP =
  " When the options are directions of a mock, give each an `image` (a screenshot, such as the mock's shots/a-inbox-dark.png) and a `preview` (its page and board, such as v1.html#a-inbox), and name the mock in `mock` (its mock.json or a page): the card shows each option's thumbnail, enlarges it on a click, and opens the page at that board in Preview. Paths are relative to your folder or absolute, and must be inside your worktree or repo.";

// Tool limits apply before question persistence/visual confinement. Stored historical choices
// remain readable through the broader contract schema.
const questionOptions = Schema.Array(
  Schema.Struct({
    ...QuestionChoice.fields,
    label: Schema.String.check(Schema.isMaxLength(QUESTION_LABEL_MAX)),
    description: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(QUESTION_DESCRIPTION_MAX)),
    ),
  }),
).check(Schema.isMaxLength(QUESTION_OPTIONS_MAX));

const hasVisuals = (option: QuestionChoice): boolean =>
  option.image !== undefined || option.preview !== undefined;

const NOT_AN_ORCHESTRATOR =
  "This thread is not its workspace's orchestrator, so its memory isn't open here.";

/**
 * The tools only an orchestrator or a worker is bound, and the wake
 * tools, which every thread is: a plain thread's wakes are its own (`ThreadWakes`). Audience keeps
 * them out of every other thread's context, and it is only the first line: a session keeps the tool
 * list it opened with, so each handler asks the service for authority again.
 */
const newStepId = () => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8));

export const OrchestratorAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const plans = yield* ThreadPlans;
    const orchestration = yield* Orchestration;
    const memory = yield* OrchestrationMemory;
    const threadWakes = yield* ThreadWakes;
    const hub = yield* EventHub;
    const dependencies = yield* PrDependencies;
    const publisher = yield* GitStatePublisher;
    const store = yield* ThreadStore;
    /**
     * A question's pictures and mock, confined to the asking thread's folders and made absolute
     * before the question is kept, so a card reads only what is in its worktree or repo.
     */
    const visualsFor = <
      I extends {
        readonly options?: ReadonlyArray<QuestionChoice> | undefined;
        readonly mock?: string | undefined;
      },
    >(
      tool: string,
      caller: ThreadId,
      input: I,
    ) =>
      Effect.gen(function* () {
        if (input.mock === undefined && !(input.options ?? []).some(hasVisuals)) return input;
        const thread = yield* store
          .getThread(caller)
          .pipe(Effect.mapError(() => new AppToolError({ tool, message: "unknown thread" })));
        return yield* confineQuestionVisuals(input, checkoutRoots(thread)).pipe(
          Effect.mapError((refused) => new AppToolError({ tool, message: refused.message })),
        );
      });
    /** One `schedule_wake` at a time, from its count of the other store to its write. */
    const wakeScheduleLock = yield* Semaphore.make(1);

    const spawnWorker = defineAppTool({
      descriptor: {
        name: "spawn_worker",
        class: "crossThread",
        description:
          "Start a worker thread on a brief, in a new git worktree of one of this workspace's projects. This, not `spawn_task`, is how work for this workspace starts: a worker gets a worktree, a pull request and a place on the board, and reports back to you. For a change that spans repos, name the repo where most of the work happens as `project` and the others in `alsoIn`: the worker gets a worktree in each, all on the same branch, and opens one pull request per repo; if any of them can't give it a worktree, no worker is started. Workers sharing a `feature` are one group in the ledger and get the same branch name (feat/<feature>) unless `branch` says otherwise. The worker sees only `brief`, so make it stand alone. Give `title` a concise, task-specific sidebar name, usually 2–5 words (about 24–40 characters when natural). Keep the key bug, system or feature identifier; make review titles distinct from implementation titles (for example, “Review browser safety” and “Fix browser safety”). Put procedure and full scope in `brief`. Don't mechanically truncate or use a vague label. `group` puts the feature in a group of features run as one effort (a release, say), making the group if need be. `model` names one of the charter's worker models, as `list_workers` lists them (`agent:model`, or the bare id when only one entry has it): pick it by what the user said each is for; without it the worker starts on the default one, else on your model. `scope` is an advisory list of paths it will touch (overlaps with a live worker come back as a warning); `readAlso` lists your own workers whose worktrees it may read; `clientRequestId` makes a retried call return the worker it already made. `plan` is the brief's checklist, if it has one, as the worker's first plan: steps the worker keeps and the board counts (2 of 3). `userMessages` (1–5) attaches the user's latest messages in your conversation after the brief, word for word: for a paste the worker needs exactly (a log, a spec, an error), instead of retyping it. Inside the charter this needs no approval; a project outside the workspace (in `project` or `alsoIn`), or one worker more than the charter allows at once, asks the user. When a subscription limit the worker would run on stands at the workspace's pause threshold, the user is asked once whether to pause new workers until it resets; while paused, the call is refused and running workers carry on. `priority: \"low\"` marks a brief that can wait: when the agent its worker would run on refuses turns at a subscription limit, or the limit is at the workspace's pause threshold if the user set one, it is held instead of spawned (`held: true` in the result, and in list_workers' `held`), starts on its own when the limit resets or a turn on that agent goes through, and the user can start it sooner; a share alone, even 100%, never holds it, since credits can carry on past a full window; a digest tells you when it starts. A recent worker auth, model-unavailable or network failure before any output also holds spawns on that model, at either priority. The result names the failure, its time and models clear of this breaker; output on the model clears it, or one held worker probes after ten minutes. Use `manage_held_spawn` to cancel or retarget a held brief. When the workspace offers another model at a limit, a spawn a subscription limit stops lists the worker models clear of it in `alternatives`, with their notes: one not made returns `routeOffer: true` (call again with `model` set to one whose note fits the brief, or with `atLimit: \"stay\"`), and a held brief carries them for `manage_held_spawn` to retarget. Give a held brief a `clientRequestId`: a retried call with it returns the brief already held, while one without it holds a second copy. Use it for chores, follow-ups and nice-to-haves, never for what the user is waiting on. A repo Gram doesn't know yet is named by the absolute path of its top folder, and the user is asked to add it to the workspace; a folder without git can't be one. Refused while orchestration is paused. To mention a thread to the user, link it as [title](#threadId).",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        project: Schema.NonEmptyString,
        alsoIn: Schema.optionalKey(
          Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(MAX_WORKER_REPOS)),
        ),
        feature: Schema.NonEmptyString,
        title: Schema.NonEmptyString,
        brief: Schema.NonEmptyString,
        branch: Schema.optionalKey(Schema.String),
        base: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Schema.String),
        effort: Schema.optionalKey(ReasoningVariant),
        scope: Schema.optionalKey(Schema.Array(Schema.String)),
        readAlso: Schema.optionalKey(Schema.Array(Schema.String)),
        clientRequestId: Schema.optionalKey(Schema.String),
        group: Schema.optionalKey(Schema.NonEmptyString),
        plan: Schema.optionalKey(
          Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
        ),
        userMessages: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: USER_MESSAGES_MAX })),
        ),
        priority: Schema.optionalKey(BriefPriority),
        atLimit: Schema.optionalKey(Schema.Literal("stay")),
      }),
      // Each repo as it resolves now, and the brief with the user's words in it: what the approval
      // check, the card and the handler all see.
      resolve: (caller, { userMessages, ...input }) =>
        Effect.gen(function* () {
          // The workspace's standing instructions, then the user's words, which stay last.
          const brief = yield* attachUserWords(
            store,
            "spawn_worker",
            caller,
            withBriefFooter(input.brief, yield* orchestration.briefFooter(caller)),
            userMessages,
          );
          const {
            pins: [project = input.project, ...alsoIn],
            identities,
          } = yield* orchestration.pinRepos(caller, "spawn_worker", [
            input.project,
            ...(input.alsoIn ?? []),
          ]);
          return {
            ...input,
            brief,
            project,
            ...(input.alsoIn === undefined ? {} : { alsoIn }),
            identities,
          };
        }),
      needsApproval: (caller, _input, pinned) => orchestration.spawnNeedsApproval(caller, pinned),
      describe: (caller, input) => orchestration.describeSpawn(caller, input),
      handle: (caller, input) =>
        orchestration.spawnWorker(caller, input).pipe(
          Effect.tap((spawned) =>
            // A held brief keeps its plan and is seeded with it when it starts.
            input.plan === undefined || "held" in spawned || "routeOffer" in spawned
              ? Effect.void
              : Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* plans.update(spawned.threadId, (plan) =>
                    seedOrchestratorPlan(plan, input.plan ?? [], { now, newId: newStepId }),
                  );
                }),
          ),
        ),
    });

    const manageHeldSpawn = defineAppTool({
      descriptor: {
        name: "manage_held_spawn",
        class: "self",
        description:
          "Cancel a held spawn (provider failure or usage limit), or retarget it to another configured worker model. `id` is the held brief id returned by spawn_worker or listed under list_workers' held (not a threadId). Use action `cancel`, or action `retarget` with `model` as agent:model or an unambiguous configured id. Retargeting rechecks limits and starts the brief when eligible, preserving its brief, plan and retry identity. Only the current owning orchestrator may act; workspace and feature pauses remain in force. stop_thread and set_thread_model act on threads that have already started.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        id: Schema.NonEmptyString,
        action: Schema.Literals(["cancel", "retarget"]),
        model: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, input) => orchestration.manageHeldSpawn(caller, input),
    });

    const addWorkerRepo = defineAppTool({
      descriptor: {
        name: "add_worker_repo",
        class: "crossThread",
        description:
          "Give one of your own workers a worktree in another of this workspace's projects, on the branch it already works on, when its work turns out to reach there. The worker is told where the worktree is and keeps going; it opens a pull request there if the change needs one. Prefer this to a second worker for a small follow-on in another repo. On your own worker this needs no approval, unless the project is outside the workspace; a repo Gram doesn't know yet is named by the absolute path of its top folder, and the user is asked to add it; a folder without git can't be one. Refused while orchestration is paused, for a worker the user has written to since its last report, and for a repo the worker already works in.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({ threadId: Schema.NonEmptyString, project: Schema.NonEmptyString }),
      resolve: (caller, input) =>
        orchestration.pinRepos(caller, "add_worker_repo", [input.project]).pipe(
          Effect.map(({ pins: [project = input.project], identities }) => ({
            ...input,
            project,
            identities,
          })),
        ),
      needsApproval: (caller, _input, pinned) => orchestration.addRepoNeedsApproval(caller, pinned),
      describe: (caller, input) => orchestration.describeAddRepo(caller, input),
      handle: (caller, input) => orchestration.addWorkerRepo(caller, input),
    });

    const adoptThread = defineAppTool({
      descriptor: {
        name: "adopt_thread",
        class: "crossThread",
        description:
          "Take an existing thread on as one of your workers: one the user started outside the workspace, or a worker of another workspace, which leaves that one. From then on it is on the board and in your digests, you message it without a card, and you follow its pull request as a worker's. It keeps its conversation, checkout, mode and model; it gets no brief, so read it (get_thread) before you message it. `feature` names the feature it goes under; without one it is named from its branch, or joins the feature of a worker already on that branch. `group` puts the feature in a group. `worktree` is for a thread that made a git worktree with its shell and works there rather than in its checkout: the absolute path of that worktree, in a repo Gram knows, which it moves into once idle. Always asks the user, at every autonomy level: it is their thread. Refused for an orchestrator or a memory dream, a thread already yours, one in a repo's main checkout or outside git (unless `worktree` names one to move into), and while orchestration is paused. A repo of the thread's outside the workspace joins it with the user's yes.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        feature: Schema.optionalKey(Schema.NonEmptyString),
        group: Schema.optionalKey(Schema.NonEmptyString),
        worktree: Schema.optionalKey(Schema.NonEmptyString),
      }),
      // Pinned before the card, so the call after the user's yes acts on what the card named.
      resolve: (caller, input) =>
        orchestration.pinAdopt(caller, input).pipe(Effect.map((pinned) => ({ ...input, pinned }))),
      // Taking a thread the user started, or one another orchestrator has, is the user's to allow
      // whatever the workspace's autonomy, as adding a repo is.
      needsApproval: () => Effect.succeed(true),
      describe: (caller, input) => orchestration.describeAdopt(caller, input),
      handle: (caller, input) => orchestration.adoptThread(caller, input),
    });

    const listWorkers = defineAppTool({
      descriptor: {
        name: "list_workers",
        class: "read",
        description:
          "The ledger of your workers, grouped by feature, with each feature's stage and group, the groups with theirs, how many workers are live beside the charter's cap, the subscription limits in use with the share at which new workers pause, the workspace's `autonomy`, `app` (the running Gram app's version and build, to tell whether a merged fix is live yet), and `workerModels`: the models you may pass to spawn_worker, each with what the user wants it used for (`useFor`) and the one a worker gets when you name none (`default`). A worker's row gives its state, status, project, branch, pull request (and the same for each other repo it spans), the start of its last report, pending requests (each with its requestId and what it asks), overlaps and changed files, and cost only for a worker on a gateway; what is empty or zero is left out. `detail` gives full rows instead: the whole last report with its interface, the activity line, context use and how many messages you sent it. `live` keeps only the workers that count against the cap, and `state` only those in the states named. Archived groups and their stage notes, as well as archived workers, are left out unless includeArchived (or `state` names `archived`); with `since` (epoch ms), archived, merged and delivered ones last active before it are left out too. To mention a thread to the user, link it as [title](#threadId).",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        includeArchived: Schema.optionalKey(Schema.Boolean),
        since: Schema.optionalKey(Schema.Number),
        state: Schema.optionalKey(Schema.Array(WorkerState)),
        live: Schema.optionalKey(Schema.Boolean),
        detail: Schema.optionalKey(Schema.Boolean),
      }),
      handle: (caller, { state, detail, ...options }) =>
        orchestration
          .listWorkers(caller, { ...options, ...(state === undefined ? {} : { states: state }) })
          .pipe(
            Effect.map((ledger) => {
              // Subscriptions are limits, which the budget carries; the day's dollars aren't told.
              const { costUsdToday: _, ...budget } = ledger.budget;
              return detail === true
                ? { ...ledger, budget }
                : {
                    ...ledger,
                    budget,
                    features: ledger.features.map((feature) => ({
                      ...feature,
                      workers: feature.workers.map(compactWorkerRow),
                    })),
                  };
            }),
          ),
    });

    const report = defineAppTool({
      descriptor: {
        name: "report",
        class: "self",
        description:
          "Tell the orchestrator that started you how the work stands: `done` when it is finished and verified (give prUrl when there is a pull request), `blocked` when you can't continue, `question` when you need a decision, `progress` for a milestone. Keep `summary` short and factual. Optional `evidence` carries headSha, gate result, pr and nextStep in full before the prose excerpt; these are your claims, not verified gates. If you built or changed something other repos consume, state the contract in `interface`. Then end your turn; don't wait for a reply.",
      },
      audience: ["worker"],
      input: Schema.Struct({
        state: WorkerReportState,
        evidence: Schema.optionalKey(WorkerReportEvidence),
        summary: Schema.NonEmptyString.check(Schema.isMaxLength(WORKER_REPORT_SUMMARY_MAX)),
        prUrl: Schema.optionalKey(Schema.String),
        interface: Schema.optionalKey(
          Schema.String.check(Schema.isMaxLength(WORKER_REPORT_INTERFACE_MAX)),
        ),
      }),
      handle: (worker, input) =>
        Effect.gen(function* () {
          const stored = yield* orchestration.recordReport(worker, input);
          if (stored === undefined) {
            return { reported: false, note: "No orchestrator is listening; carry on." };
          }
          yield* runtimes
            .emitChunk(worker, { type: "data-worker-report", id: randomUUID(), data: stored })
            .pipe(Effect.ignore);
          return { reported: true, state: stored.state };
        }),
    });

    /**
     * `schedule_wake`'s PR, parsed and looked up now: the baseline its events are measured from, and
     * a refusal for a PR GitHub doesn't have or that has already merged or closed. A lookup that
     * can't reach GitHub leaves the first sweep's badge as the baseline.
     */
    const wakeOnPr = (
      caller: ThreadId,
      input: {
        readonly onPr?: string | undefined;
        readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const tool = "schedule_wake";
        if (input.onPr === undefined) {
          if (input.on !== undefined) {
            return yield* new AppToolError({
              tool,
              message: "`on` needs `onPr`, the PR it watches.",
            });
          }
          return {};
        }
        const pr = parsePrRef(input.onPr);
        if (pr === undefined) {
          return yield* new AppToolError({
            tool,
            message: `"${input.onPr}" isn't a pull request; write owner/repo#N or its URL.`,
          });
        }
        const on = PrWakeEvent.literals.filter((event) =>
          (input.on ?? DEFAULT_PR_WAKE_EVENTS).includes(event),
        );
        const thread = yield* store
          .getThread(caller)
          .pipe(Effect.mapError(() => new AppToolError({ tool, message: "No such thread." })));
        const looked = yield* publisher.lookupPr(thread, {
          ...pr,
          reviews: on.includes("verdict"),
        });
        if (Option.isNone(looked)) return { onPr: pr, on };
        const badge = looked.value;
        if (badge === undefined) {
          return yield* new AppToolError({
            tool,
            message: `GitHub has no pull request ${prRefText(pr)}.`,
          });
        }
        if (badge.state !== "OPEN" || prWakeEventOf(undefined, badge, on) !== undefined) {
          return yield* new AppToolError({
            tool,
            message: `${prRefText(pr)} is ${badge.state.toLowerCase()} already; there is nothing to wait for.`,
          });
        }
        return { onPr: pr, on, seen: prWatchSeenOf(badge) };
      });

    const scheduleWake = defineAppTool({
      descriptor: {
        name: "schedule_wake",
        class: "self",
        description: `Have Gram wake you later, then end your turn: for waiting out a time (a release-age window, a rollout, a deploy that takes an hour, "check the canary in 45 minutes") where nothing else would tell you it is over, or for something to happen to a pull request that isn't yours. Give \`inMinutes\`, or \`at\` as an ISO 8601 time with its zone, at most ${WAKE_MAX_MINUTES / 1440} days ahead, and a \`note\` telling yourself what to do then; it is read back to you when the wake is due. With \`onPr\` (owner/repo#N or its URL) it fires on the first of \`on\` to happen to that PR: \`merged\`, \`closed\`, \`headChanged\` (a new push), \`checksSettled\`, \`verdict\` (the review bot's on its head); \`on\` defaults to ${DEFAULT_PR_WAKE_EVENTS.join(", ")}. The message names the event and the PR's head. Its \`at\` or \`inMinutes\` is then the fallback, when it fires anyway; without one, ${WAKE_MAX_MINUTES / 1440} days on. A PR already merged or closed is refused. A thread is sent a message; an orchestrator gets it in its next digest. It survives a restart, one that fell due while the app was down fires at start, and a parked thread or a paused workspace holds it until it is back. Closing the thread drops it. Up to ${WAKES_PER_THREAD_MAX} can be pending, and the user sees them; \`cancel_wake\` drops one. Don't use it to wait for CI, a review or a workflow run of your own PR: their monitors wake you when they settle. To wait for a PR your own PR depends on, declare it with depends_on instead, which wakes you on each of its events.`,
      },
      input: Schema.Struct({
        at: Schema.optionalKey(Schema.String),
        inMinutes: Schema.optionalKey(Schema.Number),
        note: Schema.NonEmptyString.check(Schema.isMaxLength(WAKE_NOTE_MAX)),
        onPr: Schema.optionalKey(Schema.NonEmptyString),
        on: Schema.optionalKey(Schema.Array(PrWakeEvent).check(Schema.isMinLength(1))),
      }),
      // One cap over both stores: a thread whose role changed keeps the wakes it set before. Each
      // store checks only its own count in its write, so the count read from the other store and
      // the write it guards happen under one lock; transports run tool calls concurrently.
      handle: (caller, { onPr, on, ...rest }) =>
        Effect.gen(function* () {
          const wake: WakeInput = { ...rest, ...(yield* wakeOnPr(caller, { onPr, on })) };
          const set = yield* wakeScheduleLock.withPermits(1)(
            Effect.gen(function* () {
              if (yield* orchestration.keepsWakesOf(caller)) {
                return yield* orchestration.scheduleWake(
                  caller,
                  wake,
                  yield* threadWakes.pendingOf(caller),
                );
              }
              return yield* threadWakes.schedule(
                caller,
                wake,
                yield* orchestration.pendingWakesOf(caller),
              );
            }),
          );
          return wake.onPr === undefined
            ? set
            : { ...set, onPr: prRefText(wake.onPr), on: wake.on, fallbackAt: set.at };
        }),
    });

    const cancelWake = defineAppTool({
      descriptor: {
        name: "cancel_wake",
        class: "self",
        description:
          "Drop a wake you set with schedule_wake, by the `id` it returned; without `id`, all of yours.",
      },
      input: Schema.Struct({ id: Schema.optionalKey(Schema.NonEmptyString) }),
      // Found where it was stored, not by the caller's role now: a role that changed moved where
      // new wakes go, but not the ones already set.
      handle: (caller, { id }) =>
        Effect.gen(function* () {
          const own = yield* threadWakes.cancel(caller, id);
          if (id !== undefined && own.cancelled > 0) return own;
          const held = yield* orchestration.cancelWake(caller, id);
          return { cancelled: own.cancelled + held.cancelled };
        }),
    });

    const dependsOn = defineAppTool({
      descriptor: {
        name: "depends_on",
        class: "self",
        description: `Declare that a pull request depends on another one (\`pr\`, owner/repo#N or its URL): it can't merge, or can't be finished, until that one has. For your own bound PR, or with \`threadId\` your worker's. From then on the thread is woken by itself whenever the dependency merges, is closed or gets a new push, with no wake to set; merge_when_ready waits for it to merge first unless \`mergeAfter: false\`; and the ledger shows the chain, flagging a dependency that drags on so the dependent PR can be stacked on its branch instead. \`remove: true\` drops it. Needs a bound PR (pr_bind); at most ${MAX_PR_DEPENDENCIES} per PR; a PR already merged or closed is refused. What an orchestrator declares, its worker can't drop.`,
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({
        pr: Schema.NonEmptyString,
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        remove: Schema.optionalKey(Schema.Boolean),
        mergeAfter: Schema.optionalKey(Schema.Boolean),
      }),
      handle: (caller, { pr, threadId, ...rest }) =>
        Effect.gen(function* () {
          const ref = parsePrRef(pr);
          if (ref === undefined) {
            return yield* new AppToolError({
              tool: "depends_on",
              message: `"${pr}" isn't a pull request; write owner/repo#N or its URL.`,
            });
          }
          return yield* dependencies.declare(caller, {
            ...rest,
            pr: ref,
            ...(threadId === undefined ? {} : { threadId: threadId as ThreadId }),
          });
        }),
    });

    const setStage = defineAppTool({
      descriptor: {
        name: "set_stage",
        class: "self",
        description: `Say where a feature, or a group of features, stands in the team's own process: the steps the ledger can't see, such as a contract agreed, a preview deployed, the repos merged in order, a release candidate cut. Name exactly one of \`feature\` and \`group\`. \`plan\` is an optional ordered list of up to ${FEATURE_PLAN_MAX_STAGES} short stage names you make up for it, and \`stage\` the current one, which must be in the plan; without a plan it is a free label. To advance, pass only the new \`stage\`: the plan is kept. An empty \`plan\` drops it. \`note\` is an optional line of context shown with the stage, at most ${FEATURE_STAGE_NOTE_MAX} characters (a longer one is refused, never cut), and a stage set again without one drops it. The user sees the stage on the board with who set it, and may move it themselves. Set it when it has actually changed.`,
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        feature: Schema.optionalKey(Schema.String),
        group: Schema.optionalKey(Schema.String),
        stage: Schema.String.check(Schema.isMaxLength(FEATURE_STAGE_MAX)),
        plan: Schema.optionalKey(
          Schema.Array(Schema.String.check(Schema.isMaxLength(FEATURE_STAGE_MAX))).check(
            Schema.isMaxLength(FEATURE_PLAN_MAX_STAGES),
          ),
        ),
        note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FEATURE_STAGE_NOTE_MAX))),
      }),
      handle: (caller, input) => orchestration.setStageAs(caller, input),
    });

    const setGroup = defineAppTool({
      descriptor: {
        name: "set_group",
        class: "self",
        description:
          "Put a feature in a group of features run as one effort, making the group if need be; a feature is in one group at most, so it leaves the one it was in. Without `group`, take it out of its group. A group left empty goes, unless it carries a stage.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        feature: Schema.NonEmptyString,
        group: Schema.optionalKey(Schema.String),
      }),
      handle: (caller, input) => orchestration.setGroupAs(caller, input),
    });

    const answerWorker = defineAppTool({
      descriptor: {
        name: "answer_worker",
        class: "crossThread",
        description:
          "Answer one of your own workers' questions. Two kinds: (1) a question it asked you with `ask_question`, named by `questionId` (`WQ7`) from the digest's triage list: answer it only when the brief, a standing decision or a memory entry already settles it, and say which in `source`; otherwise forward it with `forward_question`. Once forwarded it is the user's and can't be answered here. (2) A question it is waiting on the user for (its harness's ask), named by `threadId` and `requestId` from list_workers or the digest: only at `full` autonomy, and only when the answer is in the brief, the memory or what the user has told you; never an approval or a plan request, which stay the user's. Give one or the other. The worker gets the answer at once, and the user sees it in both threads. Refused while orchestration is paused and for a worker the user has written to since its last report.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        questionId: Schema.optionalKey(Schema.NonEmptyString),
        source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ANSWER_SOURCE_MAX))),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        requestId: Schema.optionalKey(Schema.NonEmptyString),
        answer: Schema.NonEmptyString.check(Schema.isMaxLength(WORKER_ANSWER_MAX)),
      }),
      // No card either way: the handler refuses everything the autonomy level doesn't allow, and
      // a card would ask the user to let the orchestrator answer what they could answer themselves.
      needsApproval: () => Effect.succeed(false),
      handle: (caller, input) =>
        Effect.gen(function* () {
          if (input.questionId !== undefined) {
            if (input.requestId !== undefined) {
              return yield* new AppToolError({
                tool: "answer_worker",
                message:
                  "Give `questionId` for a question in triage, or `threadId` and `requestId` for a waiting request, not both.",
              });
            }
            const question = yield* orchestration.answerWorkerQuestion(caller, {
              questionId: input.questionId,
              answer: input.answer,
              source: input.source ?? "",
            });
            return {
              questionId: question.id,
              threadId: question.threadId,
              answered: true,
              delivered: question.delivered,
            };
          }
          if (input.threadId === undefined || input.requestId === undefined) {
            return yield* new AppToolError({
              tool: "answer_worker",
              message:
                "Name what you answer: `questionId` for a question in triage, or `threadId` and `requestId` for a waiting request.",
            });
          }
          const answered = yield* orchestration.answerWorker(caller, {
            threadId: input.threadId,
            requestId: input.requestId,
            answer: input.answer,
          });
          for (const threadId of [answered.threadId, caller]) {
            yield* runtimes
              .emitChunk(threadId, { type: "data-worker-answer", id: randomUUID(), data: answered })
              .pipe(Effect.ignore);
          }
          return { threadId: answered.threadId, requestId: answered.requestId, answered: true };
        }),
    });

    const askQuestionTool = defineAppTool({
      descriptor: {
        name: "ask_question",
        class: "self",
        description:
          "Ask a decision you need, without waiting for it. Your orchestrator sees it first and answers it only when your brief, a standing decision or its memory settles it; otherwise it goes to the user as you wrote it. The answer reaches you as a message naming the question's id, mid-turn if you are running; if the user dismisses it, you are told that too. Give `options` (2–4, each a short `label` and a `description`) when the answer is a choice, `multiSelect` when several may be picked, and `recommended`: the label you would pick, or with no options a short recommendation of your own. Put what the decision needs in `context`. Keep working on what doesn't depend on it; end your turn only if nothing can move without it. Not for approvals: those your tools ask for themselves." +
          VISUALS_HELP,
      },
      audience: ["worker"],
      input: Schema.Struct({
        question: Schema.NonEmptyString.check(Schema.isMaxLength(QUESTION_TEXT_MAX)),
        context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(QUESTION_CONTEXT_MAX))),
        options: Schema.optionalKey(questionOptions),
        multiSelect: Schema.optionalKey(Schema.Boolean),
        recommended: Schema.optionalKey(
          Schema.String.check(Schema.isMaxLength(WORKER_RECOMMENDATION_MAX)),
        ),
        mock: Schema.optionalKey(Schema.String),
      }),
      handle: (worker, input) =>
        Effect.gen(function* () {
          const confined = yield* visualsFor("ask_question", worker, input);
          const question = yield* orchestration.askQuestion(worker, confined);
          if (question === undefined) {
            return {
              asked: false,
              note: "No orchestrator is listening; decide yourself and say what you assumed.",
            };
          }
          return {
            asked: true,
            id: question.id,
            stage: question.stage,
            ...(question.stage === "triage"
              ? { forwardsToUserAt: new Date(question.triageUntil).toISOString() }
              : {}),
          };
        }),
    });

    const forwardQuestionTool = defineAppTool({
      descriptor: {
        name: "forward_question",
        class: "crossThread",
        description:
          "Forward one of your workers' questions from the digest's triage list to the user, unchanged: they see it as the worker wrote it, on the board, in the needs-you count and in an away notification. Add at most one line of `context` (200 characters): your recommendation, or which other workers the answer affects. Forward what the brief, the standing decisions and your memory don't settle; answer what they do with `answer_worker`. A question left in triage forwards itself after ten minutes, with no context. The user's answer goes straight to the worker, and you get a copy in your next digest.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        questionId: Schema.NonEmptyString,
        context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FORWARD_CONTEXT_MAX))),
      }),
      needsApproval: () => Effect.succeed(false),
      handle: (caller, input) =>
        orchestration.forwardQuestion(caller, input).pipe(
          Effect.map((question) => ({
            questionId: question.id,
            threadId: question.threadId,
            forwarded: true,
          })),
        ),
    });

    /** The memory of the caller's workspace, or a refusal: the tree belongs to the slot's holder. */
    const memoryOf = (tool: string, caller: ThreadId) =>
      orchestration
        .authorityOf(caller)
        .pipe(
          Effect.flatMap((authority) =>
            authority === undefined
              ? Effect.fail(
                  new AppToolError({ tool, message: refusal("no_authority", NOT_AN_ORCHESTRATOR) }),
                )
              : Effect.succeed(authority.state.workspace.id),
          ),
        );

    /** A write as a diff in the caller's transcript, and `memory.changed` to every window. */
    const showWrite = (caller: ThreadId, workspaceId: WorkspaceId, write: MemoryWrite) =>
      runtimes
        .emitChunk(caller, { type: "data-memory-write", id: randomUUID(), data: write })
        .pipe(Effect.ignore, Effect.andThen(hub.publish({ type: "memory.changed", workspaceId })));

    const memoryList = defineAppTool({
      descriptor: {
        name: "memory_list",
        class: "self",
        description: "The files in your memory, with their sizes. MEMORY.md is the index.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({ prefix: Schema.optionalKey(Schema.String) }),
      handle: (caller, { prefix }) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("memory_list", caller);
          const files = yield* memory.list(workspaceId);
          return {
            files: files.filter((file) => prefix === undefined || file.path.startsWith(prefix)),
          };
        }).pipe(Effect.mapError(failed("memory_list"))),
    });

    const memoryRead = defineAppTool({
      descriptor: {
        name: "memory_read",
        class: "self",
        description:
          "Use `file` (`path` is an alias), relative to the memory root. Read one memory file's text.",
      },
      audience: ["orchestrator"],
      input: inputAliases(Schema.Struct({ path: Schema.NonEmptyString }), { path: ["file"] }),
      handle: (caller, { path }) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("memory_read", caller);
          return { path, content: yield* memory.read(workspaceId, path) };
        }).pipe(Effect.mapError(failed("memory_read"))),
    });

    const memoryWrite = defineAppTool({
      descriptor: {
        name: "memory_write",
        class: "self",
        description:
          "Use `file` (`path` is an alias) and `content` (`text` and `message` are aliases). Create or replace a memory file with `content` (the whole file); to add an entry or change one, `memory_append` and `memory_edit` need no fresh read. Paths are relative, a few folders deep at most; files and the index are size-capped, and secrets are scrubbed. The user sees every write as a diff. Record what can't be derived: goals, decisions and why, repo conventions, how the repos relate, open questions. Never worker status.",
      },
      audience: ["orchestrator"],
      input: inputAliases(Schema.Struct({ path: Schema.NonEmptyString, content: Schema.String }), {
        path: ["file"],
        content: ["text", "message"],
      }),
      handle: (caller, { path, content }) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("memory_write", caller);
          const write = yield* memory.write(workspaceId, path, content);
          yield* showWrite(caller, workspaceId, write);
          return { path: write.path, bytes: write.bytes };
        }).pipe(Effect.mapError(failed("memory_write"))),
    });

    /** A change to one file through `memory.modify`, under the memory's lock, shown as a diff. */
    const memoryChange = (
      tool: string,
      caller: ThreadId,
      path: string,
      change: (current: string | undefined) => string | { readonly problem: string },
    ) =>
      Effect.gen(function* () {
        const workspaceId = yield* memoryOf(tool, caller);
        const { write } = yield* memory.modify(workspaceId, path, (current) => {
          const next = change(current);
          return typeof next === "string"
            ? Effect.succeed({ content: next, result: undefined })
            : Effect.fail(new AppToolError({ tool, message: next.problem }));
        });
        yield* showWrite(caller, workspaceId, write);
        return { path: write.path, bytes: write.bytes };
      }).pipe(Effect.mapError(failed(tool)));

    const memoryAppend = defineAppTool({
      descriptor: {
        name: "memory_append",
        class: "self",
        description:
          "Use `file` (`path` is an alias) and `content` (`text` and `message` are aliases). Add `content` to the end of a memory file, on a line of its own, making the file if it isn't there. For a new dated entry: nothing needs reading first, and nothing written meanwhile is lost. The caps and scrubbing of `memory_write` apply.",
      },
      audience: ["orchestrator"],
      input: inputAliases(
        Schema.Struct({ path: Schema.NonEmptyString, text: Schema.NonEmptyString }),
        { path: ["file"], text: ["content", "message"] },
      ),
      handle: (caller, { path, text }) =>
        memoryChange("memory_append", caller, path, (current) => appendEntry(current, text)),
    });

    const memoryEdit = defineAppTool({
      descriptor: {
        name: "memory_edit",
        class: "self",
        description:
          "Use `file` (`path` is an alias). Replace `old` with `new` in a memory file, as it reads in `memory_read`; an empty `new` deletes the passage. `old` must appear exactly once, unless `replaceAll`; otherwise nothing changes and the result says so. For correcting or pruning one entry without rewriting the file.",
      },
      audience: ["orchestrator"],
      input: inputAliases(
        Schema.Struct({
          path: Schema.NonEmptyString,
          old: Schema.NonEmptyString,
          new: Schema.String,
          replaceAll: Schema.optionalKey(Schema.Boolean),
        }),
        { path: ["file"] },
      ),
      handle: (caller, input) =>
        memoryChange("memory_edit", caller, input.path, (current) => editPassage(current, input)),
    });

    const memoryDelete = defineAppTool({
      descriptor: {
        name: "memory_delete",
        class: "self",
        description:
          "Use `file` (`path` is an alias). Delete a memory file. Its text is kept in the memory's history.",
      },
      audience: ["orchestrator"],
      input: inputAliases(Schema.Struct({ path: Schema.NonEmptyString }), { path: ["file"] }),
      handle: (caller, { path }) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("memory_delete", caller);
          const write = yield* memory.remove(workspaceId, path);
          yield* showWrite(caller, workspaceId, write);
          return { path: write.path, deleted: true };
        }).pipe(Effect.mapError(failed("memory_delete"))),
    });

    const today = Effect.map(Clock.currentTimeMillis, questionDate);

    const askUser = defineAppTool({
      descriptor: {
        name: "ask_user",
        class: "self",
        description:
          "Ask the user a question without waiting for the answer. It is kept in questions.md in your memory and shown on the board and in Memory with an Answer button; the answer reaches you as a message naming its id, with the entry already closed. Give `options` (2–4, each a short `label` and a `description`) when the answer is a choice, `multiSelect` when several may be picked, and `recommended` naming the label you would pick; the user can always answer in their own words instead. Put what the user needs to decide in `context`. An existing `id`, or the words of an open question, updates that entry instead of adding one, and asking a closed one again reopens it. This doesn't block: carry on with what doesn't depend on the answer. The question that picks a mock's direction always carries the mock: each option's `image` and `preview`, and `mock`; never a bare path in `context`." +
          VISUALS_HELP +
          ' A worker\'s mock is in its worktree, under your repo; `mock: ""` takes the mock away.',
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        question: Schema.NonEmptyString.check(Schema.isMaxLength(QUESTION_TEXT_MAX)),
        context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(QUESTION_CONTEXT_MAX))),
        options: Schema.optionalKey(questionOptions),
        multiSelect: Schema.optionalKey(Schema.Boolean),
        recommended: Schema.optionalKey(Schema.String),
        mock: Schema.optionalKey(Schema.String),
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("ask_user", caller);
          const confined = yield* visualsFor("ask_user", caller, input);
          const date = yield* today;
          const { write, result } = yield* memory.modify(workspaceId, QUESTIONS_FILE, (current) =>
            questionEdit("ask_user", askQuestion(current, confined, date)),
          );
          yield* showWrite(caller, workspaceId, write);
          return { id: result.id, updated: result.updated, reopened: result.reopened };
        }).pipe(Effect.mapError(failed("ask_user"))),
    });

    const closeQuestionTool = defineAppTool({
      descriptor: {
        name: "close_question",
        class: "self",
        description:
          "Close an entry of questions.md yourself. `how` is `decided` when you settled it without the user (say what and why in `answer`), `withdrawn` when it no longer matters, `superseded` when another question replaced it (name that one), or `answered` when the user answered it some other way, in this conversation say. An answer given with Gram's Answer button closes its entry by itself; there is nothing to close then.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        id: Schema.NonEmptyString,
        answer: Schema.NonEmptyString,
        how: QuestionHow,
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const workspaceId = yield* memoryOf("close_question", caller);
          const date = yield* today;
          const { write, result } = yield* memory.modify(workspaceId, QUESTIONS_FILE, (current) =>
            questionEdit("close_question", closeQuestion(current, input, date)),
          );
          yield* showWrite(caller, workspaceId, write);
          return { id: result.id, closed: true };
        }).pipe(Effect.mapError(failed("close_question"))),
    });

    yield* registry.register([
      spawnWorker,
      manageHeldSpawn,
      addWorkerRepo,
      adoptThread,
      listWorkers,
      setStage,
      setGroup,
      answerWorker,
      askQuestionTool,
      forwardQuestionTool,
      report,
      scheduleWake,
      cancelWake,
      dependsOn,
      memoryList,
      memoryRead,
      memoryWrite,
      memoryAppend,
      memoryEdit,
      memoryDelete,
      askUser,
      closeQuestionTool,
    ]);
    // Only now: a wake already due opens its thread's session, which keeps the tools it opened
    // with, and these are what lets it set the next one. The session policy is in by now too, since
    // the orchestration service this layer reads sets it while it is built.
    yield* threadWakes.start;
  }),
);
