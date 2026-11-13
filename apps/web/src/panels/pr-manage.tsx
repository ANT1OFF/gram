import type { PrDetail, ThreadId } from "@gram/contracts";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import { PrPeople, reviewerRoster } from "./pr-people";
import { PrWatch } from "./review/pr-watch";

/** What the agent watches on the PR, in a few words for the folded line. */
export const watchingWords = (watch: {
  readonly babysit: boolean;
  readonly reviews: boolean;
  readonly ci: boolean;
}): string => {
  if (watch.babysit) return "watching the PR";
  const what = [watch.reviews && "reviews", watch.ci && "CI"].filter(Boolean);
  return what.length === 0 ? "not watching" : `watching ${what.join(" and ")}`;
};

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The PR's reviewers, labels and what the agent watches, under one quiet disclosure below the
 * blocker summary. Folded, one line says what is inside: "4 reviewers · 2 labels · not watching".
 * It starts folded while something blocks the merge, so the summary and its next step lead, and
 * open otherwise. It opens by itself for the bind form, whenever the agent is watching (so a
 * babysit's status stays in sight), and each time `reveal` grows.
 */
export function PrManage({
  threadId,
  detail,
  blocked,
  bindFormOpen,
  onBindFormClose,
  reveal = 0,
}: {
  threadId: ThreadId;
  detail: PrDetail;
  /** Something blocks the merge: the disclosure starts folded. */
  blocked: boolean;
  bindFormOpen: boolean;
  onBindFormClose: () => void;
  /** Opens it each time it grows, e.g. the summary's next step is asking for a review. */
  reveal?: number;
}) {
  const contentId = useId();
  const babysit = useThreadsStore((s) => s.byId[threadId]?.thread.babysit !== undefined);
  const reviews = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr?.reviewMonitor === true);
  const ci = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr?.monitor === true);
  const watch = { babysit, reviews, ci };
  const [choice, setChoice] = useState<boolean>();
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    setChoice(true);
  }
  const open = bindFormOpen || (choice ?? (!blocked || watch.babysit));
  const reviewers = reviewerRoster(detail).length;
  const labels = detail.labels?.length ?? 0;
  const facts = [count(reviewers, "reviewer"), count(labels, "label"), watchingWords(watch)];

  return (
    <section aria-label="Reviewers, labels and watching" data-testid="pr-manage">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          data-testid="pr-manage-toggle"
          onClick={() => setChoice(!open)}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-3 py-1.5 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          {/* Folded, its facts name the three things it holds ("4 reviewers · 2 labels · not
              watching"), so they stand alone and are not cut by the heading saying them first. */}
          <span className={cn("shrink-0", !open && "sr-only")}>Reviewers, labels and watching</span>{" "}
          {!open && (
            <span data-testid="pr-manage-facts" className="min-w-0 truncate">
              <span className="sr-only">· </span>
              {facts.join(" · ")}
            </span>
          )}
        </button>
      </h4>
      {open && (
        <div id={contentId} className="flex flex-col">
          <div className="px-3 pt-0.5">
            <PrPeople threadId={threadId} detail={detail} />
          </div>
          <PrWatch
            threadId={threadId}
            bindFormOpen={bindFormOpen}
            onBindFormClose={onBindFormClose}
          />
        </div>
      )}
    </section>
  );
}
