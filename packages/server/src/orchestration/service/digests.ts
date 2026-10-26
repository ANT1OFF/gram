// Wakes and digests: the reasons that wake an
// orchestrator, the debounce that gathers them, the digest built from the ledger against the last
// acknowledged snapshot, and its delivery, retries and the pause after repeated failures.
import {
  autonomyOf,
  briefFooterOf,
  serializeDigest,
  prioritizeDigestReports,
  DIGEST_REPORTS_MAX,
  DIGEST_REPORT_INTERFACE_MAX,
  type DigestReport,
  type DigestVariant,
  type OrchestrationDigest,
  type OrchestratorCharter,
  type OrchestratorLedger,
  type WorkerLedgerEntry,
  type Thread,
  type ThreadId,
  type TurnId,
  type UserInput,
  type WorkerReport,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import { clockText, resumeText, spanText } from "../../runtime/limit-wait.ts";
import { type SystemDelivery, type SystemDeliveryFailure } from "../../runtime/thread-runtimes.ts";
import { visibleFeatures } from "../ledger.ts";
import { DECISIONS_FILE } from "../memory.ts";
import {
  readOutbox as readStoredOutbox,
  notesEnd,
  storedSnapshot,
  withNotes,
  withNotesAcked,
  type OutboxState,
} from "../outbox.ts";
import { digestQuestions, withCopiesTold } from "../worker-questions.ts";
import { bootContext } from "../prompt.ts";
import {
  contextNote,
  digestDiff,
  newDigestReports,
  digestGroups,
  digestWaiting,
  markRepeatedInterfaces,
  quietWorkers,
  rosterText,
  startMode,
  tidyNotes,
  orchestratorWakeNote,
  wakesWithoutDiff,
  wakeWorthy,
  coalesceReasons,
  type PendingReason,
  type RosterUnavailable,
  type WakeEvent,
  userAwayMinutes,
} from "../rules.ts";
import {
  DIGEST_KEY,
  IN_ERROR_DETAIL,
  AWAY_REASON,
  AUTONOMY_LINES,
  ROUTE_AT_LIMIT_LINE,
  footerLine,
  pausedFeatureOf,
  type OrchestrationKit,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Pauses } from "./pauses.ts";

/** How long after a failed delivery the same digest is tried again: the first retry, then the second. */
export const DELIVERY_RETRY_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(30),
  Duration.minutes(2),
];
/** Consecutive failed deliveries after which orchestration pauses instead of trying again. */
export const DELIVERY_FAILURES_BEFORE_PAUSE = 3;
const charterLines = (
  charter: OrchestratorCharter,
  mode: Thread["mode"],
  unavailable: RosterUnavailable,
): ReadonlyArray<string> => [
  `at most ${charter.maxConcurrentWorkers} workers at once; one more asks the user`,
  ...(charter.pauseAtLimitPct === undefined
    ? []
    : [
        `new workers pause at ${charter.pauseAtLimitPct}% of a subscription limit: spawn_worker asks the user once per window, and while they pause new workers it is refused until the reset; running workers carry on`,
      ]),
  AUTONOMY_LINES[autonomyOf(charter)],
  `merge review policy: ${charter.mergeReviewPolicy ?? "bot"} (automatic uses approving configured bots, otherwise solo; solo requires passing CI or Gram's own full check of the head merged onto its base, which merge_when_ready runs itself, and GitHub merge rules)`,
  ...(charter.repoMergeReviewPolicies ?? []).map(
    ({ repo, policy }) => `merge review policy for ${repo}: ${policy}`,
  ),
  ...(charter.routeAtLimit === true ? [ROUTE_AT_LIMIT_LINE] : []),
  ...(briefFooterOf(charter) === undefined ? [] : [footerLine(briefFooterOf(charter)!)]),
  charter.workerModels === undefined
    ? `workers start in ${mode} mode on your own model`
    : rosterText(
        `workers start in ${mode} mode, on one of these worker models (agent:model, then what the user wants it used for):`,
        charter.workerModels,
        unavailable,
      ),
];

