import type { GramUIMessage, ThreadError, ThreadId, ThreadStatus, TurnId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowDown, CircleX, Clock, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";
import { feedMessages, useThreadFeed } from "@/stores/feeds";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";
import { useUsageLimits } from "@/stores/usage-limits";
import { useNow } from "@/lib/use-now";
import { resetText } from "@/usage/limit-format";

import { attemptsOf, errorKey, type AttemptFacts, type RetryReceipt } from "./attempt-model";
import { failureLabel } from "./failure-kinds";
import { retryKey, retryTimeOf, useRetrySchedule } from "./retry-time";

/** Failures a gateway profile's settings can fix: its key, its models, or its spending limit. */
const GATEWAY_FIXES: ReadonlySet<ThreadError["kind"]> = new Set([
  "auth",
  "gatewayRefused",
  "modelUnavailable",
  "costGuard",
]);

/** Statuses with no turn under way, from which sending again starts one. */
const SETTLED: ReadonlySet<ThreadStatus> = new Set(["error", "idle", "cold"]);

/**
 * The text of the message that started turn `turnId`, to send again; `undefined` when it carried
 * more than text (an attachment a resend would drop) or can't be found.
 */
const retryText = (
  messages: ReadonlyArray<GramUIMessage>,
  turnId: TurnId | undefined,
): string | undefined => {
  if (turnId === undefined) return undefined;
  const sent = messages.find((m) => m.role === "user" && m.metadata?.turnId === turnId);
  if (sent === undefined || sent.parts.some((p) => p.type !== "text")) return undefined;
  const text = sent.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return text.trim() === "" ? undefined : text;
};

/** Refusals `thread.send` makes before it takes the message, so nothing of it was sent. */
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set([
  "ThreadNotFound",
  "InvalidState",
  "NotImplemented",
]);

/**
 * What a failed retry says: that nothing was sent only when the server refused it before taking it.
 * Any other failure, a dropped connection say, may have lost the answer after the message went.
 */
const retryFailure = (error: unknown): string => {
  const tag = typeof error === "object" && error !== null ? Reflect.get(error, "_tag") : undefined;
  return typeof tag === "string" && REFUSED_BEFORE_SENDING.has(tag)
    ? `The retry was refused, so nothing was sent: ${errorMessage(error)}`
    : `Couldn't confirm the retry reached the agent: ${errorMessage(error)}. Check the transcript before trying again.`;
};

/** This failed turn's attempt facts, from the thread's transcript as it stands. */
function useAttempt(threadId: ThreadId, error: ThreadError): AttemptFacts | undefined {
  const messages = useThreadFeed(threadId, (state) => state.messages);
  const attempts = useMemo(() => attemptsOf(messages), [messages]);
  return attempts.get(errorKey(error));
}

/** "Retried · 14:05", and how that went when it failed too. */
const retriedLabel = (retried: RetryReceipt): string => {
  const at = retried.at === undefined ? "" : ` · ${formatClockTime(retried.at)}`;
  return retried.failed ? `Retried${at} · failed again` : `Retried${at}`;
};

/**
 * Where a turn failed, in the transcript: Gram's sentence for it, and a retry that sends the
 * turn's message again while that still makes sense: the failure may clear, it is still the thread's
 * last error, and nothing is running. A retry that fails says so under the turn's own failure, until
 * the next try. Once the message was sent again the card is a receipt: "Retried · 14:05", no longer
 * red and with no Retry of its own, and a link to the attempt that came of it, or, when that failed
 * too, to the newest attempt, which is the one that needs action.
 */
export function AgentErrorCard({ threadId, error }: { threadId: ThreadId; error: ThreadError }) {
  // A thread the server no longer has, a finished worker's, has no feed to read attempts from.
  const live = useThreadsStore((s) => s.byId[threadId] !== undefined);
  return live ? (
    <LiveErrorCard threadId={threadId} error={error} />
  ) : (
    <ErrorCard threadId={threadId} error={error} attempt={undefined} />
  );
}

function LiveErrorCard({ threadId, error }: { threadId: ThreadId; error: ThreadError }) {
  const attempt = useAttempt(threadId, error);
  return <ErrorCard threadId={threadId} error={error} attempt={attempt} />;
}

function ErrorCard({
  threadId,
  error,
  attempt,
}: {
  threadId: ThreadId;
  error: ThreadError;
  attempt: AttemptFacts | undefined;
}) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [unsent, setUnsent] = useState<string | undefined>();
  const retried = attempt?.retried;
  const current = useThreadsStore((s) => {
    const summary = s.byId[threadId];
    return summary?.thread.lastError?.at === error.at && SETTLED.has(summary.status);
  });
  const model = useThreadsStore((s) => s.byId[threadId]?.thread.model);
  const onGateway = model?.profileId !== undefined;
  const limited = error.kind === "rateLimit";
  // A minute's tick is enough: the time is shown to the minute, and only matters once it passes.
  const now = useNow(limited && current && retried === undefined, undefined, 60_000);
  const limits = useUsageLimits((s) => s.limits);
  const retryAt = limited ? retryTimeOf(error, model, limits, now) : undefined;
  const key = retryKey(threadId, error);
  const due = useRetrySchedule((s) => s.due[key]);

  // Read, not subscribed: the turn's own message is in the feed before its error is. A limit the
  // provider gave a reset for is worth sending again then, even where sending now would only repeat.
  const text =
    (error.retryable || retryAt !== undefined) && current && retried === undefined
      ? retryText(feedMessages(threadId), error.turnId)
      : undefined;

  const retry = async (again: string) => {
    useRetrySchedule.getState().cancel(key);
    setPending(true);
    setUnsent(undefined);
    try {
      await api.send(threadId, { text: again });
    } catch (e) {
      console.error("retry turn", e);
      setUnsent(retryFailure(e));
    } finally {
      setPending(false);
    }
  };

  if (retried !== undefined) {
    const target = retried.latestFailed ? retried.latestMessageId : retried.messageId;
    return (
      <div
        role="status"
        data-testid="agent-error"
        data-kind={error.kind}
        data-state="retried"
        className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-border p-2.5 text-reading text-muted-foreground"
      >
        <RotateCw aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-meta font-medium">
            {failureLabel(error.kind)}
            {attempt !== undefined && attempt.attempt > 1 && ` · attempt ${attempt.attempt}`}
            <span data-testid="agent-error-retried" className="text-foreground">
              {" · "}
              {retriedLabel(retried)}
            </span>
          </p>
          <p className="break-words">{error.text}</p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          data-testid="agent-error-attempt"
          onClick={() => useRevealStore.getState().reveal(threadId, target)}
        >
          <ArrowDown aria-hidden />
          {retried.latestFailed ? "Go to the attempt that needs action" : "View new attempt"}
        </Button>
      </div>
    );
  }

  const repeat = attempt !== undefined && attempt.attempt > 1;
  /**
   * "Retry then": sends the turn's message again once the reset passes, if it is still the thread's
   * last error with nothing running by then. Read when it fires, not now: the user may have sent
   * something else in the meantime.
   */
  const retryThen = (again: string, at: number) =>
    useRetrySchedule.getState().schedule(key, at, () => {
      const summary = useThreadsStore.getState().byId[threadId];
      if (summary?.thread.lastError?.at !== error.at || !SETTLED.has(summary.status)) return;
      void retry(again);
    });
  return (
    <div
      role="alert"
      data-testid="agent-error"
      data-kind={error.kind}
      data-state="failed"
      className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-destructive/40 p-2.5 text-reading"
    >
      <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-meta font-medium text-destructive">
          {failureLabel(error.kind)}
          {repeat && (
            <span data-testid="agent-error-attempt-number" className="text-foreground">
              {` · attempt ${attempt.attempt} failed too · needs action`}
            </span>
          )}
        </p>
        <p className="break-words">{error.text}</p>
        {limited && current && retried === undefined && (
          <RetryTime
            at={retryAt}
            now={now}
            due={due}
            canRetry={text !== undefined && !pending}
            onRetryThen={() =>
              text !== undefined && retryAt !== undefined && retryThen(text, retryAt)
            }
            onCancel={() => useRetrySchedule.getState().cancel(key)}
          />
        )}
        {onGateway && GATEWAY_FIXES.has(error.kind) && (
          <Link
            to="/settings/gateways"
            data-testid="agent-error-gateways"
            className="mt-1 inline-block text-meta text-link underline-offset-2 hover:underline"
          >
            Gateway settings
          </Link>
        )}
        {unsent !== undefined && text !== undefined && (
          <p data-testid="retry-unsent" className="mt-1 text-meta break-words text-foreground">
            {unsent}
          </p>
        )}
      </div>
      {text !== undefined && (error.retryable || retryAt === undefined || retryAt <= now) && (
        <Button size="xs" variant="outline" onClick={() => void retry(text)} disabled={pending}>
          <RotateCw aria-hidden />
          {retryAt !== undefined && retryAt > now ? "Retry now" : "Retry"}
        </Button>
      )}
    </div>
  );
}

