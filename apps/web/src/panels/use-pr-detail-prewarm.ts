import type { ThreadId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useApi } from "@/api/context";
import { useThreadsStore } from "@/stores/threads";

import { prDetailQuery, prDetailStamp } from "./pr-detail-query";

/** How long the pointer or focus rests on a PR panel opener before it counts as intent. */
export const PREWARM_DWELL_MS = 150;

/** As long as the server's own detail cache, so resting on an opener again within it asks nothing. */
const PREWARM_FRESH_MS = 30_000;

/** Spread onto an element that opens the PR panel. */
export interface PrDetailPrewarmHandlers {
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
}

/**
 * Handlers for an element that opens the thread's PR panel: resting the pointer or keyboard focus
 * on it fetches the PR detail under the panel's query key, so the click that follows doesn't wait
 * on `gh pr view` and `gh pr diff`. Nothing is fetched for a thread without a PR, and nothing is
 * subscribed to, so a sidebar of badges costs no renders.
 */
export function usePrDetailPrewarm(threadId: ThreadId): PrDetailPrewarmHandlers {
  const api = useApi();
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return useMemo(() => {
    const cancel = () => clearTimeout(timer.current);
    const arm = () => {
      cancel();
      // The dwell is what keeps a pointer crossing the sidebar from asking GitHub about every row.
      timer.current = setTimeout(() => {
        const summary = useThreadsStore.getState().byId[threadId];
        const stamp = prDetailStamp(summary?.git, summary?.thread.boundPr);
        if (stamp === null) return;
        void client.prefetchQuery({
          ...prDetailQuery(api, threadId, stamp),
          staleTime: PREWARM_FRESH_MS,
        });
      }, PREWARM_DWELL_MS);
    };
    return { onPointerEnter: arm, onPointerLeave: cancel, onFocus: arm, onBlur: cancel };
  }, [api, client, threadId]);
}
