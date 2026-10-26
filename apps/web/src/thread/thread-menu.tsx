import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@gram/contracts";
import { ArrowLeftRight, Ellipsis, GitFork, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { SwitchOrchestratorDialog, switchOpenLabel } from "@/orchestration/switch-orchestrator";
import { WorkerMenuItems } from "@/orchestration/worker-header";
import { FoldedTitlebarSubmenu } from "@/shell/titlebar-fold";
import { useThreadsStore } from "@/stores/threads";

import { ForkDialog } from "./fork-dialog";
import { ThreadMenuItems } from "./thread-action-items";
import { useForkAvailability, useForkThread, WORKTREE_NOTICE } from "./use-fork";

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/**
 * The pane header's "…" menu: an orchestrator's switch first, then opening the folder in the
 * editor, forking the thread, its own verbs and More…, which has the rest: the branch to copy and
 * push (the agents' working detail, kept out of the bar and its menu), the worker's or
 * orchestrator's links, other windows, revealing the folder, forking into a worktree. With
 * `folded`, a narrow title bar's folded buttons are a "Title bar" submenu before its own verbs.
 */
export function ThreadMenu({
  threadId,
  label,
  folded,
}: {
  threadId: ThreadId;
  label?: string;
  /**
   * The header is the title bar's, and the bar folded its lesser buttons into this menu; `worker`,
   * a worker's own actions too.
   */
  folded?: { orchestration: boolean; worker: boolean } | undefined;
}) {
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

  return (
    <>
      {error && (
        <button
          type="button"
          role="alert"
          title={`${error} (click to dismiss)`}
          className="max-w-48 shrink truncate text-xs text-destructive @max-md:hidden"
          onClick={clearError}
        >
          {error}
        </button>
      )}
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size={label ? "sm" : "icon-sm"}
              aria-label={label ?? "Thread menu"}
            />
          }
          className="shrink-0"
        >
          <Ellipsis />
          {label}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
            <Menu.Popup data-testid="thread-menu" className={POPUP}>
              {switchable && (
                <>
                  <Menu.Item
                    data-testid="menu-switch-orchestrator"
                    className={ITEM}
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
                  className={ITEM}
                  onClick={() => {
                    if (folder) void openInEditor(folder, { threadId });
                  }}
                >
                  <SquareArrowOutUpRight aria-hidden className="size-3.5" />
                  Open folder in editor
                </Menu.Item>
              )}
              <Menu.Item disabled={!available} className={ITEM} onClick={() => void forkThread()}>
                <GitFork aria-hidden className="size-3.5" />
                Fork thread
              </Menu.Item>
              {reason && <p className="px-2 py-1 text-xs text-muted-foreground">{reason}</p>}
              {folded && (
                <FoldedTitlebarSubmenu orchestration={folded.orchestration} itemClassName={ITEM}>
                  {thread && folded.worker && (
                    <WorkerMenuItems thread={thread} itemClassName={ITEM} />
                  )}
                </FoldedTitlebarSubmenu>
              )}
              <ThreadMenuItems threadId={threadId} itemClassName={ITEM} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
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
}
