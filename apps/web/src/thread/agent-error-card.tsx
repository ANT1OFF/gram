import type { GramUIMessage, ThreadError, ThreadId, ThreadStatus, TurnId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleX, Clock, Replace, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button, buttonVariants } from "@/components/ui/button";
import { askModelPicker } from "@/composer/model-picker-request";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatStamp } from "@/lib/time";
import { feedMessages, useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";
import { useUsageLimits } from "@/stores/usage-limits";
import { useNow } from "@/lib/use-now";
import { resetText } from "@/usage/limit-format";

import {
  attemptsOf,
  errorKey,
  type AttemptFacts,
  type EarlierAttempt,
  type RetryReceipt,
} from "./attempt-model";
import { failureLabel, USAGE_LIMIT, USAGE_LIMIT_SHORT } from "./failure-kinds";
import { HOLD_UNDER_POINTER } from "./hold-under-pointer";
import { AUTO_RETRY_MS, retryKey, retryTimeOf, useRetrySchedule } from "./retry-time";

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

/** "Retried · 14:05": when the message went again. */
/** "Recovered · 14:05" once the retry ran through, else "Retried · 14:05". */
const retriedLabel = (retried: RetryReceipt): string => {
  const word = retried.recovered ? "Recovered" : "Retried";
  return retried.at === undefined ? word : `${word} · ${formatStamp(retried.at)}`;
};

/**
 * The attempts before the one a card shows, behind a disclosure: "1 earlier attempt", each with
 * its number, when it failed and what it said.
 */
function EarlierAttempts({ earlier }: { earlier: readonly EarlierAttempt[] }) {
  if (earlier.length === 0) return null;
  const count = earlier.length === 1 ? "1 earlier attempt" : `${earlier.length} earlier attempts`;
  return (
    <Collapsible data-testid="agent-error-earlier" className="mt-1">
      <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm text-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-9">
        <ChevronRight
          aria-hidden
          className="size-icon-chip shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        {count}
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">
        <ol className="mt-1 flex flex-col gap-1 border-l border-border pl-3 text-meta text-muted-foreground">
          {earlier.map(({ attempt, error }) => (
            <li key={errorKey(error)} data-testid="agent-error-earlier-attempt">
              <span className="font-medium text-foreground">
                {`Attempt ${attempt} · ${formatStamp(error.at)}`}
              </span>
              {` · ${failureLabel(error.kind, error.retryable)}`}
              <p className="break-words">{error.text}</p>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Where a turn failed, in the transcript: Gram's sentence for it, and a retry that sends the
 * turn's message again while that still makes sense: the failure may clear, it is still the thread's
 * last error, and nothing is running. A retry that fails says so under the turn's own failure, until
 * the next try.
 *
 * The attempts at one message are one card: the newest failure's, "attempt 2 of 2 · needs action",
 * with the attempts before it behind a disclosure; their own cards draw nothing. Once a retry went
 * through, that card is a quiet receipt led by where it stands, "Recovered · 14:05", with the
 * failure under it, no longer red and with no Retry of its own, above the reply that came of it.
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
  // The server waiting the limit out (`Thread.limitWait`) retries on its own; the card offers none.
  const waiting = useThreadsStore((s) => s.byId[threadId]?.thread.limitWait !== undefined);
  const limited = error.kind === "rateLimit";
  const key = retryKey(threadId, error);
  const due = useRetrySchedule((s) => s.due[key]);
  const live = limited && current && retried === undefined;
  // A minute's tick is enough for a reset shown to the minute, and only matters once it passes.
  const minute = useNow(live, undefined, 60_000);
  const limits = useUsageLimits((s) => s.limits);
  const retryAt = limited ? retryTimeOf(error, model, limits, minute) : undefined;
  // An automatic retry, set with no reset to wait for, counts down each second.
  const second = useNow(live && due !== undefined && retryAt === undefined, undefined, 1000);
  const now = Math.max(minute, second);

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

  if (attempt?.folded === true) return null;

  if (retried !== undefined) {
    // Only the run's newest failure has a card, so a retry here is the one that didn't fail.
    return (
      <div
        role="status"
        data-testid="agent-error"
        data-kind={error.kind}
        data-state="retried"
        data-recovered={retried.recovered || undefined}
        className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-border p-2.5 text-reading text-muted-foreground"
      >
        <RotateCw aria-hidden className="mt-0.5 size-icon-row shrink-0" />
        <div className="min-w-0 flex-1">
          {/* What it is now leads; the failure it got past is the line under it. */}
          <p data-testid="agent-error-retried" className="text-meta font-medium text-foreground">
            {retriedLabel(retried)}
          </p>
          <p data-testid="agent-error-history" className="text-meta break-words">
            {failureLabel(error.kind, error.retryable)}
            {attempt !== undefined && attempt.attempt > 1 && ` · attempt ${attempt.attempt}`}
            {": "}
            {error.text}
          </p>
          <EarlierAttempts earlier={attempt?.earlier ?? []} />
        </div>
      </div>
    );
  }

  const repeat = attempt !== undefined && attempt.attempt > 1;
  // A known reset still ahead: the title says when, once, and the card's step is to retry then.
  const early = retryAt !== undefined && retryAt > now;
  // A spent usage limit says so, and when it resets once that is known: "Usage limit · resets
  // 11:15". The provider throttling requests stays "Rate limited".
  const spent = limited && (!error.retryable || retryAt !== undefined);
  const title = spent
    ? early
      ? `${USAGE_LIMIT_SHORT} · resets ${resetText(retryAt, now)}`
      : USAGE_LIMIT
    : failureLabel(error.kind, error.retryable);
  const canRetryNow = text !== undefined && (error.retryable || !early);
  // Repeated throttling, with no reset to wait for: the card can try again on its own in a moment,
  // or the user can move the thread to another model. Never while the server waits the limit out.
  const throttledAgain =
    limited && repeat && error.retryable && !early && current && retried === undefined && !waiting;
  /**
   * Sends the turn's message again at `at` (plus `margin`), if it is still the thread's last error
   * with nothing running by then: "Retry at 11:15" and "Retry automatically in 30 s". Read when it
   * fires, not now: the user may have sent something else in the meantime.
   */
  const retryLater = (again: string, at: number, margin?: number) =>
    useRetrySchedule.getState().schedule(
      key,
      at,
      () => {
        const summary = useThreadsStore.getState().byId[threadId];
        if (summary?.thread.lastError?.at !== error.at || !SETTLED.has(summary.status)) return;
        void retry(again);
      },
      margin,
    );
  const usage = (
    <Link
      to="/usage"
      data-testid="agent-error-usage"
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      Usage
    </Link>
  );
  return (
    <div
      role="alert"
      data-testid="agent-error"
      data-kind={error.kind}
      data-state="failed"
      {...{ [HOLD_UNDER_POINTER]: "" }}
      className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-destructive/40 p-2.5 text-reading"
    >
      <CircleX aria-hidden className="mt-0.5 size-icon-row shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p data-testid="agent-error-title" className="text-meta font-medium text-destructive">
          {title}
          {repeat && (
            <span data-testid="agent-error-attempt-number" className="text-foreground">
              {` · attempt ${attempt.attempt} of ${attempt.of} · needs action`}
            </span>
          )}
        </p>
        <p className="break-words">{errorSentence(error.kind, error.text, early)}</p>
        {repeat && <EarlierAttempts earlier={attempt.earlier} />}
        {limited && current && retried === undefined && !early && (
          <p
            data-testid="agent-error-retry-time"
            data-known="false"
            className="mt-1 text-meta text-muted-foreground"
          >
            {retryAt === undefined
              ? unknownResetText(onGateway ? "gateway" : "provider", text !== undefined)
              : resetPassedText(onGateway ? "gateway" : "provider", text !== undefined)}{" "}
            <Link
              to="/usage"
              data-testid="agent-error-usage"
              className="text-link underline-offset-2 hover:underline"
            >
              Usage
            </Link>
            .
          </p>
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
        {limited && early && current && retried === undefined ? (
          <div
            data-testid="agent-error-retry-time"
            data-known="true"
            className="mt-2 flex flex-wrap items-center gap-2"
          >
            {due === undefined ? (
              text !== undefined && (
                <Button
                  size="sm"
                  data-testid="agent-error-retry-then"
                  disabled={pending}
                  onClick={() => retryLater(text, retryAt)}
                >
                  <RotateCw aria-hidden />
                  {`Retry at ${resetText(retryAt, now)}`}
                </Button>
              )
            ) : (
              <span
                data-testid="agent-error-retry-scheduled"
                className="inline-flex items-center gap-1.5 text-meta"
              >
                <Clock aria-hidden className="size-icon-row text-muted-foreground" />
                <span className="text-foreground">
                  {`Retrying at ${resetText(retryAt, now)} while Gram is open`}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => useRetrySchedule.getState().cancel(key)}
                >
                  Cancel
                </Button>
              </span>
            )}
            {canRetryNow && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="agent-error-retry"
                onClick={() => void retry(text)}
                disabled={pending}
              >
                Retry now
              </Button>
            )}
            {usage}
          </div>
        ) : (
          (canRetryNow || throttledAgain) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {canRetryNow && (
                <Button
                  size="sm"
                  data-testid="agent-error-retry"
                  onClick={() => void retry(text)}
                  disabled={pending}
                >
                  <RotateCw aria-hidden />
                  {throttledAgain && due !== undefined ? "Retry now" : "Retry"}
                </Button>
              )}
              {throttledAgain && text !== undefined && (
                <AutoRetry
                  due={due}
                  now={now}
                  disabled={pending}
                  onArm={() => retryLater(text, Date.now(), AUTO_RETRY_MS)}
                  onCancel={() => useRetrySchedule.getState().cancel(key)}
                />
              )}
              {throttledAgain && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="agent-error-other-model"
                  onClick={() => askModelPicker(threadId)}
                >
                  <Replace aria-hidden />
                  Try another model
                </Button>
              )}
            </div>
          )
        )}
        {unsent !== undefined && text !== undefined && (
          <p data-testid="retry-unsent" className="mt-1 text-meta break-words text-foreground">
            {unsent}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * "Retry automatically in 30 s" on a repeated rate limit; once chosen, the seconds left counting
 * down, "Retrying in 24 s", with Cancel. It sends the turn's message again the way Retry does.
 */
function AutoRetry({
  due,
  now,
  disabled,
  onArm,
  onCancel,
}: {
  /** When the automatic retry goes, epoch ms; undefined until it is chosen. */
  due: number | undefined;
  now: number;
  disabled: boolean;
  onArm: () => void;
  onCancel: () => void;
}) {
  if (due === undefined) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid="agent-error-auto-retry"
        disabled={disabled}
        onClick={onArm}
      >
        <Clock aria-hidden />
        {`Retry automatically in ${AUTO_RETRY_MS / 1000} s`}
      </Button>
    );
  }
  // `now` can be a tick older than the click that set it: never more than the wait it was set for.
  const left = Math.min(AUTO_RETRY_MS / 1000, Math.max(0, Math.ceil((due - now) / 1000)));
  return (
    <span
      role="status"
      data-testid="agent-error-auto-retry-armed"
      className="inline-flex items-center gap-1.5 text-meta"
    >
      <Clock aria-hidden className="size-icon-row text-muted-foreground" />
      <span className="text-foreground tabular-nums">{`Retrying in ${left} s`}</span>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}

/**
 * What the card says when no reset time is known: only what is known, and the two things to do.
 * "Try again in a moment" beside "when this clears isn't known" guessed and denied it at once.
 */
export const unknownResetText = (where: "provider" | "gateway", canRetry: boolean): string =>
  `The ${where} gave no reset time. ${canRetry ? "Retry now, or check" : "Check"}`;

/** What the card says once the reported reset has passed. */
export const resetPassedText = (where: "provider" | "gateway", canRetry: boolean): string =>
  `The ${where}'s reset time has passed. ${canRetry ? "Retry now, or check" : "Check"}`;

/**
 * A rate-limit sentence as the card's one line of body: without a guess stored before it was dropped
 * ("Try again in a moment."), and, once the title names the reset (`resetNamed`), without "It resets
 * on the provider's schedule.", which only said it again.
 */
export const errorSentence = (kind: string, text: string, resetNamed = false): string => {
  if (kind !== "rateLimit") return text;
  const bare = text.replace(/\s*Try again in a moment\.\s*$/u, "");
  return resetNamed ? bare.replace(/\s*It resets on the provider's schedule\.\s*$/u, "") : bare;
};
