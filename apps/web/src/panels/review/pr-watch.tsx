import { DEFAULT_BABYSIT_ROUNDS, type ThreadId } from "@gram/contracts";
import { CircleAlert, CircleCheck, Info, Shield } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";
import { useThreadsStore } from "@/stores/threads";

import { targetBadge } from "../pr-identity";
import { babysitStatusText } from "./babysit-model";
import { BindPrForm, FollowingStatus, usePrBinding } from "./pr-binding";
import { Notice, useReviewAction } from "./review-thread-card";
import { TogglePill } from "./toggle-switch";

/** The most bot rounds the budget field accepts. */
const MAX_BABYSIT_ROUNDS = 20;

/** The budget field's text as a round count within 1–`MAX_BABYSIT_ROUNDS`; the default when it isn't one. */
export const babysitRounds = (text: string): number => {
  const rounds = Number.parseInt(text, 10);
  return Number.isInteger(rounds)
    ? Math.min(MAX_BABYSIT_ROUNDS, Math.max(1, rounds))
    : DEFAULT_BABYSIT_ROUNDS;
};

const REVIEWS_HINT = "After each bot round, the agent gets the open findings and failing checks.";

/**
 * What the agent watches on the thread's PR, as one row of switches: babysit mode with its round
 * budget, the review monitor that queues review updates into the thread after each bot round, and
 * CI. Below the row, only while something is on: babysit's phase, what watching does, and the PR
 * the thread follows. `bindFormOpen` shows the form that binds another PR (opened from the PR's
 * actions menu).
 */
export function PrWatch({
  threadId,
  bindFormOpen = false,
  onBindFormClose,
}: {
  threadId: ThreadId;
  bindFormOpen?: boolean;
  onBindFormClose?: () => void;
}) {
  const api = useApi();
  const babysit = useThreadsStore((s) => s.byId[threadId]?.thread.babysit);
  const reviewMonitor = useThreadsStore(
    (s) => s.byId[threadId]?.thread.boundPr?.reviewMonitor === true,
  );
  // The target PR's badge, not the branch's: bound to another PR, the branch's round isn't this one's.
  const roundInFlight = useThreadsStore((s) => {
    const entry = s.byId[threadId];
    return targetBadge(entry?.git, entry?.thread.boundPr)?.review?.roundInFlight === true;
  });
  const binding = usePrBinding(threadId);
  const action = useReviewAction();
  const [roundsText, setRoundsText] = useState(String(DEFAULT_BABYSIT_ROUNDS));
  const on = babysit !== undefined;
  const stopped = babysit?.phase === "stopped";
  const ciWatched = binding.boundPr?.monitor === true;
  const pending = action.pending || binding.action.pending;

  const hint = on
    ? undefined
    : reviewMonitor
      ? REVIEWS_HINT
      : ciWatched
        ? "The agent hears when a check on this PR fails."
        : undefined;

  return (
    <div
      data-testid="pr-watch"
      className="mx-3 my-2 flex flex-col rounded-(--radius-md) border border-border bg-muted/40 text-xs"
    >
      <div
        role="group"
        aria-label="What the agent watches"
        className="flex flex-wrap items-center gap-1.5 px-2 py-1.5"
      >
        <TogglePill
          on={on}
          label="Babysit this PR"
          title="Fix CI and review findings round by round until the PR is ready to merge"
          disabled={pending}
          onToggle={() =>
            void action.run(async () => {
              if (on) await api.threadSetBabysit(threadId, false);
              else
                await api.threadSetBabysit(threadId, true, { rounds: babysitRounds(roundsText) });
              return undefined;
            })
          }
        >
          Babysit
        </TogglePill>
        <TogglePill
          on={reviewMonitor}
          label="Watch reviews"
          title={on ? "Babysit relies on this; turn babysit off first" : REVIEWS_HINT}
          // Babysitting relies on the monitor; turn babysit off first.
          disabled={pending || on}
          onToggle={() =>
            void action.run(async () => {
              await api.threadSetReviewMonitor(threadId, !reviewMonitor);
              return undefined;
            })
          }
        >
          Reviews
        </TogglePill>
        {binding.hasPr && (
          <TogglePill
            on={ciWatched}
            label="Watch CI"
            disabled={pending}
            onToggle={() => void binding.watchCi()}
          >
            CI
          </TogglePill>
        )}
        {!on && (
          <label
            className="ms-auto flex items-center gap-1 text-muted-foreground"
            title="The most bot rounds babysit runs before it stops"
          >
            max
            <input
              type="number"
              aria-label="Max babysit rounds"
              min={1}
              max={MAX_BABYSIT_ROUNDS}
              value={roundsText}
              onChange={(event) => setRoundsText(event.target.value)}
              onBlur={() => setRoundsText(String(babysitRounds(roundsText)))}
              className="h-6 w-10 rounded-md border border-input bg-background px-1.5 text-xs text-foreground tabular-nums outline-none focus-visible:border-ring"
            />
          </label>
        )}
      </div>
      {babysit && (
        <div className="flex flex-col gap-1 border-t border-border px-2 py-1.5">
          <span
            data-testid="babysit-status"
            data-phase={babysit.phase}
            className={cn(
              "flex min-w-0 items-start gap-1.5",
              stopped ? "text-status-needs" : "text-muted-foreground",
            )}
          >
            {babysit.phase === "watching" && (
              <Shield aria-hidden className="mt-0.5 size-3 shrink-0" />
            )}
            {babysit.phase === "done" && (
              <CircleCheck aria-hidden className="mt-0.5 size-3 shrink-0 text-success" />
            )}
            {stopped && <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />}
            <Shimmer active={babysit.phase === "watching" && roundInFlight}>
              {babysitStatusText(babysit)}
            </Shimmer>
          </span>
          {stopped && babysit.stopDetail && (
            <p data-testid="babysit-stop-detail" className="ps-4.5 text-status-needs">
              {babysit.stopDetail}
            </p>
          )}
        </div>
      )}
      {hint && (
        <p
          data-testid="pr-watch-hint"
          className="flex items-start gap-1.5 border-t border-border px-2 py-1.5 text-muted-foreground"
        >
          <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
          {hint}
        </p>
      )}
      {binding.boundPr && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1">
          <FollowingStatus binding={binding} />
        </div>
      )}
      {bindFormOpen && !binding.boundPr && (
        <div className="border-t border-border px-2 py-1.5">
          <BindPrForm binding={binding} onDone={() => onBindFormClose?.()} />
        </div>
      )}
      {(action.notice || binding.action.notice) && (
        <div className="border-t border-border px-2 py-1.5">
          <Notice notice={action.notice} />
          <Notice notice={binding.action.notice} />
        </div>
      )}
    </div>
  );
}
