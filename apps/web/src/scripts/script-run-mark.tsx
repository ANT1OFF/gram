import type { ScriptRunState } from "@gram/contracts";
import { Check, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";

const MARKS = {
  running: { icon: Spinner, tone: "text-status-working", label: "Running" },
  finished: { icon: Check, tone: "text-success", label: "Finished" },
  failed: { icon: X, tone: "text-danger-text", label: "Failed" },
} as const;

export const scriptRunLabel = (run: ScriptRunState): string => MARKS[run].label;

/** A script tab's run: the accent spinner while it runs, green once it finished, red if it failed. */
export function ScriptRunMark({ run, className }: { run: ScriptRunState; className?: string }) {
  const { icon: Icon, tone } = MARKS[run];
  return (
    <Icon
      aria-hidden
      data-testid="script-run-mark"
      data-run={run}
      className={cn("size-3 shrink-0", tone, className)}
    />
  );
}
