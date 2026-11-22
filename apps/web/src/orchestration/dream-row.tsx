import type { Dream } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button, buttonVariants } from "@/components/ui/button";
import { useModelNames } from "@/composer/models";
import { keyLabel } from "@/keyboard/registry";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { PresenceItem } from "@/motion";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { StatePill } from "@/thread/orchestration-cards";
import { usd } from "@/thread/orchestration-model";
import { useCostShown } from "@/usage/cost";

import { InlineConfirm } from "./inline-confirm";
import {
  dreamActions,
  dreamAgentErrorText,
  dreamFailureText,
  dreamKindLabel,
  dreamRetryInput,
  dreamStatus,
} from "./memory-model";

/** What Discard warns of, on an update's row and its review. */
export const discardWarning = () =>
  keyLabel(
    "Discard this update? What it wrote and its report are deleted, and memory stays as it is. Its thread is closed too, with the folder it ran in, so ⌘⇧T brings back only its conversation to read.",
  );

/**
 * One memory update in the Draft memory update tab: its state, what it ran on, why it failed and
 * the next step, and its actions; `children` is its review while open.
 */
export function DreamRow({
  dream,
  now,
  running,
  reviewing,
  onReview,
  children,
}: {
  dream: Dream;
  now: number;
  running: boolean;
  reviewing: boolean;
  onReview: () => void;
  children?: ReactNode;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const nameOf = useModelNames([dream.model]);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const actions = dreamActions(dream);
  const threadId = dream.threadId;
  const threadError = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread.lastError,
  );
  const agentError = dreamAgentErrorText(dream, threadError);
  const failure = dreamFailureText(dream);
  const failed = dream.status === "failed";
  const showCost = useCostShown(dream.model);

  const run = (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    what()
      .then(() => queryClient.invalidateQueries({ queryKey: ["dreams", dream.workspaceId] }))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const primary = actions.cancel
    ? threadId === undefined
      ? undefined
      : "watch"
    : actions.review
      ? "review"
      : threadId === undefined
        ? undefined
        : "thread";

  return (
    <PresenceItem
      as="li"
      glide
      data-testid="dream-row"
      data-dream={dream.id}
      data-status={dream.status}
      className="flex flex-col gap-2.5 rounded-(--radius-md) border border-edge bg-card px-4 py-3 shadow-raised"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatePill state={dreamStatus(dream)} testId="dream-status" />
        <span className="ms-auto text-meta text-muted-foreground tabular-nums">
          Started {agoText(dream.createdAt, now)}
          {dream.endedAt !== undefined && ` · ended ${agoText(dream.endedAt, now)}`}
        </span>
      </div>
      <p data-testid="dream-facts" className="text-body text-description">
        {dreamKindLabel(dream)} · {agentLabel(dream.model.agent)} · {nameOf(dream.model)}
        {dream.mode === "auto" && " · saved if it checks out"}
        {showCost && dream.usage?.costUsd !== undefined && (
          <span data-testid="dream-cost" className="tabular-nums">
            {" "}
            · {usd(dream.usage.costUsd)}
          </span>
        )}
      </p>
      {failure !== undefined && (
        <p
          data-testid="dream-failure"
          className={cn(
            "text-body",
            dream.status === "failed" ? "text-destructive" : "text-description",
          )}
        >
          {failure}
          {agentError !== undefined && (
            <span data-testid="dream-agent-error" className="block">
              {agentError}
            </span>
          )}
        </p>
      )}
      {failed && (
        <p data-testid="dream-next-step" className="text-body text-description">
          Memory is unchanged.
          {threadId === undefined ? "" : " Its thread shows what it did."}
        </p>
      )}
      {(failed ? [] : (dream.notes ?? [])).map((note) => (
        <p key={note} className="text-body text-description">
          {note}
        </p>
      ))}
      <div data-testid="dream-row-actions" className="flex flex-wrap items-center gap-2">
        {failed && (
          <Button
            size="sm"
            data-testid="dream-retry"
            disabled={busy || running}
            title={running ? "One run per workspace at a time" : undefined}
            onClick={() => run(() => api.startDream(dream.workspaceId, dreamRetryInput(dream)))}
          >
            Try again
          </Button>
        )}
        {actions.review && (
          <Button
            size="sm"
            variant="outline"
            data-testid="dream-review-open"
            aria-expanded={reviewing}
            onClick={onReview}
          >
            {dream.mode === "auto" ? "Inspect" : "Review"}
          </Button>
        )}
        {threadId !== undefined && (
          <Link
            to="/t/$threadId"
            params={{ threadId }}
            data-testid="dream-thread"
            onClick={() => useLayoutStore.getState().openThread(threadId)}
            className={cn(
              buttonVariants({
                size: "sm",
                variant: primary === "watch" || primary === "thread" ? "outline" : "ghost",
              }),
            )}
          >
            {actions.cancel ? "Watch it run" : "Open thread"}
          </Link>
        )}
        {actions.cancel && (
          <Button
            size="sm"
            variant={primary === undefined ? "outline" : "ghost"}
            data-testid="dream-cancel"
            disabled={busy}
            onClick={() => run(() => api.cancelDream(dream.id))}
          >
            Cancel
          </Button>
        )}
        {actions.discard && !actions.review && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            data-testid="dream-row-discard"
            aria-expanded={discarding}
            disabled={busy}
            onClick={() => setDiscarding(!discarding)}
          >
            Discard
          </Button>
        )}
      </div>
      <InlineConfirm
        open={discarding}
        label="Discard this update?"
        confirmLabel="Discard update"
        destructive
        busy={busy}
        onCancel={() => setDiscarding(false)}
        onConfirm={() => run(() => api.discardDream(dream.id))}
      >
        {discardWarning()}
      </InlineConfirm>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      {children}
    </PresenceItem>
  );
}
