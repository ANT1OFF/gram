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
import { limitSummaryText, resetText } from "@/usage/limit-format";
import { tightestLimit, useUsageLimits } from "@/stores/usage-limits";

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
 * "Since you left", one card above the ask stack when you come back to the orchestrator: what
 * merged, what failed (and came back), how many asks wait and the tightest limit. Folded from the
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
  const limits = useUsageLimits((s) => s.limits);
  const since = opened.since;
  const now = opened.at;
  // What arrives while you watch is in the stream; the card covers the time you were away.
  const summary = sinceYouLeftOf(
    digests.filter((delivered) => delivered.at <= now),
    since,
  );
  const open = summary !== undefined && !dismissed;
  const tightest = tightestLimit(limits, now);
  const recovered = new Set(summary?.recovered ?? []);
  return (
    <ExpandPresence open={open}>
      {summary !== undefined && (
        <section
          aria-label="Since you left"
          data-testid="since-you-left"
          className="mx-auto mb-2 flex w-full max-w-(--thread-max-width) px-6"
        >
          <div className="flex w-full max-w-2xl items-start gap-2 rounded-(--radius-md) border border-border bg-card/40 px-3 py-2 text-xs">
            <History aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="font-medium">
                Since you left{" "}
                <span className="font-normal text-muted-foreground tabular-nums">
                  {since === undefined
                    ? ""
                    : `${formatClockTime(since)} to ${formatClockTime(now)}`}
                </span>
              </p>
              {summary.merged.length > 0 && (
                <p data-testid="since-merged" className="flex flex-wrap items-center gap-1">
                  {summary.merged.length} merged: <Named lines={summary.merged} />
                </p>
              )}
              {summary.failed.map((line) => (
                <p key={line.key} data-testid="since-failed" className="flex items-center gap-1">
                  {line.feature !== "" && <span>{line.feature}</span>}
                  {line.threadId !== undefined && (
                    <WorkerLink threadId={line.threadId}>{line.title ?? "worker"}</WorkerLink>
                  )}
                  <span className="text-destructive">{line.words}</span>
                  {line.threadId !== undefined && recovered.has(line.threadId) && (
                    <span className="text-muted-foreground">, then fixed</span>
                  )}
                </p>
              ))}
              {summary.asksWaiting > 0 && (
                <p data-testid="since-asks">
                  {summary.asksWaiting} {summary.asksWaiting === 1 ? "ask waits" : "asks waiting"}{" "}
                  below
                </p>
              )}
              {tightest !== undefined && (
                <p data-testid="since-limit" className="text-muted-foreground">
                  {limitSummaryText(tightest)}
                  {tightest.limit.resetsAt === undefined
                    ? ""
                    : `, resets ${resetText(tightest.limit.resetsAt, now)}`}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDismissed(true)}
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        </section>
      )}
    </ExpandPresence>
  );
}
