import {
  ciFixOwnedPrs,
  ciFixPrKey,
  ledgerPrsOf,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkerError,
  type WorkerPr,
  type WorkspaceId,
} from "@gram/contracts";

import { unseenAttention } from "@/sidebar/attention";
import { needsYou } from "@/sidebar/grouping";
import { failureLabel } from "@/thread/failure-kinds";

import { liveWorkerEntry, workerTitle } from "./board-model";

// What needs the user beside the asks, shared by every view that counts it: workers stopped on an
// error, and failing CI that no live worker owns (`ciFixOwnedPrs`). The Board shows them as
// its Failing strip, and Needs you counts them with the asks, with the errors of threads outside any
// workspace. Dismissing one (`inbox.cleared`) holds for that occurrence only. No React.

/**
 * A worker stopped on an error, or a PR of its with failing checks; or a thread that needs the user
 * for what has no item of its own: its PR's attention unseen, or its babysit stopped.
 */
interface NeedsYouFailure {
  readonly kind: "error" | "checks" | "review" | "babysit" | "thread";
  readonly threadId: ThreadId;
  readonly title: string;
  readonly project: string;
  /** A few words: "Spending limit", "#412 checks failing". */
  readonly tag: string;
  readonly error?: WorkerError | undefined;
  readonly pr?: WorkerPr | undefined;
  /** Epoch ms the turn failed, when the thread's own error says. */
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

/**
 * A thread stopped on `error`, as one failure: its id names the failed turn by when it failed (the
 * thread's own error says), so a dismiss holds only until it fails again.
 */
const errorItem = (
  where: Pick<FailureItem, "workspaceId" | "feature">,
  failure: Pick<NeedsYouFailure, "threadId" | "title" | "project">,
  error: WorkerError,
  at: number | undefined,
): FailureItem => {
  const id = `failure:error:${failure.threadId}:${at ?? error.text}`;
  return {
    ...where,
    kind: "failure",
    key: id,
    ids: [id],
    failure: { ...failure, kind: "error", tag: failureLabel(error.kind), error, at },
  };
};

/**
 * A ledger's failures: workers whose live state is `error` (as the board shows them), and open PRs
 * of theirs whose checks fail. Each id names the occurrence, a failed turn by when it failed and a
 * red build by its head where the thread's own PR status knows it, so a clear holds only until it
 * fails again.
 */
const failuresOf = (
  ledger: OrchestratorLedger,
  byId: Readonly<Record<string, ThreadSummary>>,
): FailureItem[] => {
  const owned = ciFixOwnedPrs(
    ledger.features.flatMap((feature) =>
      feature.workers.flatMap((worker) => {
        const summary = byId[worker.threadId];
        return summary === undefined || summary.thread.parked
          ? []
          : [liveWorkerEntry(worker, summary)];
      }),
    ),
  );
  return ledger.features.flatMap((feature) =>
    feature.workers.flatMap((worker) => {
      const summary = byId[worker.threadId];
      const live = liveWorkerEntry(worker, summary);

      const title = workerTitle(worker, summary);
      const base = {
        workspaceId: ledger.workspaceId,
        feature: worker.feature,
        kind: "failure" as const,
      };
      const out: FailureItem[] = [];
      const error = summary?.thread.lastError ?? worker.lastError;
      if (live.state === "error" && error !== undefined) {
        out.push(
          errorItem(
            base,
            { threadId: worker.threadId, title, project: worker.project },
            error,
            summary?.thread.lastError?.at,
          ),
        );
      }
      for (const pr of ledgerPrsOf(worker)) {
        if (
          pr.state === "merged" ||
          pr.state === "closed" ||
          pr.checks?.split(" ")[0] !== "failing"
        )
          continue;
        if (owned.has(ciFixPrKey(pr))) continue;
        const own = summary?.git?.pr;
        const head =
          own?.number === pr.number && (pr.url === undefined || own.url === pr.url)
            ? (own.headRefOid ?? "")
            : "";
        const id = `failure:checks:${pr.repo}#${pr.number}:${head}`;
        out.push({
          ...base,
          key: id,
          ids: [id],
          failure: {
            kind: "checks",
            threadId: worker.threadId,
            title,
            project: worker.project,
            tag: `#${pr.number} checks failing`,
            pr,
          },
        });
      }
      return out;
    }),
  );
};

/**
 * The workspace's failures as the Board's strip lists them: each once (one PR two workers follow is
 * one failure), less those dismissed or otherwise set aside (`hidden`).
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

/** What a thread in error without an error of its own says: a turn failed, nobody said how. */
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
          ? ["babysit", "Babysit stopped", `babysit:${thread.lastActivityAt}`]
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
          at: thread.lastActivityAt,
        },
      },
    ];
  });
