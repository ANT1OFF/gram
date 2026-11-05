import type { DraftId, Thread, ThreadId, WorkerLedgerEntry } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileDiff, GitPullRequest, History, Play } from "lucide-react";

import { carryDraft } from "@/composer/draft-prefill";
import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { formatStamp } from "@/lib/time";
import { reportLine } from "@/orchestration/board-model";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";
import { workerEntryOf } from "@/orchestration/workers-model";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

/** The most of a report's summary the outcome shows. */
const SUMMARY_MAX = 600;

/** The PR a thread ended with: the ledger's, which knows its state, else the one it was bound to. */
interface OutcomePr {
  readonly number: number;
  readonly repo: string | undefined;
  readonly state: "open" | "merged" | "closed" | undefined;
}

const outcomePr = (thread: Thread, entry: WorkerLedgerEntry | undefined): OutcomePr | undefined => {
  if (entry?.pr !== undefined)
    return { number: entry.pr.number, repo: entry.pr.repo, state: entry.pr.state };
  if (thread.boundPr !== undefined)
    return { number: thread.boundPr.number, repo: thread.boundPr.repo, state: undefined };
  const merged = thread.settledMerge?.merged.at(-1);
  return merged === undefined
    ? undefined
    : { number: merged.number, repo: undefined, state: "merged" };
};

/**
 * Whether `thread` has done work, by what it left behind other than messages: an agent session that
 * was used, a report, a PR or a completion. A thread with none of these has simply not started.
 */
export const threadDidWork = (thread: Thread, entry: WorkerLedgerEntry | undefined): boolean =>
  (thread.agentSessionId !== undefined && thread.agentSessionUnused !== true) ||
  thread.completedAt !== undefined ||
  thread.boundPr !== undefined ||
  thread.settledMerge !== undefined ||
  entry?.lastReport !== undefined;

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`;

/**
 * The brief "Resume from report" starts a new draft with: what the thread was, its last report and
 * its PR, for the user to edit and start like any other. Nothing of the old conversation is in it,
 * since that isn't here.
 */
export const resumeBrief = (
  title: string,
  report: { readonly at: number; readonly summary: string } | undefined,
  pr: OutcomePr | undefined,
): string => {
  const lines = [`Pick up where "${title}" left off.`];
  if (report !== undefined) {
    lines.push("", `Its last report (${formatStamp(report.at)}):`, report.summary.trim());
  }
  if (pr !== undefined) {
    const where = pr.repo === undefined ? "" : ` in ${pr.repo}`;
    const state = pr.state === undefined ? "" : ` (${pr.state})`;
    lines.push("", `Its pull request: #${pr.number}${where}${state}.`);
  }
  return lines.join("\n");
};

/**
 * A transcript with no messages. A thread that hasn't started says so; one that did work whose
 * conversation isn't here, such as a finished worker opened from History, shows what Gram kept of
 * it: how it ended, its last report, its PR and its changed files, each a click from its panel.
 */
export function EmptyThread({ threadId }: { threadId: ThreadId }) {
  const navigate = useNavigate();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const worker = thread?.spawnedBy !== undefined;
  const { data: ledger } = useOrchestratorLedger(worker ? thread?.workspaceId : undefined);
  const entry = workerEntryOf(ledger?.features, threadId);

  if (thread === undefined || !threadDidWork(thread, entry)) {
    return (
      <p data-testid="transcript-empty" className="p-6 text-reading text-muted-foreground">
        No messages yet.
      </p>
    );
  }

  const report = entry?.lastReport;
  const pr = outcomePr(thread, entry);
  const changed = entry?.changedFiles ?? git?.changedFiles ?? 0;
  const ended =
    thread.completedAt === undefined
      ? undefined
      : `${pr?.state === "merged" ? "Merged" : "Completed"} ${formatStamp(thread.completedAt)}`;
  const show = (panel: "pr" | "diff") =>
    useLayoutStore.getState().requestPanel({ threadId, panel }, threadId);
  // A new draft with the report as its brief, through the same New form and its Start as any other:
  // a worker's to a new worker of its workspace, anything else to a one-off thread.
  const resume = () => {
    carryDraft({
      text: resumeBrief(thread.title, report, pr),
      draftId: crypto.randomUUID() as DraftId,
      attachments: [],
    });
    if (worker && thread.workspaceId !== undefined) {
      void navigate({
        to: "/new-task",
        search: { way: "direct", workspace: thread.workspaceId },
      });
    } else {
      void navigate({ to: "/new" });
    }
  };

  return (
    <section
      data-testid="thread-outcome"
      aria-labelledby={`${threadId}-outcome`}
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-3 p-6 text-reading"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${threadId}-outcome`} className="font-medium">
          Outcome
          {ended !== undefined && (
            <span className="ms-2 text-meta font-normal text-muted-foreground tabular-nums">
              {ended}
            </span>
          )}
        </h2>
        <p data-testid="thread-outcome-note" className="text-meta text-muted-foreground">
          This thread&apos;s conversation isn&apos;t available on this computer, so this is what
          Gram saved about its work.
        </p>
      </div>
      {report !== undefined && (
        <div data-testid="thread-outcome-report" className="flex flex-col gap-0.5">
          <p className="text-meta text-muted-foreground tabular-nums">
            Last report · {formatStamp(report.at)}
          </p>
          <p className="whitespace-pre-line">{reportLine(report.summary, SUMMARY_MAX)}</p>
        </div>
      )}
      <div
        role="group"
        aria-label="What to do next"
        data-testid="thread-outcome-actions"
        className="flex flex-wrap items-center gap-2"
      >
        {pr !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="thread-outcome-pr"
            onClick={() => show("pr")}
          >
            <GitPullRequest data-icon="inline-start" />
            Open PR #{pr.number}
            {pr.repo !== undefined && (
              <span className="text-muted-foreground">{pr.repo.split("/").at(-1)}</span>
            )}
            {pr.state !== undefined && <span className="text-muted-foreground">{pr.state}</span>}
          </Button>
        )}
        {changed > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="thread-outcome-files"
            onClick={() => show("diff")}
          >
            <FileDiff data-icon="inline-start" />
            {files(changed)}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="thread-outcome-history"
          onClick={() => useHistoryStore.getState().show("all", thread.title)}
        >
          <History data-icon="inline-start" />
          Find in History
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="thread-outcome-resume"
          title="Opens New with its last report as the brief. Nothing starts until you start it."
          onClick={resume}
        >
          <Play data-icon="inline-start" />
          Resume from report
        </Button>
      </div>
    </section>
  );
}
