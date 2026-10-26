// What every part of the orchestration service shares: its services, the signal queue, the timers
// and locks, the in-memory state more than one part reads, and the core every part calls: reading
// and writing a workspace's outbox, finding a workspace or thread, and asking a caller's authority.
// `service.ts` makes the kit once and hands it to each part.

import type { OutwardGate } from "@gram/agents";
import { gateHoldsInMode as codexGateHoldsInMode } from "@gram/agents/codex";
import {
  AppToolError,
  autonomyOf,
  NotFound,
  customModelsOf,
  requiredChecksOf,
  type AgentKind,
  type GitState,
  type ModelRef,
  type OrchestratorCharter,
  type PermissionMode,
  type PrStatus,
  type Project,
  type ProjectId,
  type RequestId,
  type ServerEvent,
  type LimitWait,
  type Thread,
  type ThreadId,
  type TurnId,
  type WorkerModel,
  type WorkspaceState,
  type WorkspaceId,
  type Checkout,
  type Autonomy,
  connectorEntryProblem,
  InvalidState,
} from "@gram/contracts";
import { Proc, samePathKey, samePath, basename, tryRepoRoots } from "@gram/git";
import * as Clock from "effect/Clock";
import type * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { appLabelOf, ServerConfig } from "../../config.ts";
import { type Coalescing, makeCoalescingQueue } from "../../events/backlog.ts";
import { EventHub } from "../../events/event-hub.ts";
import { AppActivity } from "../../git/activity.ts";
import { LocalChecks } from "../../git/local-checks.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { describePath } from "../../persistence/stored.ts";
import { withOwnedBranch } from "../../git/worker-pr.ts";
import { makeKeyedLock, type KeyedLock } from "../../git/keyed-lock.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { makeThreadCreator } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { selectableModels } from "../../runtime/model-efforts.ts";
import { UsageLimitPoller } from "../../usage/limit-poller.ts";
import { UsageLimitReadings } from "../../usage/limit-readings.ts";
import { ThreadPlans } from "../../plans/service.ts";
import {
  ThreadRuntimes,
  type ObservedTurnEnd,
  type SystemDeliveryFailure,
} from "../../runtime/thread-runtimes.ts";
import {
  extraCheckoutFacts,
  noChangedPaths,
  sameChangedPaths,
  type ChangedPaths,
  type ExtraCheckoutFacts,
  type RootMark,
} from "../git-facts.ts";
import { OrchestrationMemory } from "../memory.ts";
import {
  emptyOutbox,
  emptyWorkerMemo,
  encodeOutbox,
  readOutbox as readStoredOutbox,
  type StoredOutbox,
  type LimitHold,
  type OutboxState,
  type WorkerMemo,
} from "../outbox.ts";
import { ComposerPresence } from "../../runtime/composer-presence.ts";
import {
  admittedForRole,
  checkWorkerSend,
  gateNeeds,
  gateOfAutonomy,
  hasAuthority,
  isDelegated,
  kindName,
  refusal,
  workerModelUnavailable,
  startModeFor,
  type PrWakeFired,
  type PendingReason,
  type PrMark,
  type RosterUnavailable,
  userHoldLapsesAt,
  matchWorkerModel,
  workerModelLabel,
} from "../rules.ts";
import { type OrchestrationShape } from "./shape.ts";
import { heldBriefOf } from "../limit-pause.ts";
import { type PromptWorktree } from "../prompt.ts";

/** How long wake reasons collect before the orchestrator gets its digest. */
export const DEFAULT_WAKE_DEBOUNCE = Duration.seconds(60);
/** How many debounce windows a digest may be put off by reasons that keep coming. */
export const WAKE_MAX_WAIT_WINDOWS = 3;
/**
 * The `deliveryFailed` pause for a workspace whose outbox row this build couldn't read. That row is
 * kept whole in the outbox's `setAside` until the user resumes, and delivery starts over without it.
 */
export const OUTBOX_UNREADABLE_DETAIL =
  "Gram can't read this workspace's delivery state, which a newer version may have written. It is kept as it is; resuming starts delivery over without it.";

/** The outbox's held briefs as the ledger shows them, soonest release first. */
export const heldOf = (outbox: OutboxState) =>
  (outbox.heldBriefs ?? []).map(heldBriefOf).toSorted((a, b) => a.until - b.until);

/** The project a checkout belongs to: the one whose root is its repo's main checkout. */
export const projectOfCheckout = (
  projects: Iterable<Project>,
  checkout: Checkout,
): Project | undefined => {
  const root = checkout.repoRoot ?? checkout.path;
  for (const project of projects) if (samePath(project.root, root)) return project;
  return undefined;
};

/** The threads the workspace's current orchestrator spawned, parked ones included. */
export const workersOf = (threads: ReadonlyArray<Thread>, state: WorkspaceState) => {
  const holder = state.workspace.orchestratorThreadId;
  return holder === undefined
    ? []
    : threads.filter((thread) => thread.spawnedBy?.threadId === holder);
};

/** The system-delivery key of an orchestrator's digest; one is pending at a time. */
export const DIGEST_KEY = "digest";

/** A repo a call names that isn't in the workspace; `unknown` when Gram doesn't know it yet. */
export interface OutsideRepo {
  readonly name: string;
  readonly root: string;
  readonly unknown?: true | undefined;
}

/** A repo as a card names it: one Gram doesn't know yet with its folder, to be checked. */
export const repoLabel = (repo: OutsideRepo): string =>
  repo.unknown === true ? `${repo.name} (${repo.root})` : repo.name;

/** A worker's other worktrees as its prompt and the tools' results name them. */
export const worktreesOf = (
  projects: Iterable<Project>,
  extras: ReadonlyArray<Checkout>,
): ReadonlyArray<PromptWorktree> => {
  const known = [...projects];
  return extras.map((extra) => ({
    project: projectOfCheckout(known, extra)?.name ?? basename(extra.repoRoot ?? extra.path),
    path: extra.path,
    ...(extra.branch === undefined ? {} : { branch: extra.branch }),
  }));
};

/** The `deliveryFailed` pause for an orchestrator in error: the one a recovery lifts by itself. */
export const IN_ERROR_DETAIL =
  "The orchestrator thread is in error. Open it to see why, then resume; Gram also tries again by itself from time to time.";

