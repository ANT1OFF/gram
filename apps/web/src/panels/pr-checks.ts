import type { CheckStatus, PrDetail } from "@gram/contracts";
import { CircleCheck, CircleMinus, CircleX, type LucideIcon } from "lucide-react";

import { PendingRing } from "@/motion";

// A PR's checks in words and glyphs, apart from the PR panel so a peek or a card can show them
// without loading the panel, its diff and its review threads.

const CHECK_STATUS: Record<CheckStatus, { icon: LucideIcon; label: string; tone: string }> = {
  passing: { icon: CircleCheck, label: "Passing", tone: "text-success" },
  failing: { icon: CircleX, label: "Failing", tone: "text-destructive" },
  pending: { icon: PendingRing, label: "Pending", tone: "text-status-working" },
  neutral: { icon: CircleMinus, label: "Neutral", tone: "text-muted-foreground" },
};

export type CheckRun = PrDetail["checkRuns"][number];

export const isCancelled = (run: CheckRun) => run.conclusion?.toUpperCase() === "CANCELLED";

/**
 * A check's icon and word, telling queued, running and cancelled checks apart by their words: every
 * pending one draws the one still hollow ring. `running` is set on the one under way, whose
 * duration ticks.
 */
export const checkState = (
  run: CheckRun,
): { icon: LucideIcon; label: string; tone: string; running?: boolean } => {
  if (isCancelled(run)) return { ...CHECK_STATUS.neutral, label: "Cancelled" };
  if (run.status === "pending" && run.phase === "queued") {
    return { ...CHECK_STATUS.pending, label: "Queued" };
  }
  if (run.status === "pending" && run.phase === "running") {
    return { ...CHECK_STATUS.pending, label: "Running", running: true };
  }
  return CHECK_STATUS[run.status];
};

/** How long the check ran, or has run so far; `undefined` before it starts. */
export const checkDuration = (run: CheckRun, now = Date.now()): string | undefined => {
  const start = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const end = run.completedAt === undefined ? now : Date.parse(run.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
