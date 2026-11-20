import {
  ANSWER_SOURCE_MAX,
  AppToolError,
  DISMISS_REASON_MAX,
  askQuestion,
  BriefPriority,
  closeQuestion,
  CONVERSATIONS_PER_THREAD_MAX,
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
  WORKER_REPORT_LEARNED_MAX,
  WORKER_REPORT_SUMMARY_MAX,
  DEFAULT_PR_WAKE_EVENTS,
  MAX_PR_DEPENDENCIES,
  prRefText,
  PrWakeEvent,
  WAKE_MAX_MINUTES,
  WAKE_NOTE_MAX,
  WAKES_PER_THREAD_MAX,
  WakeCondition,
  WakeConditionInput,
  wakeConditionWhen,
  WorkerReportState,
  WorkerReportEvidence,
  WorkerState,
  checkoutRoots,
  effectiveCheckout,
  hostOf,
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
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { defineAppTool, failed } from "../app-tools/definition.ts";
import { inputAliases } from "../app-tools/input.ts";
import { EventHub } from "../events/event-hub.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { parsePrRef } from "../git/merge-when-ready.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { OnDemand } from "../embedding/on-demand.ts";
import { SignedInWorkers } from "../embedding/signed-in-workers.ts";
import { ownerSubject } from "../host/ownership.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import {
  embeddedSource,
  isWorkerMachineName,
  modelRefusal,
  overTotalWords,
  pinRefusal,
  placementOf,
  resolveWorkerPicks,
  type WorkerMachineSource,
  workerMachineName,
} from "../embedding/worker-machines.ts";
import { confineQuestionVisuals } from "../preview/mocks.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { PrDependencies } from "../wakes/pr-dependencies.ts";
import { WakeConditions } from "../wakes/conditions.ts";
import { ThreadWakes, type WakeInput } from "../wakes/thread-wakes.ts";
import { compactWorkerRow } from "./ledger.ts";
import {
  appendEntry,
  editPassage,
  MEMORY_REVISION_NEW,
  memoryRevision,
  OrchestrationMemory,
} from "./memory.ts";
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
  " When the options are a mock's directions, give each an `image` (a screenshot, such as shots/a-inbox-dark.png) and a `preview` (its page and board, such as v1.html#a-inbox), and name the mock in `mock` (its mock.json or a page): the card shows each thumbnail and opens its board in Preview. Paths are relative to your folder or absolute, inside your worktree or repo.";

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

/** Whether a memory file is under `prefix`, or any file without one. */
const underPrefix =
  (prefix: string | undefined) =>
  (file: { readonly path: string }): boolean =>
    prefix === undefined || file.path.startsWith(prefix);

/**
 * Refuses a change made from a revision the file has moved on from, with the file's current text
 * and revision, so the caller can merge its change into it and write again.
 */
const checkRevision = (
  tool: string,
  path: string,
  revision: string | undefined,
  current: string | undefined,
): Effect.Effect<void, AppToolError> => {
  const now = current === undefined ? MEMORY_REVISION_NEW : memoryRevision(current);
  if (revision === undefined || revision === now) return Effect.void;
  const message =
    current === undefined
      ? `${path} isn't in memory any more (you read revision ${revision}). Write it again with revision "${MEMORY_REVISION_NEW}" if it should still exist.`
      : `${path} changed since you read it (you read revision ${revision}; it is now ${now}). Merge your change into its current text below, keeping what you aren't changing, and write again with revision ${now}.\n\n${current}`;
  return Effect.fail(new AppToolError({ tool, message: refusal("stale_revision", message) }));
};

/** Why a spawn can't reuse a machine the server reclaimed since: its name isn't given out again. */
const reclaimedWords = (name: string) =>
  `The machine ${name} was reclaimed by the server since its work was over, so it isn't there to reuse, and its name isn't given out again. Spawn again with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`;

/** `schedule_wake` lists its condition flat (`WakeConditionInput`); this decodes it as the union. */
const decodeWakeCondition = Schema.decodeUnknownEffect(WakeCondition);

/**
 * The tools only an orchestrator or a worker is bound, and the wake
 * tools, which every thread is: a plain thread's wakes are its own (`ThreadWakes`). Audience keeps
 * them out of every other thread's context, and it is only the first line: a session keeps the tool
 * list it opened with, so each handler asks the service for authority again.
 */
/**
 * Where a worker runs: on a machine of its own (`own`, with the size and processor its work needs,
 * as the host provider offers them), on one its orchestrator already has (`shareWith`, by its name
 * or a worker's thread id on it), or on its orchestrator's own (left out, or `own: false`).
 */
const WorkerSandbox = Schema.Struct({
  own: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  architecture: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  isolation: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  environment: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  shareWith: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(200))),
  /** Why it goes there rather than your machine, in a sentence the user reads on its row. */
  reason: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(400))),
});
type WorkerSandbox = typeof WorkerSandbox.Type;

const newStepId = () => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8));

