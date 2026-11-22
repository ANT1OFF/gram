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

import { threadHost } from "./machine-mark";
import { useMachineMark } from "./machine-marker";
import {
  ASKED_LAPSE_MS,
  elapsedClock,
  machineWait,
  startingHint,
  WAIT_WORDS,
  type AskedAgain,
  type MachineWait,
} from "./awaiting-machine-model";

const EMPTY: readonly QueuedInput[] = [];

const useAskedAgain = create<{
  readonly byThread: Readonly<Record<string, AskedAgain>>;
  readonly pending: Readonly<Record<string, true>>;
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
          <span className="@max-sm:hidden @max-sm/titlebar:hidden">machine </span>
          {WAIT_WORDS.chip.short}
        </span>
      )}
    </Hint>
  );
}

function Elapsed({ since }: { since: number }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const now = useNow(true, anchor);
  return (
    <span
      ref={anchor}
      data-testid="machine-wait-elapsed"
      aria-hidden
      className="shrink-0 tabular-nums"
    >
      {elapsedClock(now - since)}
    </span>
  );
}

/**
 * A thread on a machine that stopped and is being started again (`MachineMark.startingSince`): the
 * line the wait for a first machine draws, under the conversation, so a message sent to it reads
 * as waiting on the machine and not as a turn that hangs. Nothing while the machine is anything
 * else.
 */
export function MachineStarting({ thread }: { thread: Thread }) {
  const since = useMachineMark(threadHost(thread))?.startingSince;
  if (since === undefined) return null;
  return (
    <div
      data-testid="machine-restarting"
      className="@container flex w-full thread-column flex-col px-6 pt-3 pb-2"
    >
      <StartingLine wait={{ state: "starting", since }} words={WAIT_WORDS.restarting} />
    </div>
  );
}

function StartingLine({
  wait,
  words,
}: {
  wait: MachineWait;
  words?: { readonly head: string; readonly note: string } | undefined;
}) {
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
          {words?.head ?? (again ? WAIT_WORDS.again : WAIT_WORDS.starting)}
        </strong>
        <span className="@max-sm:hidden">
          {" · "}
          {words?.note ?? (again ? WAIT_WORDS.againNote : WAIT_WORDS.startingNote)}
        </span>
      </span>
      <Elapsed since={wait.since} />
    </div>
  );
}

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
  const refused = useAskedAgain((s) =>
    s.refused[threadId]?.after === failedAt ? s.refused[threadId]?.words : undefined,
  );
  const retry = () => {
    if (startAgain === undefined || useAskedAgain.getState().pending[threadId] === true) return;
    useAskedAgain.setState((s) => ({
      pending: { ...s.pending, [threadId]: true },
      refused: without(s.refused, threadId),
    }));
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