/** Whether a stored pause is the in-error one. */
export const inErrorPause = (paused: {
  readonly reason: string;
  readonly detail?: string | undefined;
}) => paused.reason === "deliveryFailed" && paused.detail === IN_ERROR_DETAIL;
/** Why an approved change by chat was refused: what it was approved against has moved. */
export const CHARTER_MOVED =
  "This workspace's settings changed after the card was shown, so what was approved no longer matches; nothing changed.";

/** The user holds the worker `memo` is of: they wrote to it, and the hold hasn't lapsed. */
export const heldByUser = (memo: WorkerMemo | undefined, now: number) => {
  const lapsesAt = memo === undefined ? undefined : userHoldLapsesAt(memo);
  return lapsesAt !== undefined && lapsesAt > now;
};

/** The reason a restart's catch-up digest carries; it also makes that digest the `away` variant. */
export const AWAY_REASON = "while you were away";
export const AUTONOMY_LINES: Record<Autonomy, string> = {
  supervised:
    "autonomy supervised: your workers ask the user before a push, a pull request or a merge",
  publish:
    "autonomy publish: your workers push and open pull requests themselves, and ask the user before a merge, a release or anything else that can't be taken back",
  full: "autonomy full: nothing asks the user; you may set auto-merge on your workers' pull requests and answer their questions",
};

export const ROUTE_AT_LIMIT_LINE =
  "another worker model at a limit: when a subscription limit stops a spawn (its account is at its limit, or the limit gates hold or refuse it) and another worker model is clear of it, spawn_worker's result lists those `alternatives` with the user's notes: a spawn not made returns `routeOffer: true`, a held brief carries them. Pick one whose note fits the brief, never one whose note rules that work out, and spawn again with `model` (or retarget the held brief); or pass `atLimit: \"stay\"` to keep the model you named";

/** The charter's line for the worker brief footer, which quotes it. */
export const footerLine = (footer: string): string =>
  `worker brief footer: Gram appends the user's standing instructions below to every worker brief, marked as theirs, so don't repeat them in a brief:\n${footer
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n")}`;

/** The models the orchestrator may start a worker on: the charter's roster, else its own. */
export const allowedWorkerModels = (
  caller: Pick<Thread, "model">,
  charter: OrchestratorCharter,
): ReadonlyArray<WorkerModel> => charter.workerModels ?? [caller.model];

/**
 * Refuses a charter whose connector set holds an entry `connectorEntryProblem` won't keep: its
 * strings decode as stored, so a credential in an address is stopped here, before it is.
 */
export const refuseConnectorEntries = (charter: OrchestratorCharter) => {
  const set = charter.connectors;
  const entries = set === undefined ? [] : "allow" in set ? set.allow : set.deny;
  for (const entry of entries) {
    const problem = connectorEntryProblem(entry);
    if (problem !== undefined) {
      return Effect.fail(new InvalidState({ message: `“${entry.trim()}”: ${problem}` }));
    }
  }
  return Effect.void;
};

/**
 * `named` as one of the charter's worker models, of an agent kind admitted for workers. An entry
 * in `unavailable` is stood in for by the default (`matchWorkerModel`), which `instead` says.
 */
export const workerModel = (
  tool: string,
  caller: Pick<Thread, "model">,
  charter: OrchestratorCharter,
  named: string | undefined,
  here?: {
    /** The charter's roster as it runs here (`rosterHere`), in its order. */
    readonly roster: ReadonlyArray<WorkerModel>;
    readonly unavailable: RosterUnavailable;
  },
) =>
  Effect.gen(function* () {
    const allowed = here?.roster ?? allowedWorkerModels(caller, charter);
    const unavailable = here?.unavailable ?? new Map<number, string>();
    const match = matchWorkerModel(allowed, named, caller.model, unavailable);
    if (!match.ok) {
      const labels = allowed.map(workerModelLabel).join(", ");
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          match.why === "ambiguous"
            ? `${named} names more than one of the charter's worker models. Say which, as agent:model. Allowed: ${labels}.`
            : match.why === "unavailable"
              ? `The selected worker model cannot run here, so no worker is spawned. ${match.reasons}. Tell the user.`
              : `The charter doesn't allow workers on ${named ?? "that model"}. Allowed: ${labels}.`,
        ),
      );
    }
    if (!admittedForRole(match.model.agent, "worker")) {
      return yield* toolError(
        tool,
        refusal("not_admitted", `${match.model.agent} threads can't be workers yet.`),
      );
    }
    return { model: match.model, instead: match.instead };
  });

/** What the consumer fiber works through, one at a time, in the order things happened. */
export type Signal =
  | { readonly type: "turnStart"; readonly thread: Thread; readonly turnId: TurnId }
  | { readonly type: "turnEnd"; readonly thread: Thread; readonly end: ObservedTurnEnd }
  | { readonly type: "quiet"; readonly thread: Thread; readonly active: boolean }
  | { readonly type: "userInput"; readonly thread: Thread }
  /** A thread began or stopped waiting out a provider limit (`RuntimeObserver.onLimitWait`). */
  | {
      readonly type: "limitWait";
      readonly thread: Thread;
      readonly wait: LimitWait;
      readonly ended?: "resumed" | "cancelled" | undefined;
    }
  | { readonly type: "gitState"; readonly thread: Thread; readonly state: GitState }
  | { readonly type: "hub"; readonly event: ServerEvent }
  | { readonly type: "wakeDue"; readonly workspaceId: WorkspaceId }
  | { readonly type: "requestAged"; readonly threadId: ThreadId; readonly requestId: RequestId }
  | { readonly type: "holdDue"; readonly threadId: ThreadId }
  /** A worker's question has been in triage `WORKER_QUESTION_TRIAGE_MS`. */
  | { readonly type: "questionDue"; readonly workspaceId: WorkspaceId; readonly questionId: string }
  | {
      readonly type: "wakeAlarm";
      readonly workspaceId: WorkspaceId;
      readonly wakeId: string;
      /** The event of the PR it waits on that fired it; absent when its time did. */
      readonly fired?: PrWakeFired | undefined;
    }
  | { readonly type: "recoveryDue"; readonly workspaceId: WorkspaceId }
  /** A window the user paused new workers for at its limit threshold has reset. */
  | { readonly type: "limitReset"; readonly workspaceId: WorkspaceId }
  /** A limit reading came in: what a limit holds back may go ahead now. */
  | { readonly type: "limitHeadroom" }
  /** A worker whose PR depends on another may now find that one dragging on. */
  | { readonly type: "dragCheck"; readonly threadId: ThreadId }
  | {
      readonly type: "handoffFailed";
      readonly workspaceId: WorkspaceId;
      readonly reason: SystemDeliveryFailure;
    }
  | { readonly type: "handoffRetry"; readonly workspaceId: WorkspaceId }
  /** The orchestrator reported a context fill below the note's threshold. */
  | { readonly type: "contextLow"; readonly workspaceId: WorkspaceId }
  /** A read found the workspace's outbox unreadable; `quarantineOutbox` sets it aside. */
  | { readonly type: "outboxUnreadable"; readonly workspaceId: WorkspaceId }
  | { readonly type: "boot" };

