import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@gram/contracts";
import { ArrowLeftRight, Check, Ellipsis, GitFork, SquareArrowOutUpRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { MENU_ITEM, MENU_POPUP } from "@/lib/selection";
import { lazyPart } from "@/lib/lazy-part";
import { useAllActivity } from "@/stores/all-activity";
import { useThreadsStore } from "@/stores/threads";

import { continueLabel } from "./agent-switch-model";
import { ThreadMenuItems } from "./thread-action-items";
import { useThreadDialogs } from "./thread-dialogs-store";
import { useSwitchOffer } from "./use-switch-offer";
import { useForkAvailability, useForkThread, WORKTREE_NOTICE } from "./use-fork";

/** The dialogs the menu opens, each loaded the first time it's asked for or once the shell is idle. */
const forkDialog = lazyPart(() => import("./fork-dialog"));

/**
 * What the pane header's "…" offers on a thread, for any menu to hold: its items, and the dialogs
 * and error line they open, which live outside the menu so they outlast it. The pane header's own
 * "…" holds them, and so does the title bar's single "…" for the thread it carries.
 */
export function useThreadMenu(threadId: ThreadId): {
  /**
   * The menu's items: "Continue in Codex…" first, the orchestrator's too, then the folder, Fork and
   * the thread verbs.
   */
  items: (itemClassName: string) => ReactNode;
  /** The dialogs the items open, and a failed fork's line: render them beside the menu. */
  aside: ReactNode;
} {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const folder = thread?.checkout.path;
  // Any thread moves to the other agent from here: a plain thread or worker from the composer's chip
  // too, the orchestrator from the workspace settings' Models too.
  const offer = useSwitchOffer(threadId);
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const { available, reason } = useForkAvailability(threadId);
  const { fork, error, clearError } = useForkThread(threadId);
  const [dialog, setDialog] = useState<{ notice?: string }>();
  const forker = forkDialog.useModule(dialog !== undefined);

  const forkThread = async () => {
    if ((await fork()) === "needsWorktree") setDialog({ notice: WORKTREE_NOTICE });
  };

  const items = (itemClassName: string) => (
    <>
      {offer.offered && (
        <>
          {offer.refusal === undefined ? (
            <Menu.Item
              data-testid="menu-continue-in"
              className={itemClassName}
              onClick={() => useThreadDialogs.getState().open({ kind: "continueIn", threadId })}
            >
              <ArrowLeftRight aria-hidden className="size-icon-row" />
              {continueLabel(offer.to)}…
            </Menu.Item>
          ) : (
            // Greyed, it says why on hover, in the words the server would refuse with.
            <Hint
              label={offer.refusal}
              side="bottom"
              render={
                <Menu.Item
                  data-testid="menu-continue-in"
                  disabled
                  aria-description={offer.refusal}
                  className={itemClassName}
                />
              }
            >
              <ArrowLeftRight aria-hidden className="size-icon-row" />
              {continueLabel(offer.to)}…
            </Hint>
          )}
          <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        </>
      )}
      {local && (
        <Menu.Item
          disabled={folder === undefined}
          className={itemClassName}
          onClick={() => {
            if (folder) void openInEditor(folder, { threadId });
          }}
        >
          <SquareArrowOutUpRight aria-hidden className="size-icon-row" />
          Open folder in editor
        </Menu.Item>
      )}
      <Menu.Item disabled={!available} className={itemClassName} onClick={() => void forkThread()}>
        <GitFork aria-hidden className="size-icon-row" />
        Fork thread
      </Menu.Item>
      {reason && <p className="px-2 py-1 text-meta text-muted-foreground">{reason}</p>}
      <ThreadMenuItems threadId={threadId} itemClassName={itemClassName} />
    </>
  );

  const aside = (
    <>
      {error && (
        <button
          type="button"
          role="alert"
          title={`${error} (click to dismiss)`}
          className="max-w-48 shrink truncate text-meta text-destructive @max-md:hidden"
          onClick={clearError}
        >
          {error}
        </button>
      )}
      {dialog && forker && (
        <forker.ForkDialog
          threadId={threadId}
          notice={dialog.notice}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(undefined);
          }}
        />
      )}
    </>
  );

  return { items, aside };
}

/**
 * "Show all activity", an orchestrator chat's view option: off, what changed nothing for the user
 * folds into its update; checked, every digest and reply as it was sent. It lives with the thread's
 * other view options (the title bar's View, a pane's "…"), not as a switch over the chat. Nothing on
 * any other thread.
 */
export function AllActivityItem({
  threadId,
  className,
}: {
  threadId: ThreadId;
  className: string;
}) {
  const orchestrator = useThreadsStore((s) => s.byId[threadId]?.thread.role === "orchestrator");
  const on = useAllActivity((s) => s.shown.has(threadId));
  if (!orchestrator) return null;
  return (
    <Menu.CheckboxItem
      data-testid="menu-all-activity"
      // One toggle, so the menu closes on it and the chat shows the change at once.
      closeOnClick
      className={className}
      checked={on}
      onCheckedChange={(checked) => useAllActivity.getState().set(threadId, checked)}
    >
      <span className="flex size-icon-row shrink-0 items-center justify-center">
        <Menu.CheckboxItemIndicator>
          <Check aria-hidden className="size-icon-row" />
        </Menu.CheckboxItemIndicator>
      </span>
      Show all activity
    </Menu.CheckboxItem>
  );
}

/**
 * The pane header's "…" menu: "Continue in Codex…" first, then opening the folder in the
 * editor, forking the thread, its own verbs and More…, then an orchestrator chat's Show all
 * activity (the title bar keeps it under View). More… has the rest: the branch to copy and
 * push (the agents' working detail, kept out of the bar and its menu), the worker's or
 * orchestrator's links, other windows, revealing the folder, forking into a worktree. A thread the
 * title bar carries has these in the bar's one "…" instead.
 */
export function ThreadMenu({ threadId, label }: { threadId: ThreadId; label?: string }) {
  const { items, aside } = useThreadMenu(threadId);
  return (
    <>
      {aside}
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size={label ? "sm" : "icon-sm"}
              aria-label={label ?? "Thread menu"}
              title={label ? undefined : "Thread menu"}
            />
          }
          className="shrink-0"
        >
          <Ellipsis />
          {label}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
            <Menu.Popup data-testid="thread-menu" className={MENU_POPUP}>
              {items(MENU_ITEM)}
              <AllActivityItem threadId={threadId} className={MENU_ITEM} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}