/** Reports as a digest names them; one from a thread that is no longer a worker is left out. */
const digestReports = (
  records: ReadonlyArray<{ readonly seq: number; readonly report: WorkerReport }>,
  features: OrchestratorLedger["features"],
): ReadonlyArray<DigestReport> => {
  const known = new Map(
    features.flatMap((feature) => feature.workers).map((worker) => [worker.threadId, worker]),
  );
  return records.flatMap(({ report }) => {
    const worker = known.get(report.threadId);
    return worker === undefined
      ? []
      : [{ ...report, title: worker.title, feature: worker.feature }];
  });
};

/** What digests take from the rest of the service. */
export interface DigestsDeps {
  readonly survey: LedgerWatch["survey"];
  readonly endRecovery: Pauses["endRecovery"];
  readonly pause: Pauses["pause"];
}

/** Wake reasons, digests and their delivery. */
export const makeDigests = (kit: OrchestrationKit, deps: DigestsDeps) => {
  const {
    wakeTimers,
    runtimes,
    signals,
    reasons,
    reasonsAbout,
    firstReasonAt,
    diffless,
    retryingIn,
    debounce,
    maxWait,
    findWorkspace,
    store,
    bootWhilePaused,
    readOutbox,
    signalUnreadable,
    memory,
    rosterAvailability,
    appActivity,
    app,
    updateOutbox,
    carried,
    selfResumed,
    hub,
    recovering,
    orchestrationChanged,
    findThread,
  } = kit;
  const { survey, endRecovery, pause } = deps;

  // ---------------------------------------------------------------------------------------
  // Pausing
  // ---------------------------------------------------------------------------------------

  const cancelDelivery = (workspaceId: WorkspaceId, orchestratorId: ThreadId | undefined) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(wakeTimers, workspaceId);
      if (orchestratorId !== undefined) {
        yield* runtimes.cancelSystemDelivery(orchestratorId, DIGEST_KEY);
      }
    });

  const armWake = (workspaceId: WorkspaceId, delay: Duration.Duration) =>
    Effect.gen(function* () {
      yield* FiberMap.run(
        wakeTimers,
        workspaceId,
        Effect.sleep(delay).pipe(Effect.andThen(signals.offer({ type: "wakeDue", workspaceId }))),
      );
    });

  /**
   * Notes a reason and restarts the workspace's window, so a burst lands in one digest. While
   * any thread of the tree is being rate limited the window is twice as long.
   */
  const wake = (
    workspaceId: WorkspaceId,
    reason: string,
    withoutDiff = false,
    about?: Omit<PendingReason, "reason">,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      reasons.set(workspaceId, (reasons.get(workspaceId) ?? new Set()).add(reason));
      if (about !== undefined) {
        const kept = reasonsAbout.get(workspaceId) ?? new Map<string, PendingReason>();
        reasonsAbout.set(workspaceId, kept.set(reason, { reason, ...about }));
      }
      if (!firstReasonAt.has(workspaceId)) firstReasonAt.set(workspaceId, now);
      if (withoutDiff) diffless.add(workspaceId);
      yield* Effect.logDebug("orchestration wake scheduled").pipe(
        Effect.annotateLogs({ workspaceId, reason }),
      );
      const window = retryingIn(workspaceId) === undefined ? debounce : Duration.times(debounce, 2);
      // A steady trickle of reasons would otherwise push the digest back forever.
      const left = firstReasonAt.get(workspaceId)! + Duration.toMillis(maxWait) - now;
      yield* armWake(workspaceId, Duration.min(window, Duration.millis(Math.max(0, left))));
    });

  /**
   * Wakes for `event`, unless it is about a worker (`from`) of a feature the user paused: that
   * wakes nobody, and the ledger's word on it rides along on the next digest something else sends.
   */
  const wakeFor = (workspaceId: WorkspaceId, event: WakeEvent, from?: Thread) =>
    Effect.gen(function* () {
      const reason = wakeWorthy(event);
      if (reason === undefined) return;
      if (from !== undefined && pausedFeatureOf(yield* findWorkspace(workspaceId), from)) return;
      yield* wake(workspaceId, reason, wakesWithoutDiff(event), {
        ...("worker" in event ? { worker: event.worker } : {}),
        type: event.type,
      });
    });

  /** Forgets a workspace's pending reasons and what is kept beside them. */
  const forgetReasons = (workspaceId: WorkspaceId) => {
    reasons.delete(workspaceId);
    reasonsAbout.delete(workspaceId);
    firstReasonAt.delete(workspaceId);
    // A reason the diff can't show went with them; left set, it would force a later digest.
    diffless.delete(workspaceId);
  };

  /**
   * What a digest sent now would say, or `undefined` when there is nothing to say: the ledger
   * against the snapshot of the last acknowledged digest, and the reports filed since.
   */
  const planDigest = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      // Before the workspace is read, so a stage set after this may be missing from the text.
      const readAt = yield* Clock.currentTimeMillis;
      const state = yield* findWorkspace(workspaceId);
      const settings = yield* store.getSettings;
      if (state === undefined) return undefined;
      // A pause holds every digest back but one: the boot of a session a handoff has just
      // emptied, which would otherwise sit there knowing nothing until the user resumed.
      const bootsAnyway =
        bootWhilePaused.has(workspaceId) && !(yield* readOutbox(workspaceId)).booted;
      if (state.paused !== undefined && !bootsAnyway) return undefined;
      const found = yield* survey(state, true);
      const { outbox } = found;
      const records = yield* store.listWorkerReports(workspaceId, outbox.ackedReportSeq);
      const reports = newDigestReports(digestReports(records, found.features), outbox.snapshot);
      const diff = digestDiff({
        now: yield* Clock.currentTimeMillis,
        snapshot: outbox.snapshot,
        ledger: { features: found.features },
        reports,
        archivedRemovals: outbox.archivedRemovals,
        interfaces: found.interfaces,
        turnEnds: Object.fromEntries(
          Object.entries(outbox.workers).map(([threadId, memo]) => [threadId, memo.turnEnds]),
        ),
        turnEndsAtReport: Object.fromEntries(
          Object.entries(outbox.workers).flatMap(([threadId, memo]) =>
            memo.turnEndsAtReport === undefined ? [] : [[threadId, memo.turnEndsAtReport]],
          ),
        ),
        autonomy: autonomyOf(state.charter),
        paused: new Set(state.pausedFeatures ?? []),
      });
      const variant: DigestVariant = !outbox.booted
        ? "boot"
        : reasons.get(workspaceId)?.has(AWAY_REASON) === true
          ? "away"
          : "digest";
      // A wake the orchestrator set that has fallen due is owed a digest by itself, restart or not.
      const wakeDue = (outbox.dueWakes ?? []).length > 0;
      const liveRemoved = (outbox.liveRemovals ?? []).length > 0;
      if (
        variant !== "boot" &&
        !diff.worthWaking &&
        !diffless.has(workspaceId) &&
        !wakeDue &&
        !liveRemoved
      ) {
        return undefined;
      }
      return { state, settings, found, records, reports, diff, variant, readAt };
    });

  /**
   * The digest for `turnId`, or `undefined` when there is nothing to say. Runs under the
   * orchestrator's runtime lock, so it reads the store and asks other threads' status only.
   */
  const buildDigest = (workspaceId: WorkspaceId, turnId: TurnId) =>
    Effect.gen(function* () {
      // An outbox that can't be read, or one set aside and waiting on the user's resume, gives
      // nothing to diff against: the empty state would make this a boot digest.
      const stored = readStoredOutbox(yield* store.getOutbox(workspaceId));
      // Never released here: a row is set aside by the first outbox write after it is found,
      // which can come before its pause lands, so a missing pause doesn't mean the user ended it.
      if (
        stored._tag === "unreadable" ||
        (stored._tag === "read" && stored.setAside !== undefined)
      ) {
        yield* signalUnreadable(workspaceId, stored);
        yield* Effect.logDebug("orchestration digest dropped: outbox set aside").pipe(
          Effect.annotateLogs({ workspaceId }),
        );
        return undefined;
      }
      const plan = yield* planDigest(workspaceId);
      if (plan === undefined) {
        forgetReasons(workspaceId);
        yield* Effect.logDebug("orchestration digest dropped: nothing to say").pipe(
          Effect.annotateLogs({ workspaceId }),
        );
        return undefined;
      }
      const { state, settings, found, records, reports, diff, variant, readAt } = plan;
      const { outbox } = found;
      const taken = [...(reasons.get(workspaceId) ?? [])];
      // What comes after this is a new window's, bounded from its own first reason.
      firstReasonAt.delete(workspaceId);
      const about = reasonsAbout.get(workspaceId);
      const boot =
        variant === "boot"
          ? bootContext({
              memoryIndex: yield* memory.index(workspaceId).pipe(Effect.orElseSucceed(() => "")),
              decisions: yield* memory.read(workspaceId, DECISIONS_FILE).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed("")),
                // Unreadable isn't absent: the session is told, so no restriction is lost.
                Effect.catch((e) => Effect.succeed({ unreadable: e.message })),
              ),
              charterLines: charterLines(
                state.charter,
                startMode(settings, state.charter),
                yield* rosterAvailability(state.charter),
              ),
            })
          : [];
      // Not on a boot: the last usage on record is then the session a handoff left behind.
      const context =
        variant === "boot"
          ? { note: undefined, noted: outbox.contextNoted === true }
          : contextNote(found.ownContextPct, outbox.contextNoted === true);
      const tidy = tidyNotes({
        snapshot: outbox.snapshot,
        features: found.features,
        groups: found.groups,
        noted: outbox.tidyNoted ?? [],
      });
      const features = visibleFeatures(found.features, () => 0, { includeArchived: false });
      const quiet = quietWorkers({
        variant,
        features,
        groups: found.groups,
        changes: diff.changes,
        reports,
      });
      const excerpts = prioritizeDigestReports(reports).slice(0, DIGEST_REPORTS_MAX);
      const interfaces = markRepeatedInterfaces(
        excerpts,
        outbox.interfacesRead ?? {},
        DIGEST_REPORT_INTERFACE_MAX,
      );
      const annotated = new Map(
        excerpts.map((report, index) => [report, interfaces.reports[index]!]),
      );
      const waitThreads = [
        ...(state.workspace.orchestratorThreadId === undefined
          ? []
          : [state.workspace.orchestratorThreadId]),
        ...features.flatMap((feature) => feature.workers.map((worker) => worker.threadId)),
      ];
      const waiting = digestWaiting({
        variant,
        threads: yield* Effect.forEach(waitThreads, (threadId) =>
          store.listWaits(threadId, "all").pipe(Effect.map((items) => ({ threadId, items }))),
        ),
        now: readAt,
        since: outbox.lastDigestAt,
      });
      const limitNote = yield* orchestratorLimitNote(state, outbox, features, readAt);
      const questions = digestQuestions(outbox);
      const awayMinutes = userAwayMinutes(
        Option.isSome(appActivity) ? yield* appActivity.value.inactiveSince : undefined,
        readAt,
      );
      const digest: OrchestrationDigest = {
        kind: "orchestration",
        variant,
        generation: outbox.generation + 1,
        workspaceId,
        workspaceName: state.workspace.name,
        ...(app === undefined ? {} : { app }),
        reasons: coalesceReasons(taken.map((reason) => about?.get(reason) ?? { reason })),
        changes: diff.changes,
        reports: reports.map((report) => annotated.get(report) ?? report),
        features,
        ...(found.groups.length === 0
          ? {}
          : { groups: digestGroups(found.groups, found.features, features) }),
        ...(found.groups.some((group) => group.state === "archived")
          ? {
              archivedGroupCount: found.groups.filter((group) => group.state === "archived").length,
            }
          : {}),
        ...(quiet.length === 0 ? {} : { quiet }),
        ...(variant === "boot" || outbox.lastDigestAt === undefined
          ? {}
          : { lastDigestAt: outbox.lastDigestAt }),
        budget: found.budget,
        notes: [
          ...boot,
          ...diff.notes,
          ...tidy.notes,
          ...outbox.notes,
          ...(outbox.liveRemovals ?? []).map(
            (removal) =>
              `Worker [thread ${removal.threadId}] was ${removal.action === "moved" ? "moved to another workspace" : removal.action} while live; it is no longer your worker.`,
          ),
          ...(outbox.dueWakes ?? []).map(orchestratorWakeNote),
          ...(context.note === undefined ? [] : [context.note]),
          ...(limitNote === undefined ? [] : [limitNote]),
        ],
        ...(state.paused === undefined ? {} : { paused: state.paused }),
        ...(waiting === undefined ? {} : { waiting }),
        ...(awayMinutes === undefined ? {} : { userAwayMinutes: awayMinutes }),
        ...(questions === undefined ? {} : { questions }),
      };
      yield* updateOutbox(workspaceId, (current) => [
        {
          ...current,
          inFlight: {
            generation: digest.generation,
            turnId,
            reportSeqUpTo: records.at(-1)?.seq ?? current.ackedReportSeq,
            nextSnapshot: storedSnapshot(diff.nextSnapshot),
            notesUpTo: notesEnd(outbox),
            liveRemovalsTaken: (outbox.liveRemovals ?? []).map((removal) => removal.id),
            ...(outbox.dueWakes === undefined
              ? {}
              : { dueWakesTaken: outbox.dueWakes.map((due) => due.id) }),
            ...(questions === undefined || questions.closed.length === 0
              ? {}
              : { questionCopiesTaken: questions.closed.map((question) => question.id) }),
            contextNoted: context.noted,
            tidyNoted: tidy.noted,
            interfacesRead: interfaces.read,
            claimedAt: readAt,
            ...(limitNote === undefined ? {} : { limitNoted: true }),
          },
        },
        undefined,
      ]);
      carried.set(turnId, taken);
      const input: UserInput = { text: serializeDigest(digest), notice: digest };
      return input;
    });

  const onAccepted = (workspaceId: WorkspaceId, turnId: TurnId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const generation = yield* updateOutbox(workspaceId, (outbox) => {
        const flight = outbox.inFlight;
        if (flight === undefined || flight.turnId !== turnId) return [outbox, undefined];
        const {
          inFlight: _,
          dueWakes,
          limited,
          ...acked
        } = withNotesAcked(outbox, flight.notesUpTo);
        const rest =
          limited === undefined || flight.limitNoted === true ? acked : { ...acked, limited };
        const copied = withCopiesTold(rest, flight.questionCopiesTaken ?? []);
        const told = new Set(flight.dueWakesTaken ?? []);
        const stillDue = (dueWakes ?? []).filter((due) => !told.has(due.id));
        const removalsTold = new Set(flight.liveRemovalsTaken ?? []);
        return [
          {
            ...copied,
            ...(stillDue.length === 0 ? {} : { dueWakes: stillDue }),
            booted: true,
            generation: flight.generation,
            lastDigestAt: flight.claimedAt,
            snapshot: flight.nextSnapshot,
            archivedRemovals: (outbox.archivedRemovals ?? []).filter(
              (id) => flight.nextSnapshot[id] !== undefined,
            ),
            liveRemovals: (outbox.liveRemovals ?? []).filter(
              (removal) => !removalsTold.has(removal.id),
            ),
            ackedReportSeq: flight.reportSeqUpTo,
            failures: 0,
            ...(flight.contextNoted === undefined ? {} : { contextNoted: flight.contextNoted }),
            ...(flight.tidyNoted === undefined ? {} : { tidyNoted: flight.tidyNoted }),
            ...(flight.interfacesRead === undefined
              ? {}
              : { interfacesRead: flight.interfacesRead }),
          },
          flight.generation,
        ];
      });
      const taken = carried.get(turnId) ?? [];
      carried.delete(turnId);
      if (generation === undefined) return;
      bootWhilePaused.delete(workspaceId);
      if (selfResumed.has(workspaceId)) {
        const workspace = (yield* findWorkspace(workspaceId))?.workspace;
        const holder = workspace?.orchestratorThreadId;
        yield* hub.publish({
          type: "notify",
          kind: "info",
          title: `Orchestration resumed${workspace === undefined ? "" : ` (${workspace.name})`}`,
          body: "The orchestrator could be reached again, so its workspace resumed by itself.",
          ...(holder === undefined ? {} : { threadId: holder }),
        });
      }
      if (recovering.has(workspaceId)) yield* endRecovery(workspaceId);
      const pending = reasons.get(workspaceId);
      for (const reason of taken) {
        pending?.delete(reason);
        reasonsAbout.get(workspaceId)?.delete(reason);
      }
      if (pending === undefined || pending.size === 0) forgetReasons(workspaceId);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: now,
        kind: "wake",
        data: { generation, reasons: taken },
      });
      yield* orchestrationChanged(workspaceId);
    });

  const onFailed = (
    workspaceId: WorkspaceId,
    turnId: TurnId | undefined,
    reason: SystemDeliveryFailure,
  ) =>
    Effect.gen(function* () {
      if (turnId !== undefined) carried.delete(turnId);
      // The orchestrator stopped on a limit it now waits out. Nothing failed: the digest goes
      // back to wait at the thread, and the resume delivers it, with all that came meanwhile.
      if (reason === "limited") {
        yield* updateOutbox(workspaceId, (outbox) => {
          const { inFlight: _, ...rest } = outbox;
          return [rest, undefined];
        });
        const holder = (yield* findWorkspace(workspaceId))?.workspace.orchestratorThreadId;
        if (holder === undefined) return;
        return yield* runtimes
          .requestSystemDelivery(holder, DIGEST_KEY, deliveryFor(workspaceId))
          .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
      }
      // The generation stays where it was, so the retry carries the same number.
      const failures = yield* updateOutbox(workspaceId, (outbox) => {
        const { inFlight: _, ...rest } = outbox;
        const next = { ...rest, failures: outbox.failures + 1 };
        return [next, next.failures];
      });
      yield* Effect.logWarning("orchestration digest not delivered").pipe(
        Effect.annotateLogs({ workspaceId, reason, failures }),
      );
      // An orchestrator in `error` or `ended` won't take the next one either.
      if (reason === "error" || reason === "ended") {
        return yield* pause(
          workspaceId,
          "deliveryFailed",
          reason === "ended"
            ? "The orchestrator thread has ended. Close it and open a new orchestrator."
            : IN_ERROR_DETAIL,
        );
      }
      if (failures >= DELIVERY_FAILURES_BEFORE_PAUSE) {
        return yield* pause(
          workspaceId,
          "deliveryFailed",
          `A digest failed to reach the orchestrator ${failures} times in a row (${reason}).`,
        );
      }
      // The reasons it carried are still pending, so the retry says what this one would have.
      const delay = DELIVERY_RETRY_DELAYS[failures - 1] ?? DELIVERY_RETRY_DELAYS.at(-1)!;
      yield* armWake(workspaceId, delay);
    });

  const deliveryFor = (workspaceId: WorkspaceId): SystemDelivery => ({
    build: (turnId) => buildDigest(workspaceId, turnId),
    accepted: (turnId) => onAccepted(workspaceId, turnId),
    failed: (turnId, reason) => onFailed(workspaceId, turnId, reason),
  });

  /**
   * The window closed. Nothing is counted or rationed here: how often an orchestrator is woken
   * is not the app's to limit. `build` decides, at the moment of sending, whether there is
   * anything to say.
   */
  const onWakeDue = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const state = yield* findWorkspace(workspaceId);
      const holder = state?.workspace.orchestratorThreadId;
      if (state === undefined || holder === undefined || state.paused !== undefined) return;
      // Parked and not yet paused for it: the reasons wait for the resume that unparking brings.
      if ((yield* findThread(holder))?.parked === true) return;
      // A digest now would go to the session a handoff is about to replace. The reasons stay,
      // and the boot digest that ends the handoff carries them.
      if ((yield* readOutbox(workspaceId)).handoff !== undefined) return;
      // Asked here as well as in `build`, so a cold orchestrator's agent isn't started only to
      // be told nothing. `build` asks again, since the thread may be busy for a while yet.
      if ((yield* planDigest(workspaceId)) === undefined) {
        forgetReasons(workspaceId);
        return;
      }
      yield* runtimes
        .requestSystemDelivery(holder, DIGEST_KEY, deliveryFor(workspaceId))
        .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
    });

  // Dreams' seam (`dreams.ts`).
  const addNote: OrchestrationShape["addNote"] = (workspaceId, note) =>
    Effect.gen(function* () {
      yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);
      yield* wake(workspaceId, "memory consolidated", true);
    });

  const noteQuietly: OrchestrationShape["noteQuietly"] = (workspaceId, note) =>
    updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);

  /**
   * The note the first digest after the orchestrator's limit wait carries: how long it lasted,
   * which workers resumed, and which still wait and when they go. None while it still waits.
   */
  const orchestratorLimitNote = (
    state: WorkspaceState,
    outbox: OutboxState,
    features: ReadonlyArray<{ readonly workers: ReadonlyArray<WorkerLedgerEntry> }>,
    now: number,
  ) =>
    Effect.gen(function* () {
      const limited = outbox.limited;
      const holder = state.workspace.orchestratorThreadId;
      if (limited === undefined || holder === undefined) return undefined;
      if ((yield* findThread(holder))?.limitWait !== undefined) return undefined;
      const workers = features.flatMap((feature) => feature.workers);
      const named = (threadId: ThreadId) => {
        const title = workers.find((worker) => worker.threadId === threadId)?.title;
        return title === undefined ? `[thread ${threadId}]` : `"${title}" [thread ${threadId}]`;
      };
      const ended = limited.endedAt ?? now;
      const waiting = workers
        .flatMap((worker) =>
          worker.limitWait === undefined ? [] : [{ worker, at: worker.limitWait.resumeAt }],
        )
        .toSorted((a, b) => a.at - b.at);
      return [
        `You were stopped by a usage limit from ${clockText(limited.since)} to ${clockText(ended)} local time (${spanText(ended - limited.since)}). Digests were held; this one covers the whole wait. Carry on from where you stopped.`,
        ...(limited.resumed.length === 0
          ? []
          : [`Workers resumed: ${limited.resumed.map(named).join(", ")}.`]),
        ...(waiting.length === 0
          ? []
          : [
              `Workers resuming on their own, staggered: ${waiting.map(({ worker, at }) => `${named(worker.threadId)} at ${resumeText(at, now)}`).join(", ")}. Don't message them to restart; it isn't a failure.`,
            ]),
      ].join(" ");
    });

  return {
    cancelDelivery,
    armWake,
    wake,
    wakeFor,
    forgetReasons,
    deliveryFor,
    onWakeDue,
    addNote,
    noteQuietly,
  };
};

/** What `makeDigests` makes, for the parts whose `deps` take some of it. */
export type Digests = ReturnType<typeof makeDigests>;
