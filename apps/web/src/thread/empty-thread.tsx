import type {
  DiffFile,
  DraftId,
  GitState,
  Thread,
  ThreadId,
  WorkerLedgerEntry,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleX, GitBranch, type LucideIcon } from "lucide-react";

import { useApi } from "@/api/context";
import { carryDraft } from "@/composer/draft-prefill";
import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import { reportLine } from "@/orchestration/board-model";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";
import { workerEntryOf } from "@/orchestration/workers-model";
import { FILE_STATUS } from "@/panels/diff-files";
import { prDetailQuery, prDetailStamp } from "@/panels/pr-detail-query";
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

const outcomePr = (
  thread: Thread,
  entry: WorkerLedgerEntry | undefined,
  git?: GitState | undefined,
): OutcomePr | undefined => {
  if (entry?.pr !== undefined)
    return { number: entry.pr.number, repo: entry.pr.repo, state: entry.pr.state };
  if (git?.pr !== undefined)
    return {
      number: git.pr.number,
      repo: git.origin,
      state: git.pr.state === "MERGED" ? "merged" : git.pr.state === "CLOSED" ? "closed" : "open",
    };
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

const filesChanged = (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`;

/** A saved PR state in the outcome's words. */
const PR_STATE: Readonly<Record<NonNullable<OutcomePr["state"]>, string>> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed without merging",
};

/** How a PR's checks last read, in words, with the mark and tone the outcome shows them in. */
export const checksOutcome = (
  checks: string | undefined,
): { word: string; icon: LucideIcon; tone: string } | undefined => {
  switch (checks) {
    case "passing":
      return { word: "Passed", icon: CircleCheck, tone: "text-success" };
    case "failing":
      return { word: "Failed", icon: CircleX, tone: "text-destructive" };
    case "pending":
      return { word: "Still running when it was saved", icon: CircleDashed, tone: "" };
    case "none":
      return { word: "None ran", icon: CircleDashed, tone: "" };
    default:
      return undefined;
  }
};

/** GitHub's review decision in words; undefined where none was read. */
const REVIEW: Readonly<Record<string, string>> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

/** One labelled fact of the saved outcome: its term, then its value and the action beside it. */
function Fact({ term, testId, children }: { term: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="contents">
      <dt className="text-meta text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{children}</dd>
    </div>
  );
}

/** The most of a PR's files the outcome lists; "Review all" opens the rest in the PR panel. */
const OUTCOME_FILES_MAX = 8;

/**
 * What the thread's PR changed, file by file with its lines added and removed, each a click from
 * its diff in the PR panel; "Review in PR" opens them all there.
 */
function OutcomeFiles({
  number,
  files,
  onReview,
  onFile,
}: {
  number: number;
  files: readonly DiffFile[];
  onReview: () => void;
  onFile: (path: string) => void;
}) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const shown = files.slice(0, OUTCOME_FILES_MAX);
  const more = files.length - shown.length;
  return (
    <section
      aria-labelledby="thread-outcome-files-title"
      data-testid="thread-outcome-pr-files"
      className="flex flex-col gap-2 pt-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="thread-outcome-files-title" className="text-body-strong">
          Changed in PR #{number}
        </h3>
        <span className="text-meta text-muted-foreground tabular-nums">
          {files.length} {files.length === 1 ? "file" : "files"}{" "}
          <span className="font-mono text-success">+{additions}</span>{" "}
          <span className="font-mono text-destructive">−{deletions}</span>
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ms-auto self-center"
          data-testid="thread-outcome-review"
          onClick={onReview}
        >
          Review in PR
        </Button>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-lg border border-edge-group bg-card [&>li~li]:border-t [&>li~li]:border-border/60">
        {shown.map((file) => {
          const status = FILE_STATUS[file.status];
          return (
            <li key={file.path}>
              <button
                type="button"
                data-testid="thread-outcome-pr-file"
                data-path={file.path}
                title={`Review ${file.path} in PR #${number}`}
                onClick={() => onFile(file.path)}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-meta outline-none hover:bg-accent focus-visible:focus-ring"
              >
                <status.icon aria-hidden className={cn("size-icon-row shrink-0", status.tone)} />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                <span className="sr-only">{status.label}</span>
                <span className="shrink-0 font-mono tabular-nums">
                  <span className="text-success">+{file.additions}</span>{" "}
                  <span className="text-destructive">−{file.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
        {more > 0 && (
          <li>
            <button
              type="button"
              onClick={onReview}
              className="flex w-full px-3 py-2 text-left text-meta text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring"
            >
              {more} more in the PR
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

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
  const api = useApi();
  const navigate = useNavigate();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const worker = thread?.spawnedBy !== undefined;
  const { data: ledger } = useOrchestratorLedger(worker ? thread?.workspaceId : undefined);
  const entry = workerEntryOf(ledger?.features, threadId);
  // The PR's files, from the same query (and cache) the PR panel reads: what a finished thread
  // changed, after its worktree is gone.
  const prStamp = prDetailStamp(git, thread?.boundPr);
  const { data: prResult } = useQuery({
    ...prDetailQuery(api, threadId, prStamp),
    enabled: prStamp !== null && thread !== undefined && threadDidWork(thread, entry),
  });
  const prDetail = prResult?.detail;

  if (thread === undefined || !threadDidWork(thread, entry)) {
    return (
      <p data-testid="transcript-empty" className="p-6 text-reading text-muted-foreground">
        No messages yet.
      </p>
    );
  }

  const report = entry?.lastReport;
  const pr = outcomePr(thread, entry, git);
  const changed = entry?.changedFiles ?? git?.changedFiles ?? 0;
  const checks = checksOutcome(entry?.pr?.checks ?? git?.pr?.checks);
  const review =
    entry?.pr?.reviewDecision === undefined ? undefined : REVIEW[entry.pr.reviewDecision];
  const branch = entry?.branch ?? git?.branch ?? thread.checkout.branch;
  const base = git?.pr?.baseRef;
  const ended =
    thread.completedAt === undefined
      ? undefined
      : `${pr?.state === "merged" ? "Merged" : "Completed"} ${formatStamp(thread.completedAt)}`;
  const show = (panel: "pr" | "diff", target?: string) =>
    useLayoutStore
      .getState()
      .requestPanel({ threadId, panel, ...(target === undefined ? {} : { target }) }, threadId);
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

  // When it happened, from what Gram kept: started, last reported, and how it ended.
  const times: readonly { term: string; at: number }[] = [
    { term: "Started", at: thread.createdAt },
    ...(report === undefined ? [] : [{ term: "Last report", at: report.at }]),
    ...(thread.completedAt === undefined
      ? []
      : [{ term: pr?.state === "merged" ? "Merged" : "Completed", at: thread.completedAt }]),
  ];
  const evidence = report?.evidence;

  return (
    <section
      data-testid="thread-outcome"
      aria-labelledby={`${threadId}-outcome`}
      className="mx-auto grid w-full max-w-(--settings-column-wide) grid-cols-1 content-start gap-x-8 gap-y-6 p-6 text-reading lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]"
    >
      <header className="flex flex-col gap-1 lg:col-span-2">
        <h2 id={`${threadId}-outcome`} className="font-heading text-title">
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
      </header>
      {/* The story, read first: its last report in full, what it was checked with, and what next. */}
      <div className="flex min-w-0 flex-col gap-4">
        {report === undefined ? (
          <p data-testid="thread-outcome-no-report" className="text-muted-foreground">
            It left no report.
          </p>
        ) : (
          <div data-testid="thread-outcome-report" className="flex flex-col gap-1">
            <p className="text-meta text-muted-foreground tabular-nums">
              Last report · {formatStamp(report.at)}
            </p>
            <p className="whitespace-pre-line">{reportLine(report.summary, SUMMARY_MAX)}</p>
          </div>
        )}
        {evidence !== undefined && (
          <dl
            aria-label="What it was checked with"
            data-testid="thread-outcome-evidence"
            className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2"
          >
            <Fact term="Checked with" testId="thread-outcome-gate">
              {evidence.gate}
            </Fact>
            <Fact term="Head" testId="thread-outcome-head">
              <span className="font-mono text-meta">{evidence.headSha.slice(0, 7)}</span>
            </Fact>
            <Fact term="Next step" testId="thread-outcome-next">
              {evidence.nextStep}
            </Fact>
          </dl>
        )}
        <div
          role="group"
          aria-label="What to do next"
          data-testid="thread-outcome-actions"
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            type="button"
            size="sm"
            data-testid="thread-outcome-resume"
            title="Opens New with its last report as the brief. Nothing starts until you start it."
            onClick={resume}
          >
            Resume from report
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="thread-outcome-history"
            onClick={() => useHistoryStore.getState().show("all", thread.title)}
          >
            Find in History
          </Button>
        </div>
        {prDetail !== undefined && prDetail.files.length > 0 && (
          <OutcomeFiles
            number={prDetail.number}
            files={prDetail.files}
            onReview={() => show("pr")}
            onFile={(path) => show("pr", path)}
          />
        )}
      </div>
      {/* Beside it, the facts Gram saved of how it ended, and when each thing happened. */}
      <aside
        aria-label="What it left"
        className="flex min-w-0 flex-col gap-6 lg:border-s lg:border-border lg:ps-8"
      >
        <dl
          aria-label="Saved outcome"
          data-testid="thread-outcome-facts"
          className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2"
        >
          {pr !== undefined && (
            <Fact term="Pull request" testId="thread-outcome-fact-pr">
              <span className="tabular-nums">
                #{pr.number}
                {pr.repo !== undefined && (
                  <span className="text-muted-foreground"> {pr.repo.split("/").at(-1)}</span>
                )}
              </span>
              {pr.state !== undefined && (
                <span data-testid="thread-outcome-pr-state">· {PR_STATE[pr.state]}</span>
              )}
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-testid="thread-outcome-pr"
                onClick={() => show("pr")}
              >
                Open PR #{pr.number}
              </Button>
            </Fact>
          )}
          {checks !== undefined && (
            <Fact term="Checks" testId="thread-outcome-checks">
              <span className="flex items-center gap-1.5">
                <checks.icon aria-hidden className={cn("size-icon-row shrink-0", checks.tone)} />
                {checks.word}
              </span>
            </Fact>
          )}
          {review !== undefined && (
            <Fact term="Review" testId="thread-outcome-review">
              {review}
            </Fact>
          )}
          {branch !== undefined && (
            <Fact term="Branch" testId="thread-outcome-branch">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                <GitBranch aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-meta">{branch}</span>
                {base !== undefined && (
                  <span className="text-meta text-muted-foreground">
                    into <span className="font-mono">{base}</span>
                  </span>
                )}
              </span>
            </Fact>
          )}
          <Fact term="Files" testId="thread-outcome-changed">
            {changed > 0 ? (
              <>
                <span className="tabular-nums">{filesChanged(changed)}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-testid="thread-outcome-files"
                  onClick={() => show("diff")}
                >
                  Show changes
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">
                {pr === undefined
                  ? "None left in its worktree"
                  : `None left in its worktree; its changes are in PR #${pr.number}`}
              </span>
            )}
          </Fact>
        </dl>
        <dl
          aria-label="When"
          data-testid="thread-outcome-times"
          className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 border-t border-border pt-4"
        >
          {times.map((time) => (
            <Fact key={time.term} term={time.term} testId="thread-outcome-time">
              <span className="tabular-nums">{formatStamp(time.at)}</span>
            </Fact>
          ))}
        </dl>
      </aside>
    </section>
  );
}
