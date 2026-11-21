import type { OutwardGate } from "@gram/agents";
import { gateHoldsInMode as codexGateHoldsInMode } from "@gram/agents/codex";
import {
  AppToolError,
  autonomyOf,
  NotFound,
  customModelsOf,
  withCustomModels,
  listedRow,
  type AgentModel,
  type CatalogueRow,
  resolveModel,
  isLocalHost,
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
  type HostId,
  type RosterModel,
  type WorkerModel,
  type WorkspaceState,
  type WorkspaceId,
  type Checkout,
  type Autonomy,
  connectorEntryProblem,
  InvalidState,
  hostCandidates,
  hostListing,
  rosterModelHere,
} from "@gram/contracts";
import { Proc, samePathKey, samePath, basename, tryRepoRoots } from "@gram/git";
import * as Clock from "effect/Clock";
import type * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { appLabelOf, ServerConfig } from "../../config.ts";
import { type Coalescing, makeCoalescingQueue } from "../../events/backlog.ts";
import { Timers } from "../../embedding/timers.ts";
import { EventHub } from "../../events/event-hub.ts";
import { EventSink } from "../../embedding/event-sink.ts";
import { AppActivity } from "../../git/activity.ts";
import { LocalChecks } from "../../git/local-checks.ts";
import { WakeConditions } from "../../wakes/conditions.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { describePath } from "../../persistence/stored.ts";
import { withOwnedBranch } from "../../git/worker-pr.ts";
import { makeKeyedLock, type KeyedLock } from "../../git/keyed-lock.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { makeThreadCreator } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { availableHere } from "../../runtime/model-slots.ts";
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
  ADMITTED,
  admittedForRole,
  checkWorkerSend,
  gateNeeds,
  gateOfAutonomy,
  hasAuthority,
  isDelegated,
  kindName,
  refusal,
  workerModelUnavailable,
  hasAuto,
  startModeFor,
  type PrWakeFired,
  type PendingReason,
  type PrMark,
  type RosterCatalogue,
  type RosterUnavailable,
  userHoldLapsesAt,
  matchWorkerModel,
  closestWorkerModel,
  rosterNames,
  workerModelLabel,
} from "../rules.ts";
import { type OrchestrationShape } from "./shape.ts";
import { RemoteHosts } from "../../host/remote-hosts.ts";
import type { OwnerOf } from "../../host/ownership.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import { Conversations } from "../../embedding/conversations.ts";
import { workerMachinesOffered } from "./worker-machines-offered.ts";
import { heldBriefOf } from "../limit-pause.ts";
import { type PromptWorktree } from "../prompt.ts";

import { prMarkOf } from "./pr-mark.ts";

export { prMarkOf };

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

export const WATCH_DEFAULT_BRANCH_LINE =
  "the default branch of each workspace repo is watched after merges: when one turns red, a digest names the failed runs and the pull requests merged since it was green, with their workers. Don't hold other merges for it. Have a worker rerun the failed jobs once; if they pass, it was flaky. If not and one PR is named, have a worker open a revert PR and merge it with merge_when_ready, then have the PR's owner re-land the change with a fix in a new PR. When merged PRs in other repos depend on it (`depends_on`, or a version pinned to it), revert those first, in reverse order of merging. With several, have a worker bisect them (the failing job or the project's check at each midpoint) first. A merge someone else made is the user's to revert";

/** The charter's line for the worker brief footer, which quotes it. */
export const footerLine = (footer: string): string =>
  `worker brief footer: Gram appends the user's standing instructions below to every worker brief, marked as theirs, so don't repeat them in a brief:\n${footer
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n")}`;

const ownWorkerModel = (caller: Pick<Thread, "model">): ReadonlyArray<RosterModel> => [
  caller.model,
];

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

/** The charter line, and the setting's name in Settings, of `otherWorkerModels`. */
export const OTHER_WORKER_MODELS_LINE =
  "other worker models: allowed. Prefer the worker models below and their notes; go beyond them only when none fits the work or a council needs a model they lack, on a model a harness lists on the user's own login or on a gateway profile one of them uses, named as agent:model, at effort high or below. Say which model and why";