/**
 * Under a rate limit, when to try again: "Try again at 11:15" with "Retry then" when the provider
 * reported the reset, and a plain "no time" when it didn't, never a guess. Usage has the readings
 * behind it either way.
 */
function RetryTime({
  at,
  now,
  due,
  canRetry,
  onRetryThen,
  onCancel,
}: {
  at: number | undefined;
  now: number;
  /** When a retry set with "Retry then" goes, epoch ms. */
  due: number | undefined;
  canRetry: boolean;
  onRetryThen: () => void;
  onCancel: () => void;
}) {
  const usage = (
    <Link
      to="/usage"
      data-testid="agent-error-usage"
      className="text-link underline-offset-2 hover:underline"
    >
      Usage
    </Link>
  );
  if (at === undefined || at <= now) {
    return (
      <p
        data-testid="agent-error-retry-time"
        data-known="false"
        className="mt-1 text-meta text-muted-foreground"
      >
        {at === undefined
          ? "The provider gave no retry time, so when this clears isn't known."
          : "The provider's reset time has passed."}{" "}
        {usage}
      </p>
    );
  }
  const time = resetText(at, now);
  return (
    <div
      data-testid="agent-error-retry-time"
      data-known="true"
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
    >
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <Clock aria-hidden className="size-3.5 text-muted-foreground" />
        Try again at {time}
      </span>
      <span className="text-muted-foreground">when the provider's limit resets</span>
      {due === undefined ? (
        canRetry && (
          <Button
            size="xs"
            variant="outline"
            data-testid="agent-error-retry-then"
            onClick={onRetryThen}
          >
            <RotateCw aria-hidden />
            Retry then
          </Button>
        )
      ) : (
        <span
          data-testid="agent-error-retry-scheduled"
          className="inline-flex items-center gap-1.5"
        >
          <span className="text-muted-foreground">Retrying at {time} while Gram is open</span>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </span>
      )}
      {usage}
    </div>
  );
}
