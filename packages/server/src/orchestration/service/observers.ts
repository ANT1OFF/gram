// Observers: what the service does with each signal the runtime,
// the git publisher and the hub send, from turn starts and ends, context and limit waits, the user's
// input and git state, to drift, overlapping changes, dragging dependencies, requests that age and
// threads that come and go.
import {
  autonomyOf,
  effectiveCheckout,
  type BackgroundTask,
  type GitState,
  DEPENDENCY_DRAG_CONFLICT_MIN,
  prRefText,
  type Project,
  type RequestId,
  type LimitWait,
  type Thread,
  type ThreadId,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import { repoFromPrUrl, samePathKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { existsSync } from "node:fs";
import { branchPrOf } from "../../git/completion.ts";
import { isBadgeOf } from "../../git/extra-prs.ts";
import { redactText } from "../../logging/redact.ts";
import { releaseBatchAt } from "../../runtime/limit-wait.ts";
import { type ObservedTurnEnd } from "../../runtime/thread-runtimes.ts";
import {
  changedPaths,
  driftBetween,
  markRoot,
  noChangedPaths,
  type RootMark,
} from "../git-facts.ts";
import { contextPct, finishedWorkers, waitingOnAutomation, workerErrorOf } from "../ledger.ts";
import {
  outboxContextRearmed,
  wakesOf,
  withNotes,
  type BackgroundWork,
  type StoredHeldBrief,
} from "../outbox.ts";
import {
  contextNote,
  restartContinuation,
  restartNote,
  type RestartCost,
  modeAfterDowngrade,
  overlapPairs,
  requestWakeMs,
  USER_HOLD_IDLE_MS,
  userHoldLapsesAt,
  dependencyDragWhy,
  type WorkerFiles,
} from "../rules.ts";
import {
  projectOfCheckout,
  workersOf,
  prMarkOf,
  pausedFeatureOf,
  type OrchestrationKit,
} from "./kit.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Digests } from "./digests.ts";
import type { HandoffPart } from "./handoff.ts";
import type { Workers } from "./workers.ts";
import type { Pauses } from "./pauses.ts";
import type { Adoption } from "./adoption.ts";

/** The wake an orchestrator's limit wait leaves, which the digest its resume delivers carries. */
const LIMIT_REASON = "your usage limit has reset";
/** The `sendNotice` key of the one continuation a restart sends a cut-off worker. */
const RESTART_CONTINUE_KEY = "restart-continue";

/** What the observers take from the rest of the service. */
export interface ObserversDeps {
  readonly updateHeld: (
    workspaceId: WorkspaceId,
    id: string,
    change: (brief: StoredHeldBrief) => StoredHeldBrief,
  ) => Effect.Effect<undefined>;
  readonly armLimitResume: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly handoffAfterTurn: HandoffPart["handoffAfterTurn"];
  readonly armHold: Workers["armHold"];
  readonly wakeFor: Digests["wakeFor"];
  readonly wake: Digests["wake"];
  readonly survey: LedgerWatch["survey"];
  readonly dependencyBadgesOf: LedgerWatch["dependencyBadgesOf"];
  readonly followPark: Pauses["followPark"];
  readonly workerRemoved: Adoption["workerRemoved"];
  readonly clearHandoff: HandoffPart["clearHandoff"];
  readonly forgetReasons: Digests["forgetReasons"];
}

/** The handlers for the signals the consumer fiber works through. */
export const makeObservers = (kit: OrchestrationKit, deps: ObserversDeps) => {
  const {
    store,
    provideProc,
    driftBefore,
    updateOutbox,
    orchestrationChanged,
    orchestratorState,
    listeningWorkspace,
    updateMemo,
    readOutbox,
    openedInAuto,
    sampleExtras,
    changedFiles,
    extraFacts,
    knownOverlaps,
    conflictedSince,
    dragTimers,
    signals,
    findThread,
    dragsTold,
    publisher,
    prMarks,
    extraBadges,
    worktreesGone,
    runtimes,
    orchestrators,
    workerWorkspaces,
    parkedWorkers,
    completedSeen,
    retrying,
    sends,
    wakeTimers,
    bootWhilePaused,
    reload,
    workspacesChanged,
    requestTimers,
    requestSeen,
    findWorkspace,
  } = kit;
  const {
    updateHeld,
    armLimitResume,
    handoffAfterTurn,
    armHold,
    wakeFor,
    wake,
    survey,
    dependencyBadgesOf,
    followPark,
    workerRemoved,
    clearHandoff,
    forgetReasons,
  } = deps;

  // ---------------------------------------------------------------------------------------
  // What the service watches
  // ---------------------------------------------------------------------------------------

  const rootsOf = (state: WorkspaceState) =>
    store.listProjects.pipe(
      Effect.map((projects) =>
        projects.filter((project) => state.workspace.projectIds.includes(project.id)),
      ),
    );

  const markRoots = (state: WorkspaceState) =>
    Effect.gen(function* () {
      const marks = new Map<string, RootMark>();
      for (const project of yield* rootsOf(state)) {
        const mark = yield* provideProc(markRoot(project.root), undefined);
        if (mark !== undefined) marks.set(project.root, mark);
      }
      return marks;
    });

  /** What the orchestrator's own turn changed in the workspace's checkouts. */
  const measureDrift = (thread: Thread, state: WorkspaceState) =>
    Effect.gen(function* () {
      const before = driftBefore.get(thread.id);
      driftBefore.delete(thread.id);
      if (before === undefined) return;
      const after = yield* markRoots(state);
      const names = new Map((yield* rootsOf(state)).map((p) => [p.root, p.name]));
      const notes: Array<string> = [];
      const roots: Array<{ root: string; files: number; headMoved: boolean }> = [];
      for (const [root, earlier] of before) {
        const later = after.get(root);
        const drift = later === undefined ? undefined : driftBetween(earlier, later);
        if (drift === undefined) continue;
        roots.push({ root, ...drift });
        const name = names.get(root) ?? root;
        const what =
          drift.files > 0
            ? `changed ${drift.files} ${drift.files === 1 ? "file" : "files"} in ${name}`
            : `moved HEAD in ${name}`;
        notes.push(`You ${what} yourself; hand this kind of thing to a worker.`);
      }
      if (roots.length === 0) return;
      yield* updateOutbox(state.workspace.id, (outbox) => [
        withNotes({ ...outbox, orchestratorEdits: outbox.orchestratorEdits + 1 }, notes),
        undefined,
      ]);
      yield* store.appendOrchestrationEvent(state.workspace.id, {
        at: yield* Clock.currentTimeMillis,
        kind: "orchestratorEdits",
        data: { roots },
      });
      yield* orchestrationChanged(state.workspace.id);
    });

  const onTurnStart = (thread: Thread) =>
    Effect.gen(function* () {
      const own = yield* orchestratorState(thread);
      if (own !== undefined) {
        driftBefore.set(thread.id, yield* markRoots(own));
        return;
      }
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) return;
      yield* updateMemo(state.workspace.id, thread.id, (memo) => {
        const { quiet: _, ...rest } = memo;
        return { ...rest, started: true };
      });
    });

  /**
   * Ends the context note's crossing, so the next one is noted. A digest sees only the reading it
   * is built with, and a compaction can drop the context below the threshold and refill it within
   * one turn, or in a turn of the user's with no digest after it: so every reading the
   * orchestrator reports below the threshold comes here, and so does its turn's last one.
   */
  const rearmContextNote = (workspaceId: WorkspaceId) =>
    updateOutbox(workspaceId, (outbox) => [outboxContextRearmed(outbox), undefined]);

  const observeContext = (workspaceId: WorkspaceId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const pct = contextPct(yield* store.lastTurnUsage(threadId));
      if (!contextNote(pct, true).noted) yield* rearmContextNote(workspaceId);
    });

  /**
   * A turn on `agent`'s own login went through: a limit it refused turns at no longer applies,
   * so its held briefs fall due, oldest first, in the batches a limit's resume takes
   * (`releaseBatchAt`). `releaseDue` asks each again, and one the workspace's own threshold still
   * holds waits on for its reset.
   */
  const heldAgentTookTurn = (agent: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const state of yield* store.listWorkspaces) {
        const workspaceId = state.workspace.id;
        const due = ((yield* readOutbox(workspaceId)).heldBriefs ?? [])
          .filter(
            (brief) =>
              brief.breaker === undefined &&
              brief.releasedEarly !== true &&
              brief.agent === agent &&
              brief.until > now,
          )
          .toSorted((a, b) => a.heldAt - b.heldAt);
        if (due.length === 0) continue;
        for (const [index, brief] of due.entries()) {
          const at = releaseBatchAt(index, now);
          yield* updateHeld(workspaceId, brief.id, (held) =>
            held.until > at ? { ...held, until: at, releasedEarly: true } : held,
          );
        }
        yield* armLimitResume(workspaceId);
      }
    });

  const onTurnEnd = (thread: Thread, end: ObservedTurnEnd) =>
    Effect.gen(function* () {
      openedInAuto.delete(thread.id);
      if (end.reason === "completed" && !end.synthesized && thread.model.profileId === undefined) {
        yield* heldAgentTookTurn(thread.model.agent);
      }
      const own = yield* orchestratorState(thread);
      if (own !== undefined) {
        yield* measureDrift(thread, own);
        yield* observeContext(own.workspace.id, thread.id);
        return yield* handoffAfterTurn(own.workspace.id, thread, end);
      }
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) return;
      // A worker stopped by a limit waits to resume on its own: the ledger shows it waiting, and
      // nothing wakes the orchestrator, so workers on one limit don't each send a digest.
      if (thread.limitWait !== undefined) return yield* orchestrationChanged(state.workspace.id);
      // Nothing else looks at a worker's other repos, and a turn is when they change.
      if (yield* sampleExtras(thread)) yield* noteOverlaps(thread, state);
      const deliberateWait =
        end.reason !== "error" &&
        waitingOnAutomation(thread, wakesOf(yield* readOutbox(state.workspace.id), thread.id));
      yield* updateMemo(state.workspace.id, thread.id, (memo) => {
        const { reportInTurn, turnEndsAtReport: _, quiet: _quiet, ...rest } = memo;
        const turnEnds = end.queueEmpty ? memo.turnEnds + 1 : memo.turnEnds;
        if (reportInTurn !== true)
          return end.queueEmpty && !deliberateWait
            ? {
                ...rest,
                turnEnds,
                quiet: {
                  kind: "turnEnded",
                  at: end.endedAt ?? thread.lastActivityAt,
                  ...(end.lastTool === undefined ? {} : { lastTool: end.lastTool }),
                },
              }
            : { ...rest, turnEnds };
        return { ...rest, turnEnds, ...(end.queueEmpty ? { turnEndsAtReport: turnEnds } : {}) };
      });
      // The idle status can reach subscribers before extra-repo sampling and this memo write.
      yield* orchestrationChanged(state.workspace.id);
      if (end.queueEmpty) {
        const memo = (yield* readOutbox(state.workspace.id)).workers[thread.id];
        const lapsesAt = memo === undefined ? undefined : userHoldLapsesAt(memo);
        if (lapsesAt !== undefined) {
          yield* armHold(thread.id, lapsesAt - (yield* Clock.currentTimeMillis));
        }
      }
      yield* wakeFor(
        state.workspace.id,
        end.reason === "error"
          ? { type: "workerError", worker: thread.title, error: workerErrorOf(thread) }
          : { type: "turnEnded", worker: thread.title, queueEmpty: end.queueEmpty },
        thread,
      );
    });

  /**
   * A thread began or stopped waiting out a provider limit. Nothing here wakes for a worker: its
   * ledger row says it waits, and when it resumes. The orchestrator's own wait is kept on its
   * outbox, and a wake leaves a digest waiting at the thread, which the resume delivers as its
   * first turn, saying how long the wait lasted and which workers resumed.
   */
  const onLimitWait = (
    thread: Thread,
    wait: LimitWait,
    ended: "resumed" | "cancelled" | undefined,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const own = yield* orchestratorState(thread);
      if (own !== undefined) {
        const workspaceId = own.workspace.id;
        yield* updateOutbox(workspaceId, (outbox) => {
          if (ended === undefined) {
            const kept = outbox.limited?.endedAt === undefined ? outbox.limited : undefined;
            return [
              {
                ...outbox,
                limited: { since: kept?.since ?? wait.since, resumed: kept?.resumed ?? [] },
              },
              undefined,
            ];
          }
          return outbox.limited === undefined
            ? [outbox, undefined]
            : [{ ...outbox, limited: { ...outbox.limited, endedAt: now } }, undefined];
        });
        if (ended === undefined) yield* wake(workspaceId, LIMIT_REASON, true);
        return yield* orchestrationChanged(workspaceId);
      }
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) return;
      if (ended === "resumed") {
        yield* updateOutbox(state.workspace.id, (outbox) =>
          outbox.limited === undefined || outbox.limited.resumed.includes(thread.id)
            ? [outbox, undefined]
            : [
                {
                  ...outbox,
                  limited: { ...outbox.limited, resumed: [...outbox.limited.resumed, thread.id] },
                },
                undefined,
              ],
        );
      }
      yield* orchestrationChanged(state.workspace.id);
    });

  const onUserInput = (thread: Thread) =>
    Effect.gen(function* () {
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      yield* updateMemo(state.workspace.id, thread.id, (memo) => ({
        ...memo,
        userIntervened: true,
        userInputAt: now,
        lastInputAt: now,
      }));
      // Armed here as well as at a turn's end: an input whose turn never ends (an agent that
      // failed to open) must lapse too. The due check leaves a worker still in a turn alone.
      yield* armHold(thread.id, USER_HOLD_IDLE_MS);
      yield* orchestrationChanged(state.workspace.id);
    });

  /** A thread's changed files by the project they are in: its own, and each repo it spans. */
  const filesByProject = (
    thread: Thread,
    projects: ReadonlyArray<Project>,
  ): ReadonlyArray<WorkerFiles> => {
    const own = changedFiles.get(thread.id);
    const found: Array<WorkerFiles> = [
      {
        threadId: thread.id,
        projectId: thread.projectId,
        files: own?.files ?? [],
        signatures: own?.signatures,
      },
    ];
    for (const extra of thread.extraCheckouts ?? []) {
      const project = projectOfCheckout(projects, extra);
      const sampled = extraFacts.get(samePathKey(extra.path));
      if (project === undefined || sampled === undefined) continue;
      found.push({
        threadId: thread.id,
        projectId: project.id,
        files: sampled.files,
        signatures: sampled.signatures,
      });
    }
    return found;
  };

  /** Whether either worker of an `overlapPairs` key has yet to be sampled since boot. */
  const unsampled = (pair: string) =>
    pair.split(" ").some((id) => !changedFiles.has(id as ThreadId));

  /** A pair that starts overlapping wakes the orchestrator once; the ledger carries it after. */
  const noteOverlaps = (thread: Thread, state: WorkspaceState) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const threads = yield* store.listThreads;
      const projects = yield* store.listProjects;
      const titles = new Map(threads.map((t) => [t.id, t.title]));
      const others = workersOf(threads, state).filter(
        (other) => other.id !== thread.id && !other.parked,
      );
      const involving = (pair: string) => pair.split(" ").includes(thread.id);
      const pairs = new Map(
        [
          ...overlapPairs(
            [thread, ...others].flatMap((each) => filesByProject(each, projects)),
            state.charter.overlapIgnorePaths,
          ),
        ].filter(([pair]) => involving(pair)),
      );
      const known = knownOverlaps.get(workspaceId) ?? new Set<string>();
      // Only a new pair costs a survey: a worker that is finished takes no part in overlap, in the
      // ledger (`featuresOf`) or here, and whether it is finished is the ledger's to say.
      if ([...pairs.keys()].some((pair) => !known.has(pair))) {
        const finished = finishedWorkers((yield* survey(state, false)).features);
        for (const pair of pairs.keys()) {
          if (pair.split(" ").some((id) => finished.has(id as ThreadId))) pairs.delete(pair);
        }
      }
      // A pair seeded at boot stands until both of its workers have been sampled since, or the
      // first of them to be would drop it and the second would tell it again as new.
      knownOverlaps.set(
        workspaceId,
        new Set([
          ...[...known].filter((pair) => !involving(pair) || unsampled(pair)),
          ...pairs.keys(),
        ]),
      );
      for (const [pair, files] of pairs) {
        if (known.has(pair)) continue;
        const other = pair.split(" ").find((id) => id !== thread.id) as ThreadId;
        yield* wakeFor(
          workspaceId,
          { type: "overlap", worker: thread.title, other: titles.get(other) ?? other, files },
          thread,
        );
      }
    });

  /**
   * Keeps when a worker's PR, while it depends on another, started conflicting with its base, and
   * looks again once that has lasted long enough to count as dragging on.
   */
  const noteConflict = (thread: Thread, git: GitState) =>
    Effect.gen(function* () {
      const bound = thread.boundPr;
      const conflicted =
        bound !== undefined &&
        (bound.dependsOn ?? []).length > 0 &&
        git.pr !== undefined &&
        isBadgeOf(git.pr, bound) &&
        git.pr.state === "OPEN" &&
        git.pr.mergeState === "DIRTY";
      if (!conflicted) {
        conflictedSince.delete(thread.id);
        yield* FiberMap.remove(dragTimers, thread.id);
      } else if (!conflictedSince.has(thread.id)) {
        conflictedSince.set(thread.id, yield* Clock.currentTimeMillis);
        yield* FiberMap.run(
          dragTimers,
          thread.id,
          Effect.sleep(Duration.minutes(DEPENDENCY_DRAG_CONFLICT_MIN)).pipe(
            Effect.andThen(signals.offer({ type: "dragCheck", threadId: thread.id })),
          ),
        );
      }
      yield* onDragCheck(thread.id);
    });

  /**
   * Wakes the orchestrator once over each dependency of a worker's PR that has started to drag
   * on; one that stops dragging is told again if it starts again.
   */
  const onDragCheck = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* findThread(threadId);
      const state = thread === undefined ? undefined : yield* listeningWorkspace(thread);
      if (thread === undefined || state === undefined || thread.parked) return;
      const since = conflictedSince.get(threadId);
      const now = yield* Clock.currentTimeMillis;
      const conflictedMin = since === undefined ? undefined : Math.floor((now - since) / 60_000);
      const badges = yield* dependencyBadgesOf(thread);
      for (const dependency of thread.boundPr?.dependsOn ?? []) {
        const name = prRefText(dependency);
        const key = `${threadId} ${name.toLowerCase()}`;
        const badge = badges.find((each) => isBadgeOf(each, dependency));
        const why =
          badge === undefined || badge.state !== "OPEN"
            ? undefined
            : dependencyDragWhy(conflictedMin, badge.review?.rounds);
        if (why === undefined) {
          dragsTold.delete(key);
          continue;
        }
        if (dragsTold.has(key)) continue;
        dragsTold.add(key);
        yield* wakeFor(
          state.workspace.id,
          { type: "dependencyDrags", worker: thread.title, dependency: name, why },
          thread,
        );
      }
    });

  const onGitState = (thread: Thread, git: GitState) =>
    Effect.gen(function* () {
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) return;
      const workspaceId = state.workspace.id;
      // The worker's own PR under its thread id, each extra one under its URL as well, and its
      // branch's own PR when it is bound to another, which what it is sent doesn't carry.
      const branchPr = branchPrOf(
        thread,
        yield* publisher.stateFor(effectiveCheckout(thread).path),
      );
      const branchKey = branchPr === undefined ? undefined : `${thread.id} branch ${branchPr.url}`;
      const seenBefore = prMarks.has(thread.id);
      const badges = [
        [thread.id as string, git.pr] as const,
        ...(git.extraPrs ?? []).map((badge) => [`${thread.id} ${badge.url}`, badge] as const),
        ...(branchPr === undefined || branchKey === undefined
          ? []
          : [[branchKey, branchPr] as const]),
      ];
      for (const [key, badge] of badges) {
        const mark = prMarkOf(badge);
        const repo =
          key === thread.id || badge === undefined ? undefined : repoFromPrUrl(badge.url);
        // The worker's own PR is first heard of with its first git state, which is no news. An
        // extra one is first heard of when its badge arrives, which is: it was just bound. Its
        // branch's is news once the worker's state has been heard of before: it opened another.
        const news = key === branchKey ? seenBefore : key !== thread.id;
        if (prMarks.has(key) || news) {
          yield* wakeFor(
            workspaceId,
            {
              type: "pr",
              worker: repo === undefined ? thread.title : `${thread.title} (${repo})`,
              previous: prMarks.get(key),
              current: mark,
            },
            thread,
          );
        }
        prMarks.set(key, mark);
      }
      extraBadges.set(thread.id, git.extraPrs ?? []);
      yield* noteConflict(thread, git);
      // An idle or cold worker whose folder goes ends no turn, so nothing else would wake the
      // orchestrator to read the ledger row that says so.
      if (git.missing === true) {
        if (!worktreesGone.has(thread.id)) {
          worktreesGone.add(thread.id);
          yield* wakeFor(workspaceId, { type: "worktreeMissing", worker: thread.title }, thread);
        }
      } else worktreesGone.delete(thread.id);

      const token = `${git.head}\0${git.changesToken}`;
      const ownMoved = git.repo && changedFiles.get(thread.id)?.token !== token;
      if (ownMoved) {
        const changed = yield* provideProc(
          changedPaths(effectiveCheckout(thread).path, git.base),
          noChangedPaths,
        );
        changedFiles.set(thread.id, { token, ...changed });
      }
      const extrasMoved = yield* sampleExtras(thread);
      if (ownMoved || extrasMoved) yield* noteOverlaps(thread, state);
    });

  /**
   * A model with no Auto answers an `auto` open by reporting `default`. Only the first
   * report after an open this service started in `auto` is acted on, and only until that
   * thread's first turn ends, so a user who picks `default` by hand later is left alone.
   */
  const onUpsert = (thread: Thread) =>
    Effect.gen(function* () {
      if (openedInAuto.has(thread.id) && thread.mode !== "auto") {
        openedInAuto.delete(thread.id);
        const next = modeAfterDowngrade({ openedIn: "auto", reported: thread.mode });
        if (next !== undefined) {
          yield* runtimes
            .setMode(thread.id, next)
            .pipe(
              Effect.catch((e) =>
                Effect.logWarning("orchestration couldn't leave default mode").pipe(
                  Effect.annotateLogs({ threadId: thread.id, error: e.message }),
                ),
              ),
            );
        }
      }
      const holding = orchestrators.get(thread.id);
      if (holding !== undefined) yield* followPark(holding, thread);
      const workspaceId = workerWorkspaces.get(thread.id);
      if (workspaceId === undefined) return;
      if (thread.parked) parkedWorkers.add(thread.id);
      else parkedWorkers.delete(thread.id);
      if (thread.parked) return;
      if (thread.completedAt === undefined) {
        completedSeen.delete(thread.id);
      } else if (!completedSeen.has(thread.id)) {
        completedSeen.add(thread.id);
        yield* wakeFor(workspaceId, { type: "completed", worker: thread.title }, thread);
      }
      // A dependency declared on a PR conflicting already moves no git state, which the
      // publisher only sends when it changes: its conflict is measured from the badge it has.
      if ((thread.boundPr?.dependsOn ?? []).length > 0 || conflictedSince.has(thread.id)) {
        const git = yield* publisher.stateForThread(thread);
        if (git !== undefined) yield* noteConflict(thread, git);
      }
    });

  /** The store already emptied the slot and cut the workers loose; say so. */
  const onRemoved = (threadId: ThreadId) =>
    Effect.gen(function* () {
      retrying.delete(threadId);
      openedInAuto.delete(threadId);
      completedSeen.delete(threadId);
      driftBefore.delete(threadId);
      for (const key of sends.keys()) {
        if (key.split(" ").includes(threadId)) sends.delete(key);
      }
      // The worktrees it held in other repos went with it: keep only the samples a thread still
      // holds. Keyed by folder, so a folder another worker took over keeps its sample.
      if (extraFacts.size > 0) {
        const held = new Set(
          (yield* store.listThreads).flatMap((thread) =>
            (thread.extraCheckouts ?? []).map((extra) => samePathKey(extra.path)),
          ),
        );
        for (const key of extraFacts.keys()) if (!held.has(key)) extraFacts.delete(key);
      }
      const worked = workerWorkspaces.get(threadId);
      if (worked !== undefined) {
        yield* workerRemoved(worked, threadId, parkedWorkers.has(threadId), "closed");
      }
      const workspaceId = orchestrators.get(threadId);
      if (workspaceId === undefined) return;
      orchestrators.delete(threadId);
      yield* FiberMap.remove(wakeTimers, workspaceId);
      yield* clearHandoff(workspaceId);
      forgetReasons(workspaceId);
      bootWhilePaused.delete(workspaceId);
      knownOverlaps.delete(workspaceId);
      // The park went with the thread; a vacant workspace isn't parked.
      yield* store
        .updateWorkspace(workspaceId, (current) => {
          if (current.paused?.reason !== "parked") return current;
          const { paused: _, ...rest } = current;
          return rest;
        })
        .pipe(Effect.ignore);
      const orphans = (yield* store.listThreads).filter(
        (thread) => workerWorkspaces.get(thread.id) === workspaceId,
      );
      for (const orphan of orphans) {
        workerWorkspaces.delete(orphan.id);
        parkedWorkers.delete(orphan.id);
        // The store stripped `spawnedBy` without publishing; an unchanged update republishes.
        yield* runtimes.updateThread(orphan.id, (thread) => thread).pipe(Effect.ignore);
        yield* reload(orphan.id);
      }
      yield* workspacesChanged;
      yield* orchestrationChanged(workspaceId);
    });

  const armRequestTimer = (threadId: ThreadId, requestId: RequestId, afterMs: number) =>
    FiberMap.run(
      requestTimers,
      requestId,
      Effect.sleep(Duration.millis(afterMs + 1_000)).pipe(
        Effect.andThen(signals.offer({ type: "requestAged", threadId, requestId })),
      ),
    ).pipe(Effect.asVoid);

  const onRequest = (threadId: ThreadId, requestId: RequestId, kind: string) =>
    Effect.gen(function* () {
      const workspaceId = workerWorkspaces.get(threadId);
      if (workspaceId === undefined) return;
      requestSeen.set(requestId, { threadId, at: yield* Clock.currentTimeMillis });
      const state = yield* findWorkspace(workspaceId);
      const autonomy = state === undefined ? undefined : autonomyOf(state.charter);
      yield* armRequestTimer(threadId, requestId, requestWakeMs(kind, autonomy));
    });

  const onRequestAged = (threadId: ThreadId, requestId: RequestId) =>
    Effect.gen(function* () {
      const seen = requestSeen.get(requestId);
      const workspaceId = workerWorkspaces.get(threadId);
      const pending = yield* store.listRequests(threadId);
      const request = pending.find((each) => each.id === requestId);
      const thread = yield* findThread(threadId);
      if (seen === undefined || workspaceId === undefined || request === undefined) return;
      const state = yield* findWorkspace(workspaceId);
      const autonomy = state === undefined ? undefined : autonomyOf(state.charter);
      const pendingMs = (yield* Clock.currentTimeMillis) - seen.at;
      const dueAfter = requestWakeMs(request.kind, autonomy);
      // The level was lowered while a question's one-minute timer ran: it is the user's again,
      // and waits the ten minutes every other request does.
      if (pendingMs <= dueAfter) {
        return yield* armRequestTimer(threadId, requestId, dueAfter - pendingMs);
      }
      yield* wakeFor(
        workspaceId,
        {
          type: "requestPending",
          worker: thread?.title ?? threadId,
          kind: request.kind,
          pendingMs,
          autonomy,
        },
        thread,
      );
    });

  /**
   * Tells the away digest which workers the restart cut off mid-turn and what background work it
   * stopped, and with `continuing` asks each cut-off worker once to go on, unless the workspace is
   * paused, the user holds the worker, or something is queued for it already. `true` when it
   * left a note.
   */
  const noteRestart = (
    state: WorkspaceState,
    threads: ReadonlyArray<Thread>,
    cutOff: ReadonlySet<ThreadId>,
    continuing: boolean,
  ) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const { workers } = yield* readOutbox(workspaceId);
      const costs: Array<RestartCost> = [];
      const stopped: Array<ThreadId> = [];
      const mine = workersOf(threads, state);
      const candidates: Array<Thread> = [];
      for (const worker of mine) {
        const touched = cutOff.has(worker.id) || (workers[worker.id]?.background ?? []).length > 0;
        if (!touched || worker.parked || worker.completedAt !== undefined) continue;
        if (yield* Effect.sync(() => existsSync(effectiveCheckout(worker).path))) {
          candidates.push(worker);
        }
      }
      // Nothing has looked a PR up yet this early in a boot, and one that merged while the app was
      // down would read as work under way: each candidate's is looked up now, and one that still
      // can't be is asked nothing, since it may well be finished.
      yield* Effect.forEach(
        candidates,
        (worker) =>
          publisher.refresh(effectiveCheckout(worker).path, {
            remote: true,
            rebase: false,
            scanElsewhere: false,
          }),
        { concurrency: 4, discard: true },
      );
      const finished =
        candidates.length === 0
          ? new Set<ThreadId>()
          : finishedWorkers((yield* survey(state, false)).features);
      for (const worker of mine) {
        const memo = workers[worker.id];
        const lost = memo?.background ?? [];
        const cut = cutOff.has(worker.id);
        if (lost.length > 0) stopped.push(worker.id);
        // What a restart cut short in a worker whose work is over, or whose worktree has gone, is
        // nobody's to pick up: an open turn row or a dev server left from long ago.
        if (!candidates.includes(worker) || finished.has(worker.id)) continue;
        const prUnknown =
          worker.boundPr !== undefined && (yield* publisher.badgeFor(worker)) === undefined;
        const eligible =
          cut &&
          continuing &&
          !prUnknown &&
          state.paused === undefined &&
          pausedFeatureOf(state, worker) === undefined &&
          memo?.userIntervened !== true &&
          worker.completedAt === undefined &&
          !worker.parked &&
          (yield* store.listQueue(worker.id)).length === 0;
        const continued =
          eligible &&
          (yield* runtimes
            .sendNotice(worker.id, RESTART_CONTINUE_KEY, { text: restartContinuation(lost) })
            .pipe(
              Effect.as(true),
              Effect.catch((e) =>
                Effect.logWarning("couldn't continue a worker the restart cut off").pipe(
                  Effect.annotateLogs({ threadId: worker.id, error: e.message }),
                  Effect.as(false),
                ),
              ),
            ));
        costs.push({ title: worker.title, threadId: worker.id, cutOff: cut, lost, continued });
      }
      const note = restartNote(costs);
      if (note === undefined && stopped.length === 0) return false;
      // The process that ran it is gone, so no restart after this one stops it again.
      yield* updateOutbox(workspaceId, (outbox) => {
        const next = { ...outbox.workers };
        for (const id of stopped) {
          const memo = next[id];
          if (memo === undefined) continue;
          const { background: _, ...rest } = memo;
          next[id] = rest;
        }
        return [
          withNotes({ ...outbox, workers: next }, note === undefined ? [] : [note]),
          undefined,
        ];
      });
      return note !== undefined;
    });

  /** Keeps a worker's background work in its memo, for what a restart stops (`noteRestart`). */
  const onBackground = (threadId: ThreadId, tasks: ReadonlyArray<BackgroundTask>) =>
    Effect.gen(function* () {
      const workspaceId = workerWorkspaces.get(threadId);
      if (workspaceId === undefined) return;
      // Redacted before it is stored: a command line can carry a token, and this row outlives it.
      const background = tasks.map((task): BackgroundWork => ({
        kind: task.kind,
        description: redactText(task.description),
        ...(task.command === undefined ? {} : { command: redactText(task.command) }),
        ...(task.subagentType === undefined ? {} : { subagentType: redactText(task.subagentType) }),
      }));
      yield* updateMemo(workspaceId, threadId, (memo) => {
        if (background.length === 0) {
          if (memo.background === undefined) return memo;
          const { background: _, ...rest } = memo;
          return rest;
        }
        return { ...memo, background };
      });
    });

  return {
    onTurnStart,
    rearmContextNote,
    onTurnEnd,
    onLimitWait,
    onUserInput,
    onDragCheck,
    onGitState,
    onUpsert,
    onRemoved,
    onRequest,
    onRequestAged,
    noteRestart,
    onBackground,
  };
};

/** What `makeObservers` makes, for the parts whose `deps` take some of it. */
export type Observers = ReturnType<typeof makeObservers>;