export const OTHER_WORKER_MODELS_SETTING =
  "Let the orchestrator use other models when none of these fit (Settings → Workspaces → Models)";

/**
 * A model off the roster `named` resolves to (`otherWorkerModels`): the model to run, at Standard
 * speed and high effort or below, or why the one it names can't run here. `undefined` when no
 * harness here lists it.
 */
export type OtherWorkerModel = { readonly model: ModelRef } | { readonly why: string } | undefined;

const atHigh = (efforts: ReadonlyArray<string> | undefined) => {
  const variant = (["high", "medium", "low"] as const).find((each) => efforts?.includes(each));
  return variant === undefined ? {} : { variant };
};

/** The charter's roster as it runs here (`rosterHere`), which `workerModel` picks from. */
export interface WorkerModelsHere {
  /** In the charter's order. */
  readonly roster: ReadonlyArray<RosterModel>;
  readonly unavailable: RosterUnavailable;
  /** Its agents' model catalogues, which name a model by alias, pinned id or display name. */
  readonly catalogue?: RosterCatalogue | undefined;
  /** Resolves a model off the roster, for a charter with `otherWorkerModels` on. */
  readonly other?:
    | ((named: string, profileId?: string | undefined) => Effect.Effect<OtherWorkerModel>)
    | undefined;
}

/**
 * `named` as one of the charter's worker models, of an agent kind admitted for workers. An entry
 * in `unavailable` is stood in for by the default (`matchWorkerModel`), which `instead` says.
 * With `otherWorkerModels` on, a name no entry matches may be a model off the roster (`other`),
 * on `profileId` when one is given.
 */
export const workerModel = (
  tool: string,
  caller: Pick<Thread, "model">,
  charter: OrchestratorCharter,
  named: string | undefined,
  here?: WorkerModelsHere,
  profileId?: string,
) =>
  Effect.gen(function* () {
    const allowed = here?.roster ?? ownWorkerModel(caller);
    const unavailable = here?.unavailable ?? new Map<number, string>();
    const catalogue = here?.catalogue;
    const match = matchWorkerModel(allowed, named, caller.model, unavailable, catalogue);
    const others = charter.otherWorkerModels === true ? here?.other : undefined;
    if (!match.ok && match.why === "unknown" && named !== undefined && others !== undefined) {
      const found = yield* others(named, profileId);
      if (found !== undefined && "why" in found) {
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${named} isn't one of the charter's worker models, and it can't run here: ${found.why}.`,
          ),
        );
      }
      if (found !== undefined) {
        return {
          model: found.model,
          name: workerModelLabel(found.model),
          follows: false,
          other: true,
          instead: undefined,
        };
      }
    }
    if (!match.ok) {
      const labels = rosterNames(allowed, catalogue);
      const closest =
        named === undefined || match.why !== "unknown"
          ? undefined
          : closestWorkerModel(allowed, named, catalogue);
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          match.why === "ambiguous"
            ? `${named} names more than one of the charter's worker models. Say which by its name: agent:model, or tier:<tier> for one that follows a tier. Allowed: ${labels}.`
            : match.why === "unavailable"
              ? `The selected worker model cannot run here, so no worker is spawned. ${match.reasons}. Tell the user.`
              : `The charter doesn't allow workers on ${named ?? "that model"}.${closest === undefined ? "" : ` Did you mean ${closest}?`} Allowed: ${labels}.${
                  charter.otherWorkerModels === true
                    ? " No harness here lists it either: name another as agent:model."
                    : ` Others need the workspace setting "${OTHER_WORKER_MODELS_SETTING}"; if none of these fits, ask the user to turn it on.`
                }`,
        ),
      );
    }
    if (!admittedForRole(match.model.agent, "worker")) {
      return yield* toolError(
        tool,
        refusal("not_admitted", `${match.model.agent} threads can't be workers yet.`),
      );
    }
    return {
      model: match.model,
      name: match.name,
      follows: match.follows,
      other: false,
      instead: match.instead,
    };
  });

