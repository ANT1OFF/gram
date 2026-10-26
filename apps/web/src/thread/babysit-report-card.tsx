import type { BabysitReport, ChecksRollup } from "@gram/contracts";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  GitPullRequest,
  Hand,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { OutboundLink } from "@/panels/outbound-link";

import { FindingList, VerdictLabel } from "./review-notice-card";

const CHECKS: Record<ChecksRollup, { icon: LucideIcon; label: string; tone: string }> = {
  passing: { icon: CircleCheck, label: "Checks passing", tone: "text-success" },
  failing: { icon: CircleX, label: "Checks failing", tone: "text-destructive" },
  pending: { icon: CircleDashed, label: "Checks running", tone: "text-warning" },
  none: { icon: CircleMinus, label: "No checks", tone: "text-muted-foreground" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Babysitting's closing card: the PR is ready for a human to merge. */
export function BabysitReportCard({ report }: { report: BabysitReport }) {
  const checks = CHECKS[report.checks];
  return (
    <article
      aria-label={`#${report.number} ready to merge`}
      data-testid="babysit-report"
      className="my-2 flex flex-col gap-2 rounded-(--radius-md) border border-border bg-card/40 p-3 text-sm"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitPullRequest aria-hidden className="size-4 text-success" />
        <OutboundLink
          href={report.url}
          className="flex items-center gap-1 font-medium text-link underline-offset-4 hover:underline"
        >
          #{report.number} ready to merge
          <ExternalLink aria-hidden className="size-3" />
        </OutboundLink>
        <span className="font-mono text-xs text-muted-foreground">
          {report.headRefOid.slice(0, 7)}
        </span>
      </header>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <VerdictLabel verdict={report.verdict} />
        <span className={cn("flex items-center gap-1", checks.tone)}>
          <checks.icon aria-hidden className="size-3.5" />
          {checks.label}
        </span>
        <span className="text-muted-foreground">
          Merge state <span className="font-mono">{report.mergeState}</span>
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        {plural(report.rounds, "round")} · {plural(report.handled, "finding")} handled
      </p>
      <FindingList label="Declined" findings={report.declined} tone="text-warning" />
      <p data-testid="babysit-not-merged" className="flex items-center gap-1 text-xs font-medium">
        <Hand aria-hidden className="size-3.5" />
        Not merged: merging is up to you
      </p>
    </article>
  );
}
