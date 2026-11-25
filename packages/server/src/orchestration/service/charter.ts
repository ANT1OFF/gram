import {
  autonomyOf,
  briefFooterOf,
  routineWhenText,
  InvalidState,
  connectorSetOf,
  type ConnectorSet,
  type OrchestratorCharter,
  type RoutineState,
  type Thread,
  type WorkspaceState,
  applyCharterWrites,
  withRoutineGenerations,
  withRoutineIds,
  settingsHold,
  type SettingsRequirement,
  type WorkspaceId,
  slotAgent,
  profileAllowsModel,
  profileModelRefusal,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { SettingsAuditEntry } from "../../persistence/thread-store.ts";
import { withNotes } from "../outbox.ts";
import {
  admittedForRole,
  gateNeedsReason,
  gateOfAutonomy,
  kindName,
  rosterText,
} from "../rules.ts";
import {
  workersOf,
  CHARTER_MOVED,
  ROUTE_AT_LIMIT_LINE,
  OTHER_WORKER_MODELS_LINE,
  WATCH_DEFAULT_BRANCH_LINE,
  footerLine,
  refuseConnectorEntries,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import type { OrchestrationShape } from "./shape.ts";
import type { Digests } from "./digests.ts";
import { randomUUID } from "node:crypto";
import type { OutboxState } from "../outbox.ts";
import { packingLine } from "../worker-packing.ts";

const routinesKey = (charter: Pick<OrchestratorCharter, "routines">): string =>
  JSON.stringify(charter.routines ?? []);

/**
 * The outbox without the run states of routines `charter` no longer has; the same outbox when
 * nothing goes. An unsettled run of one is let go with it: its worker carries on as the
 * orchestrator's. A routine turned off keeps its state, its claim included, so a run still going
 * is followed to its end; the routines engine clears its next run (`routines/routines.ts`).
 */
export const pruneRoutineRuns = (
  outbox: OutboxState,
  charter: Pick<OrchestratorCharter, "routines">,
): OutboxState => {
  const runs = outbox.routineRuns;
  if (runs === undefined) return outbox;
  const keys = new Set(
    (charter.routines ?? []).flatMap((routine) =>
      routine.id === undefined ? [] : [routine.id as string],
    ),
  );
  if (Object.keys(runs).every((key) => keys.has(key))) return outbox;
  const kept = Object.entries(runs).filter(([key]) => keys.has(key));
  const { routineRuns: _, ...rest } = outbox;
  return kept.length === 0 ? rest : { ...rest, routineRuns: Object.fromEntries(kept) };
};

/**
 * The outbox with one routine's run state changed by `change` (undefined: forgotten), and that
 * state: the same outbox when `change` leaves it as it was.
 */
export const withRoutineRun = (
  outbox: OutboxState,
  id: string,
  change: (before: RoutineState | undefined) => RoutineState | undefined,
): readonly [OutboxState, RoutineState | undefined] => {
  const before = outbox.routineRuns?.[id];
  const after = change(before);
  if (after === before) return [outbox, after];
  const { [id]: _gone, ...others } = outbox.routineRuns ?? {};
  const runs = after === undefined ? others : { ...others, [id]: after };
  const { routineRuns: _runs, ...rest } = outbox;
  return [Object.keys(runs).length === 0 ? rest : { ...rest, routineRuns: runs }, after];
};

const withIdsOf =
  (compute: (standing: OrchestratorCharter) => OrchestratorCharter | undefined) =>
  (standing: OrchestratorCharter) => {
    const next = compute(standing);
    return next === undefined ? undefined : withIds(standing, next);
  };

const withIds = (prior: OrchestratorCharter, charter: OrchestratorCharter): OrchestratorCharter => {
  const routines = withRoutineGenerations(
    prior.routines,
    withRoutineIds(prior.routines, charter.routines, randomUUID),
  );
  return routines === charter.routines || routines === undefined
    ? charter
    : { ...charter, routines };
};

const charterChangeNotes = (
  before: Pick<
    OrchestratorCharter,
    | "workerBriefFooter"
    | "routeAtLimit"
    | "otherWorkerModels"
    | "watchDefaultBranch"
    | "routines"
    | "workerPacking"
    | "workersPerMachine"
  >,
  after: OrchestratorCharter,
): ReadonlyArray<string> => {
  const notes: Array<string> = [];
  const footer = briefFooterOf(after);
  if (briefFooterOf(before) !== footer) {
    notes.push(
      footer === undefined
        ? "The user removed the worker brief footer: Gram appends nothing to briefs now, so put what a worker needs in its brief."
        : `The user changed your charter's ${footerLine(footer)}`,
    );
  }
  if ((before.routeAtLimit === true) !== (after.routeAtLimit === true)) {
    notes.push(
      after.routeAtLimit === true
        ? `The user turned on your charter's ${ROUTE_AT_LIMIT_LINE}.`
        : "The user turned off offering another worker model at a limit: spawns stop at limits as before, with no alternatives.",
    );
  }
  if (packingLine(before) !== packingLine(after)) {
    notes.push(
      `The user changed your charter's line on where workers run: ${packingLine(after) ?? "a spawn with no `sandbox` runs on your machine, and a machine's own cap applies"}. Workers already running stay where they are.`,
    );
  }
  if ((before.otherWorkerModels === true) !== (after.otherWorkerModels === true)) {
    notes.push(
      after.otherWorkerModels === true
        ? `The user turned on your charter's ${OTHER_WORKER_MODELS_LINE}.`
        : "The user turned off other worker models: spawn workers only on the charter's worker models now.",
    );
  }
  if ((before.watchDefaultBranch === true) !== (after.watchDefaultBranch === true)) {
    notes.push(
      after.watchDefaultBranch === true
        ? `The user turned on your charter's ${WATCH_DEFAULT_BRANCH_LINE}.`
        : "The user turned off watching the default branch after merges: you are no longer told when it turns red.",
    );
  }
  if (routinesKey(before) !== routinesKey(after)) {
    const on = (after.routines ?? []).filter((routine) => routine.off !== true);
    notes.push(
      on.length === 0
        ? "The workspace's routines changed: none runs now."
        : `The workspace's routines changed. Now: ${on.map((routine) => `"${routine.name}" ${routineWhenText(routine)}`).join("; ")}.`,
    );
  }
  return notes;
};

/** What the charter takes from the rest of the service. */
export interface CharterDeps {
  readonly wake: Digests["wake"];
  /** Says a workspace's routines changed, so the routines engine looks again. */
  readonly routinesChanged: (workspaceId: WorkspaceId) => Effect.Effect<void>;
}

/** Writing and changing a workspace's charter. */
export const makeCharter = (kit: OrchestrationKit, deps: CharterDeps) => {
  const {
    store,
    findThread,
    taskStartupLock,
    workspaceStartupKeys,
    needsUnderGate,
    workspacesChanged,
    orchestrationChanged,
    rosterFor,
    updateOutbox,
    reload,
    runtimes,
  } = kit;
  const { wake } = deps;

  const checkCharter = (standing: WorkspaceState | undefined, charter: OrchestratorCharter) =>
    Effect.gen(function* () {
      const switchHolderNow = standing?.workspace.orchestratorThreadId;
      if (
        switchHolderNow !== undefined &&
        (yield* findThread(switchHolderNow))?.sessionSwitch !== undefined
      )
        return yield* new InvalidState({
          message: "Wait for the orchestrator switch before editing this workspace's charter.",
        });
      const outside = (charter.routines ?? []).find(
        (routine) =>
          routine.project !== undefined &&
          standing !== undefined &&
          !standing.workspace.projectIds.includes(routine.project),
      );
      if (outside !== undefined) {
        return yield* new InvalidState({
          message: `The routine "${outside.name}" names a project that isn't one of this workspace's.`,
        });
      }
      const orchestratorAgent = slotAgent(charter.orchestratorModel);
      if (orchestratorAgent !== undefined && !admittedForRole(orchestratorAgent, "orchestrator")) {
        return yield* new InvalidState({
          message: `${kindName(orchestratorAgent)} threads can't be orchestrators yet.`,
        });
      }
      const slot = charter.orchestratorModel;
      if (
        slot !== undefined &&
        "model" in slot &&
        switchHolderNow !== undefined &&
        JSON.stringify(slot) !== JSON.stringify(standing?.charter.orchestratorModel)
      ) {
        const profile = (yield* findThread(switchHolderNow))?.profile;
        if (profile !== undefined && !profileAllowsModel(profile, slot.model))
          return yield* new InvalidState({ message: profileModelRefusal(profile, slot.model) });
      }
      yield* refuseConnectorEntries(charter);
      if (standing === undefined) return;
      const gate = gateOfAutonomy(autonomyOf(charter));
      if (gateOfAutonomy(autonomyOf(standing.charter)) === undefined && gate !== undefined) {
        const holder = standing.workspace.orchestratorThreadId;
        const threads = yield* store.listThreads;
        const held = [
          ...threads.filter((thread) => thread.id === holder),
          ...workersOf(threads, standing).filter(
            (worker) => !worker.parked && worker.completedReason === undefined,
          ),
        ];
        const inTheWay: Array<{ readonly thread: Thread; readonly why: string }> = [];
        for (const thread of held) {
          const needs = yield* needsUnderGate(thread.model, gate, thread.mode, thread);
          if (needs !== undefined) {
            inTheWay.push({
              thread,
              why: gateNeedsReason(needs, thread.model.agent, thread.mode),
            });
          }
        }
        if (inTheWay.length > 0) {
          const names = inTheWay.map(({ thread }) => `“${thread.title}”`).join(", ");
          const whys = [...new Set(inTheWay.map(({ why }) => why))].join(" ");
          return yield* new InvalidState({
            message: `Autonomy can't go from full to ${autonomyOf(charter)} yet, because ${names} couldn't ask before a push. ${whys} Prepare their native approval home and start fresh sessions, choose a prepared gateway home or a mode that can ask, detach them, or let them finish, and then change it.`,
          });
        }
      }
    });

  const afterCharter = (
    workspaceId: WorkspaceId,
    state: WorkspaceState,
    prior: OrchestratorCharter,
  ) =>
    Effect.gen(function* () {
      const before = autonomyOf(prior);
      const rosterBefore = prior.workerModels;
      const connectorsBefore: ConnectorSet | undefined = connectorSetOf(prior);
      const charter = state.charter;
      const holder = state.workspace.orchestratorThreadId;
      if (
        holder !== undefined &&
        JSON.stringify(rosterBefore ?? []) !== JSON.stringify(charter.workerModels ?? [])
      ) {
        const thread = yield* findThread(holder);
        if (thread !== undefined) {
          const here = yield* rosterFor(thread, charter);
          const note = rosterText(
            "The user changed your worker models. From now on, pick from these (agent:model, then what the user wants it used for):",
            here.roster,
            here.unavailable,
            here.catalogue,
          );
          yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);
          yield* wake(workspaceId, "the user changed the worker models", true);
        }
      }
      if (routinesKey(prior) !== routinesKey(charter)) {
        yield* updateOutbox(workspaceId, (outbox) => [
          pruneRoutineRuns(outbox, charter),
          undefined,
        ]);
        yield* deps.routinesChanged(workspaceId);
      }
      const changed = charterChangeNotes(prior, charter);
      if (holder !== undefined && changed.length > 0) {
        yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, changed), undefined]);
        yield* wake(workspaceId, "the user changed how workers are briefed or routed", true);
      }
      const connectorsChanged =
        JSON.stringify(connectorsBefore) !== JSON.stringify(connectorSetOf(charter));
      if (before !== autonomyOf(charter)) {
        yield* Effect.logInfo("orchestration autonomy changed").pipe(
          Effect.annotateLogs({ workspaceId, from: before, to: autonomyOf(charter) }),
        );
      }
      if (before !== autonomyOf(charter) || connectorsChanged) {
        const threads = yield* store.listThreads;
        const held = [
          ...threads.filter((thread) => thread.id === holder),
          ...workersOf(threads, state).filter((worker) => !worker.parked),
        ];
        const codex = connectorsChanged
          ? held.filter((thread) => thread.model.agent === "codex").map((thread) => thread.id)
          : [];
        const anyCodex =
          connectorsChanged &&
          [...threads.filter((thread) => thread.id === holder), ...workersOf(threads, state)].some(
            (thread) => thread.model.agent === "codex",
          );
        for (const thread of held) if (!codex.includes(thread.id)) yield* reload(thread.id);
        if (anyCodex) {
          yield* runtimes.mcpConfigChanged({ agent: "codex", threads: codex, always: true });
        }
      }
    });

  const writeCharter = (
    workspaceId: WorkspaceId,
    compute: (standing: OrchestratorCharter) => OrchestratorCharter | undefined,
    audit?: SettingsAuditEntry,
    requires: ReadonlyArray<SettingsRequirement> = [],
  ) =>
    Effect.gen(function* () {
      const switchHolder = (yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId;
      if (
        switchHolder !== undefined &&
        (yield* findThread(switchHolder))?.sessionSwitch !== undefined
      )
        return yield* new InvalidState({
          message: "Wait for the orchestrator switch before editing this workspace's charter.",
        });

      const computeWithIds = withIdsOf(compute);
      const { state, auditSeq, prior } = yield* underKeysOf(
        taskStartupLock,
        workspaceStartupKeys(workspaceId),
        Effect.gen(function* () {
          const standing = yield* store.getWorkspace(workspaceId);
          const charter = computeWithIds(standing.charter);
          if (charter === undefined) return yield* new InvalidState({ message: CHARTER_MOVED });
          yield* checkCharter(standing, charter);
          let priorCharter: OrchestratorCharter = standing.charter;
          let committedState: WorkspaceState;
          let committedAudit: number | undefined;
          if (audit === undefined) {
            committedState = yield* store.updateWorkspace(workspaceId, (current) => {
              priorCharter = current.charter;
              return { ...current, charter };
            });
          } else {
            const done = yield* store.updateWorkspaceAudited(
              workspaceId,
              (current) => {
                const next = computeWithIds(current.charter);
                if (next === undefined) return undefined;
                priorCharter = current.charter;
                return { ...current, charter: next };
              },
              audit,
              (settings) => settingsHold(settings, requires),
            );
            if (done === undefined) return yield* new InvalidState({ message: CHARTER_MOVED });
            committedState = done.state;
            committedAudit = done.auditSeq;
          }
          return { state: committedState, auditSeq: committedAudit, prior: priorCharter };
        }),
      );
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
      yield* afterCharter(workspaceId, state, prior);
      return { state, auditSeq };
    });

  const setCharter: OrchestrationShape["setCharter"] = (workspaceId, charter) =>
    writeCharter(workspaceId, () => charter).pipe(Effect.map(({ state }) => state));

  const changeCharter: OrchestrationShape["changeCharter"] = (
    workspaceId,
    writes,
    audit,
    requires = [],
  ) =>
    Effect.uninterruptible(
      writeCharter(
        workspaceId,
        (standing) => applyCharterWrites(standing, writes),
        audit,
        requires,
      ),
    ).pipe(Effect.map(({ state, auditSeq }) => ({ state, auditSeq: auditSeq! })));

  const editCharter = (
    workspaceId: WorkspaceId,
    compute: (standing: OrchestratorCharter) => OrchestratorCharter | undefined,
  ) => writeCharter(workspaceId, compute).pipe(Effect.map(({ state }) => state));

  return { setCharter, changeCharter, checkCharter, afterCharter, editCharter };
};

/** What `makeCharter` makes, for the parts whose `deps` take some of it. */
export type Charter = ReturnType<typeof makeCharter>;
