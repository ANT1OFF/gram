import {
  sinceYouLeftOf,
  type DeliveredDigest,
  type StreamLine,
  type Thread,
} from "@gram/contracts";
import { History, X } from "lucide-react";
import { Fragment, useState } from "react";

import { formatClockTime } from "@/lib/time";
import { ExpandPresence } from "@/motion";

import { PrChip, WorkerLink } from "./feature-card";

/** When the user had last looked, as the view opened. */
interface Opened {
  readonly since: number | undefined;
  readonly at: number;
}

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

/**
 * "Since you left", one line under the status header when you come back to the orchestrator: what
 * merged and what failed (and came back) while you were away. The live state (running, waiting on
 * you, the limits) is the header's; this keeps only the summary of the absence. Folded from the
 * digests the orchestrator was given while you were away, the same facts as its own `away` digest,
 * decided once as the view opens. Reading it changes nothing.
 */
export function SinceYouLeftCard({
  thread,
  digests,
}: {
  thread: Thread;
  digests: readonly DeliveredDigest[];
}) {
  // Decided once, as the view opens; the caller keys this by thread, so another thread decides anew.
  const [opened] = useState<Opened>(() => ({ since: thread.lastViewedAt, at: Date.now() }));
  const [dismissed, setDismissed] = useState(false);
  const since = opened.since;
  const now = opened.at;
  // What arrives while you watch is in the stream; the line covers the time you were away.
  const summary = sinceYouLeftOf(
    digests.filter((delivered) => delivered.at <= now),
    since,
  );
  // Only what happened: an absence with no merge and no failure needs no line.
  const said = summary !== undefined && (summary.merged.length > 0 || summary.failed.length > 0);
  const open = said && !dismissed;
  const recovered = new Set(summary?.recovered ?? []);
  return (
    <ExpandPresence open={open}>
      {summary !== undefined && (
        <section
          aria-label="Since you left"
          data-testid="since-you-left"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs"
        >
          <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="flex min-w-0 flex-1 items-center gap-x-1 overflow-hidden whitespace-nowrap">
            <span className="shrink-0 font-medium">Since you left</span>
            {since !== undefined && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatClockTime(since)} to {formatClockTime(now)}
              </span>
            )}
            {summary.merged.length > 0 && (
              <span data-testid="since-merged" className="flex min-w-0 items-center gap-1">
                <span className="text-muted-foreground">·</span>
                <span className="shrink-0">{summary.merged.length} merged:</span>
                <span className="min-w-0 truncate">
                  <Named lines={summary.merged} />
                </span>
              </span>
            )}
            {summary.failed.map((line) => (
              <span key={line.key} data-testid="since-failed" className="flex items-center gap-1">
                <span className="text-muted-foreground">·</span>
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
              </span>
            ))}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setDismissed(true)}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </section>
      )}
    </ExpandPresence>
  );
}