export const OrchestratorAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const plans = yield* ThreadPlans;
    const orchestration = yield* Orchestration;
    const memory = yield* OrchestrationMemory;
    const threadWakes = yield* ThreadWakes;
    const conditions = yield* WakeConditions;
    const hub = yield* EventHub;
    const dependencies = yield* PrDependencies;
    const publisher = yield* GitStatePublisher;
    const store = yield* ThreadStore;
    // Absent unless an embedder's host provider is set: workers then can't ask for own machines.
    const onDemand = Option.getOrUndefined(yield* Effect.serviceOption(OnDemand));
    // In the desktop app: a hosted server it is signed in to, asked through the app.
    const signedIn = Option.getOrUndefined(yield* Effect.serviceOption(SignedInWorkers));
    const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const workerHosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const joined = () => (remoteHosts === undefined ? [] : remoteHosts.list());
    /**
     * Where `sandbox` puts a worker: the name of a machine of its own, started now, or of one its
     * orchestrator already has; or nothing, for the orchestrator's own machine.
     */
    const workerSandbox = (
      caller: ThreadId,
      input: {
        readonly title: string;
        readonly feature: string;
        readonly project: string;
        readonly clientRequestId?: string | undefined;
        readonly model?: string | undefined;
      },
      sandbox: WorkerSandbox,
    ): Effect.Effect<
      | {
          readonly name: string;
          /** Whether its provider gives machines back (`WorkerMachineSource.givesBack`). */
          readonly givesBack: boolean;
          /** Starts it and waits for it to come: run once the spawn goes ahead. */
          readonly prepare?: Effect.Effect<
            { readonly abandon?: Effect.Effect<void> | undefined },
            AppToolError,
            Scope.Scope
          >;
        }
      | undefined,
      AppToolError
    > =>
      Effect.gen(function* () {
        const tool = "spawn_worker";
        const fail = (message: string) => new AppToolError({ tool, message });
        if (sandbox.shareWith === undefined && sandbox.own !== true) {
          if (
            sandbox.size !== undefined ||
            sandbox.architecture !== undefined ||
            sandbox.isolation !== undefined ||
            sandbox.environment !== undefined
          )
            return yield* fail(
              'size, architecture, isolation and environment are for a machine of its own: add "own": true.',
            );
          return undefined;
        }
        const orchestrator = yield* store
          .getThread(caller)
          .pipe(Effect.mapError(() => fail("Your thread can't be read now.")));
        const ownHost = hostOf(effectiveCheckout(orchestrator));
        // A closed machine's holder is no one's to start machines for (`host/ownership.ts`).
        const owner = ownerSubject(workerHosts?.ownerOf(ownHost));
        const holder = workerHosts?.ownerOf(ownHost);
        // The embedder's provider for the orchestrator host's owner; or, for an orchestrator on a
        // machine of no one's in particular in the desktop app, the server the app is signed in to.
        const found: WorkerMachineSource | { readonly refused: string } | undefined =
          onDemand !== undefined
            ? owner === undefined
              ? undefined
              : embeddedSource(onDemand, owner, joined)
            : signedIn !== undefined && holder === undefined
              ? yield* signedIn.source.pipe(
                  Effect.map((each) => ("refused" in each ? each : each.source)),
                )
              : undefined;
        if (found === undefined || "refused" in found)
          return yield* fail(
            `Workers can't have machines of their own here${found === undefined ? "" : `: ${found.refused}`}. Leave out sandbox, and the worker runs on your machine.`,
          );
        const source = found;
        const theirs = source.theirs;
        // Its machines run the provider's models: a worker on another is refused before any
        // machine is asked for, never started on another model without a word.
        const models = yield* source.models;
        if (models !== undefined) {
          const chosen = yield* orchestration.spawnModel(caller, input.model);
          const refused =
            modelRefusal(source.label, models, chosen) ??
            pinRefusal(
              `${source.label}'s worker machines`,
              models.filter((model) => model.agent === chosen.agent),
              input.model,
              chosen,
            );
          if (refused !== undefined) return yield* fail(refused);
        }
        /**
         * A machine of its workers it shares: online, as it is; offline (it may be released once
         * its work was over, and sleeps until told otherwise), told it is working and waited for
         * as the spawn goes ahead. Never given back: it is the other workers' too.
         */
        const shared = (machine: {
          readonly name: string;
          readonly onlineSince?: number | undefined;
        }) =>
          machine.onlineSince !== undefined
            ? { name: machine.name, givesBack: source.givesBack }
            : {
                name: machine.name,
                givesBack: source.givesBack,
                prepare: Effect.gen(function* () {
                  if ((yield* source.unrelease(machine.name)) === "gone")
                    return yield* fail(reclaimedWords(machine.name));
                  const arrived = yield* source.arrive(machine.name);
                  if (typeof arrived !== "string")
                    return yield* fail(
                      `${machine.name} is offline and didn't come back, so the worker wasn't placed on it. It was left as it is: wait for it, or spawn on a machine of its own.`,
                    );
                  return {};
                }),
              };
        if (sandbox.shareWith !== undefined) {
          const named = sandbox.shareWith.trim();
          if (isWorkerMachineName(named)) {
            const machine = joined().find((each) => each.name === named && theirs(each));
            if (machine === undefined)
              return yield* fail(`No machine of your workers is named ${named}.`);
            return shared(machine);
          }
          const worker = yield* store
            .getThread(named as ThreadId)
            .pipe(Effect.mapError(() => fail(`shareWith names no worker or machine: ${named}.`)));
          if (worker.spawnedBy?.threadId !== caller)
            return yield* fail(`${worker.title} is not one of your workers.`);
          const host = hostOf(effectiveCheckout(worker));
          const machine = joined().find((each) => each.id === host && theirs(each));
          if (machine === undefined)
            return yield* fail(
              `${worker.title} runs on your machine, not one of its own: leave out sandbox to put this worker there too.`,
            );
          return shared(machine);
        }
        // Picks by the provider's option ids, or by their labels ("No Internet"), as it offers them.
        const offered = yield* source.choices;
        const resolved = resolveWorkerPicks(offered?.choices, sandbox);
        if ("refused" in resolved) return yield* fail(resolved.refused);
        const picks = resolved.picks;
        const name = workerMachineName(
          caller,
          input.clientRequestId ?? `${input.project}\n${input.feature}\n${input.title}`,
        );
        // Online already (a retry): nothing to start. Otherwise it is started only once the spawn
        // goes ahead, after any approval (`handle`), so a refused or denied spawn starts nothing.
        const seen = joined().find((each) => each.name === name && theirs(each));
        if (seen?.onlineSince !== undefined) return { name, givesBack: source.givesBack };
        const prepare = Effect.gen(function* () {
          // This try's hold on the name, kept until its spawn is over (`handle`'s scope): only the
          // first try to hold it may start the machine or give it back. A retry of the same
          // request while that try is still at work waits for its machine and, stopped or refused
          // itself, ends nothing: what is started under the name is the first try's.
          const hold = yield* Effect.acquireRelease(
            Effect.sync(() => source.hold(name)),
            (held) => Effect.sync(held.release),
          );
          // Read again as the spawn goes ahead, after any card: what is registered now decides
          // whether this try starts the machine (and may give it back) or waits for one it found.
          const already = joined().find((each) => each.name === name && theirs(each));
          // Reused, it may have been released once its earlier work was over, and sleeps until it
          // is told it is working: told so before it is waited for.
          if (already !== undefined && (yield* source.unrelease(name)) === "gone")
            return yield* fail(reclaimedWords(name));
          if (already === undefined && !hold.first) {
            const arrived = yield* source.arrive(name);
            if (typeof arrived !== "string")
              return yield* fail(
                `Another try of this spawn is starting the machine ${name}, and it didn't come online for this one, so this one stopped nothing. Wait for that try to finish, then spawn again with the same clientRequestId, or leave out sandbox to run the worker on your machine.`,
              );
            return {};
          }
          const asked =
            already !== undefined
              ? ({ kind: "started", name } as const)
              : yield* source
                  .start({
                    name,
                    orchestrator: caller,
                    title: input.title,
                    size: picks.size,
                    architecture: picks.architecture,
                    isolation: picks.isolation,
                    environment: picks.environment,
                  })
                  // Stopped while the start is on its way: the server may start it all the same.
                  .pipe(Effect.onInterrupt(() => source.abandon(name, { unsettled: true })));
          if (asked.kind === "refused") {
            // No answer may still have started it: given back, so none runs for nothing.
            if (asked.unknown === true) yield* source.abandon(name, { unsettled: true });
            return yield* fail(asked.message);
          }
          if (asked.kind === "over-total") {
            const threads = yield* store.listThreads;
            const workersOn = (machineName: string) => {
              const machine = joined().find((each) => each.name === machineName);
              return machine === undefined
                ? []
                : threads
                    .filter(
                      (thread) =>
                        thread.spawnedBy?.threadId === caller &&
                        !thread.parked &&
                        hostOf(effectiveCheckout(thread)) === machine.id,
                    )
                    .map((thread) => `${thread.title} [thread ${thread.id}]`);
            };
            return yield* fail(refusal("over_total", overTotalWords(asked, workersOn)));
          }
          const arrived = yield* source.arrive(name).pipe(
            // A spawn stopped while it waits gives back what it asked for.
            Effect.onInterrupt(() => (already === undefined ? source.abandon(name) : Effect.void)),
          );
          if (typeof arrived !== "string") {
            // A machine registered here before this try (an earlier spawn of the same id) may
            // hold that spawn's work on its disk: only a machine this try started is stopped.
            if (already !== undefined && source.givesBack)
              return yield* fail(
                `The machine ${name} is registered here from an earlier spawn of this request and didn't come online, so it was left as it is: it may hold that spawn's work. Wait for it to come back, spawn with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`,
              );
            if (arrived.failed === "timeout") return yield* fail(yield* source.timedOut(name));
            yield* source.abandon(name);
            return yield* fail(arrived.failed);
          }
          // Given back if the spawn is refused after it came, so none is left running for nothing:
          // never while a thread is placed on it, the spawn's own worker made before it failed
          // included, nor when that can't be read.
          const giveBack = Effect.gen(function* () {
            // A retry of the same request waiting for it now: left for that one, and, should it
            // not place a worker either, to the release pass, as a registered machine.
            if (hold.others()) return;
            const id = source.idOf(name);
            if (id !== undefined) {
              const threads = yield* store.listThreads.pipe(Effect.option);
              if (threads._tag === "None") return;
              if (
                threads.value.some(
                  (thread) =>
                    thread.parked !== true &&
                    [
                      effectiveCheckout(thread),
                      thread.checkout,
                      ...(thread.extraCheckouts ?? []),
                    ].some((checkout) => checkout !== undefined && hostOf(checkout) === id),
                )
              )
                return;
            }
            yield* source.abandon(name);
          });
          return already === undefined ? { abandon: giveBack } : {};
        });
        return { name, givesBack: source.givesBack, prepare };
      });
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
    /**
     * Each resolved sandbox spawn's plan, kept from its resolve to its handler: its machine to start,
     * and whether that machine's provider gives machines back.
     */
    const sandboxPlans = new WeakMap<
      object,
      {
        readonly prepare?: Effect.Effect<
          { readonly abandon?: Effect.Effect<void> | undefined },
          AppToolError,
          Scope.Scope
        >;
        readonly givesBack: boolean;
      }
    >();
    /** One `schedule_wake` at a time, from its count of the other store to its write. */
    const wakeScheduleLock = yield* Semaphore.make(1);

    const spawnWorker = defineAppTool({
      descriptor: {
        name: "spawn_worker",
        class: "crossThread",
        description:
          "Start a worker thread on a brief, in a new git worktree of one of this workspace's projects. This, not `spawn_task`, is how work for this workspace starts. `alsoIn` names the other repos a change spans (most of the work goes in `project`): a worktree in each on the same branch, one pull request per repo; if any can't give it a worktree, no worker starts. Workers sharing a `feature` are one group in the ledger and share its branch (feat/<feature>) unless `branch` says otherwise. The worker sees only `brief`, so make it stand alone, with procedure and full scope. Give `title` a concise, task-specific sidebar name, usually 2–5 words (about 24–40 characters), keeping the key bug, system or feature identifier and telling review from implementation (“Review browser safety”, “Fix browser safety”); never a truncated or vague label. `group` puts the feature in a group run as one effort (a release, say), making it if need be. `model` names one of the charter's worker models as `list_workers` lists them (`agent:model`, or the bare id when only one entry has it): pick it by what the user said each is for; without it, the default one, else your model. `scope` is an advisory list of paths it will touch (overlaps with a live worker come back as a warning); `readAlso` lists your own workers whose worktrees it may read; `clientRequestId` makes a retried call return the worker or held brief it already made (a retry without one holds a second copy). `machine` puts it on a joined machine (list_workers' `machines`; `local` means here); only when the user asks. Where offered, `sandbox` gives heavy work (a large build, tests on the other processor) a machine of its own, `{own: true, size, architecture, isolation, environment}` as your workspace allows (each by the option's id or its name as offered, such as `container` or `Shared container`, `No Internet` for an environment; `environment`: what it installs and may reach; left out, your machine's; a pick not offered is refused with the ones that are), or `{shareWith}` one your workers have (its name, or a worker's threadId on it); left out, as for light work, it runs on yours Give `reason` with it: one sentence on why this work needs that machine, which the user reads on the worker's row. Over your total it is refused with `over_total`, what is in use and what you can do. `plan` is the brief's checklist, if any, as the worker's first plan, which the board counts (2 of 3). `userMessages` (1–5) appends the user's latest messages after the brief, word for word. Inside the charter this needs no approval; a project outside the workspace (in `project` or `alsoIn`), or one worker more than the charter allows at once, asks the user. When a subscription limit the worker would run on stands at the workspace's pause threshold, the user is asked once whether to pause new workers until it resets; while paused, the call is refused and running workers carry on. `priority: \"low\"` marks a brief that can wait (chores, follow-ups, nice-to-haves; never what the user is waiting on): when its agent refuses turns at a subscription limit, or the limit is at the user's pause threshold, it is held instead (`held: true`, and in list_workers' `held`) until the limit allows or the user starts it; a share alone, even 100%, never holds it. A recent auth, model-unavailable or network failure before any output also holds spawns on that model, at either priority. `manage_held_spawn` cancels or retargets a held brief. A spawn a limit stops may list models clear of it in `alternatives`; one not made returns `routeOffer: true`, to call again with a `model` or `atLimit: \"stay\"`. Refused while orchestration is paused. `browser: true` lends it the user's signed-in browser, if Settings allow. `conversations` hands it ones you own; they come back when it closes.",
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
        machine: Schema.optionalKey(Schema.NonEmptyString),
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
        browser: Schema.optionalKey(Schema.Boolean),
        sandbox: Schema.optionalKey(WorkerSandbox),
        conversations: Schema.optionalKey(
          Schema.Array(Schema.NonEmptyString).check(
            Schema.isMaxLength(CONVERSATIONS_PER_THREAD_MAX),
          ),
        ),
      }),
      // Each repo as it resolves now, and the brief with the user's words in it: what the approval
      // check, the card and the handler all see.
      resolve: (caller, { userMessages, sandbox, ...asked }) =>
        Effect.gen(function* () {
          if (sandbox !== undefined && asked.machine !== undefined)
            return yield* new AppToolError({
              tool: "spawn_worker",
              message: "Give machine or sandbox, not both.",
            });
          // A machine of its own, or one its orchestrator already has, by name from here on.
          const placed =
            sandbox === undefined ? undefined : yield* workerSandbox(caller, asked, sandbox);
          const input =
            placed === undefined || sandbox === undefined
              ? asked
              : { ...asked, machine: placed.name, placement: placementOf(placed.name, sandbox) };
          // A machine not started yet is checked once it has come, as the spawn places it.
          if (placed?.prepare === undefined) yield* orchestration.checkSpawnMachine(caller, input);
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
          const resolved = {
            ...input,
            brief,
            project,
            ...(input.alsoIn === undefined ? {} : { alsoIn }),
            identities,
          };
          if (placed !== undefined)
            sandboxPlans.set(resolved, {
              ...(placed.prepare === undefined ? {} : { prepare: placed.prepare }),
              givesBack: placed.givesBack,
            });
          return resolved;
        }),
      needsApproval: (caller, _input, pinned) => orchestration.spawnNeedsApproval(caller, pinned),
      describe: (caller, input) => orchestration.describeSpawn(caller, input),
      decision: (_caller, input) => ({
        action: "spawn",
        detail: {
          title: input.title,
          project: input.project,
          feature: input.feature,
          ...(input.alsoIn === undefined ? {} : { alsoIn: input.alsoIn }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.machine === undefined ? {} : { machine: input.machine }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.browser === true ? { browser: true } : {}),
        },
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          // Its own machine, started now that the spawn goes ahead, and given back if it doesn't.
          // A worker placed by `machine` on one a hosted server started is held to the same rule.
          const named = input.machine?.trim();
          const relayedByName =
            named !== undefined &&
            joined().some(
              (each) =>
                each.via !== undefined &&
                each.onDemand === "worker" &&
                (each.name === named || each.id === named),
            );
          const plan = sandboxPlans.get(input) ?? (relayedByName ? { givesBack: true } : undefined);
          sandboxPlans.delete(input);
          const prepared = plan?.prepare === undefined ? undefined : yield* plan.prepare;
          const giveBack = prepared?.abandon ?? Effect.void;
          const spawned = yield* orchestration.spawnWorker(caller, input).pipe(
            Effect.tapError(() => giveBack),
            Effect.onInterrupt(() => giveBack),
          );
          // On a machine its provider gives back (a signed-in server's), a held brief would name a
          // machine that is stopped, or released once its other work is over, and could never run
          // there: the brief is let go first, then the machine, both whatever interrupts them, and
          // the orchestrator is told to spawn again once it can. An embedder's provider keeps its
          // machines, so a brief held there stays held, as it always has.
          if ("held" in spawned && plan?.givesBack === true)
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const cancelled = yield* orchestration
                  .manageHeldSpawn(caller, { id: spawned.id, action: "cancel" })
                  .pipe(Effect.result);
                // A brief that stays held keeps its machine, so it can still run there.
                if (cancelled._tag === "Success") yield* giveBack;
                const machine =
                  prepared?.abandon === undefined
                    ? "Its machine is shared with your other workers and stays."
                    : cancelled._tag === "Success"
                      ? "Its machine was given back."
                      : "Its machine is kept for it.";
                const kept =
                  cancelled._tag === "Success"
                    ? "Nothing is kept."
                    : `Its held brief couldn't be let go (${cancelled.failure.message}): cancel it with manage_held_spawn ${spawned.id}.`;
                return yield* new AppToolError({
                  tool: "spawn_worker",
                  message: `${spawned.note} A worker on a machine from a hosted server isn't held, since the machine wouldn't be there for it. ${machine} ${kept} Spawn again once it is allowed (schedule_wake for ${new Date(spawned.until).toISOString()}), or without sandbox to hold it for your machine.`,
                });
              }),
            );
          // A brief a limit sends back starts nothing now: nor does its machine run.
          if ("held" in spawned || "routeOffer" in spawned) yield* giveBack;
          return spawned;
        }).pipe(
          // The machine's name stays this try's (`WorkerMachineSource.hold`) until it is over.
          Effect.scoped,
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
          "Give one of your own workers a worktree in another of this workspace's projects, on the branch it already works on, when its work turns out to reach there. The worker is told where the worktree is and keeps going; it opens a pull request there if the change needs one. Prefer this to a second worker for a small follow-on in another repo. On your own worker this needs no approval, unless the project is outside the workspace, which asks the user to add it. Refused while orchestration is paused, for a worker the user has written to since its last report, and for a repo the worker already works in.",
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
          "Take an existing thread on as one of your workers: one the user started outside the workspace, or a worker of another workspace, which leaves that one. From then on it is on the board and in your digests, you message it without a card, and you follow its pull request as a worker's. It keeps its conversation, checkout, mode and model; it gets no brief, so read it (get_thread) before you message it. `feature` names the feature it goes under; without one it is named from its branch, or joins the feature of a worker already on that branch. `group` puts the feature in a group. `worktree` is for a thread that made a git worktree with its shell and works there rather than in its checkout: the absolute path of that worktree, in a repo Gram knows, which it moves into once idle. Always asks the user, at every autonomy level: it is their thread. Refused for an orchestrator or a memory update, a thread already yours, one in a repo's main checkout or outside git (unless `worktree` names one to move into), and while orchestration is paused. A repo of the thread's outside the workspace joins it with the user's yes.",
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
          "The ledger of your workers, grouped by feature with each feature's stage and group, and the groups with theirs; how many workers are live beside the charter's cap; the subscription limits in use and the share at which new workers pause; the workspace's `autonomy`; `app` (the running Gram's version and build, to tell whether a merged fix is live yet); and `workerModels`, the models spawn_worker takes, each with what the user wants it for (`useFor`) and the `default`. A full window on credits is no reason to avoid that agent's models. A worker's row gives its state, status, project, `machine` (name, `online`) if on another machine, branch and pull request (and those of each other repo it spans), the start of its last report, pending requests (each with its requestId and what it asks), overlaps, changed files, and cost only on a gateway; what is empty or zero is left out. `detail` gives full rows: the whole last report with its interface, the activity line, context use and how many messages you sent it. `live` keeps the workers that count against the cap, `state` those in the states named. Archived groups, their stage notes and archived workers are left out unless includeArchived (or `state` names `archived`); `since` (epoch ms) also leaves out archived, merged and delivered ones last active before it. Link a thread for the user as [title](#threadId).",
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
          "Tell the orchestrator that started you how the work stands: `done` when it is finished and verified (give prUrl when there is a pull request), `blocked` when you can't continue, `question` when you need a decision, `progress` for a milestone. Keep `summary` short and factual. Optional `evidence` carries headSha, gate result, pr and nextStep in full before the prose excerpt; these are your claims, not verified gates. If you built or changed something other repos consume, state the contract in `interface`. Optional `learned` is a lasting fact a later worker would otherwise have to ask or rediscover (a repo convention, a trap, how the user wants something); your orchestrator decides whether it goes into memory. Then end your turn; don't wait for a reply.",
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
        learned: Schema.optionalKey(
          Schema.NonEmptyString.check(Schema.isMaxLength(WORKER_REPORT_LEARNED_MAX)),
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
        description: `Have Gram wake you later, then end your turn: to wait out a time ("check the canary in 45 minutes") or for something nothing else would tell you of. Give \`inMinutes\` or \`at\` (ISO 8601 with its zone), at most ${WAKE_MAX_MINUTES / 1440} days ahead, and a \`note\` telling yourself what to do then. \`onPr\` (owner/repo#N or URL) fires on the first of \`on\` to happen to it (default ${DEFAULT_PR_WAKE_EVENTS.join(", ")}); \`headChanged\` is a push, \`verdict\` the review bot's on its head. Or a \`condition\` by \`kind\`: \`branchMoved\` (\`repo\`'s \`branch\` gets a new head), \`threadFinished\` (\`threadId\` is done, rests after reporting, or closes), \`ciStuck\` (a job of \`repo\`'s \`pr\`, else yours, or of \`runId\` sits queued \`queuedMinutes\` with no runner, or a run awaits approval), \`machine\` (\`metric\` \`load\` stays under \`below\` for \`forMinutes\`, or \`diskFree\` at \`path\`, else your repo, drops under \`belowGB\`), \`freezeLifted\` (a merge_freeze on \`repo\`'s \`branch\` ends), \`releasePublished\` (\`source\`'s \`name\` releases past \`after\`, \`minAgeDays\` old) or \`versionChanged\` (installed \`target\` leaves \`from\`); the result's \`when\` spells it out with defaults. Either way the time is a fallback (default ${WAKE_MAX_MINUTES / 1440} days). One already merged, closed or met is refused. A thread gets a message, an orchestrator its next digest. It survives a restart; a parked thread or paused workspace holds it; closing the thread drops it. Up to ${WAKES_PER_THREAD_MAX} pending, shown to the user; \`cancel_wake\` drops one. Not for your own PR's CI, review or runs (their monitors wake you), nor a PR yours depends on (depends_on).`,
      },
      input: Schema.Struct({
        at: Schema.optionalKey(Schema.String),
        inMinutes: Schema.optionalKey(Schema.Finite),
        note: Schema.NonEmptyString.check(Schema.isMaxLength(WAKE_NOTE_MAX)),
        onPr: Schema.optionalKey(Schema.NonEmptyString),
        on: Schema.optionalKey(Schema.Array(PrWakeEvent).check(Schema.isMinLength(1))),
        condition: Schema.optionalKey(WakeConditionInput),
      }),
      // One cap over both stores: a thread whose role changed keeps the wakes it set before. Each
      // store checks only its own count in its write, so the count read from the other store and
      // the write it guards happen under one lock; transports run tool calls concurrently.
      handle: (caller, { onPr, on, condition, ...rest }) =>
        Effect.gen(function* () {
          if (condition !== undefined && (onPr !== undefined || on !== undefined)) {
            return yield* new AppToolError({
              tool: "schedule_wake",
              message: "Give one of `onPr` and `condition`, not both.",
            });
          }
          // Listed flat (`WakeConditionInput`), decoded here as the union it is.
          const spec =
            condition === undefined
              ? undefined
              : yield* decodeWakeCondition(condition).pipe(
                  Effect.mapError(
                    (e) =>
                      new AppToolError({
                        tool: "schedule_wake",
                        message: `condition: ${e.message}`,
                      }),
                  ),
                );
          const conditionState =
            spec === undefined
              ? undefined
              : yield* store.getThread(caller).pipe(
                  Effect.mapError(
                    () => new AppToolError({ tool: "schedule_wake", message: "No such thread." }),
                  ),
                  Effect.flatMap((thread) => conditions.arm(thread, spec)),
                );
          const wake: WakeInput = {
            ...rest,
            ...(yield* wakeOnPr(caller, { onPr, on })),
            ...(conditionState === undefined ? {} : { conditionState }),
          };
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
          if (wake.conditionState !== undefined) {
            return {
              ...set,
              condition: wake.conditionState.spec,
              when: wakeConditionWhen(wake.conditionState.spec),
              fallbackAt: set.at,
            };
          }
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
        description: `Declare that a pull request depends on another one (\`pr\`, owner/repo#N or its URL): it can't merge, or can't be finished, until that one has. For your own bound PR, or with \`threadId\` your worker's. The thread is then woken whenever the dependency merges, closes or gets a new push, with no wake to set; merge_when_ready waits for it to merge first unless \`mergeAfter: false\`; and the ledger shows the chain, flagging a dependency that drags on so the dependent PR can be stacked on its branch instead. \`remove: true\` drops it. Needs a bound PR (pr_bind); at most ${MAX_PR_DEPENDENCIES} per PR; a PR already merged or closed is refused. What an orchestrator declares, its worker can't drop.`,
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
          "Answer one of your own workers' questions. Two kinds: (1) a question it asked you with `ask_question`, named by `questionId` (`WQ7`) from the digest's triage list: answer it only when the brief, a standing decision or a memory entry already settles it, and say which in `source`; otherwise forward it with `forward_question`. Once forwarded it is the user's and can't be answered here. (2) A question it is waiting on the user for (its harness's ask), named by `threadId` and `requestId` from list_workers or the digest: only when the answer is in the brief, the memory or what the user has told you; never an approval or a plan request, which stay the user's. Give one or the other. The worker gets the answer at once, and the user sees it in both threads. Refused while orchestration is paused.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        questionId: Schema.optionalKey(Schema.NonEmptyString),
        source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ANSWER_SOURCE_MAX))),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        requestId: Schema.optionalKey(Schema.NonEmptyString),
        answer: Schema.NonEmptyString.check(Schema.isMaxLength(WORKER_ANSWER_MAX)),
      }),
      // No card either way: the handler refuses what isn't the orchestrator's to answer, and a card
      // would ask the user to let the orchestrator answer what they could answer themselves.
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
          "Ask a decision you need, without waiting for it. Your orchestrator sees it first and answers it only when your brief, a standing decision or its memory settles it; otherwise it goes to the user as you wrote it. The answer, or the user dismissing it, reaches you as a message naming the question's id. Give `options` (2–4, each a short `label` and a `description`) when the answer is a choice, `multiSelect` when several may be picked, and `recommended`: the label you would pick, or with no options your own short recommendation. Put what the decision needs in `context`. Not for approvals: those your tools ask for themselves. To take back an open one, give its id as `withdraw` and a `reason`; with a new `question` too, that one supersedes it." +
          VISUALS_HELP,
      },
      audience: ["worker"],
      input: Schema.Struct({
        question: Schema.optionalKey(
          Schema.NonEmptyString.check(Schema.isMaxLength(QUESTION_TEXT_MAX)),
        ),
        context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(QUESTION_CONTEXT_MAX))),
        options: Schema.optionalKey(questionOptions),
        multiSelect: Schema.optionalKey(Schema.Boolean),
        recommended: Schema.optionalKey(
          Schema.String.check(Schema.isMaxLength(WORKER_RECOMMENDATION_MAX)),
        ),
        mock: Schema.optionalKey(Schema.String),
        withdraw: Schema.optionalKey(Schema.NonEmptyString),
        reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DISMISS_REASON_MAX))),
      }),
      handle: (worker, input) =>
        Effect.gen(function* () {
          const { withdraw, reason, question: words, ...rest } = input;
          if (words === undefined) {
            if (withdraw === undefined) {
              return yield* new AppToolError({
                tool: "ask_question",
                message: "Give the `question`, or `withdraw` and a `reason` to take one back.",
              });
            }
            const closed = yield* orchestration.withdrawQuestion(worker, {
              questionId: withdraw,
              reason: reason ?? "",
            });
            return { withdrawn: closed.id };
          }
          const confined = yield* visualsFor("ask_question", worker, { ...rest, question: words });
          const question = yield* orchestration.askQuestion(worker, confined);
          // The new question first, so the one it replaces can name it; a refusal then is reported
          // beside the question that was asked, never instead of it.
          const superseded =
            withdraw === undefined
              ? {}
              : yield* orchestration
                  .withdrawQuestion(worker, {
                    questionId: withdraw,
                    reason:
                      reason ?? (question === undefined ? "" : `Asked again as ${question.id}.`),
                    ...(question === undefined ? {} : { supersededBy: question.id }),
                  })
                  .pipe(
                    Effect.map((closed) => ({ withdrawn: closed.id })),
                    Effect.catch((error) => Effect.succeed({ notWithdrawn: error.message })),
                  );
          if (question === undefined) {
            return {
              asked: false,
              note: "No orchestrator is listening; decide yourself and say what you assumed.",
              ...superseded,
            };
          }
          return {
            asked: true,
            id: question.id,
            stage: question.stage,
            ...(question.stage === "triage"
              ? { forwardsToUserAt: new Date(question.triageUntil).toISOString() }
              : {}),
            ...superseded,
          };
        }),
    });

    const forwardQuestionTool = defineAppTool({
      descriptor: {
        name: "forward_question",
        class: "crossThread",
        description:
          "Forward one of your workers' questions from the digest's triage list to the user, unchanged: they see it as the worker wrote it, on the board, in the needs-you count and in an away notification. Add at most one line of `context` (200 characters): your recommendation, or which other workers the answer affects. Forward what the brief, the standing decisions and your memory don't settle; answer what they do with `answer_worker`. The user's answer goes straight to the worker; you get a copy in your next digest.",
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

    const recordUserAnswerTool = defineAppTool({
      descriptor: {
        name: "record_user_answer",
        class: "self",
        description:
          "Record that the user answered an open worker question (`WQ7`) in a message to you rather than on its card. Use it only when their latest message here answers it: Gram records that message, word for word, as the answer, and it leaves their board. A worker records its own questions; an orchestrator, its workers'. The other side is told.",
      },
      audience: ["worker", "orchestrator"],
      input: Schema.Struct({ questionId: Schema.NonEmptyString }),
      needsApproval: () => Effect.succeed(false),
      handle: (caller, input) =>
        orchestration
          .recordUserAnswer(caller, input)
          .pipe(
            Effect.map((question) => ({ questionId: question.id, answer: question.answer ?? "" })),
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

    /**
     * The memory the caller may read and write: its own as an orchestrator, its orchestrator's as a
     * worker. `asWorker` holds a worker to the files it can see; questions stay with `memoryOf`.
     */
    const readableMemoryOf = (tool: string, caller: ThreadId) =>
      Effect.gen(function* () {
        const workspaceId = yield* orchestration.memoryReaderOf(caller);
        if (workspaceId === undefined) {
          return yield* new AppToolError({
            tool,
            message: refusal("no_authority", yield* orchestration.memoryClosedReason(caller)),
          });
        }
        const asWorker = (yield* orchestration.authorityOf(caller)) === undefined;
        return { workspaceId, asWorker };
      });

    /** A write as a diff in the caller's transcript, and `memory.changed` to every window. */
    const showWrite = (caller: ThreadId, workspaceId: WorkspaceId, write: MemoryWrite) =>
      runtimes
        .emitChunk(caller, { type: "data-memory-write", id: randomUUID(), data: write })
        .pipe(Effect.ignore, Effect.andThen(hub.publish({ type: "memory.changed", workspaceId })));

    const memoryList = defineAppTool({
      descriptor: {
        name: "memory_list",
        class: "self",
        description:
          "The notes in your workspace's memory, with their sizes. MEMORY.md is the index. An orchestrator and its workers share it.",
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({ prefix: Schema.optionalKey(Schema.String) }),
      handle: (caller, { prefix }) =>
        Effect.gen(function* () {
          const { workspaceId, asWorker } = yield* readableMemoryOf("memory_list", caller);
          // A worker reads through the anchored tree, without what is private or credential-shaped.
          const inPrefix = underPrefix(prefix);
          if (!asWorker) return { files: (yield* memory.list(workspaceId)).filter(inPrefix) };
          const { files, withheld } = yield* memory.listForWorker(workspaceId);
          const kept = withheld.filter(inPrefix);
          // A file kept from workers is named with why, so an empty list never hides one.
          return {
            files: files.filter(inPrefix),
            ...(kept.length > 0 ? { keptFromWorkers: kept } : {}),
          };
        }).pipe(Effect.mapError(failed("memory_list"))),
    });

    const memoryRead = defineAppTool({
      descriptor: {
        name: "memory_read",
        class: "self",
        description:
          "Use `file` (`path` is an alias), relative to the memory root. Read one memory note's text and its `revision`, which `memory_write` and `memory_delete` take.",
      },
      audience: ["orchestrator", "worker"],
      input: inputAliases(Schema.Struct({ path: Schema.NonEmptyString }), { path: ["file"] }),
      handle: (caller, { path }) =>
        Effect.gen(function* () {
          const { workspaceId, asWorker } = yield* readableMemoryOf("memory_read", caller);
          const content = asWorker
            ? yield* memory.readForWorker(workspaceId, path)
            : yield* memory.read(workspaceId, path);
          return { path, content, revision: memoryRevision(content) };
        }).pipe(Effect.mapError(failed("memory_read"))),
    });

    /**
     * A change to one file through `memory.modify`, under the memory's lock, shown as a diff. A
     * worker changes only what it can see, into what every worker can still read.
     */
    const memoryChange = (
      tool: string,
      caller: ThreadId,
      path: string,
      change: (
        current: string | undefined,
        asWorker: boolean,
      ) => string | { readonly problem: string } | Effect.Effect<string, AppToolError>,
    ) =>
      Effect.gen(function* () {
        const { workspaceId, asWorker } = yield* readableMemoryOf(tool, caller);
        const { write, revision } = yield* memory.modify(
          workspaceId,
          path,
          (current) => {
            const next = change(current, asWorker);
            if (Effect.isEffect(next)) {
              return Effect.map(next, (content) => ({ content, result: undefined }));
            }
            return typeof next === "string"
              ? Effect.succeed({ content: next, result: undefined })
              : Effect.fail(new AppToolError({ tool, message: next.problem }));
          },
          { asWorker },
        );
        yield* showWrite(caller, workspaceId, write);
        return { path: write.path, bytes: write.bytes, revision };
      }).pipe(Effect.mapError(failed(tool)));

    const memoryWrite = defineAppTool({
      descriptor: {
        name: "memory_write",
        class: "self",
        description:
          "Use `file` (`path` is an alias) and `content`, the whole note (`text` and `message` are aliases). Replace a note only with the `revision` from `memory_read` (a worker must give it), keeping what you aren't changing; if it changed since, nothing is written and the refusal gives its current text to merge into. `revision: \"new\"` only creates. Secrets are scrubbed; the user sees each write as a diff. Record what can't be derived; never worker status.",
      },
      audience: ["orchestrator", "worker"],
      input: inputAliases(
        Schema.Struct({
          path: Schema.NonEmptyString,
          content: Schema.String,
          revision: Schema.optionalKey(Schema.NonEmptyString),
        }),
        { path: ["file"], content: ["text", "message"], revision: ["basedOn"] },
      ),
      handle: (caller, { path, content, revision }) =>
        memoryChange("memory_write", caller, path, (current, asWorker) => {
          if (asWorker && current !== undefined && revision === undefined) {
            return Effect.fail(
              new AppToolError({
                tool: "memory_write",
                message: refusal(
                  "stale_revision",
                  `${path} already exists. Read it with \`memory_read\`, keep what you aren't changing, and write again with the \`revision\` it gives you; or add to it with \`memory_append\`.`,
                ),
              }),
            );
          }
          return Effect.as(checkRevision("memory_write", path, revision, current), content);
        }),
    });

    const memoryAppend = defineAppTool({
      descriptor: {
        name: "memory_append",
        class: "self",
        description:
          "Use `file` (`path` is an alias) and `content` (`text` and `message` are aliases). Add `content` as a line at the end of a note, making the note if needed. Needs no read first and loses nothing written meanwhile.",
      },
      audience: ["orchestrator", "worker"],
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
          "Use `file` (`path` is an alias). Replace `old` with `new` in a note (an empty `new` deletes it). `old` must appear exactly once unless `replaceAll`; otherwise nothing changes. For one entry without a rewrite.",
      },
      audience: ["orchestrator", "worker"],
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
          "Use `file` (`path` is an alias). Delete a memory note, kept in history. With `revision` (a worker must pass it), refused if the note changed since. Take its line out of MEMORY.md too.",
      },
      audience: ["orchestrator", "worker"],
      input: inputAliases(
        Schema.Struct({
          path: Schema.NonEmptyString,
          revision: Schema.optionalKey(Schema.NonEmptyString),
        }),
        { path: ["file"], revision: ["basedOn"] },
      ),
      handle: (caller, { path, revision }) =>
        Effect.gen(function* () {
          const { workspaceId, asWorker } = yield* readableMemoryOf("memory_delete", caller);
          if (asWorker && revision === undefined) {
            return yield* new AppToolError({
              tool: "memory_delete",
              message: refusal(
                "stale_revision",
                `Read ${path} with \`memory_read\` first and pass the \`revision\` it gives you.`,
              ),
            });
          }
          const write = yield* memory.remove(workspaceId, path, {
            asWorker,
            check: (current) => checkRevision("memory_delete", path, revision, current),
          });
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
          "Ask the user a question without waiting for the answer. It is kept in questions.md in your memory and shown on the board and in Memory with an Answer button; the answer reaches you as a message naming its id, with the entry already closed. Give `options` (2–4, each a short `label` and a `description`) when the answer is a choice, `multiSelect` when several may be picked, and `recommended`, the label you would pick; the user can always answer in their own words. Put what the user needs to decide in `context`. An existing `id`, or an open question's words, updates that entry, and asking a closed one again reopens it. Carry on with what doesn't depend on the answer." +
          VISUALS_HELP +
          " A question picking a mock's direction always carries the mock this way, never as a bare path in `context`. A worker's mock is in its worktree, under your repo; `mock: \"\"` takes the mock away.",
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
          "Close an entry of questions.md yourself. `how` is `decided` when you settled it without the user (say what and why in `answer`), `withdrawn` when it no longer matters, `superseded` when another question replaced it (name that one), or `answered` when the user answered it some other way, in this conversation say. An answer given with Gram's Answer button closes its entry by itself; there is nothing to close then. A worker's open question (`WQ7`) closes the same way, but never as `decided`; it leaves the user's board, and its worker is told.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        id: Schema.NonEmptyString,
        answer: Schema.NonEmptyString,
        how: QuestionHow,
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          if (/^wq\d+$/i.test(input.id.trim())) {
            if (input.how === "decided") {
              return yield* new AppToolError({
                tool: "close_question",
                message:
                  "A worker's question isn't `decided` here: answer one in triage with `answer_worker` and its `source`; a forwarded one is the user's to answer. Close it as `withdrawn`, `superseded` or `answered` (elsewhere).",
              });
            }
            const closed = yield* orchestration.closeWorkerQuestion(caller, {
              questionId: input.id,
              how: input.how === "answered" ? "answered elsewhere" : input.how,
              reason: input.answer,
            });
            return { id: closed.id, closed: true };
          }
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
      recordUserAnswerTool,
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
