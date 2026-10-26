import type { Thread, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Clock, X } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { useNow } from "@/lib/use-now";
import { ExpandPresence, Shimmer, Swap } from "@/motion";
import { useOpenThread } from "@/shell/thread-switcher";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { startOrchestratorMessage } from "./ask-about";
import { factLines, idleFor, nudgesFor, stalledSince, type Nudge } from "./stuck-model";
import { snoozed, useStuckSnoozes } from "./stuck-snooze";
import { threadWorking } from "./tree-model";
import { useOrchestratorLedger } from "./use-orchestration";
import { workerEntryOf } from "./workers-model";

const CHIP =
  "rounded-sm border border-border px-1.5 py-0.5 text-xs text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Puts a nudge in the worker's own composer, in the pane `from` is in, to edit and send. */
function fillWorkerComposer(threadId: ThreadId, text: string, from: HTMLElement) {
  const drafts = useDraftStore.getState();
  const current = drafts.text[threadId] ?? "";
  drafts.setText(threadId, current.trim() === "" ? text : `${current.trimEnd()}\n\n${text}`);
  const composer = from
    .closest("[data-pane-index]")
    ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  requestAnimationFrame(() => {
    composer?.focus();
    composer?.setSelectionRange(composer.value.length, composer.value.length);
  });
}

/**
 * "Why is it stuck?", under the header of a worker that hasn't moved for `STUCK_AFTER_MS`: how long
 * it has sat, the helper's one sentence on its last events and PRs (or, with helpers off, those
 * facts themselves), a few nudges, and "Snooze 1 day". A nudge only fills a composer; nothing is
 * sent until you send it, and the helper never sends anything.
 */
export function StuckCard({ thread }: { thread: Thread }) {
  const api = useApi();
  const worker = thread.spawnedBy !== undefined;
  const { data: ledger } = useOrchestratorLedger(worker ? thread.workspaceId : undefined);
  const entry = workerEntryOf(ledger?.features, thread.id);
  const status = useThreadsStore((s) => s.byId[thread.id]?.status);
  const working = useThreadsStore((s) => {
    const summary = s.byId[thread.id];
    return summary !== undefined && threadWorking(summary, s.statusDetail[thread.id]);
  });
  const now = useNow(true, undefined, 60_000);
  const open = useOpenThread();
  const [dismissed, setDismissed] = useState<number>();
  const asleep = useStuckSnoozes((s) => snoozed(s.until, thread.id, now));
  const idleSince =
    entry === undefined ? undefined : stalledSince(entry, thread, status, now, working);
  const due = idleSince !== undefined && dismissed !== idleSince && !asleep;
  const { data: view, isPending } = useQuery({
    queryKey: ["thread", thread.id, "whyStuck", idleSince],
    queryFn: () => api.threadWhyStuck(thread.id),
    enabled: due,
    staleTime: Infinity,
    retry: false,
  });
  const facts = view?.facts;
  const lines = facts === undefined ? [] : factLines(facts);
  const text = view?.text;
  const source = isPending ? "pending" : text !== undefined ? "helper" : "facts";
  const nudge = (choice: Nudge, button: HTMLElement) => {
    if (choice.to === "worker") return fillWorkerComposer(thread.id, choice.text, button);
    const orchestrator = thread.spawnedBy?.threadId;
    if (orchestrator !== undefined) startOrchestratorMessage(orchestrator, choice.text, open);
  };
  // The server has the last word on whether it is stalled: once it says no, the card goes.
  const show = due && (isPending || view != null);
  return (
    <ExpandPresence open={show}>
      <div
        data-testid="worker-stuck"
        data-source={source}
        className="flex flex-col gap-1.5 border-b border-border bg-card/40 px-4 py-2 text-sm"
      >
        <div className="flex items-start gap-2">
          <Clock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-idle" />
          <div className="min-w-0 flex-1">
            <span className="mr-1.5 text-xs text-muted-foreground">
              Why is it stuck? · {idleSince === undefined ? "" : idleFor(idleSince, now)}
            </span>
            <Swap swapKey={source} className="inline">
              {isPending ? (
                <Shimmer className="text-muted-foreground">Looking</Shimmer>
              ) : text !== undefined ? (
                <span data-testid="stuck-text">{text}</span>
              ) : (
                <span data-testid="stuck-facts" className="text-muted-foreground">
                  {lines.length === 0 ? "Nothing new since it stopped." : lines.join(" · ")}
                </span>
              )}
            </Swap>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setDismissed(idleSince)}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-5.5">
          {nudgesFor(thread, facts, now).map((choice) => (
            <button
              key={choice.id}
              type="button"
              data-testid={`stuck-nudge-${choice.id}`}
              className={CHIP}
              onClick={(event) => nudge(choice, event.currentTarget)}
            >
              {choice.label}
            </button>
          ))}
          {/* Away on this machine for a day, however it moves meanwhile; Dismiss is until it moves. */}
          <button
            type="button"
            data-testid="stuck-snooze"
            className={CHIP}
            onClick={() => useStuckSnoozes.getState().snooze(thread.id, Date.now())}
          >
            Snooze 1 day
          </button>
        </div>
      </div>
    </ExpandPresence>
  );
}
