// Spawning: `spawn_worker` and the user's start of a worker, from
// the approval an outside repo or a gated mode needs, through the gates near a limit, to the thread,
// its worktrees and its brief.

import { pinRefusal } from "../../embedding/worker-machines.ts";
import type { makeSpawnBreaker } from "../spawn-breaker.ts";
import {
  listedRow,
  AppToolError,
  autonomyOf,
  briefFooterOf,
  effectiveCheckout,
  type HostId,
  hostOf,
  LOCAL_HOST_ID,
  type Checkout,
  type ModelRef,
  type Project,
  type ProjectId,
  type ReasoningVariant,
  type Thread,
  type ThreadId,
  type UserInput,
  type WorkspaceId,
  aboveHigh,
  browserUseAllowed,
  hostListing,
  profileFilesOf,
  workerBrowserOn,
} from "@gram/contracts";
import { OWNERS_DIFFER, sameOwner } from "../../host/ownership.ts";
import { samePath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { heldCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { selectableModels } from "../../runtime/model-efforts.ts";
import { limitQueuedNote } from "../../runtime/limit-wait.ts";
import { finishedWorkers } from "../ledger.ts";
import { LOCAL_MACHINE_NAMES, namesThisMachine } from "../../host/paired-machines.ts";
import { type RouteOffer } from "../limit-pause.ts";
import { ASKED_BY_LOOK_BACK, askedByOf } from "../asked-by.ts";
import { findUserMessages } from "../../persistence/thread-store.ts";
import { emptyWorkerMemo, withNotes, workerThreadId, type WorkerMemo } from "../outbox.ts";
import {
  budgetVerdict,
  featureBranch,
  featureSlug,
  gateOfAutonomy,
  refusal,
  regroup,
  scopeOverlap,
  startModeFor,
  workerModelLabel,
  workerModelVerdict,
} from "../rules.ts";
import {
  projectOfCheckout,
  repoLabel,
  worktreesOf,
  workerModel,
  toolError,
  gateHoldsIn,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import {
  type RoutineAdmission,
  type SpawnWorkerInput,
  type HeldSpawn,
  type WorkerWorktree,
  type SpawnedWorker,
  type OrchestrationShape,
} from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import { admitMachineCodex, admitMachineGrok, admitMachineOpenCode } from "./machine-admission.ts";
import type { Projects } from "./projects.ts";
import type { HeldSpawns } from "./held-spawns.ts";
import { type HomeWorker, readHomeProfile } from "../../thread-profiles/home.ts";
import { makeOwnFolder } from "../../thread-profiles/own-folder.ts";
import { makeThreadId } from "../../runtime/runtime-state.ts";

const spawnedResult = (
  worker: Thread,
  projects: ReadonlyMap<ProjectId, Project>,
): SpawnedWorker => {
  const checkout = effectiveCheckout(worker);
  const alsoIn = worktreesOf(projects.values(), worker.extraCheckouts ?? []).map(
    ({ project, path, branch }): WorkerWorktree => ({
      project,
      worktree: path,
      ...(branch === undefined ? {} : { branch }),
    }),
  );
  return {
    threadId: worker.id,
    title: worker.title,
    feature: worker.spawnedBy?.feature ?? "",
    project: projects.get(worker.projectId)?.name ?? "",
    ...(checkout.branch === undefined ? {} : { branch: checkout.branch }),
    worktree: checkout.path,
    ...(checkout.base === undefined ? {} : { base: checkout.base }),
    ...(alsoIn.length === 0 ? {} : { alsoIn }),
    model: workerModelLabel(worker.model),
    mode: worker.mode,
  };
};

/** What spawning takes from the rest of the service. */

/**
 * Where a headless Gram puts a worker that names no machine: on its orchestrator's machine, so an
 * orchestration never spreads to a machine started for other work (another run's, say). None
 * when the orchestrator runs on this machine.
 */
export const orchestratorsMachine = (under: Pick<Thread, "checkout" | "currentCheckout">) => {
  const own = hostOf(effectiveCheckout(under));
  return own === LOCAL_HOST_ID ? undefined : own;
};

/**
 * Why a worker found again by its `clientRequestId` (a spawn a crash cut short, or a retry) may
 * not be used, or nothing: each machine it works on must be one `workerMachine` allows its
 * orchestrator now. On a headless Gram, this machine runs nothing, so a worker here is refused.
 */
export const recoveredMachineProblem = (
  worker: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">,
  context: {
    readonly own: HostId | undefined;
    readonly ownerOf: (hostId: HostId) => string | undefined;
    readonly headless: boolean;
    readonly machines: ReadonlyArray<NamedMachine>;
  },
): string | undefined => {
  const hosts = [
    ...new Set(
      [effectiveCheckout(worker), worker.checkout, ...(worker.extraCheckouts ?? [])].map(hostOf),
    ),
  ];
  for (const host of hosts) {
    const placed = workerMachine(
      host === LOCAL_HOST_ID
        ? "here"
        : (context.machines.find((machine) => machine.id === host) ?? { id: host }),
      {
        own: context.own,
        ownOwner: context.own === undefined ? undefined : context.ownerOf(context.own),
        headless: context.headless,
      },
    );
    if ("error" in placed) return placed.error;
    if ((placed.hostId ?? LOCAL_HOST_ID) !== host) return NOT_THIS_ORCHESTRATIONS_MACHINE;
  }
  return undefined;
};

/** A joined machine as a worker's placement reads it. */
export interface NamedMachine {
  readonly id: HostId;
  readonly owner?: string | undefined;
  readonly onDemand?: "personal" | "thread" | "worker" | undefined;
  /** The hosted server a desktop's worker host came through (`PairedMachine.via`). */
  readonly via?: string | undefined;
}

/**
 * Why a worker for a machine of its own isn't spawned on another model than the one it was given,
 * as one elsewhere would be with a warning: the machine runs only what its provider offers.
 */
export const sandboxSwapWords = (instead: { readonly of: string; readonly why: string }) =>
  `${instead.of} can't run there (${instead.why}), so no worker is spawned and no machine is asked for. A worker on a machine of its own runs the model it is given or none: name one that machine runs, or leave out sandbox to run it here on another model.`;

/** Why a worker can't go on a machine its orchestrator named. */
export const NOT_THIS_ORCHESTRATIONS_MACHINE =
  "A worker goes on its orchestrator's own machine, or on another machine of the same person's own. That one was started for other work.";
/** Why a worker named for this machine can't run here. */
export const RUNS_ON_ITS_ORCHESTRATORS_MACHINE =
  "This Gram runs no work itself: a worker runs on its orchestrator's machine. Omit machine.";

/**
 * Where a worker its orchestrator placed goes, or why not. `named` is the joined machine the
 * orchestrator named, `"here"` for this machine (`LOCAL_MACHINE_NAMES`), or nothing.
 *
 * - Its orchestrator's own machine always.
 * - Another machine only if it is the orchestrator's person's own (`onDemand: "personal"`, the
 *   same `owner`), or one started for that person's workers (`onDemand: "worker"`), or, on a Gram that runs work itself, a machine started for nothing in particular
 *   (no owner, no kind), or a worker host it asked a hosted server for (`via`). Never a machine started for other work (`onDemand: "thread"`, another
 *   run's), and on a headless Gram never an unmarked one either, which may be another run's from
 *   before machines said their kind.
 * - On a headless Gram, which runs no work itself, "here" is its orchestrator's machine.
 *
 * `undefined` keeps today's meaning: this machine, where it runs work.
 */
export const workerMachine = (
  named: NamedMachine | "here" | undefined,
  context: {
    readonly own: HostId | undefined;
    readonly ownOwner: string | undefined;
    readonly headless: boolean;
  },
): { readonly hostId: HostId | undefined } | { readonly error: string } => {
  const { own, ownOwner, headless } = context;
  if (named === undefined || named === "here") {
    if (!headless) return { hostId: undefined };
    return own === undefined ? { error: RUNS_ON_ITS_ORCHESTRATORS_MACHINE } : { hostId: own };
  }
  if (named.id === own) return { hostId: named.id };
  // The person's own machine, or one their orchestrator started for its workers.
  const personsOwn =
    (named.onDemand === "personal" || named.onDemand === "worker") &&
    named.owner !== undefined &&
    named.owner === ownOwner;
  const unmarked = named.onDemand === undefined && named.owner === undefined;
  // A worker host this Gram asked a hosted server for, with the desktop's sign-in: this Gram's own.
  const relayedWorker =
    named.onDemand === "worker" && named.via !== undefined && named.owner === undefined;
  if (personsOwn || ((unmarked || relayedWorker) && !headless)) return { hostId: named.id };
  return { error: NOT_THIS_ORCHESTRATIONS_MACHINE };
};

export interface SpawningDeps {
  readonly outsideWorkspace: Projects["outsideWorkspace"];
  readonly survey: LedgerWatch["survey"];
  readonly repoNames: Projects["repoNames"];
  readonly joinWorkspace: Projects["joinWorkspace"];
  readonly resolveProject: Projects["resolveProject"];
  readonly projectCall: Projects["projectCall"];
  readonly pausedSpawnGate: HeldSpawns["pausedSpawnGate"];
  readonly spawnBreaker: Effect.Success<ReturnType<typeof makeSpawnBreaker>>;
  readonly routeGate: HeldSpawns["routeGate"];
  readonly holdGate: HeldSpawns["holdGate"];
  readonly routeHeld: HeldSpawns["routeHeld"];
  readonly limitGate: HeldSpawns["limitGate"];
  readonly routePaused: HeldSpawns["routePaused"];
}

/** Spawning workers. */
/** A model's every field, effort (`variant`) and speed included, for telling two apart. */
const modelFields = (model: ModelRef) =>
  JSON.stringify([model.agent, model.model, model.profileId, model.variant, model.speed]);

export const makeSpawning = (kit: OrchestrationKit, deps: SpawningDeps) => {
  const {
    authorityOf,
    requireAuthority,
    workerModelsHere,
    spawnLock,
    checkoutLock,
    checkoutKey,
    authorityKeys,
    store,
    readOutbox,
    findThread,
    workerWorkspaces,
    parkedWorkers,
    updateOutbox,
    runtimes,
    sampleExtras,
    orchestrationChanged,
    retryingIn,
    nativeGateReady,
    autoHere,
    hosts,
    creator,
    checkouts,
    openedInAuto,
    joinedMachines,
    workerHosts,
    conversations,
    config,
    headless,
    ownerOf,
  } = kit;
  /**
   * The joined machine `named` (its name, any case, or its id), for `spawn_worker`'s `machine`;
   * `undefined` for this one, named by one of `LOCAL_MACHINE_NAMES`. A blank name is refused.
   */
  const machineNamed = (tool: string, named: string) =>
    Effect.gen(function* () {
      const wanted = named.trim().toLowerCase();
      const machines = joinedMachines();
      if (wanted === "")
        return yield* toolError(
          tool,
          refusal(
            "unknown_machine",
            `machine is blank. Name a joined machine, or omit machine (or say ${LOCAL_MACHINE_NAMES.map((n) => `“${n}”`).join(" or ")}) to run here.`,
          ),
        );
      if (namesThisMachine(wanted)) {
        const legacy = machines.filter((m) => m.name.trim().toLowerCase() === wanted);
        if (legacy.length > 0)
          return yield* toolError(
            tool,
            refusal(
              "ambiguous_machine",
              `“${named}” names both this machine and a joined machine. Use the joined machine's id (${legacy.map((m) => m.id).join(", ")}), or omit machine to run here.`,
            ),
          );
        return undefined;
      }
      const found = machines.filter(
        (m) => m.id.toLowerCase() === wanted || m.name.trim().toLowerCase() === wanted,
      );
      if (found.length === 1) return found[0]!.id as HostId;
      const known =
        machines.length === 0
          ? "No machine is joined to this Gram."
          : `Joined machines: ${machines.map((m) => m.name).join(", ")}.`;
      return yield* toolError(
        tool,
        refusal(
          found.length === 0 ? "unknown_machine" : "ambiguous_machine",
          found.length === 0
            ? `No joined machine is named “${named}”. ${known} Omit machine, or say “local”, to run on this machine.`
            : `More than one joined machine is named “${named}”; name it by its id.`,
        ),
      );
    });
  /**
   * The machine a worker is placed on: the one `named`, else this one (`undefined`). A headless
   * Gram, running no work itself, puts it on its orchestrator's machine, so an orchestration stays
   * on one machine and never spreads to a machine started for other work; an orchestrator with
   * none of its own takes the placement's machine. With none that can take it, the spawn is
   * refused with why.
   */
  const placedMachine = (tool: string, named: string | undefined, under: Thread) =>
    Effect.gen(function* () {
      const own = orchestratorsMachine(under);
      // What was named, as a machine's record or this machine, before the rule decides.
      const resolved = named === undefined ? undefined : yield* machineNamed(tool, named);
      const record =
        resolved === undefined
          ? named === undefined
            ? undefined
            : ("here" as const)
          : (joinedMachines().find((machine) => machine.id === resolved) ?? { id: resolved });
      // An orchestrator on this machine of a headless Gram names nothing: placement decides.
      if (headless !== undefined && own === undefined && record === undefined) {
        return yield* headless.machine.pipe(
          Effect.mapError((error) => toolError(tool, refusal("unknown_machine", error.message))),
        );
      }
      const placed = workerMachine(record, {
        own,
        ownOwner: own === undefined ? undefined : ownerOf(own),
        headless: headless !== undefined,
      });
      if ("error" in placed) return yield* toolError(tool, refusal("not_admitted", placed.error));
      const hostId = placed.hostId;
      // A worker goes on a machine of its orchestrator's person's, or of no one's under no one's
      // (`host/ownership.ts`): an orchestration never spans two people, so nothing that reaches
      // its workers has to ask whose each one is.
      if (!sameOwner(ownerOf, effectiveCheckout(under), { hostId }))
        return yield* toolError(tool, refusal("not_admitted", OWNERS_DIFFER));
      return hostId;
    });
  /** Whether a worker goes on a machine a hosted server started for this desktop (`via`). */
  const relayed = (hostId: HostId | undefined) =>
    hostId !== undefined && joinedMachines().find((m) => m.id === hostId)?.via !== undefined;
  /**
   * On such a machine a pin on one model's own id runs that model, as its host lists it: never
   * another that an alias of the same name runs there.
   */
  const relayedPinRefusal = (
    hostId: HostId | undefined,
    named: string | undefined,
    chosen: ModelRef,
  ): string | undefined => {
    if (hostId === undefined) return undefined;
    const machine = joinedMachines().find((m) => m.id === hostId);
    if (machine?.via === undefined) return undefined;
    const rows =
      chosen.agent === "codex"
        ? machine.codex?.models
        : chosen.agent === "opencode"
          ? machine.opencode?.models
          : machine.models;
    return rows === undefined ? undefined : pinRefusal(machine.name, rows, named, chosen);
  };
  const admitMachineModel = (tool: string, hostId: HostId | undefined, chosen: ModelRef) =>
    Effect.gen(function* () {
      if (hostId === undefined) return;
      const machine = joinedMachines().find((m) => m.id === hostId);
      const name = machine?.name ?? hostId;
      if (chosen.profileId !== undefined)
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${name} runs direct Claude, Codex, OpenCode and Grok Build sessions only. Choose a worker model on its own CLI, or spawn on this machine.`,
          ),
        );
      if (chosen.agent === "codex") return yield* admitMachineCodex(tool, machine, name, chosen);
      if (chosen.agent === "opencode")
        return yield* admitMachineOpenCode(tool, machine, name, chosen);
      if (chosen.agent === "grok") return yield* admitMachineGrok(tool, machine, name, chosen);
      if (machine?.tools?.some((entry) => entry.tool === "claude" && !entry.found))
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${name}: Claude Code is not installed. Install it there, then use Settings → Machines → Sign in before spawning a worker.`,
          ),
        );
      // A machine that reported its models runs only those: a pinned model it lacks is refused.
      if (machine?.models !== undefined && hostListing(machine.models, chosen.model) === undefined)
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${name}'s Claude Code doesn't list ${chosen.model}. Pick a model it lists, or update Claude Code there.`,
          ),
        );
      if (machine?.claudeSignIn === "notSignedIn")
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${name} is not signed in to Claude Code. Use Settings → Machines → Sign in, or run claude /login on that machine, before spawning a worker.`,
          ),
        );
    });
  // Tool resolution runs before any approval card. The handler repeats admission under its lock
  // because a roster or machine may change while a card is awaiting its answer.
  const checkSpawnMachine: OrchestrationShape["checkSpawnMachine"] = (callerId, input) =>
    Effect.gen(function* () {
      const { thread, state } = yield* requireAuthority("spawn_worker", callerId);
      const hostId = yield* placedMachine("spawn_worker", input.machine, thread);
      if (hostId === undefined) return;
      // A tier resolves against what that machine lists, as the spawn itself will.
      const chosen = yield* workerModel(
        "spawn_worker",
        thread,
        state.charter,
        input.model,
        yield* workerModelsHere(thread, state.charter, hostId),
      );
      if (relayed(hostId) && chosen.instead !== undefined)
        return yield* toolError(
          "spawn_worker",
          refusal("not_admitted", sandboxSwapWords(chosen.instead)),
        );
      const pinned = relayedPinRefusal(hostId, input.model, chosen.model);
      if (pinned !== undefined)
        return yield* toolError("spawn_worker", refusal("not_admitted", pinned));
      yield* admitMachineModel("spawn_worker", hostId, chosen.model);
    });
  // The model a spawn would run on, as it resolves here before any machine is placed: what a
  // machine started for the worker must run.
  const spawnModel: OrchestrationShape["spawnModel"] = (callerId, model) =>
    Effect.gen(function* () {
      const { thread, state } = yield* requireAuthority("spawn_worker", callerId);
      const chosen = yield* workerModel(
        "spawn_worker",
        thread,
        state.charter,
        model,
        yield* workerModelsHere(thread, state.charter, undefined),
      );
      if (chosen.instead !== undefined)
        return yield* toolError(
          "spawn_worker",
          refusal("not_admitted", sandboxSwapWords(chosen.instead)),
        );
      return chosen.model;
    });
  const {
    outsideWorkspace,
    survey,
    repoNames,
    joinWorkspace,
    resolveProject,
    projectCall,
    pausedSpawnGate,
    spawnBreaker,
    routeGate,
    holdGate,
    routeHeld,
    limitGate,
    routePaused,
  } = deps;

  const spawnNeedsApproval: OrchestrationShape["spawnNeedsApproval"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      // Without authority the handler refuses; a card first would only ask for nothing.
      if (authority === undefined) return false;
      const { state } = authority;
      const outside = yield* outsideWorkspace(
        "spawn_worker",
        [input.project, ...(input.alsoIn ?? [])],
        state,
      );
      if (outside.length > 0) return true;
      const { budget } = yield* survey(state, false);
      return !budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok;
    }).pipe(Effect.catchCause(() => Effect.succeed(true)));

  /** The live workers a spawn's card counted as it asked for one past the cap, by its input. */
  const cardCounts = new WeakMap<SpawnWorkerInput, number>();

  const describeSpawn: OrchestrationShape["describeSpawn"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      const named = [input.project, ...(input.alsoIn ?? [])];
      const repos = (
        authority === undefined ? named : yield* repoNames("spawn_worker", named, authority.state)
      ).join(", ");
      const on = input.machine === undefined ? "" : ` on ${input.machine}`;
      const plain = `Spawn a worker in ${repos}${on} for ${input.feature}: ${input.title}`;
      if (authority === undefined) return plain;
      const { state } = authority;
      const outside = yield* outsideWorkspace(
        "spawn_worker",
        [input.project, ...(input.alsoIn ?? [])],
        state,
      );
      if (outside.length > 0) {
        return `Add ${outside.map(repoLabel).join(" and ")} to the "${state.workspace.name}" workspace, and spawn a worker there for ${input.feature}: ${input.title}`;
      }
      const { budget } = yield* survey(state, false);
      if (budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok)
        return plain;
      cardCounts.set(input, budget.liveWorkers);
      return `${budget.liveWorkers} workers are live and the charter allows ${budget.maxConcurrentWorkers}. Allow one more, in ${repos} for ${input.feature}: ${input.title}`;
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(`Spawn a worker in ${input.project} for ${input.feature}`),
      ),
    );

  const checkWorkerModel: OrchestrationShape["checkWorkerModel"] = (callerId, model) =>
    Effect.gen(function* () {
      const tool = "set_thread_model";
      const { thread, state } = yield* requireAuthority(tool, callerId);
      // By its full label: the target's agent kind is fixed, and a bare id may be another kind's.
      const picked = yield* workerModel(
        tool,
        thread,
        state.charter,
        workerModelLabel(model),
        yield* workerModelsHere(thread, state.charter),
        model.profileId,
      );
      // A switch is to the model named or not at all; the default stands in only for a spawn.
      if (picked.instead !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${picked.instead.of} is unavailable here (${picked.instead.why}), so the worker stays on its model.`,
          ),
        );
      }
      // Off the roster, no faster or harder than such a model is allowed to run.
      if (picked.other) {
        const problem =
          model.speed === "fast"
            ? "a model off the charter's worker models runs at Standard speed only, so switch the worker to Standard first"
            : model.variant !== undefined && aboveHigh(model.variant)
              ? `a model off the charter's worker models runs at effort high or below, not ${model.variant}`
              : undefined;
        if (problem !== undefined)
          return yield* toolError(tool, refusal("not_admitted", `${problem}.`));
      }
    });

  /** The routines engine's admission, once it has started (`setRoutineAdmission`). */
  let routineAdmission: RoutineAdmission | undefined;
  const setRoutineAdmission = (admit: RoutineAdmission) =>
    Effect.sync(() => {
      routineAdmission = admit;
    });

  /** `spawn_worker`, an orchestrator's own spawn or a routine's launch. */
  const spawnFor = (
    callerId: ThreadId,
    given: SpawnWorkerInput,
  ): Effect.Effect<SpawnedWorker, AppToolError> => {
    let recorded: { key: string; id: ThreadId; workspaceId: WorkspaceId } | undefined;
    // A routine's run is admitted below, under the spawn lock, and spawned as admitted.
    let input = given;
    return underKeysOf(
      spawnLock,
      authorityKeys(callerId),
      projectCall(input.identities, (call) =>
        Effect.gen(function* () {
          const tool = "spawn_worker";
          const { thread: caller, state } = yield* requireAuthority(tool, callerId);
          const workspaceId = state.workspace.id;
          if (state.paused !== undefined) {
            return yield* toolError(
              tool,
              refusal(
                "paused",
                `Orchestration is paused (${state.paused.reason}), so no worker is spawned. Only the user can resume it; end your turn.`,
              ),
            );
          }
          // Every launch of a routine's worker, whichever way it came, is admitted here with the spawn
          // lock held: the routine as it is now, its values exactly, or no launch.
          if (input.routine !== undefined) {
            if (routineAdmission === undefined) {
              return yield* toolError(
                tool,
                refusal("routine_changed", "Routines haven't started yet, so no worker started."),
              );
            }
            const admitted = yield* routineAdmission(state, input);
            if ("refuse" in admitted) {
              return yield* toolError(tool, refusal("routine_changed", admitted.refuse));
            }
            input = admitted;
          }
          const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
          // A retry, or a call the last run crashed in, finds the worker by the id its request
          // gives it, and makes it under that id if the first attempt got no further.
          const requestedId =
            input.clientRequestId === undefined
              ? undefined
              : ((yield* readOutbox(workspaceId)).requests[input.clientRequestId] ??
                workerThreadId(workspaceId, input.clientRequestId));
          // Only the orchestrator's own spawn answers an ask; a routine's is its own.
          const askedBy =
            input.routine === undefined
              ? askedByOf(
                  yield* findUserMessages(store, caller.id, {
                    from: "newest",
                    count: ASKED_BY_LOOK_BACK,
                  }),
                )
              : undefined;
          const brief: UserInput = {
            text: input.brief,
            origin: {
              threadId: caller.id,
              title: caller.title,
              depth: 1,
              role: "orchestrator",
              ...(askedBy === undefined ? {} : { askedBy }),
            },
          };
          const existing = requestedId === undefined ? undefined : yield* findThread(requestedId);
          if (existing !== undefined) {
            if (existing.spawnedBy === undefined || existing.workspaceId !== workspaceId) {
              return yield* toolError(
                tool,
                refusal(
                  "not_your_worker",
                  `clientRequestId ${input.clientRequestId} made “${existing.title}” [thread ${existing.id}], which is no longer one of your workers. Use a new id for a new worker.`,
                ),
              );
            }
            // A spawn ends with its audit entry; without one, a crash cut short what comes after the
            // thread row, and this finishes it as the first call would have. With one, the worker is
            // left as it is now, a group the user moved it to since included.
            const finished = (yield* store.listOrchestrationEvents(
              workspaceId,
              existing.createdAt,
            )).some(
              (event) =>
                event.kind === "spawn" &&
                (event.data as { readonly threadId?: unknown } | null)?.threadId === existing.id,
            );
            // The worker found again is held to the same rule as a new one (`workerMachine`), on the
            // machines it really works on, before anything reaches it: a brief is never delivered to
            // a worker that sits on a machine its orchestrator may not use. A half-made one there is
            // closed, and the next call with a new id places a fresh one.
            const misplaced = recoveredMachineProblem(existing, {
              own: orchestratorsMachine(caller),
              ownerOf,
              headless: headless !== undefined,
              machines: joinedMachines(),
            });
            if (misplaced !== undefined) {
              if (!finished) yield* runtimes.close(existing.id).pipe(Effect.ignore);
              return yield* toolError(tool, refusal("not_admitted", misplaced));
            }
            // A routine's half-made worker is finished only as it was made: in the project it was made
            // in. One whose routine moved since is closed instead, and the next run admits a fresh one.
            if (!finished && input.routine !== undefined && existing.projectId !== input.project) {
              yield* runtimes.close(existing.id).pipe(Effect.ignore);
              return yield* toolError(
                tool,
                refusal(
                  "routine_changed",
                  `The routine "${input.routine.name}" moved to another project since its half-made worker “${existing.title}” was made, so that worker was closed and none started; the next run starts a fresh one.`,
                ),
              );
            }
            // Finished as admitted: the routine's model and name now, as a fresh run would have. A
            // model it can't switch to (another agent kind, one the session refuses) is the same as
            // a project moved: closed, and the next run starts a fresh one.
            if (!finished && input.routine !== undefined) {
              const picked = yield* workerModel(
                tool,
                caller,
                state.charter,
                input.model,
                yield* workerModelsHere(caller, state.charter),
              );
              // Every field of the model as admitted, effort (`variant`) and speed included.
              const sameModel = modelFields(existing.model) === modelFields(picked.model);
              if (!sameModel) {
                const switched = yield* runtimes.setModel(existing.id, picked.model).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (!switched) {
                  yield* runtimes.close(existing.id).pipe(Effect.ignore);
                  return yield* toolError(
                    tool,
                    refusal(
                      "routine_changed",
                      `The routine "${input.routine.name}" now runs on a model its half-made worker “${existing.title}” can't switch to, so that worker was closed and none started; the next run starts a fresh one.`,
                    ),
                  );
                }
              }
              if (existing.title !== input.title) {
                yield* runtimes
                  .updateThread(existing.id, (thread) => ({ ...thread, title: input.title }))
                  .pipe(Effect.ignore);
              }
            }
            workerWorkspaces.set(existing.id, workspaceId);
            if (existing.parked) parkedWorkers.add(existing.id);
            if (!finished) {
              const now = yield* Clock.currentTimeMillis;
              // The memo may already exist, made by the brief's turn start before the crash, so
              // the call's scope is filled in rather than the memo written whole.
              const scope =
                input.scope === undefined || input.scope.length === 0 ? undefined : input.scope;
              yield* updateOutbox(workspaceId, (outbox) => {
                const memo = outbox.workers[existing.id];
                if (memo !== undefined && (scope === undefined || memo.scope !== undefined)) {
                  return [outbox, undefined];
                }
                const next: WorkerMemo = {
                  ...(memo ?? emptyWorkerMemo(now)),
                  ...(scope === undefined ? {} : { scope }),
                };
                return [
                  { ...outbox, workers: { ...outbox.workers, [existing.id]: next } },
                  undefined,
                ];
              });
              const held = [existing.checkout, ...(existing.extraCheckouts ?? [])].flatMap(
                (checkout) => {
                  const project = projectOfCheckout(projects.values(), checkout);
                  return project === undefined ? [] : [project];
                },
              );
              yield* joinWorkspace(state, caller.id, held);
              const group = input.group === undefined ? undefined : featureSlug(input.group);
              if (group !== undefined) {
                yield* joinGroup(workspaceId, existing.spawnedBy.feature, group);
              }
              const briefed =
                (yield* store.hasMessages(existing.id, "user")) ||
                (yield* store.listQueue(existing.id)).length > 0;
              if (!briefed) {
                yield* runtimes
                  .send(existing.id, brief)
                  .pipe(Effect.mapError((e) => toolError(tool, e.message)));
              }
              yield* sampleExtras(existing);
              const [own, ...others] = held;
              yield* store.appendOrchestrationEvent(workspaceId, {
                at: now,
                kind: "spawn",
                data: {
                  threadId: existing.id,
                  feature: existing.spawnedBy.feature,
                  projectId: existing.projectId,
                  ...(existing.checkout.branch === undefined
                    ? {}
                    : { branch: existing.checkout.branch }),
                  ...(own === undefined || others.length === 0
                    ? {}
                    : { alsoIn: others.map((other) => other.id) }),
                  ...(group === undefined ? {} : { group }),
                },
              });
              yield* orchestrationChanged(workspaceId);
            }
            return { ...spawnedResult(existing, projects), existing: true as const };
          }
          const limited = retryingIn(workspaceId);
          if (limited !== undefined) {
            const name = (yield* findThread(limited))?.title || limited;
            return yield* toolError(
              tool,
              refusal(
                "rate",
                `"${name}" (${limited}) is being rate limited, so no worker is spawned until it clears. End your turn; a digest will follow.`,
              ),
            );
          }
          const slug = featureSlug(input.feature);
          const branch =
            input.branch?.trim() || (slug === undefined ? undefined : featureBranch(slug));
          if (slug === undefined || branch === undefined) {
            return yield* toolError(
              tool,
              refusal(
                "invalid_feature",
                `"${input.feature}" isn't a usable feature name. Use a short slug such as mail-trigger.`,
              ),
            );
          }
          if (state.pausedFeatures?.includes(slug) === true) {
            return yield* toolError(
              tool,
              refusal(
                "feature_paused",
                `The user paused feature ${slug}, so no worker is spawned for it. Only the user can resume it; a digest says when they do.`,
              ),
            );
          }
          const group = input.group === undefined ? undefined : featureSlug(input.group);
          if (input.group !== undefined && group === undefined) {
            return yield* toolError(
              tool,
              refusal(
                "invalid_group",
                `"${input.group}" isn't a usable group name. Use a short slug such as release-0-4.`,
              ),
            );
          }
          if (input.carded !== undefined) {
            const { budget } = yield* survey(state, false);
            const fits = budgetVerdict({
              charter: state.charter,
              liveWorkers: budget.liveWorkers,
            }).ok;
            if (!fits && budget.liveWorkers > input.carded) {
              return yield* toolError(
                tool,
                refusal(
                  "not_admitted",
                  `${budget.liveWorkers} workers are live now and the charter allows ${budget.maxConcurrentWorkers}, more than when the user said yes, so no worker started. Call spawn_worker again to ask the user for one more.`,
                ),
              );
            }
          }
          if (input.unattended === true || input.uncarded === true) {
            // Under the spawn lock, so a spawn racing this one is counted: what would need the
            // user's card is refused here, never asked, and never let through on a stale count.
            const unattended = input.unattended === true;
            const outside = yield* outsideWorkspace(
              tool,
              [input.project, ...(input.alsoIn ?? [])],
              state,
            );
            if (outside.length > 0) {
              const repos = outside.map(repoLabel).join(" and ");
              return yield* toolError(
                tool,
                unattended
                  ? refusal(
                      "unattended",
                      `It needs your approval to add ${repos} to the "${state.workspace.name}" workspace, so no worker started.`,
                    )
                  : refusal(
                      "outside_workspace",
                      `${repos} joined no workspace meanwhile, so no worker started. Call spawn_worker again to ask the user.`,
                    ),
              );
            }
            const { budget } = yield* survey(state, false);
            if (!budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok) {
              return yield* toolError(
                tool,
                unattended
                  ? refusal(
                      "unattended_cap",
                      `It needs your approval: ${budget.liveWorkers} workers are live and the charter allows ${budget.maxConcurrentWorkers}, so no worker started.`,
                    )
                  : refusal(
                      "not_admitted",
                      `${budget.liveWorkers} workers are live now and the charter allows ${budget.maxConcurrentWorkers}, so no worker started. Call spawn_worker again to ask the user for one more.`,
                    ),
              );
            }
          }
          const project = yield* resolveProject(tool, input.project, state, call);
          const others: Array<Project> = [];
          for (const named of input.alsoIn ?? []) {
            const other = yield* resolveProject(tool, named, state, call);
            if (other.id === project.id || others.some((known) => known.id === other.id)) {
              return yield* toolError(
                tool,
                refusal(
                  "duplicate_repo",
                  `alsoIn names ${other.name} twice, or as the worker's own project. Name each repo once: the main one as project, the rest in alsoIn.`,
                ),
              );
            }
            others.push(other);
          }
          // In the folder of a workspace a profile made: a folder of the worker's own, with the
          // profile's files, skills, server and level (`thread-profiles/home.ts`).
          const scratch =
            state.workspace.fromProfile === true && project.id === state.workspace.homeProjectId
              ? yield* readHomeProfile(project.root).pipe(
                  Effect.mapError((e) => toolError(tool, e.message)),
                )
              : undefined;
          if (scratch !== undefined && others.length > 0) {
            return yield* toolError(
              tool,
              refusal(
                "not_allowed",
                `A worker in ${project.name} works in a folder of its own, with no repository. Spawn it in a repository to give it others in alsoIn.`,
              ),
            );
          }
          const handed = [...new Set(input.conversations ?? [])];
          if (handed.length > 0) {
            const notOwned = handed.filter(
              (id) => !(caller.conversations ?? []).some((each) => each.id === id),
            );
            if (conversations === undefined || notOwned.length > 0) {
              return yield* toolError(
                tool,
                refusal(
                  "not_allowed",
                  conversations === undefined
                    ? "This server keeps no conversations to hand on."
                    : `You don't own the conversation ${notOwned.join(", ")}, so no worker started. Hand on only the conversations your messages came from.`,
                ),
              );
            }
          }
          const found = yield* survey(state, true);
          // At the concurrency cap, or outside the workspace: the approval gate asked the user
          // before this handler ran (`spawnNeedsApproval`), and they said yes to this one. Nothing
          // else about a spawn is rationed.
          const settings = yield* store.getSettings;
          // Where it runs, first: a tier resolves against what that machine lists.
          const hostId = yield* placedMachine(tool, input.machine, caller);
          // Without a roster the one model is the orchestrator's own, which it runs on.
          const picked = yield* workerModel(
            tool,
            caller,
            state.charter,
            input.model,
            yield* workerModelsHere(caller, state.charter, hostId),
          );
          const chosen = picked.model;
          // On a machine of its own (`sandbox`), a worker runs the model it was given or none: the
          // machine runs what its provider offers, so another model would be a silent swap.
          if (relayed(hostId) && picked.instead !== undefined)
            return yield* toolError(
              tool,
              refusal("not_admitted", sandboxSwapWords(picked.instead)),
            );
          const pinned = relayedPinRefusal(hostId, input.model, chosen);
          if (pinned !== undefined) return yield* toolError(tool, refusal("not_admitted", pinned));
          yield* admitMachineModel(tool, hostId, chosen);
          const mode = startModeFor(
            chosen.agent,
            settings,
            state.charter,
            yield* autoHere(
              chosen.agent,
              gateOfAutonomy(autonomyOf(state.charter)),
              chosen.profileId !== undefined,
            ),
          );
          const verdict = workerModelVerdict({
            model: chosen,
            autonomy: autonomyOf(state.charter),
            gateReady: yield* nativeGateReady(chosen.agent),
            hasGatewayProfile:
              chosen.profileId !== undefined &&
              (yield* store.listProfiles).some((profile) => profile.id === chosen.profileId),
            mode,
            gateHoldsInMode: gateHoldsIn(chosen.agent, mode),
          });
          if (!verdict.ok) return yield* toolError(tool, refusal(verdict.code, verdict.reason));
          // The efforts of the machine it runs on: a joined machine's own report where it gave
          // one, else this machine's list.
          const machineRecord =
            hostId === undefined ? undefined : joinedMachines().find((m) => m.id === hostId);
          const placedModels =
            chosen.agent === "codex"
              ? machineRecord?.codex?.models
              : chosen.agent === "opencode"
                ? machineRecord?.opencode?.models
                : chosen.agent === "grok"
                  ? machineRecord?.grok?.models
                  : machineRecord?.models;
          const efforts =
            input.effort === undefined
              ? []
              : placedModels !== undefined
                ? (hostListing(placedModels, chosen.model)?.efforts ?? [])
                : yield* selectableModels(store, hosts, chosen.agent, chosen.profileId).pipe(
                    Effect.map((models) => listedRow(models, chosen.model)?.efforts ?? []),
                    Effect.orElseSucceed((): ReadonlyArray<ReasoningVariant> => []),
                  );
          const warnings: Array<string> = [];
          if (picked.instead !== undefined) {
            warnings.push(
              `${picked.instead.of} is unavailable here (${picked.instead.why}), so this worker runs on ${workerModelLabel(chosen)}. Tell the user.`,
            );
          }
          // An entry that follows a tier keeps the recommendation's ceiling: an effort asked above
          // high runs at high, as it does on a model off the roster. A pinned entry takes any effort
          // its model lists.
          const ceiling = picked.follows || picked.other === true;
          const asked =
            ceiling && input.effort !== undefined && aboveHigh(input.effort)
              ? "high"
              : input.effort;
          if (asked !== input.effort) {
            warnings.push(
              picked.other === true
                ? `${picked.name} isn't one of the charter's worker models, and a model off them stops at effort high, so this worker runs at high rather than ${input.effort}.`
                : `${picked.name} follows the recommendation, whose effort stops at high, so this worker runs at high rather than ${input.effort}.`,
            );
          }
          const effort = asked !== undefined && efforts.includes(asked) ? asked : undefined;
          if (asked !== undefined && effort === undefined) {
            warnings.push(`${chosen.model} doesn't take effort ${asked}; it was left out.`);
          }
          // A charter entry comes whole, its effort included. Without a list the model is the
          // orchestrator's own, whose effort was chosen for orchestrating and isn't handed on.
          const { variant: _variant, ...bare } = chosen;
          const model: ModelRef =
            effort !== undefined
              ? { ...bare, variant: effort }
              : state.charter.workerModels === undefined && picked.other !== true
                ? bare
                : chosen;
          // The browser only where each consent it needs is on; otherwise it runs without.
          const browserProblem =
            input.browser !== true
              ? undefined
              : !workerBrowserOn(settings)
                ? "The user hasn't let workers use their browser (Settings › Workspaces), so this worker runs without it."
                : !browserUseAllowed(settings, model.agent)
                  ? `${model.agent === "claude" ? "Claude in Chrome" : "Codex computer use"} is off in Settings › Agents, so this worker runs without the browser.`
                  : model.agent === "codex" &&
                      gateOfAutonomy(autonomyOf(state.charter)) !== undefined
                    ? "Codex computer use isn't available under this workspace's outward gate, so this worker runs without the browser."
                    : undefined;
          if (browserProblem !== undefined) warnings.push(browserProblem);
          const browser = input.browser === true && browserProblem === undefined;

          const finished = finishedWorkers(found.features);
          const siblings = found.workers.filter(
            (worker) => worker.projectId === project.id && !finished.has(worker.id),
          );
          const readAlso: Array<string> = [];
          for (const id of input.readAlso ?? []) {
            const sibling = found.workers.find((worker) => worker.id === id);
            if (sibling === undefined) {
              return yield* toolError(
                tool,
                refusal(
                  "not_your_worker",
                  `readAlso names ${id}, which isn't one of your workers.`,
                ),
              );
            }
            // A folder on another machine isn't there to read.
            if (hostOf(effectiveCheckout(sibling)) !== (hostId ?? LOCAL_HOST_ID)) {
              return yield* toolError(
                tool,
                refusal(
                  "not_allowed",
                  `readAlso names “${sibling.title}” [thread ${id}], which runs on another machine than this worker would.`,
                ),
              );
            }
            readAlso.push(effectiveCheckout(sibling).path);
          }
          if (input.scope !== undefined && input.scope.length > 0) {
            for (const sibling of siblings) {
              const shared = scopeOverlap(
                input.scope,
                found.outbox.workers[sibling.id]?.scope ?? [],
              );
              if (shared.length > 0 && found.outbox.workers[sibling.id]?.scope !== undefined) {
                warnings.push(
                  `Advisory scope overlap with “${sibling.title}” [thread ${sibling.id}] on ${shared.map((path) => path || "the whole repo").join(", ")}; this does not establish a git conflict or coordination blocker.`,
                );
              }
            }
          }

          const request = {
            kind: "newWorktree" as const,
            branch,
            ...(input.base === undefined ? {} : { base: input.base }),
            ...(hostId === undefined ? {} : { hostId }),
          };
          const prepareIn = (repo: Project) =>
            creator.prepare(request, repo.root).pipe(
              Effect.catchTag("CheckoutInUse", (e) =>
                Effect.gen(function* () {
                  const user = (yield* store.listThreads).find((thread) =>
                    heldCheckoutPaths([thread]).some((held) => samePath(held, e.path)),
                  );
                  return yield* toolError(
                    tool,
                    user === undefined
                      ? `Branch ${branch} is already checked out in ${repo.name}: ${e.message}`
                      : `Branch ${branch} is already checked out by “${user.title}” [thread ${user.id}] in ${repo.name}. Message that worker, or pass another branch.`,
                  );
                }),
              ),
              Effect.mapError((e) => (e instanceof AppToolError ? e : toolError(tool, e.message))),
            );
          if (requestedId !== undefined && input.clientRequestId !== undefined) {
            const key = input.clientRequestId;
            recorded = { key, id: requestedId, workspaceId };
            yield* updateOutbox(workspaceId, (outbox) => [
              outbox.requests[key] === requestedId
                ? outbox
                : { ...outbox, requests: { ...outbox.requests, [key]: requestedId } },
              undefined,
            ]);
          }
          const spawnedBy = {
            threadId: caller.id,
            feature: slug,
            ...(input.routine === undefined
              ? {}
              : { routine: { id: input.routine.id, name: input.routine.name } }),
            ...(askedBy === undefined ? {} : { askedBy }),
            ...(input.placement === undefined ? {} : { placement: input.placement }),
          };
          // A worker in a profile's workspace: its own new folder on the machine it was placed on,
          // with no branch, held to the profile's server and level. A start that fails takes the
          // folder back.
          const inFolder = (home: HomeWorker) =>
            Effect.gen(function* () {
              const id = requestedId ?? makeThreadId();
              const folder = yield* makeOwnFolder(
                { dataDir: config.dataDir, hosts: workerHosts },
                id,
                profileFilesOf(home.profile),
                hostId,
              ).pipe(Effect.mapError((e) => toolError(tool, e.message)));
              return yield* runtimes
                .create({
                  id,
                  projectRoot: project.root,
                  checkout: folder.checkout,
                  model,
                  mode,
                  workspaceId,
                  spawnedBy,
                  profile: home.binding,
                  ...(readAlso.length === 0 ? {} : { additionalDirectories: readAlso }),
                  title: input.title.trim(),
                  input: brief,
                })
                .pipe(
                  Effect.mapError((e) => toolError(tool, e.message)),
                  Effect.tapError(() => folder.remove),
                );
            });
          // From git's check to the thread holding them, beside a spawn in another workspace that
          // shares these repos.
          const worker = yield* scratch !== undefined
            ? inFolder(scratch)
            : checkoutLock.withLocks(
                yield* Effect.forEach([project, ...others], (repo) => checkoutKey(repo.root)),
                Effect.gen(function* () {
                  const checkout = yield* prepareIn(project);
                  const extraCheckouts: Array<Checkout> = [];
                  for (const other of others) {
                    // No half-made worker: a repo that refuses takes the worktrees made so far with it.
                    const made = yield* prepareIn(other).pipe(
                      Effect.catch((e) =>
                        Effect.forEach([checkout, ...extraCheckouts], checkouts.discard, {
                          discard: true,
                        }).pipe(
                          Effect.andThen(
                            toolError(
                              tool,
                              `No worker was started, because ${other.name} couldn't give it a worktree: ${e.message}`,
                            ),
                          ),
                        ),
                      ),
                    );
                    extraCheckouts.push(made);
                  }
                  return yield* runtimes
                    .create({
                      projectRoot: project.root,
                      checkout,
                      model,
                      mode,
                      workspaceId,
                      spawnedBy,
                      extraCheckouts,
                      ...(browser ? { browser: true } : {}),
                      additionalDirectories: [
                        ...extraCheckouts.map((extra) => extra.path),
                        ...readAlso,
                      ],
                      title: input.title.trim(),
                      input: brief,
                      ...(requestedId === undefined ? {} : { id: requestedId }),
                    })
                    .pipe(Effect.mapError((e) => toolError(tool, e.message)));
                }),
              );

          workerWorkspaces.set(worker.id, workspaceId);
          if (mode === "auto") openedInAuto.add(worker.id);
          if (handed.length > 0 && conversations !== undefined) {
            // The worker exists: a conversation that couldn't move stays the orchestrator's, and
            // it is told so rather than losing the worker.
            yield* conversations.hand(caller.id, worker.id, handed).pipe(
              Effect.catch((e) =>
                Effect.sync(() => {
                  warnings.push(`The conversations stay yours: ${e.message}`);
                }),
              ),
            );
          }
          const now = yield* Clock.currentTimeMillis;
          yield* updateOutbox(workspaceId, (outbox) => {
            // The thread was live, its brief sent, before this records it: a message the user typed
            // into it meanwhile marked it (`onUserInput`), and that stands.
            const taken = outbox.workers[worker.id];
            return [
              withNotes(
                {
                  ...outbox,
                  workers: {
                    ...outbox.workers,
                    [worker.id]: {
                      ...emptyWorkerMemo(now),
                      ...(input.scope === undefined || input.scope.length === 0
                        ? {}
                        : { scope: input.scope }),
                      ...(taken?.userIntervened === true
                        ? {
                            userIntervened: true,
                            lastInputAt: taken.lastInputAt,
                            ...(taken.userInputAt === undefined
                              ? {}
                              : { userInputAt: taken.userInputAt }),
                          }
                        : {}),
                    },
                  },
                },
                [],
              ),
              undefined,
            ];
          });
          yield* joinWorkspace(state, caller.id, [project, ...others]);
          if (group !== undefined) yield* joinGroup(workspaceId, slug, group);
          yield* sampleExtras(worker);
          yield* store.appendOrchestrationEvent(workspaceId, {
            at: now,
            kind: "spawn",
            data: {
              threadId: worker.id,
              feature: slug,
              projectId: project.id,
              ...(scratch === undefined ? { branch } : {}),
              ...(others.length === 0 ? {} : { alsoIn: others.map((other) => other.id) }),
              ...(group === undefined ? {} : { group }),
            },
          });
          yield* orchestrationChanged(workspaceId);
          // A repo registered by this call isn't in the list read before it.
          for (const known of [project, ...others]) projects.set(known.id, known);
          // Spawned on a login at its limit: the brief waits in the worker's queue for the reset.
          const limitWait = (yield* findThread(worker.id))?.limitWait;
          return {
            ...spawnedResult(worker, projects),
            ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
            ...(limitWait === undefined ? {} : { queued: limitQueuedNote(limitWait, now) }),
          };
        }),
      ).pipe(
        // A spawn that failed before its thread existed leaves no request to find it by, so a
        // branch it gave up can go to another worker without stranding a retry of this one.
        Effect.onError(() => (recorded === undefined ? Effect.void : forgetRequest(recorded))),
      ),
    );
  };

  const forgetRequest = (request: { key: string; id: ThreadId; workspaceId: WorkspaceId }) =>
    Effect.gen(function* () {
      if ((yield* findThread(request.id)) !== undefined) return;
      yield* updateOutbox(request.workspaceId, (outbox) => {
        if (outbox.requests[request.key] !== request.id) return [outbox, undefined];
        const { [request.key]: _, ...requests } = outbox.requests;
        return [{ ...outbox, requests }, undefined];
      });
    });

  /** Puts a feature in a group, making the group if need be; a no-op when it is there already. */
  const joinGroup = (workspaceId: WorkspaceId, feature: string, group: string) =>
    store
      .updateWorkspace(workspaceId, (current) => {
        const before = current.groups ?? {};
        const groups = regroup(before, feature, group);
        return groups === before ? current : { ...current, groups };
      })
      .pipe(Effect.ignore);

  const spawnWorker: OrchestrationShape["spawnWorker"] = (callerId, given, carded) => {
    const named: SpawnWorkerInput =
      carded === false
        ? { ...given, uncarded: true }
        : carded === true
          ? { ...given, carded: cardCounts.get(given) ?? -1 }
          : given;
    // The machine is checked first, and a held brief keeps its id: a name that is wrong now is
    // refused now, not when the brief is released hours later.
    return (
      named.machine === undefined
        ? Effect.succeed(named)
        : machineNamed("spawn_worker", named.machine).pipe(
            Effect.map((id) => {
              const { machine: _machine, ...rest } = named;
              return id === undefined ? rest : { ...rest, machine: id };
            }),
          )
    ).pipe(Effect.flatMap((input) => spawnGated(callerId, input)));
  };

  const spawnGated: OrchestrationShape["spawnWorker"] = (callerId, input) =>
    pausedSpawnGate(callerId, input).pipe(
      Effect.andThen(spawnBreaker.gate(callerId, input)),
      Effect.flatMap((held): Effect.Effect<HeldSpawn | RouteOffer | undefined> =>
        held === undefined ? routeGate(callerId, input) : Effect.succeed(held),
      ),
      Effect.flatMap(
        (offer): Effect.Effect<SpawnedWorker | HeldSpawn | RouteOffer, AppToolError> =>
          offer !== undefined
            ? Effect.succeed(offer)
            : holdGate(callerId, input).pipe(
                Effect.flatMap(
                  (held): Effect.Effect<SpawnedWorker | HeldSpawn | RouteOffer, AppToolError> =>
                    held !== undefined
                      ? routeHeld(callerId, input, held)
                      : limitGate(callerId, input).pipe(
                          Effect.matchEffect({
                            onFailure: (refused) => routePaused(callerId, input, refused),
                            onSuccess: () => spawnFor(callerId, input),
                          }),
                        ),
                ),
              ),
      ),
    );

  const briefFooter: OrchestrationShape["briefFooter"] = (callerId) =>
    authorityOf(callerId).pipe(
      Effect.map((authority) =>
        authority === undefined ? undefined : briefFooterOf(authority.state.charter),
      ),
    );

  return {
    setRoutineAdmission,
    spawnNeedsApproval,
    checkSpawnMachine,
    spawnModel,
    describeSpawn,
    checkWorkerModel,
    spawnFor,
    joinGroup,
    spawnWorker,
    briefFooter,
  };
};
