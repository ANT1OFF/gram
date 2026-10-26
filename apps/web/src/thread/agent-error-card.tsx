import type { GramUIMessage, ThreadError, ThreadId, ThreadStatus, TurnId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { CircleX, RotateCw } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { feedMessages } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { failureLabel } from "./failure-kinds";

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

/**
 * Where a turn failed, in the transcript: Gram's sentence for it, and a retry that sends the
 * turn's message again while that still makes sense: the failure may clear, it is still the thread's
 * last error, and nothing is running. A retry that fails says so under the turn's own failure, until
 * the next try.
 */
export function AgentErrorCard({ threadId, error }: { threadId: ThreadId; error: ThreadError }) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [unsent, setUnsent] = useState<string | undefined>();
  const current = useThreadsStore((s) => {
    const summary = s.byId[threadId];
    return summary?.thread.lastError?.at === error.at && SETTLED.has(summary.status);
  });
  const onGateway = useThreadsStore((s) => s.byId[threadId]?.thread.model?.profileId !== undefined);

  // Read, not subscribed: the turn's own message is in the feed before its error is.
  const text =
    error.retryable && current ? retryText(feedMessages(threadId), error.turnId) : undefined;

  const retry = async (again: string) => {
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

  return (
    <div
      role="alert"
      data-testid="agent-error"
      data-kind={error.kind}
      className="my-2 flex items-start gap-2 rounded-(--radius-md) border border-destructive/40 p-2.5 text-sm"
    >
      <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-destructive">{failureLabel(error.kind)}</p>
        <p className="break-words">{error.text}</p>
        {onGateway && GATEWAY_FIXES.has(error.kind) && (
          <Link
            to="/settings/gateways"
            data-testid="agent-error-gateways"
            className="mt-1 inline-block text-xs text-link underline-offset-2 hover:underline"
          >
            Gateway settings
          </Link>
        )}
        {unsent !== undefined && text !== undefined && (
          <p data-testid="retry-unsent" className="mt-1 text-xs break-words text-foreground">
            {unsent}
          </p>
        )}
      </div>
      {text !== undefined && (
        <Button size="xs" variant="outline" onClick={() => void retry(text)} disabled={pending}>
          <RotateCw aria-hidden />
          Retry
        </Button>
      )}
    </div>
  );
}
