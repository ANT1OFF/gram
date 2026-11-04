import type { WorkspaceId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  ChartNoAxesCombined,
  CircleAlert,
  CircleX,
  KeyRound,
  ListX,
  RotateCw,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { hiddenIds, useAskStackStore } from "./ask-stack-store";
import { failureRow, type FailureStep } from "./failures-card-model";
import { saveCleared, useSetAside } from "./inbox-set-aside";
import { standingFailures, type FailureItem } from "./needs-you-model";
import { useOrchestratorLedger } from "./use-orchestration";

// Failures first: workers stopped on an error and failing CI no live worker owns, from the shared
// needs-you model, in one compact card above the Board's lines and the orchestrator's transcript.
// Each row says the cause, the worker and its PR, and names the step that moves it. The worker's
// name opens it; Dismiss sets the occurrence aside (`inbox.cleared`) behind the ask stack's Undo,
// so it comes back only if it fails again.

/** How many failures show before "Show n more". */
const SHOWN = 3;

/** The workspace's standing failures, less those dismissed, being dismissed or set aside. */
function useFailures(workspaceId: WorkspaceId): readonly FailureItem[] {
  const ledger = useOrchestratorLedger(workspaceId).data;
  const byId = useThreadsStore((s) => s.byId);
  const held = useAskStackStore((s) => s.held);
  const sent = useAskStackStore((s) => s.sent);
  const setAside = useSetAside();
  return useMemo(
    () => standingFailures(ledger, byId, new Set([...hiddenIds({ held, sent }), ...setAside])),
    [ledger, byId, held, sent, setAside],
  );
}

const STEP_ICON: Record<FailureStep["kind"], LucideIcon> = {
  checks: ListX,
  limit: ChartNoAxesCombined,
  signIn: KeyRound,
  retry: RotateCw,
  open: ArrowRight,
};

const CAUSE_ICON: Record<FailureStep["kind"], LucideIcon> = {
  checks: ListX,
  limit: ChartNoAxesCombined,
  signIn: KeyRound,
  retry: CircleX,
  open: CircleX,
};

/** The glyph beside a failure's cause, so it reads without its colour. */
function CauseIcon({ step }: { step: FailureStep }) {
  const Icon = CAUSE_ICON[step.kind];
  return <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />;
}

/** The glyph on a failure's step button. */
function StepIcon({ step }: { step: FailureStep }) {
  const Icon = STEP_ICON[step.kind];
  return <Icon aria-hidden />;
}

/** One failure with its next step and Dismiss: the Board's card lists them, the Inbox shows one. */
export function FailureRowView({ item, onDismiss }: { item: FailureItem; onDismiss: () => void }) {
  const open = useOpenThread();
  const navigate = useNavigate();
  const onGateway = useThreadsStore(
    (s) => s.byId[item.failure.threadId]?.thread.model?.profileId !== undefined,
  );
  const retryable = useThreadsStore(
    (s) => s.byId[item.failure.threadId]?.thread.lastError?.retryable,
  );
  const row = failureRow(item, { onGateway, retryable });
  const { failure } = item;
  const act = () => {
    switch (row.step.kind) {
      case "checks":
        open(failure.threadId);
        useLayoutStore.getState().revealPanel("pr", { thread: true });
        return;
      case "limit":
      case "signIn":
        void navigate({ to: row.step.to });
        return;
      case "retry":
      case "open":
        open(failure.threadId);
        return;
    }
  };
  return (
    <li
      data-testid="board-failure"
      data-kind={failure.kind}
      data-thread-id={failure.threadId}
      className="flex min-w-0 items-start gap-2 px-3 py-2"
    >
      <CauseIcon step={row.step} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
          <span data-testid="board-failure-cause" className="shrink-0 font-medium text-destructive">
            {row.cause}
          </span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <button
            type="button"
            data-testid="board-failure-open"
            aria-label={`Open ${failure.title}`}
            title={`Open ${failure.title}`}
            onClick={() => open(failure.threadId)}
            className="max-w-full min-w-0 truncate rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {failure.title}
          </button>
          {failure.pr !== undefined && (
            <span
              data-testid="board-failure-pr"
              className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
            >
              #{failure.pr.number}
            </span>
          )}
        </p>
        <p
          data-testid="board-failure-detail"
          title={row.detail}
          className="truncate text-xs text-muted-foreground"
        >
          {row.detail}
        </p>
      </div>
      <Button
        size="xs"
        variant="outline"
        data-testid="board-failure-action"
        data-step={row.step.kind}
        onClick={act}
        className="mt-0.5"
      >
        <StepIcon step={row.step} />
        {row.step.label}
      </Button>
      <Hint
        label="Dismiss until it fails again"
        side="bottom"
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            data-testid="board-failure-dismiss"
            aria-label={`Dismiss ${failure.tag} on ${failure.title}`}
            onClick={onDismiss}
            className="mt-0.5 text-muted-foreground"
          />
        }
      >
        <X aria-hidden />
      </Hint>
    </li>
  );
}

/** The workspace's unresolved failures, above everything going well; nothing when there are none. */
export function FailuresCard({
  workspaceId,
  className,
}: {
  workspaceId: WorkspaceId;
  className?: string;
}) {
  const failures = useFailures(workspaceId);
  const save = useSaveSettings();
  const hold = useAskStackStore((s) => s.hold);
  const [all, setAll] = useState(false);
  if (failures.length === 0) return null;
  const dismiss = (item: FailureItem) =>
    hold({ key: item.key, ids: item.ids, done: "Dismissed" }, () =>
      saveCleared(save, item.ids).then(
        () => ({}),
        (error: unknown) => ({ failed: item.ids, problem: errorMessage(error) }),
      ),
    );
  const shown = all ? failures : failures.slice(0, SHOWN);
  const more = failures.length - shown.length;
  return (
    <div className={className}>
      <section
        data-testid="board-failing"
        aria-label="Failing"
        className="overflow-hidden rounded-(--radius-lg) border border-destructive/40 bg-card"
      >
        <h2 className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs font-medium text-destructive">
          <CircleAlert aria-hidden className="size-3.5" />
          Failing
          <span className="text-muted-foreground tabular-nums">{failures.length}</span>
        </h2>
        <ul className="divide-y divide-border">
          {shown.map((item) => (
            <FailureRowView key={item.key} item={item} onDismiss={() => dismiss(item)} />
          ))}
        </ul>
        {(more > 0 || all) && failures.length > SHOWN && (
          <button
            type="button"
            data-testid="board-failing-more"
            onClick={() => setAll(!all)}
            className="w-full border-t border-border px-3 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {all ? "Show fewer" : `Show ${more} more`}
          </button>
        )}
      </section>
    </div>
  );
}
