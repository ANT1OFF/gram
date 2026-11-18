import type { ThreadError, ThreadId } from "@gram/contracts";
import { ServerCrash } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/time";
import { useThreadsStore } from "@/stores/threads";

type MachineLost = NonNullable<ThreadError["machineLost"]>;

/** Where the card stands: offering the resume, resuming, or a quiet receipt once it went on. */
export type MachineLostState = "lost" | "resuming" | "resumed";

/** The card's title: "This worker's machine was lost at 08:14". */
export const machineLostTitle = (at: number): string =>
  `This worker's machine was lost at ${formatStamp(at)}`;

/**
 * A turn a lost machine cut off (`ThreadError.machineLost`), in the transcript: what happened, in a
 * sentence; what comes back (the folder as last saved, which is kept every few minutes while the
 * worker works); and one action, Resume worker, which brings the machine back and tells the same
 * conversation what was cut off. Once the thread has moved on it is a quiet receipt.
 */
export function MachineLostCard({
  threadId,
  error,
  lost,
}: {
  threadId: ThreadId;
  error: ThreadError;
  lost: MachineLost;
}) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const state = useThreadsStore((s): MachineLostState => {
    const summary = s.byId[threadId];
    if (summary === undefined || summary.thread.lastError?.at !== error.at) return "resumed";
    return summary.status === "error" || summary.status === "idle" || summary.status === "cold"
      ? "lost"
      : "resuming";
  });
  const shown: MachineLostState = pending && state === "lost" ? "resuming" : state;

  const resume = async () => {
    setPending(true);
    setFailed(undefined);
    try {
      await api.resumeAfterMachineLost(threadId);
    } catch (e) {
      console.error("resume after machine lost", e);
      setFailed(`Couldn't resume the worker: ${errorMessage(e)}`);
    } finally {
      setPending(false);
    }
  };

  const during =
    lost.during === undefined ? (
      "It went away while the turn was running."
    ) : (
      <>
        It went away while <code className="font-mono">{lost.during}</code> ran.
      </>
    );

  if (shown === "resumed") {
    return (
      <div
        role="status"
        data-testid="machine-lost"
        data-state="resumed"
        className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-border p-2.5 text-reading text-muted-foreground"
      >
        <ServerCrash aria-hidden className="mt-0.5 size-icon-row shrink-0" />
        <p className="min-w-0 flex-1 text-meta">
          <span className="font-medium text-foreground">{machineLostTitle(error.at)}</span>
          {" · resumed on its folder as last saved"}
        </p>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="machine-lost"
      data-state={shown}
      className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-destructive/40 p-2.5 text-reading"
    >
      <ServerCrash aria-hidden className="mt-0.5 size-icon-row shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p data-testid="machine-lost-title" className="text-meta font-medium text-destructive">
          {machineLostTitle(error.at)}
        </p>
        <p className="break-words">{during} It wasn't idle, and nothing stopped it on purpose.</p>
        <p className="mt-1 text-meta text-muted-foreground">
          Its folder is saved every few minutes while it works, so it comes back as last saved:
          anything in the last few minutes before {formatStamp(error.at)} may be missing.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            data-testid="machine-lost-resume"
            disabled={shown === "resuming"}
            onClick={() => void resume()}
          >
            {shown === "resuming" ? "Resuming…" : "Resume worker"}
          </Button>
          <span className="text-meta text-muted-foreground">
            {shown === "resuming"
              ? "Starting its machine and putting its folder back."
              : "Starts its machine, puts its folder back, and tells the worker what was cut off."}
          </span>
        </div>
        {failed !== undefined && (
          <p
            data-testid="machine-lost-failed"
            className="mt-1 text-meta break-words text-foreground"
          >
            {failed}
          </p>
        )}
      </div>
    </div>
  );
}
