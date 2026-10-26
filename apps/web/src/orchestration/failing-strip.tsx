import type { WorkspaceId } from "@gram/contracts";
import { CircleAlert, X } from "lucide-react";
import { useMemo } from "react";

import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";

import { hiddenIds, useAskStackStore } from "./ask-stack-store";
import { saveCleared, useSetAside } from "./inbox-set-aside";
import { standingFailures, type FailureItem } from "./needs-you-model";
import { useOrchestratorLedger } from "./use-orchestration";

// The Board's Failing strip: workers stopped on an error and failing
// CI no live worker owns, from the shared needs-you model, one thin line above the docked stack.
// Open goes to the worker; Dismiss sets the occurrence aside (`inbox.cleared`) behind the stack's
// Undo, so it comes back only if it fails again.

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

const ACTION =
  "relative rounded-sm px-1 text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function FailingStrip({
  workspaceId,
  className,
}: {
  workspaceId: WorkspaceId;
  className?: string;
}) {
  const failures = useFailures(workspaceId);
  const open = useOpenThread();
  const save = useSaveSettings();
  const hold = useAskStackStore((s) => s.hold);
  if (failures.length === 0) return null;
  const dismiss = (item: FailureItem) =>
    hold({ key: item.key, ids: item.ids, done: "Dismissed" }, () =>
      saveCleared(save, item.ids).then(
        () => ({}),
        (error: unknown) => ({ failed: item.ids, problem: errorMessage(error) }),
      ),
    );
  return (
    <section
      data-testid="board-failing"
      aria-label="Failing"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-destructive/30 bg-destructive/5 px-4 py-1.5 text-xs",
        className,
      )}
    >
      <span className="flex shrink-0 items-center gap-1 font-medium text-destructive">
        <CircleAlert aria-hidden className="size-3.5" />
        Failing
        <span className="text-muted-foreground tabular-nums">{failures.length}</span>
      </span>
      <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {failures.map((item) => (
          <li
            key={item.key}
            data-testid="board-failure"
            data-kind={item.failure.kind}
            data-thread-id={item.failure.threadId}
            className="flex min-w-0 items-center gap-1"
          >
            <span className="max-w-48 min-w-0 truncate font-medium" title={item.failure.title}>
              {item.failure.title}
            </span>
            <span className="shrink-0 text-destructive">{item.failure.tag}</span>
            <button
              type="button"
              data-testid="board-failure-open"
              aria-label={`Open ${item.failure.title}`}
              onClick={() => open(item.failure.threadId)}
              className={ACTION}
            >
              Open
            </button>
            <button
              type="button"
              data-testid="board-failure-dismiss"
              aria-label={`Dismiss ${item.failure.tag} on ${item.failure.title}`}
              title="Dismiss until it fails again"
              onClick={() => dismiss(item)}
              className={cn(ACTION, "px-0.5")}
            >
              <X aria-hidden className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
