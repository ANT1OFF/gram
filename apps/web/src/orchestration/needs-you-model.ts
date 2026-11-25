import type {
  BabysitStopReason,
  OrchestratorLedger,
  ThreadId,
  ThreadSummary,
  SavedWork,
  ThreadError,
  WorkerError,
  WorkspaceId,
} from "@gram/contracts";

import { STOP_REASON_TEXT } from "@/panels/review/babysit-model";
import { unseenAttention } from "@/sidebar/attention";
import { needsYou } from "@/sidebar/grouping";
import { failureLabel } from "@/thread/failure-kinds";
import { MACHINE_LOST_TAG, machineLostDetail } from "@/thread/saved-work-words";

import { liveWorkerEntry, workerTitle } from "./board-model";

/**
 * What a stopped Watch PR (babysit) reads as in the Inbox: the watch stopped, in plain words, not a
 * failing PR. "Watching #172 stopped: PR merged", or without a reason or number when it has none.
 */
export const watchStoppedText = (
  number: number | undefined,
  reason: BabysitStopReason | undefined,
): string =>
  `Watching ${number === undefined ? "the PR" : `#${number}`} stopped${reason === undefined ? "" : `: ${STOP_REASON_TEXT[reason]}`}`;

interface NeedsYouFailure {
  readonly kind: "error" | "checks" | "review" | "babysit" | "thread";
  readonly threadId: ThreadId;
  readonly title: string;
  readonly project: string;
  readonly tag: string;
  readonly error?: WorkerError | undefined;
  readonly pr?: { readonly number: number } | undefined;
  readonly at?: number | undefined;
}

/** A failure as a needs-you item: keyed by its occurrence, which is what a dismiss hides. */
export interface FailureItem {
  readonly kind: "failure";
  /** Unique across the workspace's failures. */
  readonly key: string;
  /** What a dismiss hides. */
  readonly ids: readonly string[];
  /** Absent for a thread outside any workspace. */
  readonly workspaceId: WorkspaceId | undefined;
  readonly feature: string | undefined;
  readonly failure: NeedsYouFailure;
}

const errorItem = (
  where: Pick<FailureItem, "workspaceId" | "feature">,
  failure: Pick<NeedsYouFailure, "threadId" | "title" | "project">,
  error: WorkerError | ThreadError,
  at: number | undefined,
  saved?: SavedWork | undefined,
): FailureItem => {
  const id = `failure:error:${failure.threadId}:${at ?? error.text}`;
  const lost =
    ("machineLost" in error && error.machineLost !== undefined) ||
    ("lostMachine" in error && error.lostMachine === true);
  if (lost && at !== undefined)
    return {
      ...where,
      kind: "failure",
      key: id,
      ids: [id],
      failure: {
        ...failure,
        kind: "error",
        tag: MACHINE_LOST_TAG,
        error: { kind: error.kind, text: machineLostDetail({ at }, saved) },
        at,
      },
    };
  return {
    ...where,
    kind: "failure",
    key: id,
    ids: [id],
    failure: { ...failure, kind: "error", tag: failureLabel(error.kind), error, at },
  };
};

const failuresOf = (
  ledger: OrchestratorLedger,
  byId: Readonly<Record<string, ThreadSummary>>,
): FailureItem[] =>
  ledger.features.flatMap((feature) =>
    feature.workers.flatMap((worker) => {
      const summary = byId[worker.threadId];
      const live = liveWorkerEntry(worker, summary);
      const error = summary?.thread.lastError ?? worker.lastError;
      if (live.state !== "error" || error === undefined) return [];
      return [
        errorItem(
          { workspaceId: ledger.workspaceId, feature: worker.feature },
          {
            threadId: worker.threadId,
            title: workerTitle(worker, summary),
            project: worker.project,
          },
          error,
          summary?.thread.lastError?.at,
          summary?.thread.savedWork,
        ),
      ];
    }),
  );

/**
 * The workspace's failures as the Board's strip lists them: each once, less those dismissed or
 * otherwise set aside (`hidden`).
 */
