import type {
  HumanReviewNotice,
  ReviewNotice,
  ReviewNoticeFinding,
  ReviewVerdict,
} from "@gram/contracts";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { OutboundLink } from "@/panels/outbound-link";

const NOTICE_VERDICT: Record<ReviewVerdict, { icon: LucideIcon; label: string; tone: string }> = {
  approved: { icon: CircleCheck, label: "Approved", tone: "text-success" },
  changesRequested: { icon: CircleX, label: "Changes requested", tone: "text-destructive" },
  commented: { icon: MessageSquare, label: "Commented", tone: "text-muted-foreground" },
};

const NO_VERDICT = { icon: CircleDashed, label: "No verdict yet", tone: "text-muted-foreground" };

/** The bot's verdict as icon plus words. */
export function VerdictLabel({ verdict }: { verdict: ReviewVerdict | undefined }) {
  const display = verdict ? NOTICE_VERDICT[verdict] : NO_VERDICT;
  return (
    <span data-testid="notice-verdict" className={cn("flex items-center gap-1", display.tone)}>
      <display.icon aria-hidden className="size-3.5" />
      {display.label}
    </span>
  );
}

/** Findings as `path:line` (linked when the finding has a url) plus the trimmed body. */
export function FindingList({
  label,
  findings,
  tone,
}: {
  label: string;
  findings: readonly ReviewNoticeFinding[];
  tone?: string;
}) {
  if (findings.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h4 className={cn("text-xs font-medium", tone)}>
        {label} ({findings.length})
      </h4>
      <ul className="flex flex-col gap-1.5">
        {findings.map((finding) => {
          const where =
            finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
          return (
            <li key={finding.reviewThreadId} className="flex flex-col text-xs">
              {finding.url ? (
                <OutboundLink
                  href={finding.url}
                  className="w-fit font-mono text-link underline-offset-4 hover:underline"
                >
                  {where}
                </OutboundLink>
              ) : (
                <span className="font-mono text-muted-foreground">{where}</span>
              )}
              <span className="line-clamp-3">{finding.body.replaceAll(/\s+/g, " ").trim()}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The review monitor's queued notice, shown in place of the text the agent reads. */
export function ReviewNoticeCard({ notice, text }: { notice: ReviewNotice; text: string }) {
  const title = `Review update on #${notice.number}`;
  return (
    <article
      aria-label={title}
      data-testid="review-notice"
      className="flex w-full max-w-xl flex-col gap-2 rounded-(--radius-md) border border-border bg-card/40 p-3 text-sm"
    >
      <header className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-medium">{title}</h3>
        {notice.round !== undefined && (
          <span className="text-xs text-muted-foreground">Round {notice.round}</span>
        )}
      </header>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <VerdictLabel verdict={notice.verdict} />
        {notice.mergeState !== undefined && (
          <span className="text-muted-foreground">
            Merge state <span className="font-mono">{notice.mergeState}</span>
          </span>
        )}
      </p>
      {notice.ciFailed.length > 0 && (
        <ul aria-label="Failing checks" className="flex flex-wrap gap-1">
          {notice.ciFailed.map((name) => (
            <li
              key={name}
              className="flex items-center gap-1 rounded-sm border border-destructive/40 px-1 text-xs text-destructive"
            >
              <CircleX aria-hidden className="size-3" />
              <span>Failing: {name}</span>
            </li>
          ))}
        </ul>
      )}
      <FindingList label="Blockers" findings={notice.blockers} tone="text-destructive" />
      <FindingList label="Suggestions" findings={notice.suggestions} tone="text-warning" />
      <NoticeText text={text} />
    </article>
  );
}

/** The text the agent read, behind a disclosure. */
function NoticeText({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform group-data-[panel-open]:rotate-90"
        />
        Text sent to the agent
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">
        <pre
          data-testid="notice-text"
          className="mt-1 overflow-x-auto rounded-sm bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The review monitor's notice of a person's review: each person's standing verdict. */
export function HumanReviewNoticeCard({
  notice,
  text,
}: {
  notice: HumanReviewNotice;
  text: string;
}) {
  const title = `Review from a person on #${notice.number}`;
  const fresh = new Set(notice.newReviewIds);
  return (
    <article
      aria-label={title}
      data-testid="human-review-notice"
      className="flex w-full max-w-xl flex-col gap-2 rounded-(--radius-md) border border-border bg-card/40 p-3 text-sm"
    >
      <h3 className="font-medium">{title}</h3>
      <ul aria-label="Reviews" className="flex flex-col gap-1.5">
        {notice.reviews.map((review) => (
          <li key={review.id} className="flex flex-col gap-0.5 text-xs">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium">{review.author}</span>
              <VerdictLabel verdict={review.verdict} />
              {fresh.has(review.id) && <span className="text-muted-foreground">New</span>}
            </span>
            {review.body.trim() !== "" && (
              <span className="line-clamp-3">{review.body.replaceAll(/\s+/g, " ").trim()}</span>
            )}
          </li>
        ))}
      </ul>
      <NoticeText text={text} />
    </article>
  );
}