/** What the consumer fiber works through, one at a time, in the order things happened. */
export type Signal =
  | { readonly type: "turnStart"; readonly thread: Thread; readonly turnId: TurnId }
  | { readonly type: "turnEnd"; readonly thread: Thread; readonly end: ObservedTurnEnd }
  | { readonly type: "quiet"; readonly thread: Thread; readonly active: boolean }
  | { readonly type: "userInput"; readonly thread: Thread }
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
  | { readonly type: "questionDue"; readonly workspaceId: WorkspaceId; readonly questionId: string }
  | {
      readonly type: "wakeAlarm";
      readonly workspaceId: WorkspaceId;
      readonly wakeId: string;
      /** The event of the PR it waits on that fired it; absent when its time did. */
      readonly fired?: PrWakeFired | undefined;
    }
  | { readonly type: "recoveryDue"; readonly workspaceId: WorkspaceId }
  | { readonly type: "limitReset"; readonly workspaceId: WorkspaceId }
  | { readonly type: "limitHeadroom" }
  | { readonly type: "dragCheck"; readonly threadId: ThreadId }
  | {
      readonly type: "handoffFailed";
      readonly workspaceId: WorkspaceId;
      readonly reason: SystemDeliveryFailure;
    }
  | { readonly type: "handoffRetry"; readonly workspaceId: WorkspaceId }
  | { readonly type: "contextLow"; readonly workspaceId: WorkspaceId }
  | { readonly type: "outboxUnreadable"; readonly workspaceId: WorkspaceId }
  | { readonly type: "boot" };

const CATALOGUE_WAIT = "3 seconds";

