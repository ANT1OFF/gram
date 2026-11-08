import type { ThreadId } from "@gram/contracts";
import { Square } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/time";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { stopOf, type StopReceipt } from "./attempt-model";
import { inTurn } from "./orchestration-model";
import { useStopStore } from "./stop-store";

/** "Stopped by you · 14:05", or "Stopped · 14:05" for a stop the user didn't make from here. */
export const stopLabel = (
  receipt: StopReceipt,
  now = Date.now(),
  intl: { readonly timeZone?: string } = {},
): string =>
  `${receipt.byYou ? "Stopped by you" : "Stopped"} · ${formatStamp(receipt.at, now, intl)}`;

/** What Continue sends: the agent picks up where it stopped. */
const CONTINUE = "Continue";

/** The thread's stop receipt while nothing has followed the stop and no turn runs, else undefined. */
export function useStopReceipt(threadId: ThreadId): StopReceipt | undefined {
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const stoppedAt = useStopStore((s) => s.stoppedAt[threadId]);
  const messages = useThreadFeed(threadId, (state) => state.messages);
  const receipt = useMemo(() => stopOf(messages, stoppedAt), [messages, stoppedAt]);
  return receipt === undefined || inTurn(status) ? undefined : receipt;
}

/**
 * Where a stopped turn ended, the transcript's last line until anything follows it, right under
 * what the turn had said rather than down by the composer: who stopped it and when, and Continue,
 * which sends "Continue" so the agent picks up where it stopped.
 */
export function StopReceiptLine({
  threadId,
  receipt,
}: {
  threadId: ThreadId;
  receipt: StopReceipt;
}) {
  const api = useApi();
  const [sending, setSending] = useState(false);
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
      className="my-2 flex items-center gap-3 text-meta text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <Square aria-hidden className="size-icon-chip fill-current" />
        <span data-testid="stop-receipt-label" className="text-foreground">
          {stopLabel(receipt)}
        </span>
      </span>
      <Button
        size="xs"
        variant="outline"
        className="phone:h-11 phone:px-4"
        data-testid="stop-receipt-continue"
        title="Send “Continue” so the agent picks up where it stopped"
        disabled={sending}
        onClick={() => void go()}
      >
        Continue
      </Button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
