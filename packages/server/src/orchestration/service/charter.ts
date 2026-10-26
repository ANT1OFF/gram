// The charter: writing a workspace's charter, what each change
// means for its threads, and telling the orchestrator what changed.
import {
  autonomyOf,
  briefFooterOf,
  InvalidState,
  connectorSetOf,
  type ConnectorSet,
  type OrchestratorCharter,
  type Thread,
  type WorkspaceState,
  applyCharterWrites,
  settingsHold,
  type SettingsRequirement,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { type SettingsAuditEntry } from "../../persistence/thread-store.ts";
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
  footerLine,
  allowedWorkerModels,
  refuseConnectorEntries,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { Digests } from "./digests.ts";

/** What an open orchestrator session is told when the footer or routing changes under it. */
const charterChangeNotes = (
  before: Pick<OrchestratorCharter, "workerBriefFooter" | "routeAtLimit">,
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
  return notes;
};

/** What the charter takes from the rest of the service. */
export interface CharterDeps {
  readonly wake: Digests["wake"];
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
    rosterAvailability,
    updateOutbox,
    reload,
    runtimes,
  } = kit;
  const { wake } = deps;

  /**
   * What a charter must pass to be stored over `standing` (absent for a new workspace), checked
   * where the user can still do something about it: no orchestrator switch under way, an
   * orchestrator model that may orchestrate, connector entries that can be kept, and no lower
   * autonomy a held thread couldn't open under.
   */
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
      const orchestratorModel = charter.orchestratorModel;
      if (
        orchestratorModel !== undefined &&
        !admittedForRole(orchestratorModel.agent, "orchestrator")
      ) {
        return yield* new InvalidState({
          message: `${kindName(orchestratorModel.agent)} threads can't be orchestrators yet.`,
        });
      }
      yield* refuseConnectorEntries(charter);
      if (standing === undefined) return;
      const gate = gateOfAutonomy(autonomyOf(charter));
      if (gateOfAutonomy(autonomyOf(standing.charter)) === undefined && gate !== undefined) {
        // The reload below would reopen each of these under a gate its adapter refuses to open
        // with, so the change is refused here, where the user can still do something about it.
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

  /**
   * What a stored charter change sets off, from `prior`, the charter it replaced: the roster,
   * footer and routing notes to an open orchestrator, and a reopen of the sessions a new autonomy
   * or connector set must reach.
   */
  const afterCharter = (
    workspaceId: WorkspaceId,
    state: WorkspaceState,
    prior: OrchestratorCharter,
  ) =>
    Effect.gen(function* () {
      const before = autonomyOf(prior);
      const rosterBefore = prior.workerModels;
      const connectorsBefore: ConnectorSet | undefined = connectorSetOf(prior);
      // What was stored: with an audit, the change applied to the charter as it stood then.
      const charter = state.charter;
      const holder = state.workspace.orchestratorThreadId;
      if (
        holder !== undefined &&
        // Every field of every entry: a profile or an effort changed is a roster changed, and what
        // the note says about it comes from what can run now.
        JSON.stringify(rosterBefore ?? []) !== JSON.stringify(charter.workerModels ?? [])
      ) {
        // The boot digest named the roster once; a session that is already open hears of the
        // change in its next digest rather than keep picking from the old list.
        const roster = yield* findThread(holder).pipe(
          Effect.map((thread) =>
            thread === undefined ? undefined : allowedWorkerModels(thread, charter),
          ),
        );
        if (roster !== undefined) {
          const note = rosterText(
            "The user changed your worker models. From now on, pick from these (agent:model, then what the user wants it used for):",
            roster,
            yield* rosterAvailability(charter),
          );
          yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);
          yield* wake(workspaceId, "the user changed the worker models", true);
        }
      }
      // The boot digest named the footer and routing once too; an open session hears of a change.
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
        // A session's gate, what its prompt says about asking and the connectors it loaded were
        // fixed when it opened. Reopen-when-idle: a running turn finishes on what it started with.
        const threads = yield* store.listThreads;
        const held = [
          ...threads.filter((thread) => thread.id === holder),
          ...workersOf(threads, state).filter((worker) => !worker.parked),
        ];
        // A Codex app-server that still has the thread loaded ignores `thread/resume`'s config,
        // so a new connector set reaches it only through a restart, onto a fresh server.
        // A parked or cold worker's server is kept too, so it is retired for them all the same.
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

  /**
   * The charter's one write path. `compute` makes the charter to store from the one standing; it
   * answers `undefined` when that charter has moved from what an approval was given against. With
   * `audit` (a change by chat) the charter is computed again inside the write's transaction, from
   * what is stored then, and its audit row goes in the same transaction: fields the change doesn't
   * name are never written back from an older read.
   */
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

      const { state, auditSeq, prior } = yield* underKeysOf(
        taskStartupLock,
        workspaceStartupKeys(workspaceId),
        Effect.gen(function* () {
          const standing = yield* store.getWorkspace(workspaceId);
          const charter = compute(standing.charter);
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
                const next = compute(current.charter);
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

  return { setCharter, changeCharter, checkCharter, afterCharter };
};

/** What `makeCharter` makes, for the parts whose `deps` take some of it. */
export type Charter = ReturnType<typeof makeCharter>;
