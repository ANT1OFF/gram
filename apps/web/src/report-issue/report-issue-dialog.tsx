import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

import { lazyPart } from "@/lib/lazy-part";

const reportIssueForm = lazyPart(() => import("./report-issue-form"));

export const useReportIssueDialog = create<{
  open: boolean;
  /** The thread the user was looking at, whose agent and model the diagnostics name. */
  threadId: ThreadId | undefined;
  show: (threadId?: ThreadId) => void;
  close: () => void;
}>()((set) => ({
  open: false,
  threadId: undefined,
  show: (threadId) => set({ open: true, threadId }),
  close: () => set({ open: false, threadId: undefined }),
}));

/** Help → Report an Issue…: a bug, feature request or question, filed on Gram's repo. */
export function ReportIssueDialog() {
  const open = useReportIssueDialog((s) => s.open);
  const threadId = useReportIssueDialog((s) => s.threadId);
  const close = useReportIssueDialog((s) => s.close);
  const form = reportIssueForm.useModule(open);
  if (!open || form === undefined) return null;
  return <form.ReportIssueForm threadId={threadId} onClose={close} />;
}
