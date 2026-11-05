import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { DrawnCheck } from "@/motion";

// Where the Asks dock was, above the orchestrator's composer and at the Board's foot: the Undo for
// the newest answer still held, from the Inbox, a notification, the menu bar or a failure dismissed
// on the Board, so it can be taken back from where the work is. Nothing to take back, nothing shows.
// How much waits is the status header's "Waiting on you" and the Board's chip, each its view's one
// count.

export function UndoLine({ testId = "inbox-line" }: { testId?: string }) {
  const last = useAskStackStore((s) => s.held.at(-1));
  const undo = useAskStackStore((s) => s.undo);
  if (last === undefined) return null;
  return (
    <div className="shrink-0 bg-thread px-3 pt-2" data-testid={`${testId}-dock`}>
      <div
        data-testid={testId}
        className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 rounded-md border border-border px-3 py-1 text-meta text-muted-foreground"
      >
        <span
          key={last.key}
          data-testid={`${testId}-undo`}
          className="flex min-w-0 items-center gap-1 text-foreground"
        >
          <DrawnCheck className="size-3.5 text-success-text" />
          <span className="truncate">{last.done}</span>
          <button
            type="button"
            data-testid={`${testId}-undo-button`}
            onClick={() => undo(last.key)}
            className="ml-0.5 rounded-2xs px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Undo
          </button>
        </span>
      </div>
    </div>
  );
}
