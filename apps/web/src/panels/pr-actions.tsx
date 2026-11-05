import type { MergeStrategy, PrDetail, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu } from "@base-ui/react/menu";
import {
  Ban,
  Copy,
  Ellipsis,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  RefreshCcw,
} from "lucide-react";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import {
  BOT_DISPLAY,
  CHECKS_DISPLAY,
  MERGE_DISPLAY,
  REVIEW_DISPLAY,
  type MergeMarkKind,
  type PrMarkDisplay,
} from "@/components/pr-marks-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyText } from "@/settings/copy-text";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import {
  blockedLineOf,
  blockerSummaryOf,
  fixConflictsMessage,
  mergeBlockersOf,
  primaryBlockerAction,
  type BlockerAction,
  type BlockerSource,
  type BotSource,
  type MergeBlockerKind,
} from "./pr-blockers";
import { Notice, useReviewAction, type NoticeState } from "./review/review-thread-card";

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:row-cursor [&_svg]:size-icon-row [&_svg]:shrink-0";

/**
 * Why merging an open PR wouldn't go through yet, as GitHub's merge state and the PR's reviews and
 * checks say, worst first: "Blocked: 1 failing check, changes requested"; `undefined` when nothing
 * stands in the way that the panel knows of.
 */
export function mergeBlockedReason(
  detail: BlockerSource,
  merge: MergeMarkKind | undefined,
  bot?: BotSource | undefined,
): string | undefined {
  return blockedLineOf(mergeBlockersOf(detail, merge, bot));
}

const BLOCKER_DISPLAY: Record<MergeBlockerKind, PrMarkDisplay> = {
  checks: CHECKS_DISPLAY.failing,
  conflicts: MERGE_DISPLAY.conflicts,
  changes: REVIEW_DISPLAY.changes,
  bot: BOT_DISPLAY.blockers,
  review: REVIEW_DISPLAY.waiting,
  required: MERGE_DISPLAY.blocked,
};

/**
 * What blocks an open PR's merge, worst first, then the PR's one main action and a "…" menu with
 * the rest: draft, binding another PR, copying the link and closing. Blocked, the main action is the
 * next step for the worst blocker and Merge steps back beside it. Merging and closing confirm first.
 */
