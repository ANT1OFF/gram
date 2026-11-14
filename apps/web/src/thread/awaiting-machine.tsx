import type { QueuedInput, Thread, ThreadId } from "@gram/contracts";
import { CircleAlert, CircleX, Clock } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { errorMessage } from "@/api/errors";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Hint } from "@/components/hint";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useEmbedShell } from "@/embed/store";
import { formatClockTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion/spinner";
import { useThreadsStore } from "@/stores/threads";

import {
  ASKED_LAPSE_MS,
  elapsedClock,
  machineWait,
  startingHint,
  WAIT_WORDS,
  type AskedAgain,
  type MachineWait,
} from "./awaiting-machine-model";

// A thread started before its machine, as its own view draws it: the header's chip, the message
// that waits drawn in the conversation as the person's own, and under it either the line that says
// a machine is starting and for how long, or the failure with its sentence and Try again.

const EMPTY: readonly QueuedInput[] = [];

/**
 * The tries the person asked for in this window, by thread, until each thread says its own. Held
 * here and not in the card, which is drawn again whenever its pane is (a thread left and come back
 * to, or shown twice): a call still out, or its refusal, is the thread's and not one card's.
 */
const useAskedAgain = create<{
  readonly byThread: Readonly<Record<string, AskedAgain>>;
  /** Threads whose call to ask for another machine is still out. */
  readonly pending: Readonly<Record<string, true>>;
  /** Why the last call was refused, with the failure it was asked after. */
  readonly refused: Readonly<Record<string, { readonly after: number; readonly words: string }>>;
}>()(() => ({ byThread: {}, pending: {}, refused: {} }));

const without = <T,>(
  all: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> => {
  const { [key]: _gone, ...rest } = all;
  return rest;
};

/** Forgets every try asked for here. For tests. */
export const resetAskedAgain = () =>
  useAskedAgain.setState({ byThread: {}, pending: {}, refused: {} });

/**
 * A thread's wait as this window knows it: the thread's own, with a try just asked for here. A try
 * the thread never took up (its wait didn't begin again within `ASKED_LAPSE_MS`) is forgotten, so
 * the failure and Try again come back instead of a clock that runs for good.
 */
export function useMachineWait(
  thread: Pick<Thread, "id" | "awaitingMachine" | "createdAt">,
): MachineWait | undefined {
  const asked = useAskedAgain((s) => s.byThread[thread.id]);
  const threadId = thread.id;
  const askedAt = asked?.at;
  useEffect(() => {
    if (askedAt === undefined) return;
    const forget = () =>
      useAskedAgain.setState((s) =>
        s.byThread[threadId]?.at === askedAt ? { byThread: without(s.byThread, threadId) } : s,
      );
    const timer = setTimeout(forget, Math.max(0, askedAt + ASKED_LAPSE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [threadId, askedAt]);
  return machineWait(thread, asked);
}

/**
 * In the pane header, in the machine's place: that the thread's machine is starting, or that none
 * came, never a machine "no longer joined". Short of room it keeps one word.
 */
export function AwaitingMachineChip({
  thread,
  className,
}: {
  thread: Thread;
  className?: string | undefined;
}) {
  const wait = useMachineWait(thread);
  const waits = useThreadsStore((s) => (s.byId[thread.id]?.queue ?? EMPTY).length);
  if (wait === undefined) return null;
  const failed = wait.state === "failed";
  const words = failed ? WAIT_WORDS.chip.failed : WAIT_WORDS.chip.starting;
  const hint = failed ? `${wait.sentence}\n${WAIT_WORDS.kept}` : startingHint(waits);
  return (
    <Hint
      label={hint}
      side="bottom"
      render={
        <span
          data-testid="pane-machine"
          data-machine-state={failed ? "no machine" : "starting"}
          role="img"
          aria-label={
            failed ? "No machine started for this thread" : "This thread's machine is starting"
          }
          className={cn(
            "flex max-w-full min-w-0 shrink-0 items-center gap-1 text-meta whitespace-nowrap",
            failed ? "text-destructive" : "text-muted-foreground",
            className,
          )}
        />
      }
    >
      {failed ? (
        <CircleAlert aria-hidden className="size-icon-chip shrink-0" />
      ) : (
        <Spinner aria-hidden className="size-icon-chip shrink-0" />
      )}
      {failed ? (
        <span>{words}</span>
      ) : (
        <span>
          {/* A narrow pane keeps the one word that says it. */}
          <span className="@max-sm:hidden @max-sm/titlebar:hidden">machine </span>
          {WAIT_WORDS.chip.short}
        </span>
      )}
    </Hint>
  );
}

/** The elapsed clock, ticking each second while it is in sight. */
function Elapsed({ since }: { since: number }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const now = useNow(true, anchor);
  return (
    <span
      ref={anchor}
      data-testid="machine-wait-elapsed"
      // Read out once with the line, not every second.
      aria-hidden
      className="shrink-0 tabular-nums"
    >
      {elapsedClock(now - since)}
    </span>
  );
}

/** "Starting this thread's machine · usually under a minute   0:42". */
function StartingLine({ wait }: { wait: MachineWait }) {
  const again = wait.state === "again";
  return (
    <div
      role="status"
      data-testid="machine-wait-starting"
      data-again={again || undefined}
      className="flex items-center gap-2 text-reading text-muted-foreground"
    >
      <Spinner aria-hidden className="size-icon-row shrink-0" />
      <span className="min-w-0 flex-1">
        <strong className="font-medium text-foreground">
          {again ? WAIT_WORDS.again : WAIT_WORDS.starting}
        </strong>
        {/* A narrow pane keeps the head and the clock. */}
        <span className="@max-sm:hidden">
          {" · "}
          {again ? WAIT_WORDS.againNote : WAIT_WORDS.startingNote}
        </span>
      </span>
      <Elapsed since={wait.since} />
    </div>
  );
}

/**
 * No machine came: the sentence (the platform's own, or Gram's), that nothing was lost, and Try
 * again where the app Gram is mounted in gave a way to ask for another (`machines.startAgain`).
 * Gram starts no machine itself, so without one the line says what always works.
 */
function FailedCard({
  threadId,
  wait,
  failedAt,
}: {
  threadId: ThreadId;
  wait: MachineWait;
  failedAt: number;
}) {
  const startAgain = useEmbedShell((s) => s.machines.startAgain);
  const pending = useAskedAgain((s) => s.pending[threadId] === true);
  // A refusal is of the failure it was asked after: a newer failure starts clean.
  const refused = useAskedAgain((s) =>
    s.refused[threadId]?.after === failedAt ? s.refused[threadId]?.words : undefined,
  );
  const retry = () => {
    // Read from the store, not this drawing: another card of the same thread may have asked.
    if (startAgain === undefined || useAskedAgain.getState().pending[threadId] === true) return;
    useAskedAgain.setState((s) => ({
      pending: { ...s.pending, [threadId]: true },
      refused: without(s.refused, threadId),
    }));
    // A handler that throws at once is a refusal like one that rejects.
    void Promise.resolve()
      .then(() => startAgain({ threadId }))
      .then(
        () =>
          useAskedAgain.setState((s) => ({
            byThread: { ...s.byThread, [threadId]: { at: Date.now(), after: failedAt } },
          })),
        (error: unknown) => {
          const why = errorMessage(error).trim();
          const words = why === "" ? WAIT_WORDS.retryFailed : `${WAIT_WORDS.retryFailed} ${why}`;
          useAskedAgain.setState((s) => ({
            refused: { ...s.refused, [threadId]: { after: failedAt, words } },
          }));
        },
      )
      .finally(() => useAskedAgain.setState((s) => ({ pending: without(s.pending, threadId) })));
  };
  return (
    <Alert
      variant="destructive"
      data-testid="machine-wait-failed"
      className="flex items-start gap-2"
    >
      <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 items-start gap-x-3 gap-y-2 @max-md:flex-col">
        <div className="min-w-0 flex-1">
          <AlertTitle data-testid="machine-wait-sentence" className="wrap-anywhere">
            {wait.sentence}
          </AlertTitle>
          <AlertDescription>
            {startAgain === undefined ? WAIT_WORDS.keptNoRetry : WAIT_WORDS.kept}
          </AlertDescription>
          {refused !== undefined && (
            <p data-testid="machine-wait-retry-failed" className="mt-1 wrap-anywhere">
              {refused}
            </p>
          )}
        </div>
        {startAgain !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="machine-wait-retry"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={retry}
            className="shrink-0"
          >
            {pending && <Spinner aria-hidden />}
            {WAIT_WORDS.retry}
          </Button>
        )}
      </div>
    </Alert>
  );
}

/**
 * The conversation of a thread that waits for its machine: the first message that waits, drawn as
 * the person's own and held back (a dashed edge, never greyed past reading) with when it was
 * written and that it isn't sent yet, then how the wait stands. The messages after the first stay
 * in the queue over the prompt box.
 */
export function AwaitingMachine({ thread }: { thread: Thread }) {
  const wait = useMachineWait(thread);
  const first = useThreadsStore((s) => (s.byId[thread.id]?.queue ?? EMPTY)[0]);
  if (wait === undefined) return null;
  const failed = wait.state === "failed";
  const files = first?.input.attachments?.length ?? 0;
  return (
    <div
      data-testid="machine-wait"
      data-state={wait.state}
      // A container, so its lines drop their second halves by the pane's width.
      className="@container flex w-full thread-column flex-col gap-3.5 px-6 pt-5 pb-2"
    >
      {first !== undefined && (
        <Message from="user" data-testid="machine-wait-message" className="items-end gap-1">
          <MessageContent className="border border-dashed border-edge whitespace-pre-wrap wrap-anywhere">
            {first.input.text}
            {files > 0 && (
              <span className="text-meta text-muted-foreground">
                {files === 1 ? "1 attachment" : `${files} attachments`}
              </span>
            )}
          </MessageContent>
          <span
            data-testid="machine-wait-held"
            className="inline-flex items-center gap-1.5 text-meta text-muted-foreground"
          >
            <Clock aria-hidden className="size-icon-chip shrink-0" />
            {formatClockTime(thread.createdAt)} ·{" "}
            {failed ? WAIT_WORDS.heldFailed : WAIT_WORDS.heldStarting}
          </span>
        </Message>
      )}
      {failed ? (
        <FailedCard
          threadId={thread.id}
          wait={wait}
          failedAt={thread.awaitingMachine?.failed?.at ?? 0}
        />
      ) : (
        <StartingLine wait={wait} />
      )}
    </div>
  );
}
