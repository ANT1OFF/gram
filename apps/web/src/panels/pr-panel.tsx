import { CiCheckDetail } from "./ci-check-detail";
import type { CheckStatus, PrDetail, PrDetailResult, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleMinus,
  ChevronRight,
  CircleX,
  CloudOff,
  ExternalLink,
  GitCommitHorizontal,
  MessageSquare,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useRef, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { folderProblem } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { MessageResponse } from "@/components/ai-elements/message";
import { mergeStateMarkOf, PrChip, staleReasonText } from "@/components/git-badges";
import { PR_STATE_DISPLAY, prStateMarkOf, reviewMarkOf } from "@/components/pr-marks-model";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agoText } from "@/lib/time";
import { useInSight } from "@/lib/use-in-sight";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { NumberTicker, RingGlyph, RingSpinner, usePresetTransition } from "@/motion";
import { useOpenBoard } from "@/orchestration/open-board";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { useDiffFileActions } from "./diff-file-actions";
import { DiffFileList } from "./diff-files";
import { FolderMissing } from "./folder-missing";
import { OutboundLink } from "./outbound-link";
import { PanelMessage } from "./panel-message";
import { PrActions, UpdateBranch } from "./pr-actions";
import { keepSamePr, prDetailQuery, prDetailStamp } from "./pr-detail-query";
import { ifTarget, identityOf, prTargetOf } from "./pr-identity";
import { PrPeople } from "./pr-people";
import { RefreshButton } from "./refresh-button";
import { CreatePrButton } from "@/components/create-pr-dialog";
import { PrElsewhereNotice } from "@/components/pr-elsewhere";
import { PushButton } from "@/components/push-button";

import { PrBinding } from "./review/pr-binding";
import { PrWatch } from "./review/pr-watch";
import { ReviewTab } from "./review/review-tab";
import { Notice, useReviewAction } from "./review/review-thread-card";

const CHECK_STATUS: Record<CheckStatus, { icon: LucideIcon; label: string; tone: string }> = {
  passing: { icon: CircleCheck, label: "Passing", tone: "text-success" },
  failing: { icon: CircleX, label: "Failing", tone: "text-destructive" },
  pending: { icon: RingGlyph, label: "Pending", tone: "text-warning" },
  neutral: { icon: CircleMinus, label: "Neutral", tone: "text-muted-foreground" },
};

/** A review decision, or one review's state, in the PR vocabulary's words (`reviewMarkOf`). */
const reviewWord = (decision: string): string | undefined =>
  reviewMarkOf({ reviewDecision: decision })?.word;

type CheckRun = PrDetail["checkRuns"][number];

const isCancelled = (run: CheckRun) => run.conclusion?.toUpperCase() === "CANCELLED";

/**
 * A check's icon and word, telling queued, running and cancelled checks apart. `spin` is set on
 * the one that is in motion.
 */
export const checkState = (
  run: CheckRun,
): { icon: LucideIcon; label: string; tone: string; spin?: boolean } => {
  if (isCancelled(run)) return { ...CHECK_STATUS.neutral, label: "Cancelled" };
  if (run.status === "pending" && run.phase === "queued") {
    return { ...CHECK_STATUS.pending, label: "Queued" };
  }
  if (run.status === "pending" && run.phase === "running") {
    return { ...CHECK_STATUS.pending, icon: RingSpinner, label: "Running", spin: true };
  }
  return CHECK_STATUS[run.status];
};

/** The checks failing in `next` that `prev` knew and had in another state. */
export const newlyFailing = (prev: readonly CheckRun[], next: readonly CheckRun[]): string[] => {
  const before = new Map(prev.map((run) => [run.name, run.status]));
  return next
    .filter((run) => run.status === "failing" && (before.get(run.name) ?? "failing") !== "failing")
    .map((run) => run.name);
};

/**
 * How many times each check has turned failing while `visible`, to flash its row. Hidden, the panel
 * stays mounted: what changes then is taken as known and nothing stays flashed, since a row coming
 * back from `display: none` would replay its animation. A change of `scope` (another PR) starts
 * over too, so that PR's failures aren't news.
 */
function useFailureFlashes(
  scope: string,
  runs: readonly CheckRun[],
  visible: boolean,
): Record<string, number> {
  const [seen, setSeen] = useState({ scope, runs });
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  if (seen.scope !== scope || seen.runs !== runs) {
    setSeen({ scope, runs });
    const failed = visible && seen.scope === scope ? newlyFailing(seen.runs, runs) : [];
    if (seen.scope !== scope) setFlashes({});
    else if (failed.length > 0) {
      setFlashes((counts) => ({
        ...counts,
        ...Object.fromEntries(failed.map((name) => [name, (counts[name] ?? 0) + 1])),
      }));
    }
  }
  if (!visible && Object.keys(flashes).length > 0) setFlashes({});
  return flashes;
}

