// Membership: threads joining a workspace (`join_workspace`),
// the orchestrator adopting one (`adopt_thread`) with its pinned repos, detaching and removing a
// worker, and reopening a stored thread, with the admission check its role must pass.
import {
  effectiveCheckout,
  InvalidState,
  type Checkout,
  type ModelRef,
  type Project,
  type JoinTarget,
  type Thread,
  type ThreadId,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import { realPathOrOwned, samePath } from "@gram/git";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { repoIdentity } from "../../fs/folders.ts";
import { redactText } from "../../logging/redact.ts";
import { withOwnedBranch } from "../../git/worker-pr.ts";
import { checkedOut } from "../git-facts.ts";
import {
  emptyWorkerMemo,
  withoutWakes,
  withNotes,
  type StoredWake,
  type WorkerMemo,
} from "../outbox.ts";
import {
  admittedForRole,
  budgetVerdict,
  featureSlug,
  gateNeedsReason,
  joinedFeature,
  joinRefusal,
  outwardGateFor,
  refusal,
  userHoldLapsesAt,
  type PrWakeFired,
  type PendingReason,
  type WakeEvent,
} from "../rules.ts";
import {
  projectOfCheckout,
  workersOf,
  repoLabel,
  toolError,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import { type JoinInput, type AdoptPin, type OrchestrationShape } from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Projects } from "./projects.ts";

/** A path with its symlinks resolved, else as given: a project keeps the spelling it was opened by. */
const realPath = (path: string) => Effect.promise(() => realPathOrOwned(path));

/**
 * The project a checkout belongs to, by the resolved path of its repo: a worktree's `repoRoot` is
 * git's resolved main checkout, which a project opened through a symlink spells another way.
 */
const resolvedProjectOf = (projects: ReadonlyArray<Project>, checkout: Checkout) =>
  Effect.gen(function* () {
    const lexical = projectOfCheckout(projects, checkout);
    if (lexical !== undefined) return lexical;
    const root = yield* realPath(checkout.repoRoot ?? checkout.path);
    for (const project of projects) {
      if (samePath(yield* realPath(project.repoRoot ?? project.root), root)) return project;
      if (samePath(yield* realPath(project.root), root)) return project;
    }
    return undefined;
  });

/** The projects a thread holds checkouts in: its own, then each extra worktree's, once each. */
const heldProjectsOf = (
  projects: ReadonlyArray<Project>,
  own: Project,
  extras: ReadonlyArray<Checkout>,
) =>
  Effect.gen(function* () {
    const held: Array<Project> = [own];
    for (const extra of extras) {
      const other = yield* resolvedProjectOf(projects, extra);
      if (other !== undefined && !held.some((each) => each.id === other.id)) held.push(other);
    }
    return held;
  });

/** Whether `now` is what `pinned` named: the same folder on the same branch, adding no other repo. */
const samePin = (now: AdoptPin, pinned: AdoptPin) =>
  now.project === pinned.project &&
  samePath(now.worktree, pinned.worktree) &&
  now.folder === pinned.folder &&
  now.branch === pinned.branch &&
  Object.entries(now.outside).every(([id, identity]) => pinned.outside[id] === identity);

/** Which folder is at `path` (device and inode), so one swapped in at the same path is told apart. */
const folderIdentity = (path: string): string | undefined => {
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat?.isDirectory() === true ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    // Unreadable is no identity; the pin compares, and a mismatch refuses.
    return undefined;
  }
};

/** What membership takes from the rest of the service. */
export interface AdoptionDeps {
  readonly wakeFor: (
    workspaceId: WorkspaceId,
    event: WakeEvent,
    from?: Thread,
  ) => Effect.Effect<void>;
  readonly survey: LedgerWatch["survey"];
  readonly syncPrWatches: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly armAlarm: (
    workspaceId: WorkspaceId,
    alarm: StoredWake,
    after?: Duration.Duration,
    fired?: PrWakeFired,
  ) => Effect.Effect<void>;
  readonly armHold: (threadId: ThreadId, afterMs: number) => Effect.Effect<void>;
  readonly joinWorkspace: Projects["joinWorkspace"];
  readonly joinGroup: (
    workspaceId: WorkspaceId,
    feature: string,
    group: string,
  ) => Effect.Effect<void>;
  readonly wake: (
    workspaceId: WorkspaceId,
    reason: string,
    withoutDiff?: boolean,
    about?: Omit<PendingReason, "reason">,
  ) => Effect.Effect<void>;
}

