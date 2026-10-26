import type { PrDetail, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  MessageSquare,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";

import { PrLabels } from "./pr-labels";
import { Notice, useReviewAction } from "./review/review-thread-card";

interface ReviewerState {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone: string;
}

const REVIEW_STATE: Record<string, ReviewerState> = {
  APPROVED: { icon: CircleCheck, label: "Approved", tone: "text-success" },
  CHANGES_REQUESTED: { icon: CircleX, label: "Changes requested", tone: "text-destructive" },
  COMMENTED: { icon: MessageSquare, label: "Commented", tone: "text-muted-foreground" },
  DISMISSED: { icon: CircleMinus, label: "Dismissed", tone: "text-muted-foreground" },
};

const reviewState = (state: string): ReviewerState =>
  REVIEW_STATE[state] ?? {
    icon: MessageSquare,
    label: state.toLowerCase().replaceAll("_", " "),
    tone: "text-muted-foreground",
  };

export interface Reviewer {
  readonly name: string;
  readonly team: boolean;
  readonly state: ReviewerState;
}

/**
 * Requested reviewers first, then everyone else's latest review. A re-requested reviewer shows as
 * requested, with their earlier verdict in the label; the author's own replies aren't reviews.
 */
export const reviewerRoster = (detail: PrDetail): Array<Reviewer> => {
  const latest = (detail.latestReviews ?? []).filter((review) => review.author !== detail.author);
  const byAuthor = new Map(latest.map((review) => [review.author.toLowerCase(), review]));
  const requested = (detail.reviewRequests ?? []).map((request) => {
    const earlier = byAuthor.get(request.name.toLowerCase());
    byAuthor.delete(request.name.toLowerCase());
    const label = earlier
      ? `Review requested, previously ${reviewState(earlier.state).label.toLowerCase()}`
      : "Review requested";
    return {
      name: request.name,
      team: request.kind === "team",
      state: { icon: CircleDashed, label, tone: "text-warning" },
    };
  });
  const reviewed = [...byAuthor.values()].map((review) => ({
    name: review.author,
    team: false,
    state: reviewState(review.state),
  }));
  return [...requested, ...reviewed];
};

/** The PR's reviewers and their verdicts, or nothing while there are none; `children` sits at the end of the row. */
export function PrReviewers({ detail, children }: { detail: PrDetail; children?: ReactNode }) {
  const roster = reviewerRoster(detail);
  return (
    <div
      data-testid="pr-reviewers"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {roster.length > 0 && <span>Reviewers</span>}
      {roster.length > 0 && (
        <ul aria-label="Reviewers" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {roster.map((reviewer) => (
            <li
              key={`${reviewer.team ? "team" : "user"}:${reviewer.name}`}
              title={`${reviewer.name}: ${reviewer.state.label}`}
              className="flex items-center gap-1"
            >
              <reviewer.state.icon
                aria-hidden
                className={cn("size-3.5 shrink-0", reviewer.state.tone)}
              />
              {reviewer.team && <Users aria-hidden className="size-3 shrink-0" />}
              <span className="text-foreground">{reviewer.name}</span>
              <span className="sr-only">
                {reviewer.team ? " (team)" : ""}: {reviewer.state.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

const inputCls =
  "h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The comma- or space-separated names typed so far. */
export const splitNames = (value: string): Array<string> =>
  value
    .split(/[\s,]+/)
    .map((name) => name.replace(/^@/, ""))
    .filter((name) => name !== "");

/** The PR header's people strip: reviewers, and asking someone to review. */
export function PrPeople({ threadId, detail }: { threadId: ThreadId; detail: PrDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const action = useReviewAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const suggestions = useQuery({
    queryKey: ["pr.reviewerSuggestions", threadId],
    queryFn: () => api.prReviewerSuggestions(threadId),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const typed = splitNames(value);
  const partial = /[\s,]$/.test(value) ? "" : (typed.at(-1) ?? "");
  const taken = new Set(
    [detail.author, ...reviewerRoster(detail).map((r) => r.name), ...typed].map((name) =>
      name.toLowerCase(),
    ),
  );
  const picks = (suggestions.data?.logins ?? [])
    .filter((login) => !taken.has(login.toLowerCase()))
    .filter((login) => login.toLowerCase().includes(partial.toLowerCase()))
    .slice(0, 6);

  const pick = (login: string) =>
    setValue(`${[...(partial === "" ? typed : typed.slice(0, -1)), login].join(", ")}, `);

  const stripRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setValue("");
    // The form leaves with its focused field: back to "Request review…".
    setTimeout(() => {
      if (focusLost()) focusIfConnected(stripRef.current?.querySelector("[data-request-review]"));
    }, 0);
  };

  const submit = () =>
    action.run(async () => {
      const { reviewers } = await api.prRequestReview(threadId, typed);
      close();
      await queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] });
      return `Asked ${reviewers.join(", ")} to review`;
    });

  return (
    <div className="flex flex-wrap items-start gap-x-1 gap-y-1">
      <div ref={stripRef} className="flex min-w-0 flex-col gap-1 has-[form]:basis-full">
        <PrReviewers detail={detail}>
          {!open && (
            <Button
              data-request-review
              size="xs"
              variant="outline"
              className="border-dashed text-muted-foreground"
              disabled={action.pending}
              onClick={() => setOpen(true)}
            >
              <UserPlus aria-hidden />
              Request review…
            </Button>
          )}
        </PrReviewers>
        {open && (
          <form
            aria-label="Request review"
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.length > 0) void submit();
            }}
          >
            <div className="flex items-center gap-1">
              <input
                aria-label="Logins or teams to ask"
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                className={inputCls}
                placeholder="login or org/team, comma-separated"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") close();
                }}
              />
              <Button type="submit" size="xs" disabled={action.pending || typed.length === 0}>
                Request
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
            {picks.length > 0 && (
              <ul aria-label="Suggested reviewers" className="flex flex-wrap gap-1">
                {picks.map((login) => (
                  <li key={login}>
                    <Button type="button" size="xs" variant="outline" onClick={() => pick(login)}>
                      {login}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </form>
        )}
        <Notice notice={action.notice} />
      </div>
      <PrLabels threadId={threadId} detail={detail} />
    </div>
  );
}
