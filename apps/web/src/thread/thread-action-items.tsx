import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@gram/contracts";
import {
  CircleCheck,
  Ellipsis,
  Hand,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  RotateCcw,
  X,
} from "lucide-react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import { shortcutHint } from "@/keyboard/bindings";
import { threadScope } from "@/palette/palette-items";
import { useLayoutStore, type PaletteScope } from "@/stores/layout";

import { PrContextMenuItems } from "./pr-menu-items";
import { useThreadActions } from "./use-thread-actions";

export const SEPARATOR = <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
export const DANGER = "text-destructive data-[highlighted]:text-destructive";

/** Mark done's words: a disabled item shows no tooltip, so they say why it is off while it works. */
const doneWord = (done: boolean, held: boolean) =>
  done ? "Reopen" : held ? "Mark done after it stops" : "Mark done";

/** Mark done's tick, or Reopen's arrow back for a thread already done. */
const DoneIcon = ({ done }: { done: boolean }) =>
  done ? (
    <RotateCcw aria-hidden className="size-3.5" />
  ) : (
    <CircleCheck aria-hidden className="size-3.5" />
  );

/**
 * Opens ⌘K on the commands of one thread or workspace: everything a context menu leaves out, by
 * scope. Last in every row menu.
 */
export function MoreContextMenuItem({ scope }: { scope: PaletteScope }) {
  return (
    <ContextMenuItem
      data-testid="menu-more"
      // After the menu has closed and given focus back, so the palette's field keeps it.
      onClick={() => setTimeout(() => useLayoutStore.getState().openPalette("", scope))}
    >
      <Ellipsis aria-hidden className="size-3.5" />
      More…
    </ContextMenuItem>
  );
}

/**
 * A row menu's thread verbs, after the row's own: rename, pin, park, done, its PR and close, then
 * More… for the rest. An orchestrator's row has its workspace's verbs above, and More… is its
 * workspace's.
 */
export function ThreadContextMenuItems({
  threadId,
  separated = true,
}: {
  threadId: ThreadId;
  /** Whether a group of the row's own comes first, to be set apart from. */
  separated?: boolean;
}) {
  const actions = useThreadActions(threadId);
  const { thread } = actions;
  if (!thread) return null;
  const orchestrator = thread.role === "orchestrator";
  return (
    <>
      {separated && SEPARATOR}
      <ContextMenuItem onClick={actions.rename}>
        <Pencil aria-hidden className="size-3.5" />
        Rename…
        <kbd className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">
          {shortcutHint("thread.rename")}
        </kbd>
      </ContextMenuItem>
      {/* The orchestrator's row stays in its workspace's tree, so pinning it moves nothing. */}
      {!orchestrator && (
        <ContextMenuItem onClick={actions.togglePin}>
          {thread.pinned ? (
            <PinOff aria-hidden className="size-3.5" />
          ) : (
            <Pin aria-hidden className="size-3.5" />
          )}
          {thread.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={actions.togglePark}>
        {thread.parked ? (
          <Play aria-hidden className="size-3.5" />
        ) : (
          <Pause aria-hidden className="size-3.5" />
        )}
        {thread.parked ? "Unpark" : "Park"}
      </ContextMenuItem>
      {actions.toggleDone !== undefined && (
        <ContextMenuItem
          data-testid="menu-done"
          disabled={actions.doneHeld}
          onClick={actions.toggleDone}
        >
          <DoneIcon done={thread.completedAt !== undefined} />
          {doneWord(thread.completedAt !== undefined, actions.doneHeld)}
        </ContextMenuItem>
      )}
      {/* An orchestrator follows no PR of its own; its workers carry theirs. */}
      {!orchestrator && <PrContextMenuItems threadId={threadId} />}
      <ContextMenuItem className={DANGER} onClick={actions.close}>
        <X aria-hidden className="size-3.5" />
        Close thread…
        <kbd className="ml-auto pl-3 font-mono text-[10px]">{shortcutHint("thread.close")}</kbd>
      </ContextMenuItem>
      {SEPARATOR}
      <MoreContextMenuItem scope={threadScope(thread)} />
    </>
  );
}

/** "Hand back to orchestrator", for a worker the user holds. */
export function ReleaseContextMenuItem({ threadId }: { threadId: ThreadId }) {
  const { release } = useThreadActions(threadId);
  return (
    <ContextMenuItem data-testid="menu-release-worker" onClick={release}>
      <Hand aria-hidden className="size-3.5" />
      Hand back to orchestrator
    </ContextMenuItem>
  );
}

/**
 * The same thread verbs for the pane header's base-ui menu: rename, pin, park, done and close, then
 * More… for the rest, as the row menu has them.
 */
export function ThreadMenuItems({
  threadId,
  itemClassName,
}: {
  threadId: ThreadId;
  itemClassName: string;
}) {
  const actions = useThreadActions(threadId);
  const { thread } = actions;
  if (!thread) return null;
  const orchestrator = thread.role === "orchestrator";
  const scope = threadScope(thread);
  return (
    <>
      {SEPARATOR}
      <Menu.Item className={itemClassName} onClick={actions.rename}>
        <Pencil aria-hidden className="size-3.5" />
        Rename…
      </Menu.Item>
      {!orchestrator && (
        <Menu.Item className={itemClassName} onClick={actions.togglePin}>
          {thread.pinned ? (
            <PinOff aria-hidden className="size-3.5" />
          ) : (
            <Pin aria-hidden className="size-3.5" />
          )}
          {thread.pinned ? "Unpin" : "Pin"}
        </Menu.Item>
      )}
      <Menu.Item className={itemClassName} onClick={actions.togglePark}>
        {thread.parked ? (
          <Play aria-hidden className="size-3.5" />
        ) : (
          <Pause aria-hidden className="size-3.5" />
        )}
        {thread.parked ? "Unpark" : "Park"}
      </Menu.Item>
      {actions.toggleDone !== undefined && (
        <Menu.Item
          className={itemClassName}
          disabled={actions.doneHeld}
          onClick={actions.toggleDone}
        >
          <DoneIcon done={thread.completedAt !== undefined} />
          {doneWord(thread.completedAt !== undefined, actions.doneHeld)}
        </Menu.Item>
      )}
      <Menu.Item className={`${itemClassName} ${DANGER}`} onClick={actions.close}>
        <X aria-hidden className="size-3.5" />
        Close thread…
      </Menu.Item>
      {SEPARATOR}
      <Menu.Item
        data-testid="menu-more"
        className={itemClassName}
        // After the menu has closed and given focus back, so the palette's field keeps it.
        onClick={() => setTimeout(() => useLayoutStore.getState().openPalette("", scope))}
      >
        <Ellipsis aria-hidden className="size-3.5" />
        More…
      </Menu.Item>
    </>
  );
}
