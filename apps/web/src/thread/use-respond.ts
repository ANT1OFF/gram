import type { PendingRequest, RequestAnswer, ThreadId } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { respondToCard } from "@/api/respond-to-card";

import { useApprovalReceipts } from "./approval-receipt";
import type { ApprovalReceipt } from "./request-model";

/**
 * A card's answer, sent once at a time: named for the card as it was shown (`respondToCard`), and
 * with a receipt shown once it went. A failed one lets the card be answered again.
 */
export function useRespond(threadId: ThreadId, request: PendingRequest) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const respond = async (answer: RequestAnswer, receipt?: ApprovalReceipt) => {
    if (pending) return;
    setPending(true);
    try {
      await respondToCard(api, threadId, request, answer);
      if (receipt !== undefined)
        useApprovalReceipts.getState().show(threadId, receipt, {
          requestId: request.id,
          toolUseId: request.kind === "approval" ? request.toolUseId : undefined,
        });
    } catch (error) {
      console.error("respond", error);
      setPending(false);
    }
  };
  return { respond, pending };
}