/** Joining, adopting, detaching and reopening threads. */
export const makeAdoption = (kit: OrchestrationKit, deps: AdoptionDeps) => {
  const {
    workerWorkspaces,
    parkedWorkers,
    holdTimers,
    changedFiles,
    extraBadges,
    prMarks,
    updateOutbox,
    orchestrationChanged,
    store,
    runtimes,
    reload,
    findThread,
    creator,
    provideProc,
    publisher,
    needsUnderGate,
    findWorkspace,
    readOutbox,
    wakeAlarms,
    completedSeen,
    sampleExtras,
    signals,
    spawnLock,
    checkoutLock,
    checkoutKey,
    authorityKeys,
    authorityOf,
    requireAuthority,
    orchestrators,
    workspacesChanged,
  } = kit;
  const { wakeFor, survey, syncPrWatches, armAlarm, armHold, joinWorkspace, joinGroup, wake } =
    deps;

  const forgetWorker = (workspaceId: WorkspaceId, threadId: ThreadId) =>
    Effect.gen(function* () {
      workerWorkspaces.delete(threadId);
      parkedWorkers.delete(threadId);
      yield* FiberMap.remove(holdTimers, threadId);
      changedFiles.delete(threadId);
      extraBadges.delete(threadId);
      const marked = [...prMarks.keys()].filter(
        (key) => key === threadId || key.startsWith(`${threadId} `),
      );
      for (const key of marked) prMarks.delete(key);
      yield* updateOutbox(workspaceId, (outbox) => {
        if (outbox.workers[threadId] === undefined) return [outbox, undefined];
        const { [threadId]: _, ...workers } = outbox.workers;
        return [{ ...outbox, workers }, undefined];
      });
    });

  /** Records parked housekeeping or a live loss owed delivery, never an acknowledgment. */
  const workerRemoved = (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    parked: boolean,
    action: "closed" | "detached" | "moved",
  ) =>
    Effect.gen(function* () {
      yield* updateOutbox(workspaceId, (outbox) => [
        {
          ...outbox,
          archivedRemovals: parked
            ? [...new Set([...(outbox.archivedRemovals ?? []), threadId])]
            : (outbox.archivedRemovals ?? []).filter((id) => id !== threadId),
          ...(!parked
            ? {
                liveRemovals: [
                  ...(outbox.liveRemovals ?? []),
                  { id: randomUUID(), threadId, action },
                ],
              }
            : {}),
        },
        undefined,
      ]);
      yield* forgetWorker(workspaceId, threadId);
      yield* orchestrationChanged(workspaceId);
      yield* wakeFor(workspaceId, { type: "workerRemoved", worker: threadId, parked, action });
    });

  const detach: OrchestrationShape["detach"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      if (thread.spawnedBy === undefined) {
        return yield* new InvalidState({
          message: "This thread isn't an orchestrator's worker.",
          threadId,
        });
      }
      const workspaceId = thread.workspaceId;
      const detached = yield* runtimes.updateThread(threadId, (current) => {
        const { spawnedBy: _spawnedBy, workspaceId: _workspaceId, ...rest } = current;
        return rest;
      });
      if (workspaceId !== undefined) {
        yield* workerRemoved(workspaceId, threadId, thread.parked, "detached");
      }
      // Its open session still has the worker's prompt and `report`.
      yield* reopenForRole(detached);
      return detached;
    });

  /**
   * Reopens a thread whose part changed (it joined, moved or left a workspace) once it is idle,
   * so it opens with that part's prompt, tools, gate and connectors. A Codex app-server that still
   * has the thread loaded ignores `thread/resume`'s instructions and config, so a Codex thread
   * goes through the MCP-change restart onto a fresh server, as a changed connector set does.
   */
  const reopenForRole = (thread: Thread) =>
    thread.model.agent === "codex"
      ? runtimes
          .mcpConfigChanged({ agent: "codex", threads: [thread.id], always: true })
          .pipe(Effect.asVoid)
      : reload(thread.id);

  // ---------------------------------------------------------------------------------------
  // Joining a workspace
  // ---------------------------------------------------------------------------------------

  /**
   * Everything a join decides before it changes anything, read the same way by the card and by the
   * join: the orchestrator it joins, the workspace it leaves, its feature, the worktree it moves
   * into, and the repos outside the workspace. A refusal is its reason, in words for either caller.
   */
  const planJoin = (thread: Thread, state: WorkspaceState, input: JoinInput) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const holderId = state.workspace.orchestratorThreadId;
      const holder = holderId === undefined ? undefined : yield* findThread(holderId);
      if (holderId === undefined || holder === undefined) {
        return yield* Effect.fail(
          `The "${state.workspace.name}" workspace has no orchestrator open to follow it.`,
        );
      }
      const projects = yield* store.listProjects;
      let checkout = thread.checkout;
      let project = projects.find((each) => each.id === thread.projectId);
      let relocate: Checkout | undefined;
      if (input.worktree !== undefined && !samePath(input.worktree, thread.checkout.path)) {
        const found = yield* creator
          .prepare({ kind: "existingWorktree", path: input.worktree }, project?.root ?? "")
          .pipe(
            Effect.mapError((e) =>
              e._tag === "CheckoutInUse"
                ? `Another thread already works in ${input.worktree}.`
                : `${input.worktree} isn't a git worktree it can move into: ${e.message}`,
            ),
          );
        if (found.kind !== "worktree") {
          return yield* Effect.fail(
            `${input.worktree} is a repo's main checkout, not a worktree. A worker works in a worktree of its own.`,
          );
        }
        const owner = yield* resolvedProjectOf(projects, found);
        if (owner === undefined) {
          return yield* Effect.fail(
            `${input.worktree} is a worktree of ${found.repoRoot ?? "a repo"}, which Gram doesn't know yet. Ask the user to add that repo to the workspace (Add repository… on its menu) first.`,
          );
        }
        checkout = found;
        project = owner;
        relocate = found;
      }
      const refused = joinRefusal({
        thread: { ...thread, checkout },
        holder: holderId,
        workspaceId,
        inRepo:
          checkout.kind === "worktree" ||
          project?.repoRoot !== undefined ||
          (yield* repoIdentity(checkout.path)) !== undefined,
        relocating: relocate !== undefined,
      });
      if (refused !== undefined) return yield* Effect.fail(refused);
      if (project === undefined) return yield* Effect.fail("Its project is gone.");
      const held = yield* heldProjectsOf(projects, project, thread.extraCheckouts ?? []);
      const outside = held.filter((each) => !state.workspace.projectIds.includes(each.id));
      const threads = yield* store.listThreads;
      // What git has checked out now: a shell may have switched since the publisher last looked,
      // and `checkout.branch` is only what it was when the thread was made. A detached HEAD is no
      // branch; only when git can't be asked do the publisher and the record stand in, and
      // `verified` says so, which `adopt_thread`'s pin won't accept.
      const head = yield* provideProc(checkedOut(checkout.path), { kind: "unknown" } as const);
      const branch =
        head.kind === "branch"
          ? head.branch
          : head.kind === "detached"
            ? undefined
            : ((yield* publisher.stateFor(checkout.path))?.branch ?? checkout.branch);
      const feature = joinedFeature({
        requested: input.feature,
        branch,
        title: thread.title,
        workers: workersOf(threads, state)
          .filter((worker) => worker.id !== thread.id)
          .map((worker) => ({
            feature: worker.spawnedBy?.feature ?? "",
            branch: effectiveCheckout(worker).branch,
          })),
      });
      if (feature === undefined) {
        return yield* Effect.fail(
          `"${input.feature}" isn't a usable feature name. Use a short slug such as mail-trigger.`,
        );
      }
      const group = input.group === undefined ? undefined : featureSlug(input.group);
      if (input.group !== undefined && group === undefined) {
        return yield* Effect.fail(
          `"${input.group}" isn't a usable group name. Use a short slug such as release-0-4.`,
        );
      }
      // The workspace's gate is the one its sessions will open under, so a thread that couldn't
      // hold it would join only to be dead at its next open.
      const gate = outwardGateFor({
        thread: { ...thread, workspaceId, spawnedBy: { threadId: holderId, feature } },
        workspace: state.workspace,
        charter: state.charter,
      });
      const needs = yield* needsUnderGate(thread.model, gate, thread.mode, thread);
      if (needs !== undefined) {
        return yield* Effect.fail(
          `The "${state.workspace.name}" workspace asks before ${gate === "irreversible" ? "a merge" : "a push"}. ${gateNeedsReason(needs, thread.model.agent, thread.mode)} ${needs === "home" ? "Prepare its approval home and start a fresh session." : "Change its mode first."}`,
        );
      }
      const from =
        thread.workspaceId === undefined || thread.workspaceId === workspaceId
          ? undefined
          : yield* findWorkspace(thread.workspaceId);
      const { budget } = yield* survey(state, false);
      return {
        holder,
        from,
        feature,
        group,
        project,
        checkout,
        relocate,
        outside,
        branch,
        verified: head.kind !== "unknown",
        liveWorkers: budget.liveWorkers,
        overCap: !budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok,
      };
    });

  /**
   * Makes `thread` a worker of the workspace's orchestrator as `plan` says. Leaving another
   * workspace is that one's loss of a worker, told as one; what the thread carries is its memo
   * there (a hold, a scope, background work, but not the messages counted against that
   * orchestrator), its pending wakes, and everything on the thread itself: its PR bindings and
   * monitors, a merge intent and its hold. The session reloads once idle to take a worker's
   * prompt and tools.
   */
  const applyJoin = (
    thread: Thread,
    state: WorkspaceState,
    plan: Effect.Success<ReturnType<typeof planJoin>>,
    by: "user" | "orchestrator",
  ) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const now = yield* Clock.currentTimeMillis;
      const left = thread.workspaceId !== workspaceId ? thread.workspaceId : undefined;
      let memoThere: WorkerMemo | undefined;
      let wakes: ReadonlyArray<StoredWake> = [];
      if (left !== undefined) {
        const before = yield* readOutbox(left);
        memoThere = before.workers[thread.id];
        wakes = yield* updateOutbox(left, (outbox) => {
          const gone = (outbox.wakes ?? []).filter((each) => each.threadId === thread.id);
          return [withoutWakes(outbox, gone), gone];
        });
        for (const alarm of wakes) yield* FiberMap.remove(wakeAlarms, alarm.id);
        yield* syncPrWatches(left);
        if (thread.spawnedBy !== undefined) {
          yield* workerRemoved(left, thread.id, thread.parked, "moved");
        } else {
          yield* forgetWorker(left, thread.id);
          yield* orchestrationChanged(left);
        }
      }
      if (plan.relocate !== undefined) {
        yield* runtimes
          .moveCheckout(thread.id, plan.relocate)
          .pipe(Effect.mapError((e) => e.message));
      }
      const joined = yield* runtimes
        .updateThread(thread.id, (current) =>
          withOwnedBranch(
            {
              ...current,
              projectId: plan.project.id,
              workspaceId,
              spawnedBy: { threadId: plan.holder.id, feature: plan.feature },
            },
            plan.checkout.path,
            plan.branch,
          ),
        )
        .pipe(Effect.mapError((e) => e.message));
      workerWorkspaces.set(joined.id, workspaceId);
      if (joined.parked) parkedWorkers.add(joined.id);
      else parkedWorkers.delete(joined.id);
      if (joined.completedAt !== undefined) completedSeen.add(joined.id);
      const started = joined.agentSessionId !== undefined && joined.agentSessionUnused !== true;
      const memo: WorkerMemo =
        memoThere === undefined
          ? { ...emptyWorkerMemo(now), started }
          : { ...memoThere, messages: 0 };
      const where =
        left === undefined ? "" : ` from the "${plan.from?.workspace.name ?? "other"}" workspace`;
      yield* updateOutbox(workspaceId, (outbox) => [
        withNotes(
          {
            ...outbox,
            workers: { ...outbox.workers, [joined.id]: memo },
            ...(wakes.length === 0 ? {} : { wakes: [...(outbox.wakes ?? []), ...wakes] }),
          },
          by === "orchestrator"
            ? []
            : [
                `The user ${left === undefined ? "added" : "moved"} "${redactText(joined.title)}" [thread ${joined.id}] in ${plan.project.name}${where} to this workspace as your worker, for feature ${plan.feature}. You didn't brief it: read it (get_thread) before you message it, and follow its pull request like your own workers'.`,
              ],
        ),
        undefined,
      ]);
      for (const alarm of wakes) yield* armAlarm(workspaceId, alarm);
      if (wakes.length > 0) yield* syncPrWatches(workspaceId);
      const lapsesAt = userHoldLapsesAt(memo);
      if (lapsesAt !== undefined) yield* armHold(joined.id, lapsesAt - now);
      yield* joinWorkspace(state, plan.holder.id, plan.outside);
      if (plan.group !== undefined) yield* joinGroup(workspaceId, plan.feature, plan.group);
      yield* sampleExtras(joined);
      // Its PR and changed files are read from the git state the publisher already has, as for
      // a worker whose state just moved, so the ledger and the overlap check start with it.
      const git = yield* publisher.stateFor(plan.checkout.path);
      if (git !== undefined) yield* signals.offer({ type: "gitState", thread: joined, state: git });
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: now,
        kind: "join",
        data: {
          threadId: joined.id,
          feature: plan.feature,
          projectId: plan.project.id,
          by,
          ...(plan.branch === undefined ? {} : { branch: plan.branch }),
          ...(left === undefined ? {} : { from: left }),
          ...(plan.relocate === undefined ? {} : { worktree: plan.relocate.path }),
          ...(plan.group === undefined ? {} : { group: plan.group }),
        },
      });
      yield* orchestrationChanged(workspaceId);
      if (by === "user") {
        yield* wake(
          workspaceId,
          `the user ${left === undefined ? "added" : "moved in"} a worker`,
          true,
        );
      }
      yield* reopenForRole(joined);
      return joined;
    });

  /**
   * Runs a join under the spawn lock of the workspace it joins (`into`) and of the one the thread
   * leaves, then the checkout lock of the worktree it moves into, so neither workspace spawns or
   * joins meanwhile and no other workspace moves a thread into that worktree.
   */
  const joining = <A, E, R>(
    threadId: string,
    into: Effect.Effect<ReadonlyArray<string>>,
    worktree: string | undefined,
    effect: Effect.Effect<A, E, R>,
  ) =>
    underKeysOf(
      spawnLock,
      Effect.all([into, findThread(threadId)]).pipe(
        Effect.map(([keys, thread]) =>
          thread?.workspaceId === undefined ? keys : [...keys, thread.workspaceId],
        ),
      ),
      // By the repository the worktree belongs to, as a spawn there keys it, read again once
      // held: a worktree made meanwhile then waits for the spawn that made it.
      worktree === undefined
        ? effect
        : underKeysOf(checkoutLock, checkoutKey(worktree).pipe(Effect.map((key) => [key])), effect),
    );

  const joinThread: OrchestrationShape["joinWorkspace"] = (threadId, workspaceId, input) =>
    joining(
      threadId,
      Effect.succeed([workspaceId]),
      input.worktree,
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const state = yield* store.getWorkspace(workspaceId);
        const refuse = (message: string) => new InvalidState({ message, threadId });
        const plan = yield* planJoin(thread, state, input).pipe(Effect.mapError(refuse));
        if (plan.outside.length > 0 && input.addRepos !== true) {
          return yield* refuse(
            `${plan.outside.map((each) => each.name).join(" and ")} ${plan.outside.length === 1 ? "isn't one of" : "aren't"} the "${state.workspace.name}" workspace's repos. Add ${plan.outside.length === 1 ? "it" : "them"} with it, or add the thread to a workspace that has ${plan.outside.length === 1 ? "it" : "them"}.`,
          );
        }
        return yield* applyJoin(thread, state, plan, "user").pipe(Effect.mapError(refuse));
      }),
    );

  const joinTargets: OrchestrationShape["joinTargets"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      if (thread.role !== undefined) return [];
      const projects = yield* store.listProjects;
      const own = projects.find((each) => each.id === thread.projectId);
      const held =
        own === undefined ? [] : yield* heldProjectsOf(projects, own, thread.extraCheckouts ?? []);
      const targets: Array<JoinTarget> = [];
      for (const state of yield* store.listWorkspaces) {
        const holder = state.workspace.orchestratorThreadId;
        if (holder === undefined || (yield* findThread(holder)) === undefined) continue;
        if (thread.spawnedBy !== undefined && thread.workspaceId === state.workspace.id) continue;
        targets.push({
          workspaceId: state.workspace.id,
          name: state.workspace.name,
          adds: held
            .filter((each) => !state.workspace.projectIds.includes(each.id))
            .map((each) => each.name),
        });
      }
      return targets;
    });

  const describeAdopt: OrchestrationShape["describeAdopt"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      const thread = yield* findThread(input.threadId);
      const plain = `Take “${thread?.title ?? input.threadId}” on as a worker of this workspace`;
      if (authority === undefined || thread === undefined) return plain;
      const { state } = authority;
      const plan = yield* planJoin(thread, state, input).pipe(Effect.option);
      if (Option.isNone(plan)) return plain;
      const { feature, outside, from, relocate, overCap, liveWorkers } = plan.value;
      return [
        `Take “${thread.title}” on as a worker of the "${state.workspace.name}" workspace, for ${feature}`,
        from === undefined ? undefined : `moving it from the "${from.workspace.name}" workspace`,
        relocate === undefined ? undefined : `moving it into ${relocate.path}`,
        outside.length === 0
          ? undefined
          : `adding ${outside.map(repoLabel).join(" and ")} to the workspace`,
        overCap
          ? `one past the charter: ${liveWorkers} workers are live and it allows ${state.charter.maxConcurrentWorkers}`
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(", ");
    }).pipe(Effect.catchCause(() => Effect.succeed(`Take ${input.threadId} on as a worker`)));

  /** The pin of a plan, as `pinAdopt` hands it to the card and `adoptThread` holds it to. */
  const pinOf = (plan: Effect.Success<ReturnType<typeof planJoin>>) =>
    Effect.gen(function* () {
      const outside: Record<string, string> = {};
      for (const each of plan.outside) {
        outside[each.id] = (yield* repoIdentity(each.repoRoot ?? each.root)) ?? "";
      }
      const folder = folderIdentity(plan.checkout.path);
      return {
        project: plan.project.id,
        worktree: plan.checkout.path,
        ...(folder === undefined ? {} : { folder }),
        ...(plan.branch === undefined ? {} : { branch: plan.branch }),
        outside,
      } satisfies AdoptPin;
    });

  const pinAdopt: OrchestrationShape["pinAdopt"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "adopt_thread";
      const { state } = yield* requireAuthority(tool, callerId);
      const thread = yield* findThread(input.threadId);
      if (thread === undefined) {
        return yield* toolError(tool, `No thread has the id ${input.threadId}.`);
      }
      const plan = yield* planJoin(thread, state, input).pipe(
        Effect.mapError((message) => toolError(tool, refusal("not_joinable", message))),
      );
      if (!plan.verified) {
        return yield* toolError(
          tool,
          refusal("not_joinable", `Git couldn't say what is checked out in ${plan.checkout.path}.`),
        );
      }
      return yield* pinOf(plan);
    });

  const adoptThread: OrchestrationShape["adoptThread"] = (callerId, input) =>
    joining(
      input.threadId,
      authorityKeys(callerId),
      input.worktree,
      Effect.gen(function* () {
        const tool = "adopt_thread";
        const { state } = yield* requireAuthority(tool, callerId);
        if (state.paused !== undefined) {
          return yield* toolError(
            tool,
            refusal(
              "paused",
              `Orchestration is paused (${state.paused.reason}), so no thread is taken on. Only the user can resume it; end your turn.`,
            ),
          );
        }
        const thread = yield* findThread(input.threadId);
        if (thread === undefined) {
          return yield* toolError(tool, `No thread has the id ${input.threadId}.`);
        }
        const refuse = (message: string) => toolError(tool, refusal("not_joinable", message));
        // The card was raised on this same plan; one read again now that the user has said yes
        // is what runs, so a thread that changed meanwhile is held to what it is now.
        const plan = yield* planJoin(thread, state, input).pipe(Effect.mapError(refuse));
        // A shell can swap the worktree named, or the thread move, while the card waits: what
        // runs must be what the user said yes to, or a repo they never saw would join.
        const now = yield* pinOf(plan);
        if (input.pinned === undefined || !plan.verified || !samePin(now, input.pinned)) {
          return yield* refuse(
            "What it would join with changed after the user was asked (its folder, its repo, its branch or the repos it adds), so nothing was taken on. Ask again if it is still wanted.",
          );
        }
        const joined = yield* applyJoin(thread, state, plan, "orchestrator").pipe(
          Effect.mapError(refuse),
        );
        return {
          threadId: joined.id,
          title: joined.title,
          feature: plan.feature,
          project: plan.project.name,
          ...(plan.branch === undefined ? {} : { branch: plan.branch }),
          worktree: plan.checkout.path,
          ...(plan.from === undefined ? {} : { movedFrom: plan.from.workspace.name }),
        };
      }),
    );

  const checkModelChange: OrchestrationShape["checkModelChange"] = (threadId, model) =>
    Effect.gen(function* () {
      const thread = yield* findThread(threadId);
      if (thread === undefined) return;
      yield* checkAdmitted(thread, model);
    });

  /**
   * Whether `thread`, on `model`, may still be what its role or `spawnedBy` makes it.
   * `asHolder` asks it of an orchestrator as the holder of its workspace's slot, which a reopen
   * is about to claim: the slot is empty until then, and the gate an empty slot gives is the
   * strictest one.
   */
  const checkAdmitted = (thread: Thread, model: ModelRef, asHolder = false) =>
    Effect.gen(function* () {
      const threadId = thread.id;
      if (thread.role !== undefined && !admittedForRole(model.agent, thread.role)) {
        return yield* new InvalidState({
          message:
            thread.role === "orchestrator"
              ? `This thread is a workspace's orchestrator, and ${model.agent} isn't admitted to orchestrate. Close it and open another to change that.`
              : `This thread is a memory dream, and ${model.agent} isn't admitted for one.`,
          threadId,
        });
      }
      if (thread.spawnedBy !== undefined && !admittedForRole(model.agent, "worker")) {
        return yield* new InvalidState({
          message: `This thread is an orchestrator's worker, and ${model.agent} isn't admitted as one. Detach it from its orchestrator first.`,
          threadId,
        });
      }
      // The same rule `spawn_worker` holds a new worker to, asked of the gate this thread's
      // sessions would open under on the new model: a change that passed here and then couldn't
      // open would leave a worker, or the orchestrator, dead until someone noticed.
      if (thread.role === "dream" || (thread.role === undefined && thread.spawnedBy === undefined))
        return;
      const state = yield* findWorkspace(thread.workspaceId);
      const gate = outwardGateFor({
        thread: { ...thread, model },
        workspace:
          asHolder && state !== undefined
            ? { ...state.workspace, orchestratorThreadId: thread.id }
            : state?.workspace,
        charter: state?.charter,
      });
      const needs = yield* needsUnderGate(model, gate, thread.mode, thread);
      if (needs !== undefined) {
        const who = thread.role === "orchestrator" ? "a workspace's orchestrator" : "a worker";
        return yield* new InvalidState({
          message: `This thread is ${who} that asks before ${gate === "irreversible" ? "a merge" : "a push"}. ${gateNeedsReason(needs, model.agent, thread.mode)} ${
            needs === "home"
              ? "Prepare the native approval home and start a fresh session, or choose a prepared gateway home."
              : "Change its mode first."
          }`,
          threadId,
        });
      }
    });

  /** `checkAdmitted` as a yes or no, for a reopen that falls back rather than refusing. */
  const admits = (thread: Thread, asHolder = false) =>
    checkAdmitted(thread, thread.model, asHolder).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );

  const reopen: OrchestrationShape["reopen"] = (stored, workers, create) =>
    Effect.gen(function* () {
      // A dream's thread is made by its dream and is read, never run again as one.
      if (stored.workspaceId === undefined || stored.role === "dream") {
        return { thread: yield* create({}) };
      }
      const state = yield* findWorkspace(stored.workspaceId);
      if (state === undefined) return { thread: yield* create({}), membership: "workspaceGone" };
      const workspaceId = state.workspace.id;
      const inWorkspace = { workspaceId };
      const admitted = yield* admits(stored, stored.role === "orchestrator");
      const holderId = state.workspace.orchestratorThreadId;
      const holder = holderId === undefined ? undefined : yield* findThread(holderId);

      if (stored.role === "orchestrator") {
        if (holder !== undefined && holder.id !== stored.id) {
          return { thread: yield* create(inWorkspace), membership: "slotTaken" };
        }
        if (!admitted) return { thread: yield* create(inWorkspace), membership: "notAdmitted" };
        // Its session policy asks for the slot, which can only be claimed once the row exists.
        const made = yield* create({ ...inWorkspace, role: "orchestrator", deferOpen: true });
        if (!(yield* store.claimOrchestratorSlot(workspaceId, made.id))) {
          // An `open` won the slot meanwhile: a role outside its slot is inert, so it goes.
          const plain = yield* runtimes
            .updateThread(made.id, ({ role: _role, ...rest }) => rest)
            .pipe(Effect.orElseSucceed(() => made));
          return { thread: plain, membership: "slotTaken" };
        }
        orchestrators.set(made.id, workspaceId);
        const relinked: Array<Thread> = [];
        for (const { threadId, feature } of workers) {
          const worker = yield* findThread(threadId);
          // Detached by the user since, or another orchestrator's now: not this one's to take.
          if (
            worker === undefined ||
            worker.workspaceId !== workspaceId ||
            worker.spawnedBy !== undefined ||
            worker.role !== undefined
          ) {
            continue;
          }
          // A plain thread meanwhile, its model may have moved where no worker is admitted.
          const spawnedBy = { threadId: made.id, feature };
          if (!(yield* admits({ ...worker, spawnedBy }))) continue;
          const linked = yield* runtimes
            .updateThread(threadId, (current) => ({ ...current, spawnedBy }))
            .pipe(Effect.option);
          if (Option.isNone(linked)) continue;
          workerWorkspaces.set(threadId, workspaceId);
          if (linked.value.parked) parkedWorkers.add(threadId);
          if (linked.value.completedAt !== undefined) completedSeen.add(threadId);
          relinked.push(linked.value);
          // Its open session was given a plain thread's tools when the close detached it.
          yield* reload(threadId);
        }
        if (relinked.length > 0) {
          yield* updateOutbox(workspaceId, (outbox) => [
            withNotes(outbox, [
              `The user closed you and reopened you with ⌘⇧T. These workers are yours again: ${relinked
                .map((worker) => `“${worker.title}” [thread ${worker.id}]`)
                .join(", ")}.`,
            ]),
            undefined,
          ]);
        }
        yield* workspacesChanged;
        yield* orchestrationChanged(workspaceId);
        yield* wake(workspaceId, "orchestrator reopened", relinked.length > 0);
        return { thread: made, membership: "restored" };
      }

      const spawnedBy = stored.spawnedBy;
      if (spawnedBy === undefined)
        return { thread: yield* create(inWorkspace), membership: "restored" };
      if (holder === undefined || holder.id !== spawnedBy.threadId) {
        return { thread: yield* create(inWorkspace), membership: "orchestratorGone" };
      }
      if (!admitted) return { thread: yield* create(inWorkspace), membership: "notAdmitted" };
      const made = yield* create({ ...inWorkspace, spawnedBy });
      // Its orchestrator closed while the row was being made, and the close cut links only from
      // the rows there were: cut this one too, as that close would have.
      const after = yield* findWorkspace(workspaceId);
      if (after?.workspace.orchestratorThreadId !== spawnedBy.threadId) {
        const detached = yield* runtimes
          .updateThread(made.id, ({ spawnedBy: _spawnedBy, ...rest }) => rest)
          .pipe(Effect.orElseSucceed(() => made));
        yield* reload(made.id);
        return { thread: detached, membership: "orchestratorGone" };
      }
      workerWorkspaces.set(made.id, workspaceId);
      if (made.parked) parkedWorkers.add(made.id);
      yield* updateOutbox(workspaceId, (outbox) => [
        withNotes(outbox, [
          `The user reopened “${made.title}” [thread ${made.id}] with ⌘⇧T after closing it. It is your worker on ${spawnedBy.feature} again.`,
        ]),
        undefined,
      ]);
      yield* orchestrationChanged(workspaceId);
      yield* wake(workspaceId, "a worker was reopened", true);
      return { thread: made, membership: "restored" };
    });

  return {
    workerRemoved,
    detach,
    joinThread,
    joinTargets,
    describeAdopt,
    pinAdopt,
    adoptThread,
    checkModelChange,
    reopen,
  };
};

/** What `makeAdoption` makes, for the parts whose `deps` take some of it. */
export type Adoption = ReturnType<typeof makeAdoption>;
