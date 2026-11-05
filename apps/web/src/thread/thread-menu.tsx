import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@gram/contracts";
import { ArrowLeftRight, Ellipsis, GitFork, SquareArrowOutUpRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { MENU_ITEM, MENU_POPUP } from "@/lib/selection";
import { SwitchOrchestratorDialog, switchOpenLabel } from "@/orchestration/switch-orchestrator";
import { useThreadsStore } from "@/stores/threads";

import { ForkDialog } from "./fork-dialog";
import { ThreadMenuItems } from "./thread-action-items";
import { useForkAvailability, useForkThread, WORKTREE_NOTICE } from "./use-fork";

/**
 * What the pane header's "…" offers on a thread, for any menu to hold: its items, and the dialogs
 * and error line they open, which live outside the menu so they outlast it. The pane header's own
 * "…" holds them, and so does the title bar's single "…" for the thread it carries.
 */
export function useThreadMenu(threadId: ThreadId): {
  /** The menu's items: an orchestrator's switch first, then the folder, Fork and the thread verbs. */
  items: (itemClassName: string) => ReactNode;
  /** The dialogs the items open, and a failed fork's line: render them beside the menu. */
  aside: ReactNode;
} {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const folder = thread?.checkout.path;
  // Its harness and model, switched from here and from the workspace settings' Models.
  const switchable =
    thread?.role === "orchestrator" && thread.workspaceId !== undefined ? thread : undefined;
  const [switching, setSwitching] = useState(false);
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const { available, reason } = useForkAvailability(threadId);
  const { fork, error, clearError } = useForkThread(threadId);
  const [dialog, setDialog] = useState<{ notice?: string }>();

  const forkThread = async () => {
    if ((await fork()) === "needsWorktree") setDialog({ notice: WORKTREE_NOTICE });
  };

  const items = (itemClassName: string) => (
    <>
      {switchable && (
        <>
          <Menu.Item
            data-testid="menu-switch-orchestrator"
            className={itemClassName}
            onClick={() => setSwitching(true)}
          >
            <ArrowLeftRight aria-hidden className="size-3.5" />
            {switchOpenLabel(switchable)}
          </Menu.Item>
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
          <SquareArrowOutUpRight aria-hidden className="size-3.5" />
          Open folder in editor
        </Menu.Item>
      )}
      <Menu.Item disabled={!available} className={itemClassName} onClick={() => void forkThread()}>
        <GitFork aria-hidden className="size-3.5" />
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
      {switching && switchable && (
        <SwitchOrchestratorDialog
          thread={switchable}
          workspaceId={switchable.workspaceId!}
          onClose={() => setSwitching(false)}
        />
      )}
      {dialog && (
        <ForkDialog
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
 * The pane header's "…" menu: an orchestrator's switch first, then opening the folder in the
 * editor, forking the thread, its own verbs and More…, which has the rest: the branch to copy and
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
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}
