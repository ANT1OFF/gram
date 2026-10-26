import type { FinishedWorkerDetail, ThreadId } from "@gram/contracts";
import {
  Archive,
  ChevronRight,
  FileDiff,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { ExpandPresence } from "@/motion";
import { OutboundLink } from "@/panels/outbound-link";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";
import { splitSubagents } from "@/thread/parts";
import { ReadOnlyTranscript } from "@/thread/read-only-transcript";
import { Transcript } from "@/thread/transcript";

import { aboutFinishedWorker, startOrchestratorMessage } from "./ask-about";
import { useWorkspaces } from "./use-orchestration";
import { finishedRow } from "./workers-model";

/** The changed files shown before "more". */
const FILES_SHOWN = 6;

const NO_STREAMING = new Set<string>();
const NO_TURN_ENDS = new Map();

/** The orchestrator to ask about a finished worker: the one it reported to, else the workspace's. */
function useAskTarget(detail: FinishedWorkerDetail): ThreadId | undefined {
  const workspaces = useWorkspaces();
  const own = detail.worker.orchestratorThreadId;
  const ownOpen = useThreadsStore((s) => own !== undefined && s.byId[own] !== undefined);
  if (own !== undefined && ownOpen) return own;
  return workspaces.find((state) => state.workspace.id === detail.worker.workspaceId)?.workspace
    .orchestratorThreadId;
}

/**
 * A worker whose worktree was cleaned up, read-only, from what Gram kept of it: the brief it was
 * given, its PRs and last report, the files it changed and its transcript, or the archived
 * transcript alone once only the archive has it. "Ask about it" starts a message to the
 * orchestrator with the worker's context and leaves it in the composer.
 */
export function FinishedWorkerView({ detail }: { detail: FinishedWorkerDetail }) {
  const { worker } = detail;
  const now = useNow(true, undefined, 60_000);
  const row = finishedRow(worker, now);
  const workspaces = useWorkspaces();
  const workspaceName =
    workspaces.find((state) => state.workspace.id === worker.workspaceId)?.workspace.name ??
    "Workspace";
  const target = useAskTarget(detail);
  const open = useOpenThread();
  const { top, children, subagentUsage } = useMemo(
    () => splitSubagents(detail.messages),
    [detail.messages],
  );
  const separator = (
    <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
  );

  return (
    <div
      data-pane-root
      data-testid="finished-worker"
      data-kept={worker.kept}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header
        data-testid="pane-header"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-sm"
      >
        <h1
          aria-label={`Worker: ${worker.title}`}
          className="flex min-w-0 items-center gap-1 font-heading font-medium"
        >
          <span className="max-w-40 min-w-0 shrink-[6] truncate font-normal text-muted-foreground">
            {workspaceName}
          </span>
          {separator}
          <span className="max-w-40 min-w-0 shrink-[6] truncate font-normal text-muted-foreground">
            {worker.feature}
          </span>
          {separator}
          <span className="min-w-0 truncate">{worker.title}</span>
        </h1>
        {row.glyph === "merged" ? (
          <GitMerge aria-hidden className="size-3.5 shrink-0 text-merged" />
        ) : (
          <Archive aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span data-testid="finished-when" className="shrink-0 text-xs text-muted-foreground">
          {row.now}
        </span>
      </header>
      <div
        data-testid="finished-note"
        className="flex shrink-0 items-center gap-2 border-b border-border bg-card/40 px-4 py-1.5 text-xs text-muted-foreground"
      >
        <Archive aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Worktree cleaned up · read-only</span>
        <Button
          size="xs"
          variant="outline"
          data-testid="finished-ask"
          disabled={target === undefined}
          onClick={() => {
            if (target !== undefined)
              startOrchestratorMessage(target, aboutFinishedWorker(worker), open);
          }}
        >
          <MessageSquare data-icon="inline-start" />
          Ask about it
        </Button>
      </div>
      <FinishedFacts detail={detail} />
      <ReadOnlyTranscript.Provider value>
        {detail.messages.length > 0 ? (
          <Transcript
            threadId={worker.threadId}
            loading={false}
            messages={top}
            subagents={children}
            subagentUsage={subagentUsage}
            streamingIds={NO_STREAMING}
            turnEnds={NO_TURN_ENDS}
            animate={false}
            jump={undefined}
          />
        ) : detail.archived !== undefined ? (
          <div
            data-testid="finished-archived"
            className="mx-auto min-h-0 w-full max-w-(--thread-max-width) flex-1 overflow-y-auto px-6 py-4 text-sm leading-relaxed"
          >
            <MessageResponse>{detail.archived}</MessageResponse>
          </div>
        ) : (
          <p className="flex-1 px-6 py-8 text-center text-sm text-muted-foreground">
            No transcript kept
          </p>
        )}
      </ReadOnlyTranscript.Provider>
    </div>
  );
}

/** The brief, PRs, last report and changed files, above the transcript and compact. */
function FinishedFacts({ detail }: { detail: FinishedWorkerDetail }) {
  const { worker, files } = detail;
  const [allFiles, setAllFiles] = useState(false);
  const report = worker.lastReport;
  if (
    detail.brief === undefined &&
    worker.prs.length === 0 &&
    report === undefined &&
    files.length === 0
  ) {
    return null;
  }
  const shown = allFiles ? files : files.slice(0, FILES_SHOWN);
  return (
    <section
      aria-label="What it did"
      data-testid="finished-facts"
      className="mx-auto flex w-full max-w-(--thread-max-width) shrink-0 flex-col gap-2 px-6 py-3 text-sm"
    >
      {detail.brief !== undefined && (
        <div className="rounded-md border border-border bg-card/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Brief</div>
          <p data-testid="finished-brief" className="line-clamp-3" title={detail.brief}>
            {detail.brief}
          </p>
        </div>
      )}
      {(worker.prs.length > 0 || report !== undefined) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {worker.prs.map((pr) => (
            <OutboundLink
              key={`${pr.repo}#${pr.number}`}
              href={pr.url}
              className="inline-flex items-center gap-1 text-xs text-foreground/80 hover:text-foreground"
            >
              {pr.merged === true ? (
                <GitMerge aria-hidden className="size-3 text-merged" />
              ) : (
                <GitPullRequest aria-hidden className="size-3 text-muted-foreground" />
              )}
              {pr.repo.split("/").pop()}#{pr.number}
            </OutboundLink>
          ))}
          {report !== undefined && (
            <p
              data-testid="finished-report"
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={report.summary}
            >
              Reported {report.state}: {report.summary}
            </p>
          )}
        </div>
      )}
      {files.length > 0 && (
        <div data-testid="finished-files" className="text-xs">
          <div className="flex items-center gap-1 text-muted-foreground">
            <FileDiff aria-hidden className="size-3" />
            {files.length} {files.length === 1 ? "file" : "files"} changed
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {shown.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 text-success">+{file.additions}</span>
                <span className="shrink-0 text-destructive">−{file.deletions}</span>
              </li>
            ))}
          </ul>
          <ExpandPresence open={!allFiles && files.length > FILES_SHOWN}>
            <button
              type="button"
              className={cn(
                "mt-1 rounded-sm px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              )}
              onClick={() => setAllFiles(true)}
            >
              {files.length - FILES_SHOWN} more
            </button>
          </ExpandPresence>
        </div>
      )}
    </section>
  );
}