export const standingFailures = (
  ledger: OrchestratorLedger | undefined,
  byId: Readonly<Record<string, ThreadSummary>>,
  hidden: ReadonlySet<string>,
): readonly FailureItem[] => {
  if (ledger === undefined) return [];
  const seen = new Set<string>();
  return failuresOf(ledger, byId).filter((item) => {
    if (seen.has(item.key) || item.ids.some((id) => hidden.has(id))) return false;
    seen.add(item.key);
    return true;
  });
};

const UNEXPLAINED: WorkerError = { kind: "unknown", text: "" };

/**
 * The errors of threads outside any workspace (`threads`), each a failure while the thread needs the
 * user by `needsYou`, as the window title and the dock badge count it, less those dismissed. One
 * whose error isn't recorded is dated by its last activity.
 */
export const soloFailures = (
  threads: readonly ThreadSummary[],
  hidden: ReadonlySet<string>,
  projectName: (projectId: string) => string | undefined = () => undefined,
): readonly FailureItem[] =>
  threads.flatMap((summary) => {
    const { thread } = summary;
    if (summary.status !== "error" || !needsYou(summary)) return [];
    const item = errorItem(
      { workspaceId: undefined, feature: undefined },
      { threadId: thread.id, title: thread.title, project: projectName(thread.projectId) ?? "" },
      thread.lastError ?? UNEXPLAINED,
      thread.lastError?.at ?? thread.lastActivityAt,
    );
    return item.ids.some((id) => hidden.has(id)) ? [] : [item];
  });

/** What a thread whose machine never came is listed for. */
export const NO_MACHINE_TAG = "No machine started";

/**
 * What else a thread needing the user (`needsYou`) has to show for it, beside its asks and its
 * error: an item for unseen PR attention, a stopped babysit, or failing that the thread itself, so
 * every thread that needs the user is somewhere in Needs you and its count is the one the window
 * title and the dock badge show. `covered` are threads a failure already shows. Each id names the
 * occurrence, so a dismiss holds until the attention is new again.
 */
export const threadNeedsItems = (
  threads: readonly ThreadSummary[],
  covered: ReadonlySet<ThreadId>,
  hidden: ReadonlySet<string>,
  projectName: (projectId: string) => string | undefined = () => undefined,
): readonly FailureItem[] =>
  threads.flatMap((summary) => {
    const { thread } = summary;
    if (
      summary.pendingRequests.length > 0 ||
      summary.status === "error" ||
      covered.has(thread.id) ||
      !needsYou(summary)
    ) {
      return [];
    }
    const attention = unseenAttention(summary);
    const pr = summary.git?.pr;
    const [kind, tag, occurrence]: [NeedsYouFailure["kind"], string, string] =
      attention !== undefined
        ? [
            attention.reason === "ciFailed" ? "checks" : "review",
            pr === undefined
              ? attention.label
              : `#${pr.number} ${attention.reason === "ciFailed" ? "checks failing" : "changes requested"}`,
            attention.key,
          ]
        : thread.babysit?.phase === "stopped"
          ? [
              "babysit",
              watchStoppedText(pr?.number, thread.babysit.stopReason),
              `babysit:${thread.lastActivityAt}`,
            ]
          : thread.awaitingMachine?.failed !== undefined
            ? ["thread", NO_MACHINE_TAG, `machine:${thread.awaitingMachine.failed.at}`]
            : ["thread", "Needs you", `${summary.status}:${thread.lastActivityAt}`];
    const id = `failure:${kind}:${thread.id}:${occurrence}`;
    if (hidden.has(id)) return [];
    return [
      {
        kind: "failure",
        key: id,
        ids: [id],
        workspaceId: thread.workspaceId,
        feature: undefined,
        failure: {
          kind,
          threadId: thread.id,
          title: thread.title,
          project: projectName(thread.projectId) ?? "",
          tag,
          ...(kind === "checks" || kind === "review"
            ? pr === undefined
              ? {}
              : { pr: { number: pr.number } }
            : {}),
          at: thread.lastActivityAt,
        },
      },
    ];
  });