const NO_AUTHORITY =
  "This thread is not its workspace's orchestrator, so this tool does nothing here.";

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
  transitionOf: (signal) => {
    if (signal.type === "gitState") return gitTransition(signal.thread, signal.state);
    if (signal.type === "hub" && signal.event.type === "thread.upsert") {
      return upsertTransition(signal.event.thread);
    }
    return "";
  },
};

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
  const conditions = yield* WakeConditions;
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
  const autoHere = (
    kind: AgentKind,
    gate: OutwardGate | undefined,
    gateway = false,
  ): Effect.Effect<boolean> =>
    kind !== "codex" || gate !== undefined || gateway
      ? Effect.succeed(hasAuto(kind, { gate, autoReviewReady: false, gateway }))
      : hosts.get(kind).pipe(
          Effect.flatMap((host) => host.autoReviewReady ?? Effect.succeed(false)),
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.map((autoReviewReady) => hasAuto(kind, { gate, autoReviewReady })),
        );
  const config = yield* ServerConfig;
  const app = appLabelOf(config);
  const proc = yield* Effect.serviceOption(Proc);
  const limitReadings = yield* Effect.serviceOption(UsageLimitReadings);
  const remoteHosts = yield* Effect.serviceOption(RemoteHosts);
  const workerHosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
  const conversations = Option.getOrUndefined(yield* Effect.serviceOption(Conversations));
  const headless = workerHosts?.headless;
  const ownerOf: OwnerOf = workerHosts?.ownerOf ?? (() => undefined);
  const joinedMachines = () =>
    Option.isSome(remoteHosts) ? remoteHosts.value.list().filter((m) => m.confirmed) : [];
  const appActivity = yield* Effect.serviceOption(AppActivity);
  const limitPoller = yield* Effect.serviceOption(UsageLimitPoller);
  const localChecks = Option.getOrUndefined(yield* Effect.serviceOption(LocalChecks));
  const composerPresence = Option.getOrUndefined(yield* Effect.serviceOption(ComposerPresence));
  const eventSink = Option.getOrUndefined(yield* Effect.serviceOption(EventSink));
  const creator = makeThreadCreator({ store, checkouts, runtimes });
  const catalogueListings = yield* FiberSet.make();

  const rosterHere = (
    allowed: ReadonlyArray<WorkerModel>,
    charter: OrchestratorCharter,
    hostId?: HostId,
  ) =>
    Effect.gen(function* () {
      const profiles = yield* store.listProfiles;
      const settings = yield* store.getSettings;
      const own = new Map<AgentKind, ReadonlyArray<string> | undefined>();
      const catalogue = new Map<AgentKind, ReadonlyArray<CatalogueRow>>();
      const listings = new Map<AgentKind, ReadonlyArray<AgentModel>>();
      const catalogueOf = (agent: AgentKind) =>
        Effect.gen(function* () {
          if (own.has(agent)) return own.get(agent);
          const listing = (yield* hosts.get(agent)).listModels().pipe(Effect.option);
          const found =
            agent === "codex"
              ? yield* listing
              : yield* Fiber.join(yield* FiberSet.run(catalogueListings, listing)).pipe(
                  Effect.timeout(CATALOGUE_WAIT),
                  Effect.orElseSucceed(() => Option.none()),
                );
          const listed = Option.isNone(found)
            ? undefined
            : withCustomModels(found.value, customModelsOf(settings, agent));
          if (listed !== undefined) {
            catalogue.set(agent, listed);
            listings.set(agent, listed);
          }
          const ids = listed?.map((each) => each.id);
          own.set(agent, ids);
          return ids;
        }).pipe(Effect.orElseSucceed(() => undefined));
      const unavailableHere = (model: Pick<ModelRef, "agent" | "model" | "profileId">) =>
        Effect.gen(function* () {
          if (model.profileId === undefined) yield* catalogueOf(model.agent);
          const context = {
            profiles,
            ownModels: own.get(model.agent),
            customModels: customModelsOf(settings, model.agent).map((each) => each.id),
            gated: gateOfAutonomy(autonomyOf(charter)) !== undefined,
            gateReady: yield* nativeGateReady(model.agent),
          };
          const mode = startModeFor(
            model.agent,
            settings,
            charter,
            yield* autoHere(
              model.agent,
              gateOfAutonomy(autonomyOf(charter)),
              model.profileId !== undefined,
            ),
          );
          const cantAsk =
            admittedForRole(model.agent, "worker") &&
            gateNeeds({
              model,
              gate: gateOfAutonomy(autonomyOf(charter)),
              mode,
              hasGatewayProfile: true,
              gateHoldsInMode: gateHoldsIn(model.agent, mode),
            }) === "mode";
          return (
            workerModelUnavailable({ model, ...context }) ??
            (cantAsk
              ? `workers start in ${mode} mode here, in which a ${kindName(model.agent)} worker can't ask before a push; pick another worker mode in Settings → Workspaces, or set the workspace's autonomy to Full`
              : undefined)
          );
        });
      const roster: Array<RosterModel> = [];
      const unavailable = new Map<number, string>();
      const following = allowed.some((entry) => "tier" in entry);
      const placedMachine =
        hostId === undefined ? undefined : joinedMachines().find((m) => m.id === hostId);
      const placed = placedMachine?.models;
      const placedCodex = placedMachine?.codex?.models;
      const placedOpenCode = placedMachine?.opencode?.models;
      const available = !following
        ? {}
        : placed !== undefined
          ? {
              claude: hostCandidates(placed),
              ...(placedCodex === undefined ? {} : { codex: placedCodex }),
              ...(placedOpenCode === undefined ? {} : { opencode: placedOpenCode }),
            }
          : yield* availableHere(hosts);
      const machineName = placedMachine?.name;
      for (const [index, stored] of allowed.entries()) {
        const { entry, missing } = rosterModelHere(stored, available);
        if (missing !== undefined) {
          roster.push(entry);
          unavailable.set(index, missing);
          continue;
        }
        const machineList =
          entry.agent === "claude"
            ? placed
            : entry.agent === "codex"
              ? placedCodex
              : placedOpenCode;
        if (
          machineList !== undefined &&
          !("tier" in stored) &&
          entry.profileId === undefined &&
          hostListing(machineList, entry.model) === undefined
        ) {
          const cli =
            entry.agent === "claude"
              ? "Claude Code"
              : entry.agent === "codex"
                ? "Codex"
                : "OpenCode";
          roster.push(entry);
          unavailable.set(
            index,
            `${machineName ?? "that machine"}'s ${cli} doesn't list ${entry.model}; pick another model, or update ${cli} there`,
          );
          continue;
        }
        roster.push(entry);
        const why = yield* unavailableHere(entry);
        if (why !== undefined) unavailable.set(index, why);
      }
      const other = (named: string, profileId?: string): Effect.Effect<OtherWorkerModel> =>
        Effect.gen(function* () {
          const wanted = named.trim();
          const prefixed = /^([a-z]+):(.+)$/i.exec(wanted);
          const scoped = ADMITTED.worker.find((agent) => agent === prefixed?.[1]?.toLowerCase());
          const asked = scoped === undefined ? wanted : prefixed![2]!.trim();
          const found: Array<ModelRef> = [];
          for (const agent of scoped === undefined ? ADMITTED.worker : [scoped]) {
            if (profileId === undefined) {
              yield* catalogueOf(agent);
              const listed = resolveModel(listings.get(agent), asked);
              if (listed.ok) {
                found.push({
                  agent,
                  model: listed.row.id,
                  speed: "standard",
                });
              }
            }
            const used = new Set(
              roster.flatMap((entry) =>
                entry.agent === agent && entry.profileId !== undefined ? [entry.profileId] : [],
              ),
            );
            for (const profile of profiles) {
              if (!used.has(profile.id) || (profileId !== undefined && profile.id !== profileId))
                continue;
              const row = profile.models.find((each) => each.id === asked);
              if (row === undefined) continue;
              found.push({
                agent,
                model: row.id,
                profileId: profile.id,
                speed: "standard",
              });
            }
          }
          if (found.length === 0) return undefined;
          const agents = new Set(found.map((each) => each.agent));
          if (agents.size > 1) {
            return {
              why: `more than one harness lists it, so name it as agent:model (${[...agents].map((agent) => `${agent}:${asked}`).join(" or ")})`,
            };
          }
          let first: string | undefined;
          for (const model of found) {
            const why = yield* unavailableHere(model);
            if (why === undefined) {
              const efforts = yield* selectableModels(
                store,
                hosts,
                model.agent,
                model.profileId,
              ).pipe(
                Effect.map((models) => listedRow(models, model.model)?.efforts ?? []),
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
              );
              return { model: { ...model, ...atHigh(efforts) } };
            }
            first ??= why;
          }
          return { why: first! };
        });
      return {
        roster,
        unavailable: unavailable as RosterUnavailable,
        catalogue: catalogue as RosterCatalogue,
        other,
      };
    });

  const workerModelsHere = (
    caller: Pick<Thread, "model">,
    charter: OrchestratorCharter,
    hostId?: HostId,
  ): Effect.Effect<WorkerModelsHere | undefined> =>
    charter.workerModels !== undefined
      ? rosterHere(charter.workerModels, charter, hostId)
      : charter.otherWorkerModels !== true
        ? Effect.succeed(undefined)
        : rosterHere([], charter, hostId).pipe(
            Effect.map((here) => ({ ...here, roster: ownWorkerModel(caller) })),
          );

  const rosterFor = (caller: Pick<Thread, "model">, charter: OrchestratorCharter) =>
    charter.workerModels === undefined
      ? Effect.succeed({
          roster: ownWorkerModel(caller),
          unavailable: new Map<number, string>() as RosterUnavailable,
          catalogue: new Map() as RosterCatalogue,
        })
      : rosterHere(charter.workerModels, charter);

  const debounce = config.orchestrationDebounce ?? DEFAULT_WAKE_DEBOUNCE;
  const maxWait = Duration.times(debounce, WAKE_MAX_WAIT_WINDOWS);

  const signals = yield* makeCoalescingQueue("orchestration signals", SIGNAL_COALESCING);
  const wakeTimers = yield* FiberMap.make<WorkspaceId>();
  const requestTimers = yield* FiberMap.make<RequestId>();
  const handoffTimers = yield* FiberMap.make<WorkspaceId>();
  const switchJobs = yield* FiberMap.make<WorkspaceId>();
  const holdTimers = yield* FiberMap.make<ThreadId>();
  const wakeAlarms = yield* FiberMap.make<string>();
  const wakeClock = yield* Timers;
  const questionTimers = yield* FiberMap.make<string>();
  const limitAlarms = yield* FiberMap.make<WorkspaceId>();
  const pauseFence = makeKeyedLock<WorkspaceId>();
  const pauseResumeTimers = yield* FiberMap.make<WorkspaceId>();
  const heldReleases = yield* FiberSet.make();
  const heldLock = makeKeyedLock<string>();
  const alarmLock = makeKeyedLock<WorkspaceId>();
  const heldPending = new Set<WorkspaceId>();
  const plans = yield* Effect.serviceOption(ThreadPlans);
  const limitAsks = new Map<string, Deferred.Deferred<LimitHold["decision"] | undefined>>();
  const recoveryTimers = yield* FiberMap.make<WorkspaceId>();
  const recovering = new Map<WorkspaceId, number>();
  const selfResumed = new Set<WorkspaceId>();
  const outboxLock = makeKeyedLock<WorkspaceId>();
  const spawnLock = makeKeyedLock<string>();
  const registryLock = yield* Semaphore.make(1);
  const claimedProjects = new Map<ProjectId, number>();
  const unjoinedRegistered = new Set<ProjectId>();
  const checkoutLock = makeKeyedLock<string>();
  const wakeLock = makeKeyedLock<string>();
  const sendLock = makeKeyedLock<string>();
  const taskStartupLock = makeKeyedLock<string>();
  const workspaceLock = makeKeyedLock<ProjectId>();
  const removalLock = makeKeyedLock<WorkspaceId>();
  const handoffLock = makeKeyedLock<WorkspaceId>();

  const reasons = new Map<WorkspaceId, Set<string>>();
  const reasonsAbout = new Map<WorkspaceId, Map<string, PendingReason>>();
  const firstReasonAt = new Map<WorkspaceId, number>();
  const diffless = new Set<WorkspaceId>();
  const carried = new Map<TurnId, ReadonlyArray<string>>();
  const orchestrators = new Map<ThreadId, WorkspaceId>();
  const workerWorkspaces = new Map<ThreadId, WorkspaceId>();
  const parkedWorkers = new Set<ThreadId>();
  const retrying = new Set<ThreadId>();
  const openedInAuto = new Set<ThreadId>();
  const stopsAsked = new Set<ThreadId>();
  const completedSeen = new Set<ThreadId>();
  const requestSeen = new Map<RequestId, { readonly threadId: ThreadId; readonly at: number }>();
  const prMarks = new Map<string, PrMark | undefined>();
  const changedFiles = new Map<ThreadId, ChangedPaths & { readonly token: string }>();
  const extraFacts = new Map<string, ExtraCheckoutFacts>();
  const extraBadges = new Map<ThreadId, ReadonlyArray<PrStatus>>();
  const conflictedSince = new Map<ThreadId, number>();
  const dragsTold = new Set<string>();
  const dragTimers = yield* FiberMap.make<ThreadId>();
  const baseRechecks = yield* FiberMap.make<string>();
  const worktreesGone = new Set<ThreadId>();
  const bootWhilePaused = new Set<WorkspaceId>();
  const knownOverlaps = new Map<WorkspaceId, ReadonlySet<string>>();
  const driftBefore = new Map<ThreadId, ReadonlyMap<string, RootMark>>();
  const sends = new Map<string, ReadonlyArray<number>>();

  const workspacesChanged = hub.publish({ type: "workspaces.changed" });
  const orchestrationChanged = (workspaceId: WorkspaceId) =>
    hub.publish({ type: "orchestration.changed", workspaceId });

  const findWorkspace = (workspaceId: WorkspaceId | undefined) =>
    workspaceId === undefined
      ? Effect.succeed<WorkspaceState | undefined>(undefined)
      : store.getWorkspace(workspaceId).pipe(Effect.orElseSucceed(() => undefined));

  const workspaceStartupKeys = (workspaceId: WorkspaceId) =>
    findWorkspace(workspaceId).pipe(Effect.map((state) => startupKeysOf(workspaceId, state)));

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

  const sampleExtras = (thread: Thread) =>
    Effect.gen(function* () {
      let moved = false;
      for (const extra of thread.extraCheckouts ?? []) {
        if (!isLocalHost(extra)) continue;
        const key = samePathKey(extra.path);
        const before = extraFacts.get(key);
        const after = yield* provideProc(
          extraCheckoutFacts(extra.path),
          before ?? { ...noChangedPaths, repo: undefined },
        );
        extraFacts.set(key, after);
        if (withOwnedBranch(thread, extra, after.branch) !== thread) {
          yield* runtimes
            .updateThread(thread.id, (latest) => withOwnedBranch(latest, extra, after.branch))
            .pipe(Effect.ignore);
        }
        moved ||= before === undefined || !sameChangedPaths(before, after);
      }
      return moved;
    });

  const unreadableSignalled = new Set<WorkspaceId>();

  const signalUnreadable = (workspaceId: WorkspaceId, stored: StoredOutbox) =>
    stored._tag !== "unreadable" || unreadableSignalled.has(workspaceId)
      ? Effect.void
      : Effect.suspend(() => {
          unreadableSignalled.add(workspaceId);
          return signals.offer({ type: "outboxUnreadable", workspaceId }).pipe(Effect.asVoid);
        });

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

  const readOutbox = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const stored = readStoredOutbox(yield* store.getOutbox(workspaceId));
      yield* signalUnreadable(workspaceId, stored);
      return stored.state;
    });

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

  const noteStop: OrchestrationShape["noteStop"] = (callerId, targetId) =>
    delegated(callerId, targetId).pipe(
      Effect.map((own) => {
        if (own) stopsAsked.add(targetId);
      }),
    );

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
        !admittedForRole(caller.model.agent, "worker") ||
        caller.workspaceId === undefined ||
        caller.workspaceId !== target.workspaceId
      )
        return undefined;
      const owner = yield* authorityOf(caller.spawnedBy.threadId);
      if (owner === undefined || owner.state.workspace.id !== caller.workspaceId) return undefined;
      const parent = target.id === owner.thread.id;
      if (
        !parent &&
        (target.parked ||
          target.role !== undefined ||
          target.spawnedBy?.threadId !== owner.thread.id ||
          !admittedForRole(target.model.agent, "worker"))
      )
        return undefined;
      if (!parent) {
        const outbox = readStoredOutbox(yield* store.getOutbox(owner.state.workspace.id));
        if (outbox._tag !== "read" || outbox.state.workers[target.id] === undefined)
          return undefined;
      }
      const checked = checkWorkerSend({
        recentSends: [],
        now: yield* Clock.currentTimeMillis,
        paused: owner.state.paused !== undefined,
        pausedFeature: parent ? undefined : pausedFeatureOf(owner.state, target),
      });
      const verdict: typeof checked =
        checked.ok && owner.thread.parked
          ? {
              ok: false,
              code: "paused",
              reason:
                "Your orchestrator is archived, so its workers' messages wait until the user brings it back. Carry on with what you can, or end your turn.",
            }
          : checked;
      return { thread: caller, state: owner.state, verdict };
    });

  const workerSendAuthority = (callerId: ThreadId, targetId: string) =>
    workerMessageRoute(callerId, targetId);

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
            "These threads are no longer a current worker and its bound parent or sibling in the same workspace. Retry the call to request approval.",
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

  const cardsLock = makeKeyedLock<WorkspaceId>();

  const retryingIn = (workspaceId: WorkspaceId) =>
    [...retrying].find(
      (threadId) =>
        orchestrators.get(threadId) === workspaceId ||
        workerWorkspaces.get(threadId) === workspaceId,
    );

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
    joinedMachines,
    workerHosts,
    conversations,
    headless,
    ownerOf,
    store,
    hub,
    runtimes,
    publisher,
    conditions,
    memory,
    checkouts,
    hosts,
    nativeGateReady,
    autoHere,
    config,
    app,
    proc,
    limitReadings,
    appActivity,
    limitPoller,
    localChecks,
    composerPresence,
    eventSink,
    workerMachinesOffered: yield* workerMachinesOffered,
    creator,
    rosterHere,
    rosterFor,
    workerModelsHere,
    debounce,
    maxWait,
    signals,
    wakeTimers,
    requestTimers,
    handoffTimers,
    switchJobs,
    holdTimers,
    wakeAlarms,
    wakeClock,
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
    stopsAsked,
    noteStop,
    completedSeen,
    requestSeen,
    prMarks,
    changedFiles,
    extraFacts,
    extraBadges,
    conflictedSince,
    dragsTold,
    dragTimers,
    baseRechecks,
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
