import type { PrReview, ReviewThread, ThreadId } from "@gram/contracts";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, CircleX, MessageSquare, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useApi } from "@/api/context";
import { folderProblem } from "@/api/errors";
import { MessageResponse } from "@/components/ai-elements/message";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { useThreadsStore } from "@/stores/threads";

import { FolderMissing } from "../folder-missing";
import { PanelMessage } from "../panel-message";
import { addressBlockersMessage, groupReviewThreads } from "./review-model";
import {
  Notice,
  ReviewThreadCard,
  useReviewAction,
  type ReviewActions,
} from "./review-thread-card";

const VERDICT: Record<string, { icon: LucideIcon; label: string; tone: string }> = {
  approved: { icon: CircleCheck, label: "Approved", tone: "text-success" },
  changesRequested: { icon: CircleX, label: "Changes requested", tone: "text-destructive" },
  commented: { icon: MessageSquare, label: "Commented", tone: "text-muted-foreground" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The PR's bot review: verdict, unresolved threads by file, and the actions on them. */
export function ReviewTab({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const reviewStamp = useThreadsStore((s) => {
    const pr = s.byId[threadId]?.git?.pr;
    const review = pr?.review;
    return pr
      ? `${pr.number}:${pr.updatedAt ?? ""}:${review?.latestReviewId ?? ""}:${review?.roundInFlight ?? ""}:${review?.threads.unresolved ?? ""}`
      : null;
  });
  const query = useQuery({
    queryKey: ["git.prReview", threadId, reviewStamp],
    queryFn: () => api.prReview(threadId),
    retry: false,
    // Actions change the stamp; keep showing the review (and any open reply) while it refetches.
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <PanelMessage loading>Loading review…</PanelMessage>;
  const error = query.isError
    ? query.error
    : query.data.error
      ? new Error(query.data.error)
      : undefined;
  if (error) {
    const problem = folderProblem(error);
    if (problem) return <FolderMissing threadId={threadId} problem={problem} />;
    return <QueryError error={error} feature="The review tab" />;
  }
  const review = query.data;
  if (!review) return null;
  if (!review.available) {
    return <PanelMessage>GitHub CLI not available or logged out</PanelMessage>;
  }
  if (!review.pr) return <PanelMessage>No PR for this branch</PanelMessage>;

  const actions: ReviewActions = {
    api,
    threadId,
    prNumber: review.pr.number,
    refresh: () => queryClient.invalidateQueries({ queryKey: ["git.prReview", threadId] }),
  };
  return <ReviewView review={review} actions={actions} />;
}

function ReviewView({ review, actions }: { review: PrReview; actions: ReviewActions }) {
  const { files, resolved } = groupReviewThreads(review.threads);
  const hasReview = review.latestReview !== undefined || review.threads.length > 0;

  return (
    <div data-testid="review-panel" className="min-h-0 flex-1 overflow-y-auto text-sm">
      {hasReview ? (
        <VerdictBanner review={review} actions={actions} />
      ) : (
        <NoReviewYet review={review} actions={actions} />
      )}
      {hasReview && files.length === 0 && (
        <p role="status" className="px-3 py-4 text-center text-xs text-muted-foreground">
          No unresolved findings
        </p>
      )}
      {files.map((group) => (
        <section
          key={group.path}
          aria-label={group.path}
          data-testid="review-file"
          className="border-b border-border py-2"
        >
          <h4 className="flex items-center gap-2 px-3 pb-1 font-mono text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{group.path}</span>
            <span className="shrink-0 tabular-nums">
              {group.current.length + group.outdated.length}
            </span>
          </h4>
          <ThreadList threads={group.current} actions={actions} />
          {group.outdated.length > 0 && (
            <Group label={`Outdated (${group.outdated.length})`}>
              <ThreadList threads={group.outdated} actions={actions} />
            </Group>
          )}
        </section>
      ))}
      {resolved.length > 0 && (
        <section aria-label="Resolved" className="py-2">
          <Group label={`Resolved (${resolved.length})`}>
            <ThreadList threads={resolved} actions={actions} />
          </Group>
        </section>
      )}
    </div>
  );
}

function ThreadList({ threads, actions }: { threads: ReviewThread[]; actions: ReviewActions }) {
  return (
    <ul className="flex flex-col gap-2 px-3 py-1">
      {threads.map((thread) => (
        <li key={thread.id}>
          <ReviewThreadCard thread={thread} actions={actions} />
        </li>
      ))}
    </ul>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform group-data-[panel-open]:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function VerdictBanner({ review, actions }: { review: PrReview; actions: ReviewActions }) {
  const { state, latestReview: latest } = review;
  const verdictKey = state?.verdictOnHead ?? latest?.verdict;
  const verdict = verdictKey ? VERDICT[verdictKey]! : undefined;
  const meta = latest?.meta;
  const blockers = review.threads.filter((t) => !t.isResolved && t.severity === "blocker");

  return (
    <header
      data-testid="review-verdict"
      className="flex flex-col gap-2 border-b border-border px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {verdict ? (
          <span className={cn("flex items-center gap-1 font-medium", verdict.tone)}>
            <verdict.icon aria-hidden className="size-4" />
            {verdict.label}
          </span>
        ) : (
          <span className="font-medium text-muted-foreground">No verdict yet</span>
        )}
        <span className="text-xs text-muted-foreground">
          {state?.verdictOnHead
            ? "On head"
            : latest && !latest.onHead
              ? "No verdict on head (older commit)"
              : "No verdict on head"}
        </span>
        {state?.roundInFlight && (
          <span data-testid="round-in-flight" className="flex items-center gap-1 text-xs text-info">
            <Spinner aria-hidden className="size-3" />
            Round in progress
          </span>
        )}
      </div>
      <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        {latest && <span>{latest.author}</span>}
        {latest && <span>{agoText(latest.submittedAt)}</span>}
        {meta?.model && <span className="font-mono">{meta.model}</span>}
        {meta?.scope && <span>scope: {meta.scope}</span>}
        {meta?.strictness && <span>{meta.strictness}</span>}
      </p>
      {state && (
        <p data-testid="review-counts" className="text-xs">
          <span className={cn(state.threads.blockers > 0 && "text-destructive")}>
            {plural(state.threads.blockers, "blocker")}
          </span>
          {" · "}
          <span>{plural(state.threads.suggestions, "suggestion")}</span>
          {" · "}
          <span>{state.threads.unresolved} unresolved</span>
          {(state.threads.humanUnresolved ?? 0) > 0 && (
            <>
              {" · "}
              <span data-testid="review-counts-human">
                {plural(state.threads.humanUnresolved ?? 0, "reviewer thread")}
              </span>
            </>
          )}
        </p>
      )}
      {latest?.body && (
        <div className="rounded-(--radius-md) border border-border bg-card/40 p-2">
          <MessageResponse>{latest.body}</MessageResponse>
        </div>
      )}
      <BulkActions
        blockers={blockers}
        roundInFlight={state?.roundInFlight ?? false}
        actions={actions}
      />
    </header>
  );
}

function NoReviewYet({ review, actions }: { review: PrReview; actions: ReviewActions }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground"
    >
      <p>No bot review on this PR yet</p>
      <BulkActions
        blockers={[]}
        roundInFlight={review.state?.roundInFlight ?? false}
        actions={actions}
      />
    </div>
  );
}

function BulkActions({
  blockers,
  roundInFlight,
  actions,
}: {
  blockers: ReviewThread[];
  roundInFlight: boolean;
  actions: ReviewActions;
}) {
  const address = useReviewAction();
  const rereview = useReviewAction();
  const { api, threadId, prNumber } = actions;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {blockers.length > 0 && (
          <Button
            size="xs"
            variant="outline"
            disabled={address.pending}
            onClick={() =>
              void address.run(async () => {
                const result = await api.send(threadId, {
                  text: addressBlockersMessage(prNumber, blockers),
                });
                return result.queued ? "Queued for the agent" : "Sent to the agent";
              })
            }
          >
            Address all blockers
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={roundInFlight || rereview.pending}
          onClick={() =>
            void rereview.run(async () => {
              const { command } = await api.prRequestRereview(threadId);
              await actions.refresh();
              return `Posted ${command}`;
            })
          }
        >
          Request re-review
        </Button>
      </div>
      <Notice notice={address.notice} />
      <Notice notice={rereview.notice} />
    </div>
  );
}
