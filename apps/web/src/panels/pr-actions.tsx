import type { MergeStrategy, PrDetail, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu } from "@base-ui/react/menu";
import {
  Copy,
  Ellipsis,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  RefreshCcw,
} from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import type { MergeMarkKind } from "@/components/pr-marks-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyText } from "@/settings/copy-text";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { Notice, useReviewAction, type NoticeState } from "./review/review-thread-card";

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * The PR's one main action (Merge, Ready for review or Reopen) and a "…" menu with the rest: draft,
 * binding another PR, copying the link and closing. Merging and closing confirm first.
 */
export function PrActions({
  threadId,
  detail,
  onBind,
}: {
  threadId: ThreadId;
  detail: PrDetail;
  /** Opens the form that binds the thread to another PR; no menu item without it. */
  onBind?: (() => void) | undefined;
}) {
  const api = useApi();
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
      <div className="flex flex-wrap items-center gap-1.5">
        {detail.state !== "MERGED" && (
          <div data-testid="pr-actions" className="flex items-center gap-1.5">
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
              <Button size="xs" disabled={action.pending} onClick={() => setConfirming("merge")}>
                <GitMerge aria-hidden />
                Merge…
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
      {options.isPending ? (
        <p className="text-xs text-muted-foreground">Loading merge options…</p>
      ) : options.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {options.error.message}
        </p>
      ) : strategies.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This repository allows none of squash, merge commits or rebase.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1.5 text-sm">
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
            <p data-testid="auto-merge-babysit" className="text-xs text-muted-foreground">
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
