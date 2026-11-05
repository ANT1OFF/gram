import { Popover } from "@base-ui/react/popover";
import {
  sinceYouLeftOf,
  type DeliveredDigest,
  type StreamLine,
  type Thread,
} from "@gram/contracts";
import { History, X } from "lucide-react";
import { Fragment, useState } from "react";

import { formatClockTime, formatStamp } from "@/lib/time";

import { PrChip, WorkerLink } from "./feature-card";

/** When the user had last looked, as the view opened. */
interface Opened {
  readonly since: number | undefined;
  readonly at: number;
}

/**
 * The absences already dismissed, by thread and the time it was last viewed: a dismissed line
 * stays dismissed when the view is opened again before the thread records the visit.
 */
const dismissed = new Set<string>();
const absenceKey = (threadId: Thread["id"], since: number | undefined) =>
  `${threadId}:${since ?? "never"}`;

/** "api#212, api#431", or the workers' names where a line has no PR. */
function Named({ lines }: { lines: readonly StreamLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={line.key}>
          {i > 0 && ", "}
          {line.pr !== undefined ? (
            <PrChip pr={line.pr} threadId={line.threadId} />
          ) : line.threadId !== undefined ? (
            <WorkerLink threadId={line.threadId}>{line.title ?? line.feature}</WorkerLink>
          ) : (
            line.words
          )}
        </Fragment>
      ))}
    </>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * "Since you left · 2 merged", one chip in the orchestrator's status row when you come back to
 * it: what merged and what failed (and came back) while you were away, with the time range and
 * each PR on request. The live state (running, waiting on you) is the row's own; this keeps only
 * the summary of the absence. Folded from the digests the orchestrator was given while you were
 * away, the same facts as its own `away` digest, decided once as the view opens. Dismissed, it
 * stays gone for that absence. Reading it changes nothing.
 */
export function SinceYouLeft({
  thread,
  digests,
}: {
  thread: Thread;
  digests: readonly DeliveredDigest[];
}) {
  // Decided once, as the view opens; the caller keys this by thread, so another thread decides anew.
  const [opened] = useState<Opened>(() => ({ since: thread.lastViewedAt, at: Date.now() }));
  const key = absenceKey(thread.id, opened.since);
  const [gone, setGone] = useState(() => dismissed.has(key));
  const since = opened.since;
  const now = opened.at;
  // What arrives while you watch is in the stream; the chip covers the time you were away.
  const summary = sinceYouLeftOf(
    digests.filter((delivered) => delivered.at <= now),
    since,
  );
  // Only what happened: an absence with no merge and no failure needs no chip.
  if (gone || summary === undefined) return null;
  const merged = summary.merged.length;
  const failed = summary.failed.length;
  if (merged === 0 && failed === 0) return null;
  const recovered = new Set(summary.recovered);
  const words = [
    merged > 0 ? `${merged} merged` : undefined,
    failed > 0 ? `${failed} ${plural(failed, "failure", "failures")}` : undefined,
  ]
    .filter((each) => each !== undefined)
    .join(", ");
  const dismiss = () => {
    dismissed.add(key);
    setGone(true);
  };
  return (
    <section
      aria-label="Since you left"
      data-testid="since-you-left"
      className="flex min-w-0 shrink items-center"
    >
      <Popover.Root>
        <Popover.Trigger
          data-testid="since-you-left-open"
          aria-label={`Since you left: ${words}. Show what happened`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-meta text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <History aria-hidden className="size-icon-row shrink-0" />
          <span className="shrink-0 @max-4xl:hidden">Since you left</span>
          {merged > 0 && (
            <span data-testid="since-merged" className="shrink-0">
              <span className="font-medium text-foreground tabular-nums">{merged}</span> merged
            </span>
          )}
          {failed > 0 && (
            <span data-testid="since-failed-count" className="shrink-0 text-destructive">
              <span className="font-medium tabular-nums">{failed}</span>{" "}
              {plural(failed, "failure", "failures")}
            </span>
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
            <Popover.Popup
              data-testid="since-you-left-detail"
              className="flex w-96 max-w-[90vw] origin-(--transform-origin) flex-col gap-1.5 rounded-md border border-edge bg-popover p-3 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
            >
              <Popover.Title className="flex items-baseline gap-1.5 font-medium">
                Since you left
                {since !== undefined && (
                  <span className="font-normal text-muted-foreground tabular-nums">
                    {formatStamp(since, now)} to {formatClockTime(now)}
                  </span>
                )}
              </Popover.Title>
              {merged > 0 && (
                <p data-testid="since-merged-detail" className="flex flex-wrap items-center gap-1">
                  <span>{merged} merged:</span>
                  <Named lines={summary.merged} />
                </p>
              )}
              {summary.failed.map((line) => (
                <p
                  key={line.key}
                  data-testid="since-failed"
                  className="flex flex-wrap items-center gap-1"
                >
                  {line.threadId !== undefined ? (
                    <WorkerLink threadId={line.threadId}>
                      {line.title ?? (line.feature || "worker")}
                    </WorkerLink>
                  ) : (
                    line.feature !== "" && <span>{line.feature}</span>
                  )}
                  <span className="text-destructive">{line.words}</span>
                  {line.threadId !== undefined && recovered.has(line.threadId) && (
                    <span className="text-muted-foreground">, then fixed</span>
                  )}
                </p>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        aria-label="Dismiss Since you left"
        data-testid="since-you-left-dismiss"
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={dismiss}
      >
        <X aria-hidden className="size-icon-chip" />
      </button>
    </section>
  );
}