export function PrActions({
  threadId,
  detail,
  onBind,
  merge,
  bot,
  onBlocker,
}: {
  threadId: ThreadId;
  detail: PrDetail;
  /** Opens the form that binds the thread to another PR; no menu item without it. */
  onBind?: (() => void) | undefined;
  /** Where GitHub says the merge stands, from the thread's PR badge. */
  merge?: MergeMarkKind | undefined;
  /** The review bot's status on the PR's badge; its blockers block the merge too. */
  bot?: BotSource | undefined;
  /** Takes the user to what blocks the merge: a check, a review. No such step is offered without it. */
  onBlocker?: ((action: BlockerAction) => void) | undefined;
}) {
  const api = useApi();
  const reasonId = useId();
  const queryClient = useQueryClient();
  const action = useReviewAction();
  const [confirming, setConfirming] = useState<"merge" | "close">();
  const pr = `#${detail.number}`;

  const write = (effect: () => Promise<void>, done: string) =>
    void action.run(async () => {
      // Refetch on failure too: `gh` can fail after GitHub already acted.
      try {
        await effect();
        setConfirming(undefined);
      } finally {
        await queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] });
      }
      return done;
    });

  const open = detail.state === "OPEN";
  const blockers = open && !detail.isDraft ? mergeBlockersOf(detail, merge, bot) : [];
  const blocked = blockedLineOf(blockers);
  const summary = blockerSummaryOf(blockers);
  const next = primaryBlockerAction(
    blockers.filter(
      (blocker) =>
        onBlocker !== undefined ||
        blocker.action?.kind === "fixConflicts" ||
        blocker.action?.kind === "openCheck",
    ),
  );
  const takeNext = (step: BlockerAction) => {
    if (step.kind === "openCheck") {
      void openExternalUrl(api, step.url).catch(() => undefined);
    } else if (step.kind === "fixConflicts") {
      void action.run(async () => {
        const result = await api.send(threadId, {
          text: fixConflictsMessage(detail.number, detail.baseRefName),
        });
        return result.queued ? "Queued for the agent" : "Sent to the agent";
      });
    } else onBlocker?.(step);
  };
  const more = (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="More PR actions"
            title="More PR actions"
            disabled={action.pending}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="isolate z-50">
          <Menu.Popup data-surface="overlay" data-testid="pr-actions-menu" className={POPUP}>
            {open && !detail.isDraft && (
              <Menu.Item
                className={ITEM}
                onClick={() => write(() => api.prReady(threadId, true), `${pr} is a draft again.`)}
              >
                <GitPullRequestDraft aria-hidden />
                Convert to draft
              </Menu.Item>
            )}
            {onBind && (
              <Menu.Item className={ITEM} onClick={onBind}>
                <Link2 aria-hidden />
                Bind another PR…
              </Menu.Item>
            )}
            <Menu.Item
              className={ITEM}
              onClick={() => void copyText(detail.url).catch(() => undefined)}
            >
              <Copy aria-hidden />
              Copy PR link
            </Menu.Item>
            {open && (
              <>
                <Menu.Separator className="mx-1 my-1 h-px bg-border" />
                <Menu.Item
                  className={cn(ITEM, "text-destructive data-[highlighted]:text-destructive")}
                  onClick={() => setConfirming("close")}
                >
                  <GitPullRequestClosed aria-hidden />
                  Close pull request…
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {summary !== undefined && (
        <div data-testid="pr-blockers" className="flex flex-col gap-1">
          {/* One heading: that the merge is blocked, how many things block it and of what kind.
              Each one's own words follow, and the header above leaves out what this repeats. */}
          <p
            id={reasonId}
            data-testid="pr-merge-blocked"
            className="flex min-w-0 items-baseline gap-1.5 text-reading"
          >
            <Ban aria-hidden className="size-icon-row shrink-0 self-center" />
            <span className="shrink-0 font-medium">Merge blocked</span>{" "}
            <span className="min-w-0 truncate text-muted-foreground">
              · <span data-testid="pr-blocker-count">{summary.count}</span>: {summary.categories}
            </span>
          </p>
          <ul
            aria-label="What blocks the merge"
            className="flex flex-col gap-0.5 text-meta text-muted-foreground"
          >
            {blockers.map((blocker) => {
              const mark = BLOCKER_DISPLAY[blocker.kind];
              return (
                <li
                  key={blocker.kind}
                  data-blocker={blocker.kind}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <mark.icon aria-hidden className={cn("size-icon-row shrink-0", mark.tone)} />
                  <span className="min-w-0 truncate">{blocker.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {detail.state !== "MERGED" && (
          <div data-testid="pr-actions" className="flex items-center gap-1.5">
            {next !== undefined && (
              <Button
                size="xs"
                data-testid="pr-next-action"
                data-action={next.kind}
                disabled={action.pending}
                onClick={() => takeNext(next)}
              >
                {next.label}
              </Button>
            )}
            {detail.state === "CLOSED" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={action.pending}
                onClick={() => write(() => api.prReopen(threadId), `Reopened ${pr}.`)}
              >
                Reopen
              </Button>
            ) : detail.isDraft ? (
              <Button
                size="xs"
                disabled={action.pending}
                onClick={() =>
                  write(() => api.prReady(threadId, false), `${pr} is ready for review.`)
                }
              >
                Ready for review
              </Button>
            ) : (
              // Blocked, Merge steps back to a secondary button that says so, "Merge blocked · 3
              // reasons…", described by the blockers above; it still opens, for auto-merge or a
              // merge the panel can't foresee GitHub allowing.
              <Button
                size="xs"
                variant={blocked === undefined ? "default" : "outline"}
                aria-describedby={blocked === undefined ? undefined : reasonId}
                data-blocked={blocked !== undefined}
                data-testid="pr-merge"
                disabled={action.pending}
                onClick={() => setConfirming("merge")}
              >
                <GitMerge aria-hidden />
                {summary === undefined ? "Merge…" : `Merge blocked · ${summary.count}…`}
              </Button>
            )}
          </div>
        )}
        {more}
      </div>
      {confirming === undefined && <Notice notice={action.notice} />}
      {confirming === "merge" && (
        <MergeDialog
          threadId={threadId}
          detail={detail}
          blocked={summary}
          pending={action.pending}
          notice={action.notice}
          onClose={() => setConfirming(undefined)}
          onMerge={(strategy, auto) =>
            write(
              () => api.prMerge(threadId, strategy, auto),
              auto ? `Auto-merge is on for ${pr}.` : `Merged ${pr}.`,
            )
          }
        />
      )}
      {confirming === "close" && (
        <DialogShell
          testId="pr-close-dialog"
          title={`Close ${pr} without merging?`}
          description={detail.title}
          onClose={() => setConfirming(undefined)}
        >
          <Notice notice={action.notice} />
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </Dialog.Close>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={action.pending}
              onClick={() => write(() => api.prClose(threadId), `Closed ${pr}.`)}
            >
              Close pull request
            </Button>
          </div>
        </DialogShell>
      )}
    </div>
  );
}

/** `gh pr update-branch` beside an out-of-date or conflicting PR's merge-state chip. */
export function UpdateBranch({
  threadId,
  number,
  base,
  kind,
}: {
  threadId: ThreadId;
  number: number;
  base: string;
  kind: MergeMarkKind | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const action = useReviewAction();
  const updatable = kind === "behind" || kind === "conflicts";
  if (!updatable && !action.notice) return null;
  return (
    <span className="flex items-center gap-1.5">
      {updatable && (
        <Button
          size="xs"
          variant="outline"
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              try {
                await api.prUpdateBranch(threadId);
              } finally {
                await queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] });
              }
              return `Updating #${number} with ${base}.`;
            })
          }
        >
          <RefreshCcw aria-hidden />
          Update branch
        </Button>
      )}
      <Notice notice={action.notice} />
    </span>
  );
}

/** Picks one of the strategies the repository allows, or auto-merge outside babysit mode. */
function MergeDialog({
  threadId,
  detail,
  blocked,
  pending,
  notice,
  onClose,
  onMerge,
}: {
  threadId: ThreadId;
  detail: PrDetail;
  pending: boolean;
  notice: NoticeState | undefined;
  onClose: () => void;
  onMerge: (strategy: MergeStrategy, auto: boolean) => void;
  /** What blocks the merge, as the panel's summary counts it; the dialog says so too. */
  blocked?: { readonly count: string; readonly categories: string } | undefined;
}) {
  const api = useApi();
  const options = useQuery({
    queryKey: ["pr.mergeOptions", threadId],
    queryFn: () => api.prMergeOptions(threadId),
    retry: false,
  });
  const [picked, setPicked] = useState<MergeStrategy>();
  const [autoPicked, setAutoPicked] = useState(false);
  const strategies = options.data?.strategies ?? [];
  const strategy = picked ?? strategies[0];
  const babysit = options.data?.babysit === true;
  const auto = autoPicked && options.data?.autoMerge === true && !babysit;

  return (
    <DialogShell
      testId="pr-merge-dialog"
      title={`Merge #${detail.number} into ${detail.baseRefName}?`}
      description={detail.title}
      onClose={onClose}
    >
      {blocked !== undefined && (
        <p
          data-testid="pr-merge-dialog-blocked"
          className="flex min-w-0 items-baseline gap-1.5 text-reading"
        >
          <Ban aria-hidden className="size-icon-row shrink-0 self-center" />
          <span className="shrink-0 font-medium">Merge blocked</span>{" "}
          <span className="min-w-0 text-muted-foreground">
            · {blocked.count}: {blocked.categories}
          </span>
        </p>
      )}
      {options.isPending ? (
        <p className="text-meta text-muted-foreground">Loading merge options…</p>
      ) : options.isError ? (
        <p role="alert" className="text-meta text-destructive">
          {options.error.message}
        </p>
      ) : strategies.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          This repository allows none of squash, merge commits or rebase.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1.5 text-reading">
          <legend className="sr-only">Merge strategy</legend>
          {strategies.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input
                type="radio"
                name="merge-strategy"
                checked={strategy === s}
                onChange={() => setPicked(s)}
              />
              {STRATEGY_LABEL[s]}
            </label>
          ))}
          {options.data.autoMerge && (
            <label
              className={cn("mt-1 flex items-center gap-2", babysit && "text-muted-foreground")}
            >
              <input
                type="checkbox"
                checked={auto}
                disabled={babysit}
                onChange={(event) => setAutoPicked(event.target.checked)}
              />
              Merge automatically once checks and reviews pass
            </label>
          )}
          {babysit && (
            <p data-testid="auto-merge-babysit" className="text-meta text-muted-foreground">
              Auto-merge is off while babysitting; merge by hand.
            </p>
          )}
        </fieldset>
      )}
      <Notice notice={notice} />
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          type="button"
          size="sm"
          disabled={pending || strategy === undefined}
          onClick={() => {
            if (strategy !== undefined) onMerge(strategy, auto);
          }}
        >
          {auto ? "Enable auto-merge" : STRATEGY_LABEL[strategy ?? "squash"]}
        </Button>
      </div>
    </DialogShell>
  );
}
