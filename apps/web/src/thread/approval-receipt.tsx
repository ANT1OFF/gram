import type { ThreadId } from "@gram/contracts";
import { CircleCheck, CircleSlash, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

import type { ApprovalReceipt } from "./request-model";

// What answering an approval did, in the scope that was chosen, where its card was: "Allowed once",
// "Always allowed Bash(git push:*) · This repository · saved in …", or "Denied". It shows for a few
// seconds, then goes; the tool row above carries the lasting state.

export const RECEIPT_MS = 8000;

/** Which request the receipt answered, and the tool call it held: its row shows the receipt. */
export interface ReceiptSource {
  readonly requestId: string;
  readonly toolUseId: string | undefined;
}

interface ApprovalReceiptsState {
  readonly byThread: Readonly<
    Record<string, ApprovalReceipt & Partial<ReceiptSource> & { readonly at: number }>
  >;
  show: (threadId: ThreadId, receipt: ApprovalReceipt, source?: ReceiptSource) => void;
  clear: (threadId: ThreadId, at: number) => void;
}

export const useApprovalReceipts = create<ApprovalReceiptsState>()((set) => ({
  byThread: {},
  show: (threadId, receipt, source) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: { ...receipt, ...source, at: Date.now() } },
    })),
  clear: (threadId, at) =>
    set((s) => {
      if (s.byThread[threadId]?.at !== at) return s;
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: rest };
    }),
}));

const ICON = { once: CircleCheck, always: ShieldCheck, deny: CircleSlash } as const;

/** The last approval's receipt in this thread, while it is fresh. */
export function ApprovalReceiptLine({ threadId }: { threadId: ThreadId }) {
  const receipt = useApprovalReceipts((s) => s.byThread[threadId]);
  const at = receipt?.at;
  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(
      () => useApprovalReceipts.getState().clear(threadId, at),
      Math.max(0, at + RECEIPT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [threadId, at]);
  if (receipt === undefined) return null;
  const Icon = ICON[receipt.decision];
  return (
    <p
      role="status"
      data-testid="approval-receipt"
      data-decision={receipt.decision}
      className="my-2 flex min-w-0 items-baseline gap-1.5 text-meta text-muted-foreground"
    >
      <Icon
        aria-hidden
        className={cn(
          "size-icon-row shrink-0 translate-y-0.5",
          receipt.decision === "deny" ? "text-muted-foreground" : "text-success",
        )}
      />
      <span className="shrink-0 text-foreground">{receipt.label}</span>
      <code className="min-w-0 truncate font-mono" title={receipt.subject}>
        {receipt.subject}
      </code>
      {receipt.scope !== undefined && (
        <span className="min-w-0 truncate" title={receipt.scope}>
          · {receipt.scope}
        </span>
      )}
    </p>
  );
}