const NO_AUTHORITY =
  "This thread is not its workspace's orchestrator, so this tool does nothing here.";

export const prMarkOf = (badge: PrStatus | undefined): PrMark | undefined => {
  if (badge === undefined) return undefined;
  const verdict = badge.review?.verdictOnHead;
  return {
    state: badge.state === "MERGED" ? "merged" : badge.state === "CLOSED" ? "closed" : "open",
    checks: requiredChecksOf(badge),
    ...(verdict === undefined ? {} : { verdictOnHead: verdict }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
  };
};

export const toolError = (tool: string, message: string) => new AppToolError({ tool, message });

/** The adapter's word on whether `kind`'s outward gate holds in `mode`; Claude's hook asks in every mode. */
export const gateHoldsIn = (kind: AgentKind, mode: PermissionMode): boolean =>
  kind === "codex" ? codexGateHoldsInMode(mode) : kind === "claude";

export const clipped = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The feature of `thread` when the user has paused it in `state`, else `undefined`. */
export const pausedFeatureOf = (
  state: Pick<WorkspaceState, "pausedFeatures"> | undefined,
  thread: Pick<Thread, "spawnedBy"> | undefined,
): string | undefined => {
  const feature = thread?.spawnedBy?.feature;
  return feature !== undefined && state?.pausedFeatures?.includes(feature) === true
    ? feature
    : undefined;
};

const threadSubject = (threadId: ThreadId) => `thread ${threadId}`;
const workspaceSubject = (workspaceId: WorkspaceId) => `workspace ${workspaceId}`;

/**
 * Which signals the queue may coalesce. An upsert, a git state, a thread's background tasks and a
 * low context reading each carry, or make the handler read, the latest state of their thread or
 * workspace, so a newer one supersedes a waiting one. The rest are lossless: a removal, a request
 * and its resolution, a turn's start and end, user input and every timer each do something once.
 */
export const SIGNAL_COALESCING: Coalescing<Signal> = {
  subjectOf: (signal) => {
    switch (signal.type) {
      case "turnStart":
      case "turnEnd":
      case "userInput":
      case "limitWait":
      case "gitState":
        return threadSubject(signal.thread.id);
      case "requestAged":
      case "holdDue":
      case "dragCheck":
        return threadSubject(signal.threadId);
      case "wakeDue":
      case "recoveryDue":
      case "handoffFailed":
      case "handoffRetry":
      case "contextLow":
      case "wakeAlarm":
      case "limitReset":
      case "outboxUnreadable":
      case "questionDue":
        return workspaceSubject(signal.workspaceId);
      case "hub": {
        const { event } = signal;
        if (event.type === "thread.upsert") return threadSubject(event.thread.id);
        return "threadId" in event && event.threadId !== undefined
          ? threadSubject(event.threadId)
          : undefined;
      }
      case "limitHeadroom":
        return "limits";
      case "boot":
        return undefined;
    }
  },
  replaceableAs: (signal) => {
    if (
      signal.type === "gitState" ||
      signal.type === "contextLow" ||
      signal.type === "limitHeadroom"
    ) {
      return signal.type;
    }
    if (signal.type !== "hub") return undefined;
    return signal.event.type === "thread.upsert" || signal.event.type === "thread.background"
      ? signal.event.type
      : undefined;
  },
  // Background tasks are stored as they are and a low reading only rearms, so neither has one.
  transitionOf: (signal) => {
    if (signal.type === "gitState") return gitTransition(signal.thread, signal.state);
    if (signal.type === "hub" && signal.event.type === "thread.upsert") {
      return upsertTransition(signal.event.thread);
    }
    return "";
  },
};

/**
 * What `onUpsert` and `followPark` act on a change of: the mode an `auto` open is checked against,
 * a park, a completion, and which workspace the thread holds or works for.
 */
const upsertTransition = (thread: Thread) =>
  JSON.stringify([
    thread.mode,
    thread.parked,
    thread.completedAt !== undefined,
    thread.role ?? null,
    thread.workspaceId ?? null,
    thread.spawnedBy ?? null,
  ]);

const prTransition = (badge: PrStatus | undefined) =>
  badge === undefined ? null : { number: badge.number, url: badge.url, ...prMarkOf(badge) };

/**
 * What `onGitState` compares with what it saw last: each PR's mark (`prMarks`), and the head,
 * changes and base its changed files and overlaps are sampled at.
 */
const gitTransition = (thread: Thread, git: GitState) =>
  JSON.stringify([
    prTransition(git.pr),
    (git.extraPrs ?? []).map(prTransition),
    git.repo,
    git.head,
    git.changesToken,
    git.base ?? null,
    (thread.extraCheckouts ?? []).map((extra) => extra.path),
    git.missing === true,
  ]);

/**
 * Makes the kit. Every timer and lock is made here, in the order the service always made them, so
 * its scope finalizes them in that order too.
 */
/**
 * The `taskStartupLock` keys of workspace `workspaceId`: its own, and for a one-project workspace
 * its project's (`projectKey`) too. A task for that project took the project's key while it had
 * no workspace yet, and goes on holding it while its run makes the workspace, so whatever takes
 * this workspace's keys waits for it.
 */
export const startupKeysOf = (
  workspaceId: WorkspaceId,
  state: WorkspaceState | undefined,
): ReadonlyArray<string> => {
  const projects = state?.workspace.projectIds ?? [];
  return projects.length === 1 ? [workspaceId, projectKey(projects[0]!)] : [workspaceId];
};

/** Whether `a` and `b` hold the same keys. */
const sameKeys = <K>(a: ReadonlyArray<K>, b: ReadonlyArray<K>) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
};