/** How long the check ran, or has run so far; `undefined` before it starts. */
export const checkDuration = (run: CheckRun, now = Date.now()): string | undefined => {
  const start = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const end = run.completedAt === undefined ? now : Date.parse(run.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** Checks `git.prRerunChecks` can queue again: failed or cancelled GitHub Actions runs. */
const rerunnable = (run: CheckRun) =>
  run.runId !== undefined && (run.status === "failing" || isCancelled(run));

/** The commit's page on the PR's host, or `undefined` when `prUrl` isn't a `…/pull/<n>` page. */
export const commitUrl = (prUrl: string, oid: string): string | undefined => {
  const match = /^(.+)\/pull\/\d+\/?$/.exec(prUrl);
  return match ? `${match[1]}/commit/${oid}` : undefined;
};

/** How long a "no PR" answer is shown again on a remount without asking. */
const NO_PR_FRESH_MS = 30_000;

const isNoPr = (result: PrDetailResult | undefined) =>
  result?.available === true && result.detail === undefined && result.error === undefined;

/**
 * The thread's PR: conversation, checks, commits and files. Refetches when the PR badge changes, or
 * on Refresh. An orchestrator has none of its own, and is pointed at its workers' on the board.
 */
export function PrPanel({ threadId }: { threadId: ThreadId }) {
  const role = useThreadsStore((s) => s.byId[threadId]?.thread.role);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId);
  if (role === "orchestrator") return <OrchestratorPrs workspaceId={workspaceId} />;
  return <ThreadPrPanel threadId={threadId} />;
}

/** What the PR tab says on an orchestrator: its workers each carry their own PR. */
function OrchestratorPrs({ workspaceId }: { workspaceId: WorkspaceId | undefined }) {
  const openBoard = useOpenBoard();
  return (
    <div data-testid="pr-panel-orchestrator" className="flex flex-col items-center pb-3">
      <PanelMessage>
        An orchestrator has no pull request of its own. Each of its workers carries its own.
      </PanelMessage>
      {workspaceId !== undefined && (
        <Button size="sm" variant="outline" onClick={() => openBoard(workspaceId)}>
          Open board
        </Button>
      )}
    </div>
  );
}

function ThreadPrPanel({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const prStamp = useThreadsStore((s) =>
    prDetailStamp(s.byId[threadId]?.git, s.byId[threadId]?.thread.boundPr),
  );
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const query = useQuery({
    ...prDetailQuery(api, threadId, prStamp),
    // A badge update refetches under a new key; keep the tabs mounted, and the Review tab open.
    placeholderData: keepSamePr(prTargetOf(git, boundPr), git?.origin),
    // A badge or a binding gives the thread a PR under a new key, so a "no PR" answer can stand for a
    // while on a switch back, sparing the server several `git` runs. Only a while: the server also
    // finds a PR the badge missed, and gh unavailable isn't "no PR".
    staleTime: (q) => (prStamp === null && isNoPr(q.state.data) ? NO_PR_FRESH_MS : 0),
  });
  const refresh = (
    <RefreshButton
      threadId={threadId}
      label="Refresh pull request"
      fetching={query.isFetching}
      refetch={() => query.refetch()}
    />
  );

  if (query.isPending) return <PanelMessage loading>Loading pull request…</PanelMessage>;
  const error = query.isError
    ? query.error
    : query.data.error
      ? new Error(query.data.error)
      : undefined;
  if (error) {
    const problem = folderProblem(error);
    if (problem) return <FolderMissing threadId={threadId} problem={problem} />;
    return (
      <WithToolbar tools={refresh}>
        <WithBinding threadId={threadId}>
          <QueryError error={error} feature="The PR panel" />
        </WithBinding>
      </WithToolbar>
    );
  }
  const result = query.data;
  if (!result) return null;
  if (!result.available) {
    return (
      <WithToolbar tools={refresh}>
        <WithBinding threadId={threadId}>
          <PanelMessage>GitHub CLI not available or logged out</PanelMessage>
        </WithBinding>
      </WithToolbar>
    );
  }
  if (!result.detail) {
    return (
      <WithToolbar tools={refresh}>
        <WithBinding threadId={threadId}>
          <PanelMessage>No PR for this branch</PanelMessage>
          <PrElsewhereNotice threadId={threadId} />
          <div className="flex justify-center gap-2 pb-3">
            <PushButton threadId={threadId} size="sm" />
            <CreatePrButton threadId={threadId} />
          </div>
        </WithBinding>
      </WithToolbar>
    );
  }
  return <PrTabs threadId={threadId} detail={result.detail} tools={refresh} />;
}

function WithToolbar({ tools, children }: { tools: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end border-b border-border px-2 py-1">{tools}</div>
      {children}
    </div>
  );
}

/** A panel state without PR detail that still lets the user bind, unbind or watch a PR. */
function WithBinding({ threadId, children }: { threadId: ThreadId; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {children}
      <PrBinding threadId={threadId} />
    </div>
  );
}

function PrTabs({
  threadId,
  detail,
  tools,
}: {
  threadId: ThreadId;
  detail: PrDetail;
  tools: ReactNode;
}) {
  const unresolved = useThreadsStore((s) => s.byId[threadId]?.git?.pr?.review?.threads.unresolved);
  const tab = useLayoutStore((s) => s.prPanelTab);
  const setTab = useLayoutStore((s) => s.setPrPanelTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value === "review" ? "review" : "overview")}
      className="min-h-0 flex-1"
    >
      <div className="flex shrink-0 items-center border-b border-border pe-2">
        <TabsList className="flex-1 border-b-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="review">
            Review
            {unresolved ? (
              <span className="ml-1 text-muted-foreground tabular-nums">
                <NumberTicker value={unresolved} />
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        {tools}
      </div>
      {/* Follow-up commits after the PR opened; collapses while origin is up to date. */}
      <div data-testid="pr-panel-push" className="flex justify-end px-3 pt-2 empty:hidden">
        <PushButton threadId={threadId} size="sm" />
      </div>
      <TabsContent value="overview" className="flex min-h-0 flex-col">
        <PrDetailView threadId={threadId} detail={detail} />
      </TabsContent>
      <TabsContent value="review" className="flex min-h-0 flex-col">
        <PrWatch threadId={threadId} />
        <ReviewTab threadId={threadId} />
      </TabsContent>
    </Tabs>
  );
}

function PrDetailView({ threadId, detail }: { threadId: ThreadId; detail: PrDetail }) {
  const api = useApi();
  // Only the badge of the PR on screen: a same-numbered PR in another repository isn't this one.
  const badge = useThreadsStore((s) => {
    const git = s.byId[threadId]?.git;
    return ifTarget(identityOf(detail, git?.origin), git?.pr, git?.origin);
  });
  const { actions } = useDiffFileActions(threadId);
  const panel = useRef<HTMLDivElement>(null);
  const now = useNow(
    detail.checkRuns.some((run) => checkState(run).spin === true),
    panel,
  );
  const flashes = useFailureFlashes(detail.url, detail.checkRuns, useInSight(panel));
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const bound = boundPr !== undefined;
  const [bindFormOpen, setBindFormOpen] = useState(false);
  const stateMark = prStateMarkOf(detail);
  const state = { ...PR_STATE_DISPLAY[stateMark.kind], label: stateMark.word };
  const mergeState = mergeStateMarkOf(badge, boundPr);
  const decision = reviewWord(detail.reviewDecision);

  return (
    <div ref={panel} data-testid="pr-panel" className="min-h-0 flex-1 overflow-y-auto text-sm">
      <header className="flex flex-col gap-2 px-3 pt-3 pb-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            data-testid="pr-state"
            className={cn(
              "flex items-center gap-1 rounded-full bg-current/10 py-0.5 ps-1.5 pe-2 font-medium",
              state.tone,
            )}
          >
            <state.icon aria-hidden className="size-3.5" />
            {state.label}
          </span>
          <span className="tabular-nums">#{detail.number}</span>
          {detail.author && (
            <span data-testid="pr-author" className="min-w-0 truncate">
              by <span className="text-foreground">{detail.author}</span>
            </span>
          )}
          <OutboundLink
            href={detail.url}
            title="Open on GitHub"
            className="ms-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">Open on GitHub</span>
          </OutboundLink>
        </div>
        <h3 className="font-medium text-pretty">{detail.title}</h3>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <span
            className="min-w-0 truncate font-mono"
            title={`${detail.baseRefName} ← ${detail.headRefName}`}
          >
            {detail.baseRefName} ← {detail.headRefName}
          </span>
          <span className="font-mono tabular-nums">
            <span className="text-success">
              +<NumberTicker value={detail.additions} />
            </span>{" "}
            <span className="text-destructive">
              −<NumberTicker value={detail.deletions} />
            </span>
          </span>
          {decision !== undefined && <span data-testid="review-decision">{decision}</span>}
          {detail.reviews !== undefined && detail.reviews > 0 && (
            <span data-testid="pr-reviews">
              {detail.reviews === 1 ? "1 review" : `${detail.reviews} reviews`}
            </span>
          )}
          <PrChip group="merge" mark={mergeState} testId="pr-merge-state" />
          <UpdateBranch
            threadId={threadId}
            number={detail.number}
            base={detail.baseRefName}
            kind={mergeState?.kind}
          />
        </div>
        <PrPeople threadId={threadId} detail={detail} />
        {badge?.stale && (
          <p
            data-testid="pr-stale"
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <CloudOff aria-hidden className="size-3.5 shrink-0" />
            Couldn't refresh from GitHub: {staleReasonText(badge.stale.reason)}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void api.refreshGit(threadId).catch(() => undefined)}
            >
              Refresh
            </Button>
          </p>
        )}
        <PrActions
          threadId={threadId}
          detail={detail}
          onBind={bound ? undefined : () => setBindFormOpen(true)}
        />
      </header>

      <PrWatch
        threadId={threadId}
        bindFormOpen={bindFormOpen}
        onBindFormClose={() => setBindFormOpen(false)}
      />

      {detail.body && <PrDescription key={detail.url} body={detail.body} />}

      <Section
        title="Checks"
        meta={
          <>
            <NumberTicker value={detail.checksPassed} />/
            <NumberTicker value={detail.checksTotal} /> passing
          </>
        }
        empty="No checks"
        count={detail.checkRuns.length}
        attention={detail.checkRuns.some((run) => run.status === "failing")}
        action={
          <RerunFailedChecks threadId={threadId} available={detail.checkRuns.some(rerunnable)} />
        }
      >
        <ul className="flex flex-col">
          {detail.checkRuns.map((run) => {
            const drawn = checkState(run);
            const duration = checkDuration(run, now);
            // Still red or amber, so the user sees it, but dimmed: GitHub merges past it.
            const unrequired =
              run.required === false && (run.status === "failing" || run.status === "pending");
            const check = unrequired ? { ...drawn, tone: cn(drawn.tone, "opacity-50") } : drawn;
            return (
              <li
                // Keyed on the flash count too, so a second failure replays the animation.
                key={`${run.name}:${flashes[run.name] ?? 0}`}
                data-testid="check-run"
                className={cn(
                  "flex flex-col gap-1 px-3 py-1 text-xs",
                  flashes[run.name] !== undefined && "gram-flash",
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <CheckIcon check={check} />
                  <span className="min-w-0 flex-1 truncate">{run.name}</span>
                  {duration && (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{duration}</span>
                  )}
                  {unrequired && (
                    <span
                      data-testid="check-not-required"
                      className="shrink-0 text-muted-foreground"
                    >
                      not required
                    </span>
                  )}
                  <span className={cn("shrink-0", check.tone)}>{check.label}</span>
                  {run.link && (
                    <OutboundLink
                      href={run.link}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink aria-label={`Open ${run.name}`} className="size-3" />
                    </OutboundLink>
                  )}
                </div>
                <CiCheckDetail
                  threadId={threadId}
                  prUrl={detail.url}
                  prNumber={detail.number}
                  headOid={detail.headRefOid}
                  check={run}
                />
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Commits"
        empty="No commits"
        count={detail.commitList.length}
        defaultOpen={false}
      >
        <ul className="flex flex-col">
          {detail.commitList.map((commit) => {
            const short = commit.oid.slice(0, 7);
            const url = commitUrl(detail.url, commit.oid);
            return (
              <li key={commit.oid} className="flex items-center gap-2 px-3 py-1 text-xs">
                <GitCommitHorizontal
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                {url === undefined ? (
                  <span className="shrink-0 font-mono text-muted-foreground">{short}</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Open commit ${short} on GitHub`}
                    title="Open on GitHub"
                    onClick={() => void openExternalUrl(api, url)}
                    className="shrink-0 rounded-sm font-mono text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {short}
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate">{commit.headline}</span>
                {commit.author && (
                  <span className="shrink-0 text-muted-foreground">{commit.author}</span>
                )}
                <span className="shrink-0 text-muted-foreground">{agoText(commit.at)}</span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Conversation" empty="No comments yet" count={detail.conversation.length}>
        <ul className="flex flex-col gap-2 px-3 py-1">
          {detail.conversation.map((comment) => (
            <li
              key={`${comment.author}-${comment.at}`}
              className="rounded-(--radius-md) border border-border bg-card/40 p-2"
            >
              <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessageSquare aria-hidden className="size-3" />
                <span className="font-medium text-foreground">{comment.author}</span>
                {comment.kind === "review" && comment.state && (
                  <span>{reviewWord(comment.state) ?? comment.state.toLowerCase()}</span>
                )}
                <span className="ml-auto">{agoText(comment.at)}</span>
              </p>
              {comment.body && <MessageResponse>{comment.body}</MessageResponse>}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Files"
        meta={`${detail.changedFiles} changed`}
        empty={detail.note ?? "No files"}
        count={detail.files.length}
      >
        {detail.note && <p className="px-3 pb-1 text-xs text-warning">{detail.note}</p>}
        <DiffFileList files={detail.files} {...actions} />
      </Section>
    </div>
  );
}

function Section({
  title,
  meta,
  action,
  empty,
  count,
  defaultOpen = true,
  attention = false,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /** Rendered below the heading, e.g. a button acting on the section's rows. */
  action?: ReactNode;
  empty: string;
  count: number;
  defaultOpen?: boolean;
  /** Opens the section when it turns true, e.g. a check started failing. */
  attention?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || attention);
  const [noticed, setNoticed] = useState(attention);
  if (attention !== noticed) {
    setNoticed(attention);
    if (attention) setOpen(true);
  }
  const heading =
    "flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
  const trailing = meta ?? (count === 0 ? undefined : count);

  // Nothing to fold: the heading says it's empty, with any action (a rerun's outcome) below.
  if (count === 0) {
    return (
      <section aria-label={title} className="border-t border-border">
        <h4 className={heading}>
          {title}
          <span className="ml-auto tracking-normal normal-case">{meta ?? empty}</span>
        </h4>
        {action}
        {meta !== undefined && <p className="px-3 pb-2 text-xs text-muted-foreground">{empty}</p>}
      </section>
    );
  }
  return (
    <section aria-label={title} className="border-t border-border">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            heading,
            "rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          {title}
          {trailing !== undefined && (
            <span
              className={cn(
                "tracking-normal tabular-nums normal-case",
                meta !== undefined && "ml-auto",
              )}
            >
              {trailing}
            </span>
          )}
        </button>
      </h4>
      {open && (
        <div className="pb-2">
          {action}
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * The PR's description, folded to a two-line preview so the checks and files stay in view. It
 * stays open for the PR once opened; the panel keys it by PR, so another PR starts folded.
 */
function PrDescription({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Description" className="border-t border-border px-3">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1.5 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          Description
        </button>
      </h4>
      {open ? (
        <div data-testid="pr-description" className="pb-2">
          <MessageResponse>{body}</MessageResponse>
        </div>
      ) : (
        // A mouse shortcut beside the heading's button, which keyboard users have.
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
        <p
          data-testid="pr-description-preview"
          onClick={() => setOpen(true)}
          className="mb-2 line-clamp-2 cursor-pointer text-xs text-muted-foreground"
        >
          {descriptionPreview(body)}
        </p>
      )}
    </section>
  );
}

/** The description's opening as plain text: markdown marks, links' targets and HTML dropped. */
export const descriptionPreview = (body: string): string =>
  body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

/** A check's icon, which pops in when the check changes state rather than cutting over. */
function CheckIcon({ check }: { check: ReturnType<typeof checkState> }) {
  const transition = usePresetTransition("snappy");
  return (
    <AnimatePresence initial={false}>
      <m.span
        key={check.label}
        className="flex shrink-0"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={transition}
      >
        <check.icon aria-hidden className={cn("size-3.5", check.tone)} />
      </m.span>
    </AnimatePresence>
  );
}

/**
 * Reruns the failed jobs of the PR's failing Actions runs, then refetches the detail. `available`
 * hides the button without dropping the outcome notice once the rerun checks are queued.
 */
function RerunFailedChecks({ threadId, available }: { threadId: ThreadId; available: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const action = useReviewAction();
  if (!available && !action.notice) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pb-1">
      {available && (
        <Button
          size="xs"
          variant="outline"
          className="w-fit"
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              // Refetch on failure too: some runs may have been queued before one failed.
              const { runIds, skipped } = await api
                .prRerunChecks(threadId)
                .finally(() =>
                  queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] }),
                );
              const runs = runIds.length === 1 ? "1 run" : `${runIds.length} runs`;
              const others =
                skipped.length === 0 ? "" : ` Rerun ${skipped.join(", ")} on its provider.`;
              return `Rerunning the failed jobs of ${runs}.${others}`;
            })
          }
        >
          <RotateCcw aria-hidden />
          Rerun failed
        </Button>
      )}
      <Notice notice={action.notice} />
    </div>
  );
}
