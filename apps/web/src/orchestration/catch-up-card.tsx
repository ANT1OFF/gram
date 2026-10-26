import { catchUpDue, type Thread, type ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { ExpandPresence, Shimmer, Swap } from "@/motion";

import { reportLine } from "./board-model";
import { useOrchestratorLedger } from "./use-orchestration";
import { workerEntryOf } from "./workers-model";

/** The most of a report's own summary the card shows when the helper has nothing to say. */
const REPORT_MAX = 220;

/** What the worker had told you, and when you had last looked, as the view opened. */
interface Opened {
  readonly threadId: ThreadId;
  readonly reportAt: number | undefined;
  readonly summary: string | undefined;
  readonly due: boolean;
}

/**
 * "Catch me up", at the top of a worker you open after a report you hadn't seen: the helper's one
 * or two sentences on what changed since you last looked, else that report's own summary, so the
 * view is complete with helpers off. Decided once, as the view opens: a report that lands while you
 * watch is one you saw. Reading it changes nothing about the worker.
 */
export function CatchUpCard({ thread }: { thread: Thread }) {
  const api = useApi();
  const worker = thread.spawnedBy !== undefined;
  const { data: ledger } = useOrchestratorLedger(worker ? thread.workspaceId : undefined);
  const entry = workerEntryOf(ledger?.features, thread.id);
  const [opened, setOpened] = useState<Opened>();
  const [dismissed, setDismissed] = useState<ThreadId>();
  // Taken the first render the ledger has the worker, and again only for another thread.
  if (worker && entry !== undefined && opened?.threadId !== thread.id) {
    const report = entry.lastReport;
    setOpened({
      threadId: thread.id,
      reportAt: report?.at,
      summary: report?.summary,
      due: catchUpDue(report?.at, thread.lastViewedAt),
    });
  }
  const due = opened?.threadId === thread.id && opened.due;
  const { data: helper, isPending } = useQuery({
    queryKey: ["thread", thread.id, "catchUp", opened?.reportAt],
    queryFn: () => api.threadCatchUp(thread.id),
    enabled: due,
    staleTime: Infinity,
    retry: false,
  });
  const text =
    helper?.text ??
    (opened?.summary === undefined ? undefined : reportLine(opened.summary, REPORT_MAX));
  // Its room is taken as the view opens, with a placeholder line while the helper drafts, so the
  // transcript isn't pushed down under a reader it is following.
  const show = due && dismissed !== thread.id && (isPending || text !== undefined);
  return (
    <ExpandPresence open={show}>
      <div
        data-testid="worker-catch-up"
        data-source={isPending ? "pending" : helper == null ? "report" : "helper"}
        className="flex items-start gap-2 border-b border-border bg-card/40 px-4 py-2 text-sm"
      >
        <History aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="line-clamp-2 min-w-0 flex-1" title={isPending ? undefined : text}>
          <span className="mr-1.5 text-xs text-muted-foreground">Since you looked</span>
          <Swap swapKey={isPending ? "pending" : "text"} className="inline">
            {isPending ? <Shimmer className="text-muted-foreground">Catching up</Shimmer> : text}
          </Swap>
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setDismissed(thread.id)}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
    </ExpandPresence>
  );
}
