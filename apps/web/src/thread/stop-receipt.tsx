import type { ThreadId } from "@gram/contracts";
import { Play, Square } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { stopOf, type StopReceipt } from "./attempt-model";
import { inTurn } from "./orchestration-model";
import { useStopStore } from "./stop-store";

/** "Stopped by you · 14:05", or "Stopped · 14:05" for a stop the user didn't make from here. */
export const stopLabel = (
  receipt: StopReceipt,
  intl?: { readonly locale?: string; readonly timeZone?: string },
): string =>
  `${receipt.byYou ? "Stopped by you" : "Stopped"} · ${formatClockTime(receipt.at, intl)}`;

/** What Continue sends: the agent picks up where it stopped. */
const CONTINUE = "Continue";

/**
 * Where a stopped turn ended, at the foot of the transcript until anything follows it: who stopped
 * it and when, and Continue, which sends "Continue" so the agent picks up where it stopped.
 */
export function StopReceiptLine({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const stoppedAt = useStopStore((s) => s.stoppedAt[threadId]);
  const messages = useThreadFeed(threadId, (state) => state.messages);
  const receipt = useMemo(() => stopOf(messages, stoppedAt), [messages, stoppedAt]);
  const [sending, setSending] = useState(false);
  if (receipt === undefined || inTurn(status)) return null;
  const go = async () => {
    setSending(true);
    try {
      await api.send(threadId, { text: CONTINUE });
    } catch (error) {
      console.error("continue turn", error);
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      role="status"
      data-testid="stop-receipt"
      data-by-you={receipt.byYou}
      className="my-2 flex items-center gap-3 text-xs text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <Square aria-hidden className="size-3 fill-current" />
        <span data-testid="stop-receipt-label" className="text-foreground">
          {stopLabel(receipt)}
        </span>
      </span>
      <Button
        size="xs"
        variant="outline"
        data-testid="stop-receipt-continue"
        title="Send “Continue” so the agent picks up where it stopped"
        disabled={sending}
        onClick={() => void go()}
      >
        <Play aria-hidden />
        Continue
      </Button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