/** The key of a caller with no workspace, under the locks keyed by the caller's workspace. */
export const callerKey = (threadId: ThreadId) => `caller:${threadId}`;
/** The key of a project with no workspace yet, under `taskStartupLock`. */
export const projectKey = (projectId: ProjectId) => `project:${projectId}`;
/**
 * Runs `effect` holding `lock` for each key `keysOf` reads, all at once (`withLocks`). The keys
 * are read again under the locks, and taken again if they moved meanwhile (a thread joined
 * another workspace, an orchestrator handed its slot on), so `effect` always runs under the keys
 * of what it reads.
 */
export const underKeysOf = <K, A, E, R, E2, R2>(
  lock: KeyedLock<K>,
  keysOf: Effect.Effect<ReadonlyArray<K>, E2, R2>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.gen(function* () {
    while (true) {
      const keys = yield* keysOf;
      const ran = yield* lock.withLocks(
        keys,
        Effect.gen(function* () {
          if (!sameKeys(keys, yield* keysOf)) return Option.none<A>();
          return Option.some(yield* effect);
        }),
      );
      if (Option.isSome(ran)) return ran.value;
    }
  });

export const makeOrchestrationKit = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const runtimes = yield* ThreadRuntimes;
  const publisher = yield* GitStatePublisher;
  const memory = yield* OrchestrationMemory;
  const checkouts = yield* CheckoutService;
  const hosts = yield* AgentHosts;
  const nativeGateReady = (kind: AgentKind): Effect.Effect<boolean> =>
    kind === "codex"
      ? hosts.get(kind).pipe(
          Effect.flatMap((host) => host.nativeGateReady ?? Effect.succeed(false)),
          Effect.catchCause(() => Effect.succeed(false)),
        )
      : Effect.succeed(false);
  const config = yield* ServerConfig;
  const app = appLabelOf(config);
  // Absent in runtime-only test layers, where there is no git to read drift or changed files from.
  const proc = yield* Effect.serviceOption(Proc);
  // Absent in layers that keep no limit readings: nothing is then near a limit.
  const limitReadings = yield* Effect.serviceOption(UsageLimitReadings);
  // Absent headless and in test layers: the user then never counts as away.
  const appActivity = yield* Effect.serviceOption(AppActivity);
  // Absent in layers that keep no limit readings, and there nothing is near a limit.
  const limitPoller = yield* Effect.serviceOption(UsageLimitPoller);
  // Absent where Gram runs no local checks: no ledger row then shows one.
  const localChecks = Option.getOrUndefined(yield* Effect.serviceOption(LocalChecks));
  // Absent in layers that don't track the composers: unknown presence holds idle compaction.
  const composerPresence = Option.getOrUndefined(yield* Effect.serviceOption(ComposerPresence));
  const creator = makeThreadCreator({ store, checkouts, runtimes });

  /**
   * The roster as it runs here: local entries stay on their own CLI, while explicit gateway
   * entries require their selected profile/key. Setup never changes routing merely because a key
   * was added.
   */
  const rosterHere = (allowed: ReadonlyArray<WorkerModel>, charter: OrchestratorCharter) =>
    Effect.gen(function* () {
      const profiles = yield* store.listProfiles;
      const settings = yield* store.getSettings;
      const own = new Map<AgentKind, ReadonlyArray<string> | undefined>();
      const roster: Array<WorkerModel> = [];
      const unavailable = new Map<number, string>();
      for (const [index, entry] of allowed.entries()) {
        const gatewayKind = entry.agent === "codex";
        if (gatewayKind && entry.profileId === undefined && !own.has(entry.agent)) {
          own.set(
            entry.agent,
            yield* selectableModels(store, hosts, entry.agent, undefined).pipe(
              Effect.map((models) => models.map((each) => each.id)),
              Effect.orElseSucceed(() => undefined),
            ),
          );
        }
        const context = {
          profiles,
          ownModels: own.get(entry.agent),
          customModels: customModelsOf(settings, entry.agent).map((each) => each.id),
          gated: gateOfAutonomy(autonomyOf(charter)) !== undefined,
          gateReady: yield* nativeGateReady(entry.agent),
        };
        const model = entry;
        roster.push(model);
        const mode = startModeFor(model.agent, settings, charter);
        // A mode the gate can't ask in is as unrunnable as a missing key, so a spawn on it falls
        // back too rather than being refused by `workerModelVerdict`.
        const cantAsk =
          admittedForRole(model.agent, "worker") &&
          gateNeeds({
            model,
            gate: gateOfAutonomy(autonomyOf(charter)),
            mode,
            hasGatewayProfile: true,
            gateHoldsInMode: gateHoldsIn(model.agent, mode),
          }) === "mode";
        const why =
          workerModelUnavailable({ model, ...context }) ??
          (cantAsk
            ? `workers start in ${mode} mode here, in which a ${kindName(model.agent)} worker can't ask before a push; pick another worker mode in Settings → Workspaces, or set the workspace's autonomy to Full`
            : undefined);
        if (why !== undefined) unavailable.set(index, why);
      }
      return { roster, unavailable: unavailable as RosterUnavailable };
    });

  /** Which of a roster's entries can't be spawned on here, and why. */
  const rosterAvailability = (charter: OrchestratorCharter) =>
    rosterHere(charter.workerModels ?? [], charter).pipe(
      Effect.map(({ unavailable }) => unavailable),
    );

  const debounce = config.orchestrationDebounce ?? DEFAULT_WAKE_DEBOUNCE;
  const maxWait = Duration.times(debounce, WAKE_MAX_WAIT_WINDOWS);

  const signals = yield* makeCoalescingQueue("orchestration signals", SIGNAL_COALESCING);
  const wakeTimers = yield* FiberMap.make<WorkspaceId>();
  const requestTimers = yield* FiberMap.make<RequestId>();
  const handoffTimers = yield* FiberMap.make<WorkspaceId>();
  const switchJobs = yield* FiberMap.make<WorkspaceId>();
  /** Per held worker, the check that lets the user's hold lapse (`USER_HOLD_IDLE_MS`). */
  const holdTimers = yield* FiberMap.make<ThreadId>();
  /** Per `schedule_wake`, by its id, the timer that fires it. */
  const wakeAlarms = yield* FiberMap.make<string>();
  /**
   * Per worker question in triage, by `questionTimerKey`, the timer that forwards it to the user.
   * Ids are numbered per workspace, so every workspace has its own `WQ1`.
   */
  const questionTimers = yield* FiberMap.make<string>();
  /** Per workspace, the next reset of a window it paused new workers for. */
  const limitAlarms = yield* FiberMap.make<WorkspaceId>();
  /** Per workspace: a pause's write and a merge's launch never interleave (`launchUnlessPaused`). */
  const pauseFence = makeKeyedLock<WorkspaceId>();
  /** Per workspace, the timer letting go of the workers its resume holds back (`resuming`). */
  const pauseResumeTimers = yield* FiberMap.make<WorkspaceId>();
  /** The background runs that spawn the held briefs whose limit has reset (`releaseDue`). */
  const heldReleases = yield* FiberSet.make();
  // The locks below are per workspace (`makeKeyedLock`): what each guards is one workspace's
  // outbox, workers, charter or session, so a slow workspace holds up only itself. The few that
  // span workspaces say so where they are made.
  /** One release run at a time per workspace, so a brief is looked at by one run only. */
  const heldLock = makeKeyedLock<string>();
  /**
   * One `armLimitResume` at a time per workspace, so an older read of its outbox never resets a
   * newer alarm.
   */
  const alarmLock = makeKeyedLock<WorkspaceId>();
  /**
   * Workspaces with a release run waiting for `heldLock`: that run reads the outbox once it has
   * the lock, so whatever fell due meanwhile is its to release and no second one is forked.
   */
  const heldPending = new Set<WorkspaceId>();
  /** Optional in runtime-only test layers; a released held brief's plan is seeded through it. */
  const plans = yield* Effect.serviceOption(ThreadPlans);
  /** Per workspace, agent and window, the limit ask on screen, which a parallel spawn waits on. */
  const limitAsks = new Map<string, Deferred.Deferred<LimitHold["decision"] | undefined>>();
  /** Per workspace paused for `deliveryFailed`, the next look at whether it can resume (`RECOVERY_DELAYS`). */
  const recoveryTimers = yield* FiberMap.make<WorkspaceId>();
  /**
   * Workspaces whose `deliveryFailed` pause the user has been told of, by the looks taken since, so
   * the pause a failed attempt brings back is said only once. Cleared by a digest that lands.
   */
  const recovering = new Map<WorkspaceId, number>();
  /** Workspaces the recovery resumed, whose next landed digest tells the user so. */
  const selfResumed = new Set<WorkspaceId>();
  /**
   * Serialises every read-modify-write of a workspace's outbox; never held across a
   * `ThreadRuntimes` call.
   */
  const outboxLock = makeKeyedLock<WorkspaceId>();
  /**
   * One spawn, join or adoption at a time per workspace, so a retried `clientRequestId` finds the
   * worker the first call made and the workspace's repos and folders agree. Keyed by the caller's
   * workspace (`underKeysOf`), or `callerKey` for a caller without one, which is refused inside.
   * What a spawn shares with other workspaces has its own guard: `registryLock` and
   * `claimedProjects` for the projects it registers, `checkoutLock` for the worktrees it makes.
   */
  const spawnLock = makeKeyedLock<string>();
  /**
   * Spans workspaces: workspace names are unique across them, and a project a failed call
   * registered is only forgotten while no workspace takes it in. Held by a workspace save and by
   * that forgetting, never across a spawn.
   */
  const registryLock = yield* Semaphore.make(1);
  /**
   * Projects an in-flight spawn or `add_worker_repo` resolved, by how many calls, across
   * workspaces: another call's failure doesn't forget one this call is about to use.
   */
  const claimedProjects = new Map<ProjectId, number>();
  /**
   * Projects a failed call registered and couldn't forget because another call held them: the
   * last claim to go forgets them, unless a workspace took them in. Both under `registryLock`.
   */
  const unjoinedRegistered = new Set<ProjectId>();
  /**
   * Per repository (`checkoutKey`), across workspaces: from git's check of a checkout to the thread
   * holding it, so two workspaces sharing a repo never both make, or both move into, one worktree.
   */
  const checkoutLock = makeKeyedLock<string>();
  /**
   * A wake's delivery and its cancellation, one at a time per workspace (`onWakeAlarm`,
   * `cancel_wake`).
   */
  const wakeLock = makeKeyedLock<string>();
  /** The same for a `send_message` with a `clientRequestId`, from its check to its record. */
  const sendLock = makeKeyedLock<string>();
  /**
   * Charter commits cannot interleave with a validated user task startup in their workspace. A
   * task for a project with no workspace yet is keyed by the project (`projectKey`).
   */
  const taskStartupLock = makeKeyedLock<string>();
  /** Per project: two first opens of one project must not make two workspaces for it. */
  const workspaceLock = makeKeyedLock<ProjectId>();
  /** Held by a removal, and by whatever must not see its workspace go meanwhile. */
  const removalLock = makeKeyedLock<WorkspaceId>();
  /**
   * One fresh session at a time per workspace: the request's own fiber and the consumer can both
   * get there.
   */
  const handoffLock = makeKeyedLock<WorkspaceId>();

  /** Why each workspace's pending digest is due. They decide when it goes, never what it says. */
  const reasons = new Map<WorkspaceId, Set<string>>();
  /** Who and what each pending reason is about, for `coalesceReasons`. */
  const reasonsAbout = new Map<WorkspaceId, Map<string, PendingReason>>();
  /** Epoch ms of the oldest reason no digest has taken yet, which bounds the window. */
  const firstReasonAt = new Map<WorkspaceId, number>();
  /** Workspaces with a pending reason the ledger diff can't show, so the digest goes regardless. */
  const diffless = new Set<WorkspaceId>();
  /** The reasons each in-flight digest carried, by the turn that carries it. */
  const carried = new Map<TurnId, ReadonlyArray<string>>();
  const orchestrators = new Map<ThreadId, WorkspaceId>();
  const workerWorkspaces = new Map<ThreadId, WorkspaceId>();
  /** Last observed park, kept after the thread row disappears so removal can be classified. */
  const parkedWorkers = new Set<ThreadId>();
  const retrying = new Set<ThreadId>();
  /** Threads this service started in `auto`, until their first turn ends: see `onUpsert`. */
  const openedInAuto = new Set<ThreadId>();
  const completedSeen = new Set<ThreadId>();
  const requestSeen = new Map<RequestId, { readonly threadId: ThreadId; readonly at: number }>();
  /** By thread id for a worker's own PR, and by thread id and URL for each extra one. */
  const prMarks = new Map<string, PrMark | undefined>();
  const changedFiles = new Map<ThreadId, ChangedPaths & { readonly token: string }>();
  /** Worktrees workers hold in other repos, as last sampled, by `samePathKey`. */
  const extraFacts = new Map<string, ExtraCheckoutFacts>();
  /** Each worker's `extraPrs` badges as the publisher last sent them. */
  const extraBadges = new Map<ThreadId, ReadonlyArray<PrStatus>>();
  /** Per worker whose PR depends on another, when its PR was first seen conflicting with its base. */
  const conflictedSince = new Map<ThreadId, number>();
  /** The dependencies the orchestrator was woken over as dragging on, as `thread owner/repo#N`. */
  const dragsTold = new Set<string>();
  /** Per conflicted worker, the look at whether its conflict has lasted long enough to drag. */
  const dragTimers = yield* FiberMap.make<ThreadId>();
  /** Workers whose worktree the orchestrator was woken over as missing, until it is back. */
  const worktreesGone = new Set<ThreadId>();
  /** Workspaces whose next `boot` digest goes out even while paused: a handoff the user asked for. */
  const bootWhilePaused = new Set<WorkspaceId>();
  /** Each workspace's overlapping pairs already told, as `overlapPairs` keys. */
  const knownOverlaps = new Map<WorkspaceId, ReadonlySet<string>>();
  const driftBefore = new Map<ThreadId, ReadonlyMap<string, RootMark>>();
  /**
   * Each orchestrator's delegated sends to each of its workers, epoch ms, for the rate limit. By
   * pair, since the limit is a loop guard and a worker can't message back: counted per sender, it
   * held a whole fleet to five messages a minute.
   */
  const sends = new Map<string, ReadonlyArray<number>>();

  const workspacesChanged = hub.publish({ type: "workspaces.changed" });
  const orchestrationChanged = (workspaceId: WorkspaceId) =>
    hub.publish({ type: "orchestration.changed", workspaceId });

  const findWorkspace = (workspaceId: WorkspaceId | undefined) =>
    workspaceId === undefined
      ? Effect.succeed<WorkspaceState | undefined>(undefined)
      : store.getWorkspace(workspaceId).pipe(Effect.orElseSucceed(() => undefined));

  /** `startupKeysOf` the workspace as stored now. */
  const workspaceStartupKeys = (workspaceId: WorkspaceId) =>
    findWorkspace(workspaceId).pipe(Effect.map((state) => startupKeysOf(workspaceId, state)));

  /**
   * The `checkoutLock` key of the repository `path` is a checkout of: its git common dir, which
   * every worktree of one repository shares. A folder git doesn't know is keyed by itself.
   */
  const checkoutKey = (path: string) =>
    provideProc(
      tryRepoRoots(path).pipe(
        Effect.map((roots) => roots?.common ?? path),
        Effect.orElseSucceed(() => path),
      ),
      path,
    ).pipe(Effect.map((key) => samePathKey(key)));

  const findThread = (threadId: string) =>
    store.getThread(threadId as ThreadId).pipe(Effect.orElseSucceed(() => undefined));

  const provideProc = <A>(effect: Effect.Effect<A, never, Proc>, fallback: A): Effect.Effect<A> =>
    Option.match(proc, {
      onNone: () => Effect.succeed(fallback),
      onSome: (service) => effect.pipe(Effect.provideService(Proc, service)),
    });

  /**
   * Reads each worktree the worker holds in another repo again; `true` when what one of them has
   * changed moved. The thread's published git state follows its own checkout alone, so these are
   * sampled when that state moves, when the worker ends a turn, and when one is made.
   */
  const sampleExtras = (thread: Thread) =>
    Effect.gen(function* () {
      let moved = false;
      for (const extra of thread.extraCheckouts ?? []) {
        const key = samePathKey(extra.path);
        const before = extraFacts.get(key);
        const after = yield* provideProc(
          extraCheckoutFacts(extra.path),
          before ?? { ...noChangedPaths, repo: undefined },
        );
        extraFacts.set(key, after);
        if (withOwnedBranch(thread, extra.path, after.branch) !== thread) {
          // A worker removed during the sample has no ownership left to record.
          yield* runtimes
            .updateThread(thread.id, (latest) => withOwnedBranch(latest, extra.path, after.branch))
            .pipe(Effect.ignore);
        }
        moved ||= before === undefined || !sameChangedPaths(before, after);
      }
      return moved;
    });

  /** Workspaces whose unreadable outbox has been signalled and not set aside yet. */
  const unreadableSignalled = new Set<WorkspaceId>();

  /**
   * Queues the setting aside of an outbox row that can't be read. Never done in place: a digest
   * builder reads the outbox under its runtime's lock, which the pause that follows would wait on.
   */
  const signalUnreadable = (workspaceId: WorkspaceId, stored: StoredOutbox) =>
    stored._tag !== "unreadable" || unreadableSignalled.has(workspaceId)
      ? Effect.void
      : Effect.suspend(() => {
          unreadableSignalled.add(workspaceId);
          return signals.offer({ type: "outboxUnreadable", workspaceId }).pipe(Effect.asVoid);
        });

  /**
   * Replaces an outbox row that can't be read with an empty outbox keeping its text in `setAside`,
   * so what runs next writes for real, and logs where it failed. Runs under `outboxLock`.
   */
  const setAside = (workspaceId: WorkspaceId, json: string | undefined) =>
    Effect.gen(function* () {
      const stored = readStoredOutbox(json);
      if (stored._tag !== "unreadable") return stored;
      yield* store.putOutbox(workspaceId, encodeOutbox(emptyOutbox, json));
      yield* Effect.logWarning("orchestration outbox unreadable").pipe(
        Effect.annotateLogs({
          workspaceId,
          version: stored.version ?? "none",
          fields: stored.paths.slice(0, 8).map(describePath),
        }),
      );
      return readStoredOutbox(encodeOutbox(emptyOutbox, json));
    });

  /**
   * Lets go of the row an outbox set aside once the user has ended its pause: by resuming, by a
   * fresh session, or by opening another orchestrator. `true` when there was one.
   */
  const releaseSetAside = (workspaceId: WorkspaceId) =>
    outboxLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const stored = readStoredOutbox(yield* store.getOutbox(workspaceId));
        if (stored._tag !== "read" || stored.setAside === undefined) return false;
        yield* store.putOutbox(workspaceId, encodeOutbox(stored.state));
        yield* Effect.logInfo("orchestration outbox set aside let go").pipe(
          Effect.annotateLogs({ workspaceId }),
        );
        return true;
      }),
    );

  /** The workspace's outbox, `emptyOutbox` in place of a row that can't be read. */
  const readOutbox = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const stored = readStoredOutbox(yield* store.getOutbox(workspaceId));
      yield* signalUnreadable(workspaceId, stored);
      return stored.state;
    });

  /**
   * Read-modify-write of one outbox. `f` may return the state it was given to write nothing. A
   * row that can't be read is set aside first, so what `f` makes of the empty state is stored.
   */
  const updateOutbox = <A>(
    workspaceId: WorkspaceId,
    f: (outbox: OutboxState) => readonly [OutboxState, A],
  ): Effect.Effect<A> =>
    Effect.gen(function* () {
      const [unreadable, value] = yield* outboxLock.withLock(
        workspaceId,
        Effect.gen(function* () {
          const json = yield* store.getOutbox(workspaceId);
          const read = yield* setAside(workspaceId, json);
          const [after, result] = f(read.state);
          if (after !== read.state) {
            const kept = read._tag === "read" ? read.setAside : undefined;
            yield* store.putOutbox(workspaceId, encodeOutbox(after, kept));
          }
          return [readStoredOutbox(json), result] as const;
        }),
      );
      yield* signalUnreadable(workspaceId, unreadable);
      return value;
    });

  const updateMemo = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    f: (memo: WorkerMemo) => WorkerMemo,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* updateOutbox(workspaceId, (outbox) => {
        const before = outbox.workers[threadId] ?? emptyWorkerMemo(now);
        const after = f(before);
        return after === before && outbox.workers[threadId] !== undefined
          ? [outbox, undefined]
          : [{ ...outbox, workers: { ...outbox.workers, [threadId]: after } }, undefined];
      });
    });

  const authorityOf: OrchestrationShape["authorityOf"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* findThread(threadId);
      if (thread === undefined) return undefined;
      const state = yield* findWorkspace(thread.workspaceId);
      return state !== undefined && hasAuthority({ thread, workspace: state.workspace })
        ? { thread, state }
        : undefined;
    });

  /**
   * The key of the workspace `threadId` holds authority in, for the locks keyed by the caller's
   * workspace; `callerKey` for one with none, which the call refuses under it.
   */
  const authorityKeys = (threadId: ThreadId) =>
    authorityOf(threadId).pipe(
      Effect.map((authority) => [authority?.state.workspace.id ?? callerKey(threadId)]),
    );

  const requireAuthority = (tool: string, threadId: ThreadId) =>
    authorityOf(threadId).pipe(
      Effect.flatMap((authority) =>
        authority === undefined
          ? Effect.fail(toolError(tool, refusal("no_authority", NO_AUTHORITY)))
          : Effect.succeed(authority),
      ),
    );

  const delegated: OrchestrationShape["isDelegated"] = (callerId, targetId) =>
    Effect.gen(function* () {
      const caller = yield* findThread(callerId);
      const target = yield* findThread(targetId);
      if (caller === undefined || target === undefined) return false;
      const state = yield* findWorkspace(caller.workspaceId);
      return isDelegated({ caller, target, workspace: state?.workspace });
    });

  // Message-only authority: current workers can coordinate with their bound parent or siblings.
  // Read persisted relationships on every gate and dispatch; no thread text establishes ownership.
  const workerMessageRoute = (callerId: ThreadId, targetId?: string) =>
    Effect.gen(function* () {
      const caller = yield* findThread(callerId);
      const resolvedId = targetId ?? caller?.spawnedBy?.threadId;
      const target = resolvedId === undefined ? undefined : yield* findThread(resolvedId);
      if (
        caller === undefined ||
        target === undefined ||
        caller.id === target.id ||
        caller.spawnedBy === undefined ||
        caller.role !== undefined ||
        caller.parked ||
        target.parked ||
        !admittedForRole(caller.model.agent, "worker") ||
        caller.workspaceId === undefined ||
        caller.workspaceId !== target.workspaceId
      )
        return undefined;
      const owner = yield* authorityOf(caller.spawnedBy.threadId);
      if (
        owner === undefined ||
        owner.thread.parked ||
        owner.state.workspace.id !== caller.workspaceId
      )
        return undefined;
      const parent = target.id === owner.thread.id;
      if (
        !parent &&
        (target.role !== undefined ||
          target.spawnedBy?.threadId !== owner.thread.id ||
          !admittedForRole(target.model.agent, "worker"))
      )
        return undefined;
      // A missing/unreadable membership memo must not silently lose a user hold.
      const outbox = readStoredOutbox(yield* store.getOutbox(owner.state.workspace.id));
      if (
        outbox._tag !== "read" ||
        outbox.state.workers[callerId] === undefined ||
        (!parent && outbox.state.workers[target.id] === undefined)
      )
        return undefined;
      const verdict = checkWorkerSend({
        // Worker sends also pass the ordinary per-sender rate, back-to-back and hop guard.
        recentSends: [],
        now: yield* Clock.currentTimeMillis,
        paused: owner.state.paused !== undefined,
        // A sibling of a paused feature takes no message: it would start its turn again.
        pausedFeature: parent ? undefined : pausedFeatureOf(owner.state, target),
        userIntervened:
          outbox.state.workers[callerId]?.userIntervened === true ||
          (!parent && outbox.state.workers[target.id]?.userIntervened === true),
      });
      return { thread: caller, state: owner.state, verdict };
    });

  const workerSendAuthority = (callerId: ThreadId, targetId: string) =>
    workerMessageRoute(callerId, targetId).pipe(
      Effect.map((route) =>
        route !== undefined && autonomyOf(route.state.charter) === "full" ? route : undefined,
      ),
    );

  const resolveWorkerParent: OrchestrationShape["resolveWorkerParent"] = (callerId) =>
    Effect.gen(function* () {
      const route = yield* workerMessageRoute(callerId);
      if (route === undefined)
        return yield* toolError(
          "message_orchestrator",
          refusal(
            "no_authority",
            `This worker has no current bound orchestrator: ${callerId}. The parent or worker membership may be missing, detached, archived or stale. Use list_threads/list_workers to inspect ownership, or ask the user to restore it.`,
          ),
        );
      if (!route.verdict.ok)
        return yield* toolError(
          "message_orchestrator",
          refusal(route.verdict.code, route.verdict.reason),
        );
      return {
        threadId: route.state.workspace.orchestratorThreadId!,
        workspaceId: route.state.workspace.id,
      };
    });

  const isWorkerSend: OrchestrationShape["isWorkerSend"] = (callerId, targetId) =>
    workerSendAuthority(callerId, targetId).pipe(
      // A pause/hold refuses delivery instead of asking the user to approve around it.
      Effect.map((authority) => authority !== undefined),
    );

  const requireWorkerSendAuthority = (callerId: ThreadId, targetId: ThreadId) =>
    Effect.gen(function* () {
      const authority = yield* workerSendAuthority(callerId, targetId);
      if (authority === undefined) {
        return yield* toolError(
          "send_message",
          refusal(
            "no_authority",
            "These threads are no longer a current worker and its bound parent or sibling in the same Full Auto workspace. Retry the call to request approval.",
          ),
        );
      }
      if (!authority.verdict.ok)
        return yield* toolError(
          "send_message",
          refusal(authority.verdict.code, authority.verdict.reason),
        );
      return authority;
    });

  const requireSendAuthority = (callerId: ThreadId, targetId: ThreadId) =>
    Effect.gen(function* () {
      return (
        (yield* authorityOf(callerId)) ?? (yield* requireWorkerSendAuthority(callerId, targetId))
      );
    });

  // ---------------------------------------------------------------------------------------
  // Feature cards
  // ---------------------------------------------------------------------------------------

  /** One reconcile at a time per workspace, so two watchers never give one change two versions. */
  const cardsLock = makeKeyedLock<WorkspaceId>();

  // ---------------------------------------------------------------------------------------
  // Waking and delivery
  // ---------------------------------------------------------------------------------------

  /** A thread of the workspace's tree that is being rate limited, if any. */
  const retryingIn = (workspaceId: WorkspaceId) =>
    [...retrying].find(
      (threadId) =>
        orchestrators.get(threadId) === workspaceId ||
        workerWorkspaces.get(threadId) === workspaceId,
    );

  // ---------------------------------------------------------------------------------------
  // Workspaces and the orchestrator thread
  // ---------------------------------------------------------------------------------------

  const projectsOf = (ids: ReadonlyArray<ProjectId>) =>
    Effect.gen(function* () {
      const known = new Map((yield* store.listProjects).map((p) => [p.id, p]));
      const found: Array<Project> = [];
      for (const id of ids) {
        const project = known.get(id);
        if (project === undefined) return yield* new NotFound({ entity: "project", id });
        found.push(project);
      }
      return found;
    });

  const reload = (threadId: ThreadId) => runtimes.reloadSession(threadId).pipe(Effect.ignore);

  /** `gateNeeds` with the facts only the store and the adapters have. */
  const needsUnderGate = (
    model: ModelRef,
    gate: OutwardGate | undefined,
    mode: PermissionMode,
    thread?: Thread,
  ) =>
    Effect.gen(function* () {
      const hasGatewayProfile =
        model.profileId !== undefined &&
        (yield* store.listProfiles).some((profile) => profile.id === model.profileId);
      return gateNeeds({
        model,
        gate,
        hasGatewayProfile,
        gateReady: yield* nativeGateReady(model.agent),
        codexHome:
          thread?.model.agent === model.agent &&
          thread.model.profileId === model.profileId &&
          thread.agentSessionId !== undefined
            ? (thread.codexHome ?? "user")
            : undefined,
        mode,
        gateHoldsInMode: gateHoldsIn(model.agent, mode),
      });
    });

  /** The workspace a worker reports into, while its orchestrator still holds the slot. */
  const listeningWorkspace = (worker: Thread) =>
    Effect.gen(function* () {
      if (worker.spawnedBy === undefined) return undefined;
      const state = yield* findWorkspace(worker.workspaceId);
      return state?.workspace.orchestratorThreadId === worker.spawnedBy.threadId
        ? state
        : undefined;
    });

  const orchestratorState = (thread: Thread) =>
    Effect.gen(function* () {
      if (thread.role !== "orchestrator") return undefined;
      const state = yield* findWorkspace(thread.workspaceId);
      return state?.workspace.orchestratorThreadId === thread.id ? state : undefined;
    });

  return {
    store,
    hub,
    runtimes,
    publisher,
    memory,
    checkouts,
    hosts,
    nativeGateReady,
    config,
    app,
    proc,
    limitReadings,
    appActivity,
    limitPoller,
    localChecks,
    composerPresence,
    creator,
    rosterHere,
    rosterAvailability,
    debounce,
    maxWait,
    signals,
    wakeTimers,
    requestTimers,
    handoffTimers,
    switchJobs,
    holdTimers,
    wakeAlarms,
    questionTimers,
    limitAlarms,
    pauseFence,
    pauseResumeTimers,
    heldReleases,
    heldLock,
    alarmLock,
    heldPending,
    plans,
    limitAsks,
    recoveryTimers,
    recovering,
    selfResumed,
    outboxLock,
    spawnLock,
    registryLock,
    claimedProjects,
    unjoinedRegistered,
    checkoutLock,
    checkoutKey,
    wakeLock,
    sendLock,
    taskStartupLock,
    workspaceLock,
    removalLock,
    handoffLock,
    reasons,
    reasonsAbout,
    firstReasonAt,
    diffless,
    carried,
    orchestrators,
    workerWorkspaces,
    parkedWorkers,
    retrying,
    openedInAuto,
    completedSeen,
    requestSeen,
    prMarks,
    changedFiles,
    extraFacts,
    extraBadges,
    conflictedSince,
    dragsTold,
    dragTimers,
    worktreesGone,
    bootWhilePaused,
    knownOverlaps,
    driftBefore,
    sends,
    workspacesChanged,
    orchestrationChanged,
    findWorkspace,
    workspaceStartupKeys,
    findThread,
    provideProc,
    sampleExtras,
    unreadableSignalled,
    signalUnreadable,
    setAside,
    releaseSetAside,
    readOutbox,
    updateOutbox,
    updateMemo,
    authorityOf,
    requireAuthority,
    authorityKeys,
    delegated,
    workerMessageRoute,
    workerSendAuthority,
    resolveWorkerParent,
    isWorkerSend,
    requireWorkerSendAuthority,
    requireSendAuthority,
    cardsLock,
    retryingIn,
    projectsOf,
    reload,
    needsUnderGate,
    listeningWorkspace,
    orchestratorState,
  };
});

/** The kit `makeOrchestrationKit` makes, which every part of the service takes. */
export type OrchestrationKit = Effect.Success<typeof makeOrchestrationKit>;
