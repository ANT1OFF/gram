import type { FinishedWorker, OrchestratorLedger } from "@gram/contracts";
import { GitBranch, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { agentLabel } from "@/agents/agent-display";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import { reportLine } from "@/orchestration/board-model";

import type { HistoryEntry } from "./history-model";

/** The most of a report or a first prompt the preview quotes. */
const QUOTE_MAX = 600;

/** What History knows of a row beyond its line, from what Gram already holds. */
export interface HistoryPreviewFacts {
  /** Its last report, for a worker that made one. */
  readonly report?: { readonly summary: string; readonly at: number } | undefined;
  readonly pr?:
    | {
        readonly number: number;
        readonly repo: string | undefined;
        readonly state: "open" | "merged" | "closed" | undefined;
      }
    | undefined;
  readonly branch?: string | undefined;
  /** When its thread was made, where the client holds it. */
  readonly startedAt?: number | undefined;
  /** An imported session's first prompt: what it was about. */
  readonly firstPrompt?: string | undefined;
}

/**
 * A row's facts from its workspace's ledger (a worker still on it), its finished record (one the
 * sweep closed) or, for an imported session, the session itself; `startedAt` from its thread.
 */
export const previewFacts = (
  entry: HistoryEntry,
  sources: {
    readonly ledger: Pick<OrchestratorLedger, "features"> | undefined;
    readonly finished: readonly FinishedWorker[] | undefined;
    readonly startedAt: number | undefined;
  },
): HistoryPreviewFacts => {
  if (entry.session !== undefined) {
    const prompt = entry.session.firstPrompt?.trim();
    return {
      branch: entry.session.gitBranch,
      firstPrompt:
        prompt === undefined || prompt === "" || prompt === entry.title ? undefined : prompt,
    };
  }
  const live = sources.ledger?.features
    .flatMap((feature) => feature.workers)
    .find((worker) => worker.threadId === entry.threadId);
  const closed = sources.finished?.find((worker) => worker.threadId === entry.threadId);
  const report = live?.lastReport ?? closed?.lastReport;
  const closedPr = closed?.prs.find((pr) => pr.merged === true) ?? closed?.prs[0];
  const pr =
    live?.pr !== undefined
      ? { number: live.pr.number, repo: live.pr.repo, state: live.pr.state }
      : closedPr === undefined
        ? undefined
        : {
            number: closedPr.number,
            repo: closedPr.repo,
            state: closedPr.merged === true ? ("merged" as const) : undefined,
          };
  return {
    report:
      report === undefined || report.summary.trim() === ""
        ? undefined
        : { summary: report.summary, at: report.at },
    pr,
    branch: live?.branch,
    startedAt: sources.startedAt,
  };
};

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
    </>
  );
}

/**
 * Beside History's list, the row the cursor is on: what it was, how and when it ended, and what Gram
 * kept of it (its PR, its branch, its last report or an imported session's first prompt), so a row
 * can be told apart from its neighbours before it is opened.
 */
export function HistoryPreview({
  entry,
  facts,
  glyph,
  word,
  when,
  where,
  action,
}: {
  entry: HistoryEntry;
  facts: HistoryPreviewFacts;
  glyph: { icon: LucideIcon; tone: string };
  /** Its outcome in words. */
  word: string;
  /** When it finished, in full. */
  when: string;
  /** Its workspace and repo, each said once. */
  where: string;
  /** What Return does to it. */
  action: string;
}) {
  const { report, pr, branch, startedAt, firstPrompt } = facts;
  return (
    <aside
      aria-label="Selected"
      data-testid="history-preview"
      data-thread-id={entry.threadId}
      className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-s border-border p-4 text-meta md:flex"
    >
      <div className="flex flex-col gap-1">
        <h3 data-testid="history-preview-title" className="text-body-strong break-words">
          {entry.title}
        </h3>
        {where !== "" && <p className="text-muted-foreground">{where}</p>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
        <Fact term={entry.outcome === undefined ? "Kind" : "Outcome"}>
          <glyph.icon
            aria-hidden
            className={cn("size-icon-chip shrink-0 self-center", glyph.tone)}
          />
          <span className="capitalize">{word}</span>
        </Fact>
        <Fact term={entry.outcome === undefined ? "Last active" : "Finished"}>
          <span className="tabular-nums">{when}</span>
        </Fact>
        {startedAt !== undefined && (
          <Fact term="Started">
            <span className="tabular-nums">{formatStamp(startedAt)}</span>
          </Fact>
        )}
        {entry.agent !== undefined && <Fact term="Agent">{agentLabel(entry.agent)}</Fact>}
        {pr !== undefined && (
          <Fact term="Pull request">
            <span data-testid="history-preview-pr" className="tabular-nums">
              #{pr.number}
              {pr.repo !== undefined && (
                <span className="text-muted-foreground"> {pr.repo.split("/").at(-1)}</span>
              )}
              {pr.state !== undefined && ` · ${pr.state}`}
            </span>
          </Fact>
        )}
        {branch !== undefined && (
          <Fact term="Branch">
            <GitBranch
              aria-hidden
              className="size-icon-chip shrink-0 self-center text-muted-foreground"
            />
            <span className="truncate font-mono">{branch}</span>
          </Fact>
        )}
      </dl>
      {report !== undefined && (
        <div data-testid="history-preview-report" className="flex flex-col gap-1">
          <p className="text-muted-foreground tabular-nums">
            Last report · {formatStamp(report.at)}
          </p>
          <p className="text-body whitespace-pre-line">{reportLine(report.summary, QUOTE_MAX)}</p>
        </div>
      )}
      {firstPrompt !== undefined && (
        <div data-testid="history-preview-prompt" className="flex flex-col gap-1">
          <p className="text-muted-foreground">First prompt</p>
          <p className="line-clamp-6 text-body break-words whitespace-pre-line">
            {firstPrompt.slice(0, QUOTE_MAX)}
          </p>
        </div>
      )}
      <p className="mt-auto text-muted-foreground">
        {action === "Resume"
          ? "Return resumes it in a new thread."
          : entry.cleanedUp === true
            ? "Return opens it, read-only: its worktree was cleaned up."
            : "Return opens it where it is."}
      </p>
    </aside>
  );
}
